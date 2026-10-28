// Cliente do Zapbot (WhatsApp não oficial: QR Code ou código de pareamento). Referência: docs do Zapbot, 28/09/2026.
// - Conta (rotas /account/*): JWT de 30 dias, guardado em public.zapbot_session; no 401 refaz o login e repete uma vez.
//   E-mail e senha vêm dos segredos das Edge Functions (ZAPBOT_API_URL, ZAPBOT_EMAIL, ZAPBOT_PASSWORD) ou, se não
//   estiverem lá, do Vault pela função public.zapbot_account() (só a service role executa).
// - Conexão (rotas /instances/{id}/token/{token}/*): sem JWT, com o header Client-Token. Essas rotas são as mesmas do
//   Z-API, então a conexão "zapi" (instância da própria pessoa, ver zapi.ts) usa estas funções; lá o Client-Token é
//   opcional e só vai quando preenchido.
// - Nova tentativa com espera crescente só em 429 e em 502/503 sem JSON (reinício do servidor do Zapbot).
// A conta pode ser usada por outros sistemas: só mexa em conexões que este sistema criou (as que estão em connection_secrets).

export type ZapCreds = { baseUrl: string; instanceId: string; instanceToken: string; clientToken: string; webhookToken?: string; createdBy?: string }
type Json = Record<string, any>

export class ZapbotError extends Error {
  constructor(readonly status: number, message: string, readonly body: Json = {}) {
    super(message)
  }
}

// Falta ou erro de configuração do servidor: o cliente vê um aviso para chamar o administrador; `hint` diz o que ajustar.
export class ZapbotConfigError extends Error {
  constructor(message: string, readonly hint: string) {
    super(message)
  }
}

const SETUP_HINT = 'Cadastre ZAPBOT_EMAIL e ZAPBOT_PASSWORD (e, se quiser, ZAPBOT_API_URL) nos segredos das Edge Functions do Supabase, ou os segredos zapbot_email e zapbot_password no Vault.'

const DEFAULT_URL = 'https://api.zapbot.online'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function http(url: string, method: string, headers: Record<string, string> = {}, body?: unknown) {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      // erro de rede traz a URL, que tem o token da instância no caminho: tira antes de alguém logar
      if (e instanceof TypeError) throw new TypeError(e.message.replace(/\/token\/[^/\s)]+/g, '/token/***'))
      throw e
    }
    const text = await res.text()
    let json: Json = {}
    let isJson = true
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      isJson = false
      json = { error: `resposta inesperada do Zapbot (HTTP ${res.status})` }
    }
    const retry = res.status === 429 || (!isJson && (res.status === 502 || res.status === 503 || res.status === 504))
    if (!retry || attempt >= 3) return { status: res.status, json }
    await sleep(1000 * 2 ** attempt)
  }
}

const fail = (status: number, json: Json) => new ZapbotError(status, json.error ?? `HTTP ${status}`, json)

/* ---------- conta ---------- */

let account: { url: string; email: string; password: string } | null = null
let jwt: string | null = null

async function config(admin: any) {
  if (!account) {
    let url = Deno.env.get('ZAPBOT_API_URL') || ''
    let email = Deno.env.get('ZAPBOT_EMAIL') || ''
    let password = Deno.env.get('ZAPBOT_PASSWORD') || ''
    if (!email || !password) {
      const { data, error } = await admin.rpc('zapbot_account')
      if (error) console.error('zapbot_account', error.message)
      url = url || data?.url || ''
      email = data?.email || ''
      password = data?.password || ''
    }
    if (!email || !password) throw new ZapbotConfigError('A conexão por QR Code ainda não foi configurada no servidor. Avise o administrador da plataforma.', SETUP_HINT)
    account = { url: (url || DEFAULT_URL).replace(/\/+$/, ''), email, password }
  }
  return account
}

async function login(admin: any) {
  const cfg = await config(admin)
  const r = await http(`${cfg.url}/auth/login`, 'POST', {}, { email: cfg.email, password: cfg.password })
  if (r.status === 401) {
    account = null // relê a senha na próxima tentativa (pode ter sido atualizada)
    throw new ZapbotConfigError(
      'O servidor não conseguiu entrar na conta do Zapbot. Avise o administrador da plataforma.',
      'O Zapbot recusou o e-mail ou a senha. Se a senha foi trocada, atualize ZAPBOT_PASSWORD nos segredos das Edge Functions ou zapbot_password no Vault.',
    )
  }
  if (r.status !== 200 || !r.json.token) throw fail(r.status, r.json)
  jwt = r.json.token
  await admin.from('zapbot_session').upsert({ id: 1, jwt, updated_at: new Date().toISOString() })
}

async function accountCall(admin: any, method: string, path: string, body?: unknown) {
  const cfg = await config(admin)
  if (!jwt) {
    const { data } = await admin.from('zapbot_session').select('jwt').eq('id', 1).maybeSingle()
    jwt = data?.jwt || null
  }
  if (!jwt) await login(admin)
  let r = await http(`${cfg.url}${path}`, method, { Authorization: `Bearer ${jwt}` }, body)
  if (r.status === 401) {
    await login(admin)
    r = await http(`${cfg.url}${path}`, method, { Authorization: `Bearer ${jwt}` }, body)
  }
  if (r.status >= 400) throw fail(r.status, r.json)
  return r.json
}

export async function zapbotBaseUrl(admin: any) {
  return (await config(admin)).url
}

export const createInstance = (admin: any, data: { name: string; webhookUrl: string; clientToken: string }) =>
  accountCall(admin, 'POST', '/account/instances', data)

export const updateInstance = (admin: any, id: string, data: Json) => accountCall(admin, 'PUT', `/account/instances/${id}/settings`, data)

export async function deleteInstance(admin: any, id: string) {
  try {
    await accountCall(admin, 'DELETE', `/account/instances/${id}`)
  } catch (e) {
    if (!(e instanceof ZapbotError && e.status === 404)) throw e // já não existia: nada a fazer
  }
}

/* ---------- conexão ---------- */

export const instanceCall = (c: ZapCreds, method: string, route: string, body?: unknown) =>
  http(`${c.baseUrl}/instances/${c.instanceId}/token/${c.instanceToken}/${route}`, method, c.clientToken ? { 'Client-Token': c.clientToken } : {}, body)

export async function status(c: ZapCreds): Promise<{ connected: boolean; phone: string; error?: string }> {
  const r = await instanceCall(c, 'GET', 'status')
  if (r.status !== 200) throw fail(r.status, r.json)
  return r.json as { connected: boolean; phone: string; error?: string }
}

// "challenge": o aparelho pede a chave de acesso (passkey) do Z-API; aqui não tem como concluir (ver zapi.ts, CHALLENGE_MSG).
type PairState = { state: 'pending' | 'connected' | 'challenge' }

export async function qrImage(c: ZapCreds): Promise<{ state: 'ready'; image: string; expiresInMs: number } | PairState> {
  const r = await instanceCall(c, 'GET', 'qr-code/image')
  if (r.status === 200 && r.json.value) return { state: 'ready', image: r.json.value, expiresInMs: r.json.expiresInMs }
  if (r.status === 200 && r.json.challenge) return { state: 'challenge' }
  if (r.status === 409 || (r.status === 200 && r.json.connected === true)) return { state: 'connected' }
  if (r.status === 200 || r.status === 202) return { state: 'pending' }
  throw fail(r.status, r.json)
}

// O Zapbot devolve o código em "code"; o Z-API, em "value".
export async function pairingCode(c: ZapCreds, phone: string): Promise<{ state: 'ready'; code: string } | PairState> {
  const r = await instanceCall(c, 'GET', `phone-code/${phone.replace(/\D/g, '')}`)
  const code = r.json.code ?? r.json.value
  if (r.status === 200 && code) return { state: 'ready', code }
  if (r.status === 200 && r.json.challenge) return { state: 'challenge' }
  if (r.status === 409 || (r.status === 200 && r.json.connected === true)) return { state: 'connected' }
  if (r.status === 200 || r.status === 202) return { state: 'pending' }
  throw fail(r.status, r.json)
}

export async function restart(c: ZapCreds) {
  const r = await instanceCall(c, 'GET', 'restart')
  if (r.status !== 200) throw fail(r.status, r.json)
}

export async function disconnect(c: ZapCreds) {
  const r = await instanceCall(c, 'GET', 'disconnect')
  if (r.status !== 200) throw fail(r.status, r.json)
}

// Envio: devolve o messageId (liga a mensagem aos recibos do webhook)
export async function send(c: ZapCreds, route: string, body: Json): Promise<string | null> {
  const r = await instanceCall(c, 'POST', route, body)
  if (r.status !== 200) throw fail(r.status, r.json)
  return r.json.messageId ?? r.json.id ?? null
}

// Avisos que o webhook da conexão recebe. notifySentByMe: o que o próprio número envia, inclusive pelo celular (a resposta
// dada no aparelho aparece no chat). notifyGroupMessages: mensagens de grupo, só para o módulo Comandos. Os dois vão sempre
// explícitos: a doc não diz se o que fica de fora é mantido ou desligado.
export type WebhookFlags = { notifySentByMe: boolean; notifyGroupMessages: boolean }

export async function setWebhook(c: ZapCreds, url: string, flags: WebhookFlags) {
  const r = await instanceCall(c, 'PUT', 'update-every-webhooks', { value: url, ...flags })
  if (r.status >= 300) throw fail(r.status, r.json)
}

// Mensagem amigável para os erros mais comuns ao conectar
export function friendlyError(e: unknown) {
  if (e instanceof ZapbotConfigError) return e.message
  if (e instanceof ZapbotError) {
    if (e.status === 403 && /confirm/i.test(e.message)) return 'A conta do Zapbot da plataforma ainda não foi confirmada. Avise o administrador da plataforma.'
    if (e.status === 403) return 'Limite de conexões de WhatsApp da plataforma atingido. Fale com o suporte.'
    // a doc fala em 400, mas na prática "phone number too short" vem como 500
    if (/phone|telefone/i.test(e.message)) return 'Número inválido. Use DDI + DDD + número, por exemplo 55119XXXXXXXX.'
    if (e.status === 404) return 'Esta conexão não existe mais no provedor. Exclua e crie de novo.'
    if (e.status === 429) return 'Muitas tentativas seguidas. Aguarde alguns segundos e tente de novo.'
    return e.message
  }
  return (e as Error)?.message || 'Erro ao falar com o provedor de WhatsApp'
}
