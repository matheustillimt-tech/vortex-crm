// Foto de perfil dos contatos.
// - WhatsApp pela API Web (Zapbot): POST /contact-picture. A API Oficial da Meta não entrega foto de contato.
// - Instagram (Zernio): participantPicture da conversa. A Meta só libera a foto de quem já mandou mensagem.
// O link das duas expira em horas: baixa na hora e guarda no bucket público "avatares". Procura de novo a cada 7 dias.
import { zernio, type IgCreds } from './zernio.ts'

export const BUCKET = 'avatares'
export const DIAS_PARA_PROCURAR_DE_NOVO = 7
const MAX_BYTES = 5 * 1024 * 1024
const TIPOS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Já procurou há pouco (com ou sem foto)? */
export const procurouHaPouco = (avatarAt: string | null | undefined, agora = Date.now()) =>
  !!avatarAt && agora - Date.parse(avatarAt) < DIAS_PARA_PROCURAR_DE_NOVO * 86_400_000

export async function linkFotoWhatsapp(c: Record<string, string>, phone: string): Promise<string | null> {
  const r = await fetch(`${c.baseUrl}/instances/${c.instanceId}/token/${c.instanceToken}/contact-picture`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Client-Token': c.clientToken },
    body: JSON.stringify({ phone: String(phone || '').replace(/\D/g, ''), preview: false }), signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => ({}))
  return j?.hasPicture && typeof j.url === 'string' && j.url.startsWith('https://') ? j.url : null
}

export async function linkFotoInstagram(c: IgCreds, conversationId: string): Promise<string | null> {
  if (!conversationId || !c?.accountId) return null
  const j = await zernio('GET', `/inbox/conversations/${encodeURIComponent(conversationId)}?accountId=${encodeURIComponent(c.accountId)}`, undefined, {}, c.apiKey || undefined)
  const conv = j?.data ?? j?.conversation ?? j
  const url = conv?.participantPicture
  return typeof url === 'string' && url.startsWith('https://') ? url : null
}

/** Baixa e guarda; devolve o link público (ou null se não for imagem ou passar de 5 MB). */
export async function guardarFoto(admin: any, companyId: string, contactId: string, url: string): Promise<string | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) return null
  const tipo = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase()
  if (!TIPOS[tipo]) return null
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_BYTES) return null
  const path = `${companyId}/${contactId}-${Date.now()}.${TIPOS[tipo]}`
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: tipo, upsert: true })
  if (error) throw error
  return admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/**
 * Procura e guarda a foto do contato pela conexão da conversa. Marca avatar_at mesmo sem foto (não procura de novo por 7 dias).
 * `forcar` ignora o prazo. Nunca lança: foto é só enfeite.
 */
export async function atualizarFoto(admin: any, contact: any, chat: { external_id?: string | null } | null, secret: { provider: string; credentials: any } | null, forcar = false) {
  try {
    if (!contact?.id || !secret || (!forcar && procurouHaPouco(contact.avatar_at))) return contact?.avatar_url ?? null
    let link: string | null = null
    if (secret.provider === 'zapbot' && contact.phone) link = await linkFotoWhatsapp(secret.credentials, contact.phone)
    else if (secret.provider === 'instagram' && chat?.external_id) link = await linkFotoInstagram(secret.credentials, chat.external_id)
    else if (secret.provider !== 'zapbot' && secret.provider !== 'instagram') return contact.avatar_url ?? null // Meta/Evolution/sandbox: sem foto
    const salvo = link ? await guardarFoto(admin, contact.company_id, contact.id, link) : null
    const patch: Record<string, unknown> = { avatar_at: new Date().toISOString() }
    if (salvo) patch.avatar_url = salvo
    await admin.from('contacts').update(patch).eq('id', contact.id)
    return salvo ?? contact.avatar_url ?? null
  } catch (e) {
    console.error('foto do contato', contact?.id, e instanceof Error ? e.message : e)
    return contact?.avatar_url ?? null
  }
}
