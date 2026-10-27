// Regras puras do rotacionador (função rotacionador). A roda em si (qual é a vez) fica no banco: rotator_hit.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/

// Endereço do link como o banco guarda: minúsculo, sem acento, espaço vira hífen. '' quando não serve.
export function slugOf(s: unknown) {
  const v = String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return SLUG_RE.test(v) ? v : ''
}

const digits = (s: unknown) => String(s || '').replace(/\D/g, '')

// Números no ar, na ordem da roda: conectados, de WhatsApp (Instagram não tem wa.me) e com número de verdade.
// Conexão excluída que ficou na lista some aqui.
export function numerosNoAr(ids: string[] | null | undefined, conns: any[]) {
  const byId = new Map(conns.map((c) => [c.id, c]))
  return (ids || []).map((id) => byId.get(id)).filter((c) => c && c.status === 'connected' && c.provider !== 'instagram' && digits(c.number).length >= 10)
}

export function waLink(number: string, message?: string) {
  const text = String(message || '').trim()
  return `https://wa.me/${digits(number)}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

// Quem abre o link sem ser uma pessoa: a prévia do link no WhatsApp, Telegram, Facebook e afins. Não anda a roda.
export const isPreviewBot = (ua: string | null | undefined) =>
  !ua || /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|curl|wget|headless/i.test(ua)
