// Graph API da Meta para a API Oficial do WhatsApp conectada pelo Embedded Signup ("Entrar com o Facebook").
// Configuração do app do Vórtex CRM na Meta nos segredos das Edge Functions (nunca no código nem no navegador):
//   META_APP_ID, META_APP_SECRET, META_CONFIG_ID (configuração do Facebook Login for Business),
//   META_WEBHOOK_VERIFY_TOKEN (token de verificação do webhook do app) e, opcional, META_GRAPH_VERSION.
// O Vórtex CRM é Tech Provider: cada cliente cadastra a própria forma de pagamento na conta do WhatsApp Business e paga as
// mensagens direto à Meta. Por isso o login não pede business_management nem compartilha linha de crédito.

export const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') || 'v26.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

export function metaApp() {
  return {
    appId: Deno.env.get('META_APP_ID') || '',
    appSecret: Deno.env.get('META_APP_SECRET') || '',
    configId: Deno.env.get('META_CONFIG_ID') || '',
    verifyToken: Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || '',
  }
}

// Segredos que faltam para o "Entrar com o Facebook" funcionar (só os nomes; o painel mostra ao superadmin)
export function metaMissing() {
  const a = metaApp()
  return [
    ['META_APP_ID', a.appId], ['META_APP_SECRET', a.appSecret], ['META_CONFIG_ID', a.configId], ['META_WEBHOOK_VERIFY_TOKEN', a.verifyToken],
  ].filter(([, v]) => !v).map(([k]) => k)
}

export class MetaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly subcode?: number, readonly userMessage?: string) {
    super(message)
  }
}

type Opts = { token?: string; query?: Record<string, string>; body?: unknown }

export async function graph(method: string, path: string, { token, query, body }: Opts = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v)
  const r = await fetch(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let j: any = {}
  try { j = text ? JSON.parse(text) : {} } catch { j = { raw: text } }
  if (!r.ok || j?.error) {
    const e = j?.error || {}
    throw new MetaError(e.message || `HTTP ${r.status}`, r.status, e.code, e.error_subcode, e.error_user_msg || e.error_data?.details)
  }
  return j
}

/* ---------- Onboarding (Embedded Signup, Tech Provider) ---------- */

// O código do Embedded Signup vale 30 segundos: troque assim que ele chegar.
export async function exchangeCode(code: string): Promise<string> {
  const { appId, appSecret } = metaApp()
  const j = await graph('GET', 'oauth/access_token', { query: { client_id: appId, client_secret: appSecret, code } })
  const token = j.access_token || j.raw
  if (!token || typeof token !== 'string') throw new MetaError('A Meta não devolveu o token de acesso.', 502)
  return token
}

export type TokenInfo = { appId: string; valid: boolean; expiresAt: number; scopes: string[]; wabaIds: string[] }

// Confere o token com o próprio app (app_id e validade) e devolve as contas do WhatsApp liberadas para ele.
export async function debugToken(token: string): Promise<TokenInfo> {
  const { appId, appSecret } = metaApp()
  const { data = {} } = await graph('GET', 'debug_token', { query: { input_token: token, access_token: `${appId}|${appSecret}` } })
  const wabaIds = new Set<string>()
  for (const g of data.granular_scopes || []) {
    if (g.scope === 'whatsapp_business_management' || g.scope === 'whatsapp_business_messaging') for (const id of g.target_ids || []) wabaIds.add(String(id))
  }
  return { appId: String(data.app_id || ''), valid: !!data.is_valid, expiresAt: Number(data.expires_at || 0), scopes: data.scopes || [], wabaIds: [...wabaIds] }
}

export const PHONE_FIELDS = 'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,status'

export async function phoneNumbers(wabaId: string, token: string): Promise<any[]> {
  const j = await graph('GET', `${wabaId}/phone_numbers`, { token, query: { fields: PHONE_FIELDS, limit: '100' } })
  return j.data || []
}

export const phoneInfo = (phoneNumberId: string, token: string) => graph('GET', phoneNumberId, { token, query: { fields: PHONE_FIELDS } })

// Campo opcional: se a Meta recusar (permissão ou versão), segue sem ele
const optional = async (wabaId: string, token: string, fields: string) => {
  try { return await graph('GET', wabaId, { token, query: { fields } }) } catch { return null }
}

export async function wabaInfo(wabaId: string, token: string) {
  const [base, owner, funding] = await Promise.all([
    graph('GET', wabaId, { token, query: { fields: 'id,name,currency,account_review_status' } }),
    optional(wabaId, token, 'owner_business_info'),
    optional(wabaId, token, 'primary_funding_id'),
  ])
  return {
    id: String(base.id),
    name: base.name || '',
    currency: base.currency || '',
    reviewStatus: base.account_review_status || '',
    businessId: owner?.owner_business_info?.id ? String(owner.owner_business_info.id) : '',
    businessName: owner?.owner_business_info?.name || '',
    // forma de pagamento cadastrada na conta do cliente: ok | pending | unknown (sem acesso ao campo)
    payment: !funding ? 'unknown' : funding.primary_funding_id ? 'ok' : 'pending',
  }
}

export const subscribeApp = (wabaId: string, token: string) => graph('POST', `${wabaId}/subscribed_apps`, { token })
export const unsubscribeApp = (wabaId: string, token: string) => graph('DELETE', `${wabaId}/subscribed_apps`, { token })
export const subscribedApps = (wabaId: string, token: string) => graph('GET', `${wabaId}/subscribed_apps`, { token })

// Registra o número na Cloud API. O PIN (6 dígitos) vira a verificação em duas etapas do número.
export const registerPhone = (phoneNumberId: string, token: string, pin: string) =>
  graph('POST', `${phoneNumberId}/register`, { token, body: { messaging_product: 'whatsapp', pin } })

export const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')

/* ---------- Modelos de mensagem (templates) ---------- */

export const TEMPLATE_FIELDS = 'id,name,language,category,status,components,rejected_reason'

// Todos os modelos da conta, seguindo as páginas da Meta (até 20 páginas de 100)
export async function listTemplates(wabaId: string, token: string): Promise<any[]> {
  const out: any[] = []
  let after = ''
  for (let page = 0; page < 20; page++) {
    const j = await graph('GET', `${wabaId}/message_templates`, { token, query: { fields: TEMPLATE_FIELDS, limit: '100', ...(after ? { after } : {}) } })
    out.push(...(j.data || []))
    after = j.paging?.next ? j.paging?.cursors?.after || '' : ''
    if (!after) break
  }
  return out
}

// Cabeçalho de mídia: a Meta só aceita o exemplo como "handle" da Resumable Upload API do app (abre a sessão de upload
// e manda os bytes). O handle vai em components[HEADER].example.header_handle.
export async function uploadForTemplate(token: string, data: Uint8Array<ArrayBuffer>, fileType: string, fileName: string): Promise<string> {
  const { appId } = metaApp()
  const session = await graph('POST', `${appId}/uploads`, { token, query: { file_name: fileName, file_length: String(data.byteLength), file_type: fileType } })
  if (!session?.id) throw new MetaError('A Meta não abriu o envio do arquivo.', 502)
  const r = await fetch(`${GRAPH}/${session.id}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: data })
  const text = await r.text()
  let j: any = {}
  try { j = text ? JSON.parse(text) : {} } catch { j = { raw: text } }
  if (!r.ok || j?.error || !j?.h) {
    const e = j?.error || {}
    throw new MetaError(e.message || `HTTP ${r.status}`, r.status, e.code, e.error_subcode, e.error_user_msg || 'A Meta não aceitou o arquivo do cabeçalho.')
  }
  return String(j.h)
}

// Cria o modelo na conta; a Meta devolve { id, status, category } e analisa (o resultado chega pelo webhook)
export const createTemplate = (wabaId: string, token: string, t: { name: string; language: string; category: string; components: unknown[] }) =>
  graph('POST', `${wabaId}/message_templates`, { token, body: { name: t.name, language: t.language, category: t.category, components: t.components } })

// Link do Gerenciador do WhatsApp onde o cliente cadastra a forma de pagamento
export const paymentUrl = (wabaId: string, businessId?: string) =>
  `https://business.facebook.com/wa/manage/home/?${new URLSearchParams({ ...(businessId ? { business_id: businessId } : {}), waba_id: wabaId })}`

/* ---------- Erros ---------- */

export const PIN_MISMATCH = 133005
const AUTH_CODES = new Set([190, 102, 10, 200])
export const isAuthError = (e: unknown) => e instanceof MetaError && (AUTH_CODES.has(e.code ?? -1) || e.status === 401)

// Mensagem para o cliente (sem jargão). O detalhe técnico vai para o log.
export function friendlyMetaError(e: unknown): string {
  if (!(e instanceof MetaError)) return e instanceof Error ? e.message : 'Erro inesperado ao falar com a Meta.'
  if (e.code === 100 && /code|authorization/i.test(e.message)) return 'A autorização da Meta expirou ou já foi usada (ela vale só 30 segundos). Clique em "Entrar com o Facebook" de novo.'
  if (e.code === 190) return 'O acesso à conta da Meta expirou ou foi removido. Conecte de novo com o Facebook.'
  if (e.code === 10 || e.code === 200) return 'O Vórtex CRM não recebeu permissão para essa conta do WhatsApp. Conecte de novo e aceite todas as permissões pedidas.'
  if (e.code === PIN_MISMATCH) return 'Esse número já tem um PIN de verificação em duas etapas. Informe o PIN de 6 dígitos para concluir.'
  if (e.code === 133006) return 'A Meta pediu uma nova verificação do número. Abra o Gerenciador do WhatsApp, confirme o número por SMS ou ligação e tente de novo.'
  if (e.code === 133008 || e.code === 133009) return 'Muitas tentativas de PIN. Aguarde alguns minutos e tente de novo.'
  if (e.code === 133015) return 'Esse número foi removido há pouco de outra conta. Aguarde uns 5 minutos e tente de novo.'
  if (e.code === 133004 || e.code === 2 || e.status >= 500) return 'A Meta está instável no momento. Tente de novo em instantes.'
  if (e.code === 4 || e.code === 80008) return 'Muitas tentativas seguidas na Meta. Aguarde um minuto e tente de novo.'
  return e.userMessage || `A Meta recusou a operação: ${e.message}`
}
