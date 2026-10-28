// Mensagens que chegam do WhatsApp: normaliza o formato de cada provedor e grava contato, chat e mensagem.
import { onlyDigits, phoneVariants, type Creds, type Provider } from './whatsapp.ts'
import type { Ctx } from './flow.ts'
import { onContactMessage } from './triggers.ts'
import { pauseForHuman, scheduleReply } from './agent-core.ts'
import type { IgInbound } from './zernio.ts'
import { atualizarFoto } from './fotos.ts'
import { semCuringa } from './funil.ts'

// Trabalho que pode terminar depois da resposta ao provedor (foto do contato): no runtime da Supabase vai para o
// EdgeRuntime.waitUntil; fora dele (testes), só não é esperado.
const depois = (p: Promise<unknown>) => { try { (globalThis as any).EdgeRuntime?.waitUntil?.(p) } catch { /* sem runtime */ } }
const ECHO_WAIT_MS = 4000

export { phoneVariants }

export type Inbound = {
  phone: string
  name: string
  text: string
  waId: string | null
  fromMe: boolean
  type: string
  replyId?: string | null
  referral?: Record<string, string> | null
  media?: { url: string; mimeType?: string } | null
}

/* ---------- Cloud API da Meta ---------- */
export function parseMeta(body: any) {
  const messages: Inbound[] = []
  const statuses: { waId: string; status: string; error?: { code: number; title: string; details: string } | null }[] = []
  for (const e of body?.entry ?? []) {
    for (const ch of e.changes ?? []) {
      const v = ch.value || {}
      const names: Record<string, string> = Object.fromEntries((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]))
      for (const m of v.messages ?? []) {
        let text = ''
        let replyId: string | null = null
        if (m.type === 'text') text = m.text?.body
        else if (m.type === 'button') { text = m.button?.text; replyId = m.button?.payload ?? null }
        else if (m.type === 'interactive') { const r = m.interactive?.button_reply || m.interactive?.list_reply; text = r?.title; replyId = r?.id ?? null }
        else if (m.type === 'image') text = m.image?.caption || '📷 Imagem'
        else if (m.type === 'video') text = m.video?.caption || '🎥 Vídeo'
        else if (m.type === 'audio') text = '🎤 Áudio'
        else if (m.type === 'document') text = `📄 ${m.document?.filename || 'Documento'}`
        else if (m.type === 'sticker') text = '🔖 Figurinha'
        else if (m.type === 'location') text = '📍 Localização'
        else text = `[${m.type}]`
        const r = m.referral
        const referral = r ? { source_url: r.source_url, source_id: r.source_id, ctwa_clid: r.ctwa_clid, media_url: r.image_url || r.video_url, thumbnail_url: r.thumbnail_url } : null
        messages.push({ phone: m.from, name: names[m.from] || m.from, text: text || '', waId: m.id, fromMe: false, type: m.type, replyId, referral })
      }
      for (const s of v.statuses ?? []) {
        // entrega que falhou: a Meta manda o motivo em errors[0] (código, título e detalhe)
        const er = s.errors?.[0]
        const error = er ? { code: Number(er.code) || 0, title: String(er.title || ''), details: String(er.error_data?.details || er.message || '') } : null
        statuses.push({ waId: s.id, status: s.status, error })
      }
    }
  }
  return { messages, statuses }
}

/* ---------- Evolution API ---------- */
export function parseEvolution(body: any) {
  const ev = String(body?.event || '').toLowerCase().replace(/_/g, '.')
  if (ev === 'connection.update') return { messages: [] as Inbound[], state: body?.data?.state as string | undefined }
  if (ev !== 'messages.upsert') return { messages: [] as Inbound[] }
  const list = Array.isArray(body.data) ? body.data : body.data?.messages ?? [body.data]
  const messages: Inbound[] = []
  for (const d of list) {
    if (!d?.key) continue
    let jid: string = d.key.remoteJid || ''
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue // grupos e status ficam de fora
    if (jid.endsWith('@lid')) jid = d.key.senderPn || d.key.remoteJidAlt || d.senderPn || ''
    const phone = onlyDigits(jid.split('@')[0])
    if (!phone) continue
    const m = d.message || {}
    const text =
      m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
      m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || m.templateButtonReplyMessage?.selectedDisplayText ||
      (m.audioMessage ? '🎤 Áudio' : m.imageMessage ? '📷 Imagem' : m.videoMessage ? '🎥 Vídeo' : m.documentMessage ? '📄 Documento' : m.stickerMessage ? '🔖 Figurinha' : m.locationMessage ? '📍 Localização' : '')
    if (!text) continue
    messages.push({ phone, name: d.pushName || phone, text, waId: d.key.id ?? null, fromMe: !!d.key.fromMe, type: d.messageType || 'text', replyId: null, referral: null })
  }
  return { messages }
}

/* ---------- Zapbot ---------- */
const ZAP_MEDIA: [string, string, string, (b: any) => string][] = [
  ['image', 'imageUrl', 'image', (b) => b.caption || '📷 Imagem'],
  ['audio', 'audioUrl', 'audio', () => '🎤 Áudio'],
  ['video', 'videoUrl', 'video', (b) => b.caption || '🎥 Vídeo'],
  ['document', 'documentUrl', 'document', (b) => `📄 ${b.fileName || 'Documento'}`],
  ['sticker', 'stickerUrl', 'sticker', () => '🔖 Figurinha'],
]

export function parseZapbot(body: any) {
  const out = {
    messages: [] as Inbound[], statuses: [] as { waId: string; status: string }[],
    connected: null as null | { phone: string }, disconnected: null as null | { error: string },
  }
  if (!body || body.isTest) return out
  if (body.type === 'ConnectedCallback') {
    out.connected = { phone: onlyDigits(String(body.connectedPhone || body.phone || '')) }
    return out
  }
  // Z-API: o número caiu ou foi desvinculado (quem trata é o webhook, só para conexões "zapi")
  if (body.type === 'DisconnectedCallback') {
    out.disconnected = { error: String(body.error || '') }
    return out
  }
  // Zapbot manda messageId; o Z-API manda ids (um ou vários)
  if (body.type === 'MessageStatusCallback') {
    const status = String(body.status || '').toUpperCase()
    const ids = Array.isArray(body.ids) ? body.ids : body.messageId ? [body.messageId] : []
    for (const id of ids) if (id) out.statuses.push({ waId: String(id), status })
    return out
  }
  // só conversas 1:1 (grupos, listas de transmissão, status e canais ficam de fora)
  if (body.type !== 'ReceivedCallback' || body.isGroup || body.broadcast || body.isNewsletter || body.isStatusReply) return out
  const phone = onlyDigits(String(body.phone || ''))
  if (!phone) return out
  let text = ''
  let type = 'text'
  let replyId: string | null = null
  let media: Inbound['media'] = null
  const found = ZAP_MEDIA.find(([field, key]) => body[field]?.[key])
  if (body.text?.message) text = body.text.message
  else if (body.buttonsResponseMessage) { text = body.buttonsResponseMessage.message || ''; replyId = body.buttonsResponseMessage.buttonId ?? null }
  else if (body.listResponseMessage) { text = body.listResponseMessage.title || ''; replyId = body.listResponseMessage.selectedRowId ?? null }
  else if (found) {
    const [field, key, kind, label] = found
    type = kind
    text = label(body[field])
    media = { url: body[field][key], mimeType: body[field].mimeType }
  } else if (body.location) { type = 'location'; text = `📍 ${body.location.name || body.location.address || 'Localização'}` }
  else if (body.contact) { type = 'contact'; text = `👤 ${body.contact.displayName || 'Contato'}` }
  else if (body.reaction) { type = 'reaction'; text = `Reagiu com ${body.reaction.value || ''}` }
  else if (body.poll) { type = 'poll'; text = `📊 ${body.poll.question || 'Enquete'}` }
  else text = '[mensagem]'
  out.messages.push({ phone, name: body.senderName || body.chatName || phone, text, waId: body.messageId ?? null, fromMe: !!body.fromMe, type, replyId, referral: null, media })
  return out
}

// O Zapbot apaga a mídia em 24 h: baixa na hora e guarda no bucket privado whatsapp-media (<empresa>/<chat>/<arquivo>).
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'application/pdf': 'pdf' }
async function storeMedia(admin: any, companyId: string, chatId: string, messageId: string, media: NonNullable<Inbound['media']>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(media.url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`download HTTP ${res.status}`)
      if (+(res.headers.get('content-length') || 0) > 64 * 1024 * 1024) return console.error('mídia acima de 64 MB, não guardada')
      const type = (media.mimeType || res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
      let name = (new URL(media.url).pathname.split('/').pop() || 'arquivo').replace(/[^\w.-]/g, '_')
      if (!name.includes('.') && EXT[type]) name += '.' + EXT[type]
      const path = `${companyId}/${chatId}/${messageId}-${name}`
      const { error } = await admin.storage.from('whatsapp-media').upload(path, new Uint8Array(await res.arrayBuffer()), { contentType: type, upsert: true })
      if (error) throw error
      await admin.from('messages').update({ media_url: path }).eq('id', messageId)
      return
    } catch (e) {
      console.error('mídia: tentativa', attempt + 1, e)
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

// A conversa é sempre registrada (o webhook só chega aqui com Conexões liberado).
// Depois: fluxos (com o módulo Fluxos) têm prioridade; se nenhum fluxo cuidar da mensagem, o agente de IA da conversa
// responde, depois do tempo de agrupamento configurado nele.
export async function handleInbound(admin: any, conn: any, secret: { provider: Provider; credentials: Creds } | null, settings: Record<string, any>, m: Inbound, mods: Set<string>) {
  const companyId = conn.company_id
  // O que o próprio número envia volta por aqui, também quando quem enviou foi o sistema (painel, IA, fluxo), que grava a
  // mensagem com o mesmo wa_id logo depois da resposta do provedor. Espera esse registro antes de procurar o repetido.
  if (m.fromMe && m.waId) await new Promise((r) => setTimeout(r, ECHO_WAIT_MS))
  if (m.waId) {
    const { data: dup } = await admin.from('messages').select('id').eq('company_id', companyId).eq('wa_id', m.waId).maybeSingle()
    if (dup) return // já registrada (reenvio do provedor ou mensagem que nós mesmos enviamos)
  }

  const digits = onlyDigits(m.phone)
  let { data: contact } = await admin.from('contacts').select('*').eq('company_id', companyId).in('phone_digits', phoneVariants(digits)).order('created_at').limit(1).maybeSingle()
  const ref = m.referral ? Object.fromEntries(Object.entries(m.referral).filter(([, v]) => v)) : null
  const newContact = !contact
  if (!contact) {
    const { data, error } = await admin.from('contacts').insert({
      company_id: companyId, name: m.fromMe ? `+${digits}` : m.name, phone: `+${digits}`, status: 'lead',
      origin: ref ? 'Anúncio Meta' : 'WhatsApp', connection_id: conn.id, fields: ref || {},
    }).select('*').single()
    if (error) throw error
    contact = data
  } else if (ref) {
    const fields = { ...(contact.fields || {}), ...ref }
    await admin.from('contacts').update({ fields }).eq('id', contact.id)
    contact.fields = fields
  }

  let { data: chat } = await admin.from('chats').select('*').eq('company_id', companyId).eq('contact_id', contact.id).eq('connection_id', conn.id).order('last_message_at', { ascending: false }).limit(1).maybeSingle()
  let isNew = false
  const now = new Date().toISOString()
  if (!chat) {
    const { data, error } = await admin.from('chats').insert({ company_id: companyId, contact_id: contact.id, connection_id: conn.id, status: 'waiting', bot_active: true, last_message_at: now }).select('*').single()
    if (error) throw error
    chat = data
    isNew = true
  }

  const { data: saved, error: msgErr } = await admin.from('messages').insert({
    company_id: companyId, chat_id: chat.id, sender: m.fromMe ? 'agent' : 'contact', text: m.text, type: m.type === 'text' ? 'text' : m.type, wa_id: m.waId, delivery: 'sent', at: now,
    ...(m.fromMe ? { extra: { via: 'celular' } } : {}),
  }).select('id').single()
  if (msgErr) {
    if (msgErr.code === '23505') return
    throw msgErr
  }
  if (m.media && saved) await storeMedia(admin, companyId, chat.id, saved.id, m.media)

  // Foto de perfil (API Web): procura em segundo plano, no máximo a cada 7 dias por contato
  if (!m.fromMe && secret) depois(atualizarFoto(admin, contact, chat, secret))

  // Mensagem enviada pelo próprio celular da empresa: conta como resposta de atendente (e pausa a IA, se o agente
  // estiver configurado para parar quando um humano assumir). Eco de uma mensagem que a IA acabou de mandar não conta.
  if (m.fromMe) {
    await admin.from('chats').update({ last_message_at: now, answered: true }).eq('id', chat.id)
    const since = new Date(Date.now() - 120_000).toISOString()
    const { data: echo } = await admin.from('messages').select('id').eq('chat_id', chat.id).eq('sender', 'bot').eq('text', m.text).gte('at', since).limit(1)
    if (!echo?.length) await pauseForHuman(admin, chat, '👤 Mensagem enviada pelo celular da empresa. IA pausada nesta conversa.')
    return
  }

  // Conversa resolvida que volta: novo atendimento. A IA volta a valer (menos quando foi pausada à mão nesta conversa).
  const reopened = chat.status === 'resolved'
  const patch: Record<string, unknown> = { last_message_at: now, unread: (chat.unread || 0) + 1, answered: false, status: reopened ? 'waiting' : chat.status }
  if (reopened && chat.ai_paused && chat.ai_pause_reason !== 'manual') Object.assign(patch, { ai_paused: false, ai_pause_reason: null })
  await admin.from('chats').update(patch).eq('id', chat.id)
  Object.assign(chat, patch)
  if (!chat.bot_active) return

  if (mods.has('fluxos')) {
    // Gatilhos de mensagem (triggers.ts): continua o fluxo que esperava resposta ou começa o que combina com a mensagem.
    // Se der erro aqui, a mensagem segue para o agente de IA como se nenhum fluxo tivesse pegado.
    const ctx: Ctx = { admin, companyId, settings, chat, contact, provider: secret?.provider ?? null, creds: secret?.credentials ?? null, modules: mods }
    try {
      const took = await onContactMessage({ admin, companyId, settings, modules: mods }, ctx, {
        messageId: saved.id, text: m.text, replyId: m.replyId, connectionId: conn.id, newChat: isNew, newContact, reopened,
      })
      if (took) return
    } catch (e) {
      console.error('gatilhos de mensagem', chat.id, e)
    }
  } else if (chat.flow_state && Object.keys(chat.flow_state).length) {
    // módulo suspenso: nenhuma automação continua nem começa
    await admin.from('chats').update({ flow_state: {} }).eq('id', chat.id)
    chat.flow_state = {}
  }

  // Nenhum fluxo cuidou da mensagem: o agente de IA da conversa responde (se houver e estiver ativo).
  const r = await scheduleReply(admin, chat, contact, mods)
  if (!r.scheduled && r.why && !/nenhum agente|módulo/.test(r.why)) console.log('IA não agendada', chat.id, r.why)
}

/* ---------- Instagram (Zernio) ---------- */

// Mensagem do Direct (message.received ou message.sent). O contato é achado pelo id do Instagram, não por telefone,
// e a conversa pelo id da conversa na Zernio (chats.external_id), que é o destino das respostas.
// Fase 1: só registra e entrega para o atendimento humano. Fluxos e agente de IA no Instagram entram na Fase 2.
export async function handleInstagramInbound(admin: any, conn: any, m: IgInbound, secret: { provider: string; credentials: any } | null = null) {
  const companyId = conn.company_id
  const ids = [m.messageId, m.platformMessageId].filter(Boolean) as string[]
  const { data: dup } = await admin.from('messages').select('id').eq('company_id', companyId).in('wa_id', ids).limit(1)
  if (dup?.length) return 'duplicate' // reenvio da Zernio ou eco do que nós mesmos enviamos

  let { data: contact } = await admin.from('contacts').select('*').eq('company_id', companyId).eq('instagram_id', m.igUserId).maybeSingle()
  // Contato que nasceu no funil pelo @ (registro da automação de comentário, sem o id do Direct): liga pelo @
  if (!contact && m.username) {
    const { data: porArroba } = await admin.from('contacts').select('*').eq('company_id', companyId).ilike('instagram_username', semCuringa(m.username)).is('instagram_id', null).limit(1)
    if (porArroba?.[0]) {
      contact = { ...porArroba[0], instagram_id: m.igUserId }
      await admin.from('contacts').update({ instagram_id: m.igUserId, connection_id: porArroba[0].connection_id || conn.id }).eq('id', contact.id)
    }
  }
  if (!contact) {
    const { data, error } = await admin.from('contacts').insert({
      company_id: companyId, name: m.name || (m.username ? `@${m.username}` : 'Instagram'), phone: '', status: 'lead', origin: 'Instagram',
      connection_id: conn.id, instagram_id: m.igUserId, instagram_username: m.username || null, instagram_profile: m.igProfile,
      extra: m.picture ? { avatar: m.picture } : {},
    }).select('*').single()
    if (error) {
      if (error.code !== '23505') throw error
      // a mesma pessoa mandou duas mensagens ao mesmo tempo: fica o contato que gravou primeiro
      contact = (await admin.from('contacts').select('*').eq('company_id', companyId).eq('instagram_id', m.igUserId).single()).data
    } else contact = data
  } else if (!m.fromMe && (m.igProfile || (m.username && m.username !== contact.instagram_username))) {
    const patch: Record<string, unknown> = {}
    if (m.igProfile) patch.instagram_profile = m.igProfile
    if (m.username) patch.instagram_username = m.username
    await admin.from('contacts').update(patch).eq('id', contact.id)
  }

  let { data: chat } = await admin.from('chats').select('*').eq('connection_id', conn.id).eq('external_id', m.conversationId).maybeSingle()
  const now = new Date().toISOString()
  if (!chat) {
    const { data, error } = await admin.from('chats').insert({
      company_id: companyId, contact_id: contact.id, connection_id: conn.id, external_id: m.conversationId,
      status: 'waiting', bot_active: false, last_message_at: now,
    }).select('*').single()
    if (error) {
      if (error.code !== '23505') throw error
      chat = (await admin.from('chats').select('*').eq('connection_id', conn.id).eq('external_id', m.conversationId).single()).data
    } else chat = data
  }

  // Mensagem que saiu pela conta e não está aqui: ou é eco de um envio nosso cujo id veio diferente (mesmo texto há
  // pouco), ou alguém respondeu pelo app do Instagram.
  if (m.fromMe) {
    const since = new Date(Date.now() - 120_000).toISOString()
    const { data: echo } = await admin.from('messages').select('id').eq('chat_id', chat.id).in('sender', ['agent', 'bot']).eq('text', m.text).gte('at', since).limit(1)
    if (echo?.length) return 'echo'
  }

  const { data: saved, error: msgErr } = await admin.from('messages').insert({
    company_id: companyId, chat_id: chat.id, sender: m.fromMe ? 'agent' : 'contact', text: m.text, type: m.type, wa_id: m.messageId,
    delivery: 'sent', at: now, extra: { channel: 'instagram', ...(m.replyId ? { replyId: m.replyId } : {}), ...(m.fromMe ? { via: 'app do Instagram' } : {}) },
  }).select('id').single()
  if (msgErr) {
    if (msgErr.code === '23505') return 'duplicate'
    throw msgErr
  }
  // O link do Instagram expira: a mídia é baixada na hora para o bucket privado
  if (m.media && saved) await storeMedia(admin, companyId, chat.id, saved.id, m.media)

  if (m.fromMe) {
    await admin.from('chats').update({ last_message_at: now, answered: true }).eq('id', chat.id)
    await pauseForHuman(admin, chat, '👤 Mensagem enviada pelo app do Instagram. IA pausada nesta conversa.').catch((e) => console.error('pausa da IA', e))
    return 'ok'
  }

  const reopened = chat.status === 'resolved'
  await admin.from('chats').update({
    last_message_at: now, unread: (chat.unread || 0) + 1, answered: false, status: reopened ? 'waiting' : chat.status,
  }).eq('id', chat.id)
  // Foto de perfil: a Meta só libera depois que a pessoa escreve, então procura aqui (no máximo a cada 7 dias)
  if (secret) depois(atualizarFoto(admin, contact, chat, secret))
  return 'ok'
}
