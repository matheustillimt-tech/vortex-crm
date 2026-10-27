// Instagram (Direct) pela Zernio, que fala com a API oficial da Meta (instagram_manage_messages).
// Dois jeitos de conectar:
// - Chave da conexão (o padrão na tela): quem conecta cola a própria chave da API da Zernio e escolhe um dos Instagrams
//   que já estão conectados nela. O login no Instagram acontece só na Zernio. A chave fica no Vault
//   (zernio_connection:<conexão>, ver secrets.ts) e entra em IgCreds.apiKey na hora do uso.
// - Chave da plataforma (ZERNIO_API_KEY nos segredos): cada empresa vira um "profile" na conta da plataforma e o login
//   abre pelo CRM (instagram-start/finish). Fica como reserva.
// No Instagram o destino de um envio não é um telefone: é o id da conversa na Zernio (chats.external_id).
// Docs: https://docs.zernio.com (inbox, webhooks, connecting accounts)

export const ZERNIO_API = (Deno.env.get('ZERNIO_API_URL') || 'https://zernio.com/api/v1').replace(/\/+$/, '')
const platformKey = () => Deno.env.get('ZERNIO_API_KEY') || ''

export type IgCreds = { profileId?: string; accountId: string; username?: string; apiKey?: string }

// Janela de resposta do Instagram (regra da Meta):
// - até 24 h desde a última mensagem do cliente: robô, IA e equipe podem responder;
// - de 24 h a 7 dias: só uma pessoa da equipe, com a tag HUMAN_AGENT;
// - depois de 7 dias: não dá para mandar nada até o cliente escrever de novo.
export const IG_WINDOW_MS = 24 * 3600 * 1000
export const IG_HUMAN_MS = 7 * 24 * 3600 * 1000
export type IgWindow = 'open' | 'human' | 'closed'
export function igWindow(lastContactAt: string | null | undefined, now = Date.now()): IgWindow {
  const t = lastContactAt ? Date.parse(lastContactAt) : NaN
  if (!Number.isFinite(t)) return 'closed'
  const age = now - t
  return age < IG_WINDOW_MS ? 'open' : age < IG_HUMAN_MS ? 'human' : 'closed'
}

export class ZernioError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// `key`: a chave da conexão; sem ela, a da plataforma.
export async function zernio(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, key = platformKey()) {
  if (!key) throw new ZernioError('Conexão sem chave da Zernio', 500, 'NO_KEY')
  const r = await fetch(`${ZERNIO_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  })
  const text = await r.text()
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!r.ok) {
    const meta = json?.platformError ? ` (Meta ${json.platformError.code}/${json.platformError.subcode ?? '-'})` : ''
    throw new ZernioError(`${json?.error || json?.message || `HTTP ${r.status}`}${meta}`, r.status, json?.code)
  }
  return json
}

/* ---------- Envio ---------- */

export type IgButton = { type: 'postback'; title: string; payload: string }
export type IgSend = {
  text?: string
  attachment?: { url: string; type: 'image' | 'video' | 'audio' | 'file' }
  quickReplies?: { title: string; payload: string }[]
  buttons?: IgButton[]
  humanAgent?: boolean // só para mensagem de uma pessoa da equipe, entre 24 h e 7 dias
}

// Devolve o id da mensagem na Zernio. A Idempotency-Key faz uma nova tentativa com a mesma chave não mandar duas vezes.
export async function igSend(c: IgCreds, conversationId: string, m: IgSend, idempotencyKey: string = crypto.randomUUID()): Promise<string | null> {
  if (!c?.accountId) throw new ZernioError('Conexão do Instagram sem conta vinculada', 400, 'NO_ACCOUNT')
  if (!conversationId) throw new ZernioError('Conversa do Instagram sem id da Zernio', 400, 'MISSING_PARTICIPANT')
  const body: Record<string, unknown> = { accountId: c.accountId }
  if (m.text) body.message = m.text
  if (m.attachment) Object.assign(body, { attachmentUrl: m.attachment.url, attachmentType: m.attachment.type })
  if (m.quickReplies?.length) body.quickReplies = m.quickReplies.slice(0, 13)
  else if (m.buttons?.length) body.buttons = m.buttons.slice(0, 3)
  if (m.humanAgent) Object.assign(body, { messagingType: 'MESSAGE_TAG', messageTag: 'HUMAN_AGENT' })
  const j = await zernio('POST', `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, body, { 'Idempotency-Key': idempotencyKey }, c.apiKey || undefined)
  return j?.data?.messageId ?? j?.messageId ?? null
}

// Menu do fluxo: até 3 opções viram botões; até 13, respostas rápidas; acima disso, texto numerado.
// O toque volta no message.received com o payload opt-N, o mesmo id que o fluxo já espera (replyId).
export async function igMenu(c: IgCreds, conversationId: string, text: string, options: string[]) {
  const opts = options.map((o, i) => ({ title: o.slice(0, 20), payload: `opt-${i}` }))
  if (opts.length && opts.length <= 3) return igSend(c, conversationId, { text, buttons: opts.map((o) => ({ type: 'postback', ...o })) })
  if (opts.length && opts.length <= 13) return igSend(c, conversationId, { text, quickReplies: opts })
  return null // quem chama manda como texto numerado
}

export async function igTyping(c: IgCreds, conversationId: string) {
  try { await zernio('POST', `/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, { accountId: c.accountId }, {}, c.apiKey || undefined) } catch { /* é só cortesia */ }
}

// Formatos que o Instagram aceita (o resto é recusado pela Meta): imagem PNG/JPEG até 8 MB; vídeo MP4/OGG/AVI/MOV/WEBM e
// áudio AAC/M4A/WAV/MP4 até 25 MB; arquivo só PDF até 25 MB. MP3 e OGG/Opus de áudio são recusados.
export const IG_LIMITS = {
  image: { mimes: ['image/png', 'image/jpeg'], mb: 8 },
  video: { mimes: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/quicktime', 'video/webm'], mb: 25 },
  audio: { mimes: ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav'], mb: 25 },
  file: { mimes: ['application/pdf'], mb: 25 },
} as const
export type IgKind = keyof typeof IG_LIMITS
export function igKind(mime: string, bytes: number): IgKind | null {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  for (const [kind, lim] of Object.entries(IG_LIMITS) as [IgKind, (typeof IG_LIMITS)[IgKind]][]) {
    if ((lim.mimes as readonly string[]).includes(base)) return bytes <= lim.mb * 1024 * 1024 ? kind : null
  }
  return null
}

/* ---------- Conta (profile, login, saúde) ---------- */

// Para onde a Zernio devolve a pessoa depois do login da Meta: só os endereços do painel (SITE_URL, os de APP_ORIGINS,
// opcional e separado por vírgula, como uma prévia da Vercel, e o local), sempre na tela de Conexões com o id da conexão.
const origensDoPainel = () =>
  [Deno.env.get('SITE_URL') || '', ...(Deno.env.get('APP_ORIGINS') || '').split(',')]
    .map((u) => { try { return new URL(u.trim()).origin } catch { return '' } })
    .filter(Boolean)
export function returnUrl(from: unknown, connectionId: string) {
  let origin = ''
  try { origin = new URL(String(from || '')).origin } catch { return null }
  if (!/^http:\/\/localhost:\d+$/.test(origin) && !origensDoPainel().includes(origin)) return null
  return `${origin}/connections?ig=${encodeURIComponent(connectionId)}`
}


export async function ensureProfile(admin: any, companyId: string, companyName: string): Promise<string> {
  const { data } = await admin.from('zernio_profiles').select('profile_id').eq('company_id', companyId).maybeSingle()
  if (data?.profile_id) return data.profile_id
  // nome único na equipe da Zernio: nome da empresa + começo do id
  const j = await zernio('POST', '/profiles', { name: `${(companyName || 'Empresa').slice(0, 40)} · ${companyId.slice(0, 8)}`, description: `Vórtex CRM · ${companyId}` })
  const profileId = j?.profile?._id || j?._id || j?.id
  if (!profileId) throw new ZernioError('A Zernio não devolveu o profile', 502)
  const { error } = await admin.from('zernio_profiles').insert({ company_id: companyId, profile_id: profileId })
  if (error) {
    // duas abas ao mesmo tempo: fica o que gravou primeiro
    const { data: again } = await admin.from('zernio_profiles').select('profile_id').eq('company_id', companyId).maybeSingle()
    if (again?.profile_id) return again.profile_id
    throw error
  }
  return profileId
}

export async function connectUrl(profileId: string, redirectUrl: string): Promise<string> {
  const q = new URLSearchParams({ profileId, redirect_url: redirectUrl })
  const j = await zernio('GET', `/connect/instagram?${q}`)
  if (!j?.authUrl) throw new ZernioError('A Zernio não devolveu o link de login', 502)
  return j.authUrl
}

export type IgAccount = { accountId: string; username: string; displayName: string; picture: string | null }
export async function instagramAccounts(profileId: string): Promise<IgAccount[]> {
  const j = await zernio('GET', `/accounts?${new URLSearchParams({ profileId, platform: 'instagram' })}`)
  return (j?.accounts ?? [])
    .filter((a: any) => a?.platform === 'instagram' && a?.isActive !== false)
    .map((a: any) => ({ accountId: a._id || a.id, username: a.username || '', displayName: a.displayName || a.username || '', picture: a.profilePicture || a.profilePictureUrl || null }))
}

export const disconnectAccount = (accountId: string) => zernio('DELETE', `/accounts/${encodeURIComponent(accountId)}`)
export const accountHealth = (accountId: string, key?: string) => zernio('GET', `/accounts/${encodeURIComponent(accountId)}/health`, undefined, {}, key || undefined)

/* ---------- Conexão pela chave da Zernio de quem conecta ---------- */

// Formato da chave: sk_… (completa) ou zrk_… (restrita). Só confere o jeito; quem diz se vale é a Zernio.
export const looksLikeKey = (k: string) => /^(sk|zrk)_[A-Za-z0-9_-]{16,}$/.test(String(k || '').trim())
export const keyHint = (k: string) => `••••${String(k || '').trim().slice(-4)}`

// Instagrams já conectados na conta da Zernio dona da chave (o login no Instagram foi feito lá)
export async function accountsForKey(key: string): Promise<IgAccount[]> {
  let j: any
  try {
    j = await zernio('GET', '/accounts?platform=instagram', undefined, {}, key)
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 401 || e.status === 403)) throw new ZernioError('A Zernio não aceitou essa chave. Confira se copiou inteira e se ela tem acesso a contas, mensagens e webhooks.', 401, 'BAD_KEY')
    throw e
  }
  return (j?.accounts ?? [])
    .filter((a: any) => a?.platform === 'instagram' && a?.isActive !== false)
    .map((a: any) => ({ accountId: a._id || a.id, username: a.username || '', displayName: a.displayName || a.username || '', picture: a.profilePicture || a.profilePictureUrl || null }))
}

// Eventos que o CRM usa. O webhook é cadastrado na conta de quem conectou, apontando para esta conexão.
export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.read', 'message.deleted', 'account.disconnected']
export const connectionWebhookUrl = (connectionId: string) =>
  `${(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')}/functions/v1/zernio-webhook?c=${encodeURIComponent(connectionId)}`

export async function createWebhook(key: string, name: string, url: string, secret: string): Promise<string> {
  const j = await zernio('POST', '/webhooks/settings', { name: name.slice(0, 50), url, secret, events: WEBHOOK_EVENTS, isActive: true }, {}, key)
  const id = j?.webhook?._id || j?.webhook?.id || j?._id
  if (!id) throw new ZernioError('A Zernio não devolveu o webhook', 502)
  return id
}
export const deleteWebhook = (key: string, id: string) => zernio('DELETE', `/webhooks/settings?id=${encodeURIComponent(id)}`, undefined, {}, key)

/* ---------- Webhook ---------- */

// Assinatura: HMAC-SHA256 do corpo cru com o segredo do webhook, em hexadecimal minúsculo, no header X-Zernio-Signature.
export async function validZernioSignature(raw: string, header: string | null, secret: string) {
  if (!header || !secret) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
  const given = header.trim().toLowerCase()
  if (given.length !== hex.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

export type IgInbound = {
  conversationId: string
  igUserId: string
  username: string
  name: string
  picture: string | null
  text: string
  messageId: string
  platformMessageId: string | null
  automationId: string | null // DM mandada por uma automação de comentário da Zernio
  fromMe: boolean
  type: string
  replyId: string | null
  media: { url: string; mimeType?: string } | null
  igProfile: Record<string, unknown> | null
  sentAt: string | null
}

const ATT_LABEL: Record<string, string> = { image: '📷 Imagem', video: '🎥 Vídeo', audio: '🎤 Áudio', file: '📄 Arquivo', sticker: '🔖 Figurinha' }
const ATT_TYPE: Record<string, string> = { image: 'image', video: 'video', audio: 'audio', file: 'document', sticker: 'sticker' }

// message.received (cliente escreveu) e message.sent (saiu pela conta: pelo CRM ou pelo app do Instagram).
// Só Instagram: os outros canais da Zernio não entram por aqui.
export function parseZernioMessage(ev: any): IgInbound | null {
  const m = ev?.message
  if (!m || (ev?.account?.platform || m.platform) !== 'instagram') return null
  const conv = ev.conversation || {}
  const fromMe = ev.event === 'message.sent' || m.direction === 'outgoing'
  // No message.sent o remetente é a própria empresa: o contato vem da conversa.
  const who = fromMe
    ? { id: conv.participantId, name: conv.participantName, username: conv.participantUsername, picture: conv.participantPicture }
    : m.sender || {}
  const att = (m.attachments || [])[0]
  const md = ev.metadata || m.metadata || {}
  // Toque em botão/resposta rápida: a Zernio manda o payload em metadata (nome do campo a confirmar com um evento real).
  const replyId = md.postbackPayload ?? md.quickReplyPayload ?? md.payload ?? md.callbackData ?? null
  const text = (m.text || '').trim() || (att ? ATT_LABEL[att.type] || '📎 Anexo' : '')
  const igUserId = String(who.id || conv.participantId || '')
  if (!m.conversationId || !igUserId) return null
  return {
    conversationId: String(m.conversationId),
    igUserId,
    username: String(who.username || conv.participantUsername || ''),
    name: String(who.name || conv.participantName || who.username || ''),
    picture: who.picture || conv.participantPicture || null,
    text: text || '[mensagem]',
    messageId: String(m.id || m.platformMessageId),
    platformMessageId: m.platformMessageId ? String(m.platformMessageId) : null,
    automationId: m.automationId ? String(m.automationId) : null,
    fromMe,
    type: att ? ATT_TYPE[att.type] || 'document' : 'text',
    replyId: replyId == null ? null : String(replyId),
    media: att?.url ? { url: att.url } : null,
    igProfile: !fromMe && m.sender?.instagramProfile ? { ...m.sender.instagramProfile, fetchedAt: ev.timestamp || null } : null,
    sentAt: m.sentAt || ev.timestamp || null,
  }
}
