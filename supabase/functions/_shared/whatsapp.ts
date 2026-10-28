// Envio pelos provedores de WhatsApp suportados: Cloud API da Meta, Zapbot, Z-API (instância da própria pessoa, mesmas
// rotas do Zapbot) e Evolution API (QR Code).
// As credenciais ficam em public.connection_secrets (só o servidor lê).
// "sandbox": conexão de teste sem WhatsApp (só entra por SQL). Nada sai do servidor; as mensagens ficam no painel
// como enviadas, para validar fluxos e agentes de ponta a ponta sem mandar nada a ninguém.
import { send as zapSend, type ZapCreds } from './zapbot.ts'
import { GRAPH } from './meta.ts'
import { igKind, igSend, type IgCreds } from './zernio.ts'

// "instagram": Direct do Instagram pela Zernio (zernio.ts). Nele o destino (`to`) é o id da conversa na Zernio
// (chats.external_id), não um telefone. Use recipientOf para escolher o destino certo.
export type Provider = 'meta' | 'evolution' | 'uazapi' | 'zapbot' | 'zapi' | 'sandbox' | 'instagram'
// Zapbot e Z-API: mesmas rotas de instância (/instances/{id}/token/{token}/*), mesmo envio de texto e mídia.
const zapLike = (p: Provider) => p === 'zapbot' || p === 'zapi'
export type Creds = Record<string, string>

export const onlyDigits = (s: string) => (s || '').replace(/\D/g, '')
const sandboxId = () => `sandbox-${crypto.randomUUID()}`
const ig = (c: Creds) => c as unknown as IgCreds

// Para quem vai a mensagem: telefone do contato no WhatsApp, id da conversa na Zernio no Instagram.
// Trava de segurança (Fase 1): pelo Instagram só sai mensagem digitada por uma pessoa no Chat ao vivo (send-message chama
// a Zernio direto, sem passar por aqui). Fluxo, agente de IA, disparo e MCP usam estas funções e ficam bloqueados no
// Instagram até a Fase 2 ter as travas de ritmo e a regra de "um robô por conversa".
export class EnvioAutomaticoBloqueado extends Error {}
const semRoboNoInstagram = () => {
  throw new EnvioAutomaticoBloqueado('Envio automático pelo Instagram está desligado: só a equipe responde pelo Chat ao vivo.')
}

export const recipientOf = (provider: Provider | null | undefined, contact: { phone?: string } | null, chat: { external_id?: string | null } | null) =>
  provider === 'instagram' ? String(chat?.external_id || '') : String(contact?.phone || '')

// Destino de sendText/sendMedia: número (só dígitos) ou grupo, que vai pelo JID inteiro (120363…@g.us).
// Hoje só o MCP manda para grupo; mensagens de grupo que chegam continuam fora (inbound.ts).
export const isGroupJid = (s: string) => /^[\d-]+@g\.us$/i.test((s || '').trim())
const destination = (to: string) => (isGroupJid(to) ? to.trim().toLowerCase() : onlyDigits(to))

// Celulares BR às vezes chegam sem o 9 (55 11 8888-7777): procura as duas formas.
export function phoneVariants(d: string) {
  const out = new Set([d])
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5))
  if (d.startsWith('55') && d.length === 12) out.add(d.slice(0, 4) + '9' + d.slice(4))
  return [...out]
}

// O WhatsApp guarda muitos celulares BR sem o 9 (DDD 31 em diante, quase todos) e alguns com ele. No Zapbot, número que
// ele não acha nessa forma ("no LID found ... from server") vai de novo na outra; `onNumero` recebe a forma que funcionou,
// para quem envia corrigir o contato (o telefone que veio de outro sistema pode estar na outra).
const naoAchouNoWhatsapp = (e: unknown) => /no LID found|not on whatsapp|not registered|does ?n[o']t exist/i.test(String((e as Error)?.message || ''))
export async function comOutraForma<T>(numero: string, enviar: (n: string) => Promise<T>, onNumero?: (n: string) => void): Promise<T> {
  try {
    return await enviar(numero)
  } catch (e) {
    const outra = phoneVariants(numero).find((v) => v !== numero)
    if (!outra || !naoAchouNoWhatsapp(e)) throw e
    const r = await enviar(outra)
    onNumero?.(outra)
    return r
  }
}

export async function http(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!r.ok) {
    const msg = json?.error?.message || json?.response?.message || json?.message || json?.error || `HTTP ${r.status}`
    const err = new Error(Array.isArray(msg) ? msg.join(', ') : String(msg)) as Error & { status?: number }
    err.status = r.status
    throw err
  }
  return json
}

/* ---------- Evolution API ---------- */
export const evoBase = (c: Creds) => (c.baseUrl || '').replace(/\/+$/, '')
export const evo = (c: Creds, method: string, path: string, body?: unknown) => http(method, `${evoBase(c)}${path}`, { apikey: c.apiKey }, body)

/* ---------- Envio ---------- */

// Retorna o id da mensagem no provedor (quando ele informa). `onNumero`: ver comOutraForma.
export async function sendText(provider: Provider, c: Creds, to: string, text: string, onNumero?: (n: string) => void): Promise<string | null> {
  if (provider === 'sandbox') return sandboxId()
  if (provider === 'instagram') return semRoboNoInstagram()
  const number = destination(to)
  if (provider === 'meta') {
    const j = await http('POST', `${GRAPH}/${c.phoneNumberId}/messages`, { Authorization: `Bearer ${c.accessToken}` }, {
      messaging_product: 'whatsapp', to: number, type: 'text', text: { body: text, preview_url: true },
    })
    return j.messages?.[0]?.id ?? null
  }
  if (provider === 'evolution') {
    const j = await evo(c, 'POST', `/message/sendText/${encodeURIComponent(c.instance)}`, { number, text })
    return j.key?.id ?? null
  }
  if (provider === 'uazapi') {
    const j = await http('POST', `${evoBase(c)}/send/text`, { token: c.token }, { number, text })
    return j.messageid ?? j.id ?? null
  }
  if (zapLike(provider)) return comOutraForma(number, (phone) => zapSend(c as unknown as ZapCreds, 'send-text', { phone, message: text }), onNumero)
  throw new Error('Provedor de WhatsApp desconhecido')
}

export const numberedMenu = (text: string, options: string[]) =>
  `${text}\n\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nResponda com o número da opção.`

// Menu: na Meta e no Zapbot vira botões (até 3) ou lista (até 10); nos outros provedores, texto numerado. No Z-API o corpo dos
// botões é outro (buttonActions/optionList) e eles não são confiáveis em API não oficial: lá vai o texto numerado.
export async function sendMenu(provider: Provider, c: Creds, to: string, text: string, options: string[]): Promise<{ id: string | null; shown: string }> {
  if (provider === 'meta' && options.length && options.length <= 10) {
    const interactive = options.length <= 3
      ? { type: 'button', body: { text }, action: { buttons: options.map((o, i) => ({ type: 'reply', reply: { id: `opt-${i}`, title: o.slice(0, 20) } })) } }
      : { type: 'list', body: { text }, action: { button: 'Ver opções', sections: [{ title: 'Opções', rows: options.map((o, i) => ({ id: `opt-${i}`, title: o.slice(0, 24) })) }] } }
    const j = await http('POST', `${GRAPH}/${c.phoneNumberId}/messages`, { Authorization: `Bearer ${c.accessToken}` }, {
      messaging_product: 'whatsapp', to: onlyDigits(to), type: 'interactive', interactive,
    })
    return { id: j.messages?.[0]?.id ?? null, shown: `${text}\n${options.map((o) => `▸ ${o}`).join('\n')}` }
  }
  if (provider === 'sandbox') return { id: sandboxId(), shown: numberedMenu(text, options) }
  // Instagram: até 3 opções viram botões; até 13, respostas rápidas (o toque volta com o id opt-N)
  if (provider === 'instagram') return semRoboNoInstagram()
  // Zapbot: até 3 opções viram botões; até 10, lista. A resposta volta no webhook com o id opt-N.
  if (provider === 'zapbot' && options.length && options.length <= 10) {
    const z = c as unknown as ZapCreds
    const shown = `${text}\n${options.map((o) => `▸ ${o}`).join('\n')}`
    const id = await comOutraForma(onlyDigits(to), (phone) => options.length <= 3
      ? zapSend(z, 'send-button-actions', { phone, message: text, buttons: options.map((o, i) => ({ type: 'REPLY', id: `opt-${i}`, label: o.slice(0, 20) })) })
      : zapSend(z, 'send-option-list', { phone, message: text, buttonText: 'Ver opções', sections: [{ title: 'Opções', rows: options.map((o, i) => ({ id: `opt-${i}`, title: o.slice(0, 24), description: '' })) }] }))
    return { id, shown }
  }
  const shown = numberedMenu(text, options)
  return { id: await sendText(provider, c, to, shown), shown }
}

/* ---------- Mídia e "digitando..." (agente de IA) ---------- */

export type MediaKind = 'image' | 'audio' | 'video' | 'document'
export type OutMedia = { kind: MediaKind; url: string; mime?: string; fileName?: string; caption?: string }

export const mediaKind = (mime = ''): MediaKind =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document'

// Limites do WhatsApp por tipo (em MB); documento fica no limite do bucket whatsapp-media (64 MB).
export const MEDIA_MAX_MB: Record<MediaKind, number> = { image: 5, video: 16, audio: 16, document: 64 }
// Formatos que a API oficial aceita como foto, vídeo e áudio (os outros provedores convertem sozinhos).
const META_FORMATS: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
}

// Como um arquivo enviado pelo painel vai para o WhatsApp: acima do limite do tipo, ou num formato que a API oficial
// não aceita, vai como documento (o cliente recebe o arquivo do mesmo jeito).
export function outgoingKind(provider: Provider | null, mime: string, bytes: number): MediaKind {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  const kind = mediaKind(base)
  // Instagram: formato ou tamanho fora do que a Meta aceita vira "document" (sendMedia recusa e quem chama manda o link)
  if (provider === 'instagram') {
    const k = igKind(base, bytes)
    return k === 'image' || k === 'video' || k === 'audio' ? k : 'document'
  }
  if (kind === 'document') return kind
  if (bytes > MEDIA_MAX_MB[kind] * 1024 * 1024) return 'document'
  if (provider === 'meta' && !META_FORMATS[kind].includes(base)) return 'document'
  return kind
}

// `url`: link público ou temporário (o provedor baixa de lá). Áudio chega como mensagem de voz. `onNumero`: ver comOutraForma.
export async function sendMedia(provider: Provider, c: Creds, to: string, m: OutMedia, onNumero?: (n: string) => void): Promise<string | null> {
  if (provider === 'sandbox') return sandboxId()
  if (provider === 'instagram') {
    semRoboNoInstagram()
    // Documento só PDF; o resto falha aqui e quem chama manda o link do arquivo como texto.
    const type = m.kind === 'document' ? (igKind(m.mime || '', 0) === 'file' ? 'file' : null) : m.kind
    if (!type) throw new Error('O Instagram só aceita PDF como arquivo')
    const id = await igSend(ig(c), to, { attachment: { url: m.url, type } })
    // O Instagram não tem legenda em anexo: o texto vai logo depois, numa mensagem própria
    if (m.caption) await igSend(ig(c), to, { text: m.caption })
    return id
  }
  const number = destination(to)
  if (zapLike(provider)) {
    const z = c as unknown as ZapCreds
    // documento: rota no padrão Z-API (send-document/<extensão>); quem chama manda o link se ela falhar
    const ext = (m.fileName?.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf'
    return comOutraForma(number, (phone) => {
      if (m.kind === 'image') return zapSend(z, 'send-image', { phone, image: m.url, ...(m.caption ? { caption: m.caption } : {}) })
      if (m.kind === 'video') return zapSend(z, 'send-video', { phone, video: m.url, ...(m.caption ? { caption: m.caption } : {}) })
      if (m.kind === 'audio') return zapSend(z, 'send-audio', { phone, audio: m.url })
      return zapSend(z, `send-document/${ext}`, { phone, document: m.url, fileName: m.fileName || `arquivo.${ext}`, ...(m.caption ? { caption: m.caption } : {}) })
    }, onNumero)
  }
  if (provider === 'meta') {
    const media: Record<string, string> = { link: m.url }
    if (m.caption && m.kind !== 'audio') media.caption = m.caption
    if (m.kind === 'document' && m.fileName) media.filename = m.fileName
    const j = await http('POST', `${GRAPH}/${c.phoneNumberId}/messages`, { Authorization: `Bearer ${c.accessToken}` }, {
      messaging_product: 'whatsapp', to: number, type: m.kind, [m.kind]: media,
    })
    return j.messages?.[0]?.id ?? null
  }
  if (provider === 'evolution') {
    const inst = encodeURIComponent(c.instance)
    const j = m.kind === 'audio'
      ? await evo(c, 'POST', `/message/sendWhatsAppAudio/${inst}`, { number, audio: m.url })
      : await evo(c, 'POST', `/message/sendMedia/${inst}`, { number, mediatype: m.kind, mimetype: m.mime, media: m.url, fileName: m.fileName, caption: m.caption })
    return j.key?.id ?? null
  }
  if (provider === 'uazapi') {
    const j = await http('POST', `${evoBase(c)}/send/media`, { token: c.token }, { number, type: m.kind === 'audio' ? 'ptt' : m.kind, file: m.url, text: m.caption, docName: m.fileName })
    return j.messageid ?? j.id ?? null
  }
  throw new Error('Provedor de WhatsApp desconhecido')
}

// "Digitando..." antes de responder (só o Zapbot tem; o Z-API não documenta send-presence). Falha aqui é ignorada: é só cortesia.
export async function sendTyping(provider: Provider, c: Creds, to: string, ms: number) {
  if (provider === 'instagram') return // sem robô no Instagram (Fase 1)
  if (provider !== 'zapbot') return
  try {
    await zapSend(c as unknown as ZapCreds, 'send-presence', { phone: onlyDigits(to), status: 'composing', duration: Math.max(0, Math.min(25_000, Math.round(ms))) })
  } catch { /* sem "digitando" */ }
}

// Template oficial (só Meta).
// - params: valores de {{1}}, {{2}}… do corpo, na ordem (a Meta recusa o envio se faltar algum)
// - header: arquivo do cabeçalho de mídia (o link público; a Meta baixa na hora do envio)
// - text: o corpo já preenchido. Nos outros provedores o envio cai para esse texto (ou o nome do template).
export type TemplateHeaderMedia = { format: string; link: string; filename?: string }
export async function sendTemplate(provider: Provider, c: Creds, to: string, name: string, language = 'pt_BR',
  opts: { params?: string[]; header?: TemplateHeaderMedia | null; text?: string } = {}): Promise<string | null> {
  const params = opts.params || []
  if (provider === 'instagram') throw new Error('Template é só do WhatsApp: no Instagram não existe')
  if (provider !== 'meta') return sendText(provider, c, to, opts.text || name)
  const template: Record<string, unknown> = { name, language: { code: language } }
  const components: unknown[] = []
  const h = opts.header
  if (h?.link) {
    const kind = h.format.toLowerCase() // image | video | document
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: { link: h.link, ...(kind === 'document' && h.filename ? { filename: h.filename } : {}) } }] })
  }
  if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) })
  if (components.length) template.components = components
  const j = await http('POST', `${GRAPH}/${c.phoneNumberId}/messages`, { Authorization: `Bearer ${c.accessToken}` }, {
    messaging_product: 'whatsapp', to: onlyDigits(to), type: 'template', template,
  })
  return j.messages?.[0]?.id ?? null
}

// Corpo do template com {{1}}, {{2}}… trocados pelos valores (o que o cliente recebe; vai para o histórico do chat)
export const templateText = (body: string, params: string[]) =>
  String(body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[Number(n) - 1] ?? m)

export async function metaPhoneInfo(c: Creds) {
  return http('GET', `${GRAPH}/${c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { Authorization: `Bearer ${c.accessToken}` })
}

/* ---------- HTTP utilitários ---------- */
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

export const randomToken = (bytes = 18) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

export const webhookUrl = (connectionId: string, token: string) =>
  `${Deno.env.get('SUPABASE_URL')}/functions/v1/whatsapp-webhook?c=${connectionId}&t=${token}`
