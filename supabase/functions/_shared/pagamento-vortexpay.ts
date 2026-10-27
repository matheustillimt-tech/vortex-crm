// Vórtex Pay (checkout aberto do Grupo Vórtex, endereço em VORTEXPAY_URL), na recarga de Créditos de IA e no pagamento do plano. Regras
// puras (sem banco e sem rede), com testes em supabase/tests/creditos.test.ts.
// - Aviso no formato da Kiwify (webhook_event_type, order_id, order_status, Product, Customer), eventos em português,
//   assinado com HMAC-SHA256 do corpo no cabeçalho X-Webhook-Signature (o "Secret HMAC" do webhook na Vórtex Pay).
// - Oferta: POST /api/integracao/ofertas { produtoId, valorCentavos, autor } → { url }. Conferência do pedido:
//   GET /api/integracao/pedidos?q=<pedido> → { pedidos: [{ status: 'paid' | ..., totalCentavos, email, ... }] }.

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

async function hmac(segredo: string, dados: Uint8Array) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', chave, dados as BufferSource))
}
function igual(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// X-Webhook-Signature: 64 caracteres hex, com ou sem "sha256=". null = ausente ou fora do formato.
export function assinaturaDoCabecalho(valor: string | null | undefined): string | null {
  const h = String(valor || '').trim().replace(/^sha256=/i, '')
  return /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null
}

// HMAC-SHA256 dos bytes exatos recebidos; se não bater, do JSON reescrito (como a Kiwify às vezes assina).
export async function assinaturaConfere(bytes: Uint8Array, cabecalho: string | null | undefined, segredo: string | null | undefined): Promise<boolean> {
  const assinatura = assinaturaDoCabecalho(cabecalho)
  if (!assinatura || !segredo) return false
  if (igual(await hmac(segredo, bytes), assinatura)) return true
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return igual(await hmac(segredo, new TextEncoder().encode(JSON.stringify(JSON.parse(texto)))), assinatura)
  } catch {
    return false
  }
}

const obj = (v: unknown): Record<string, any> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : null)
const txt = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)
const CODIGO = /^[A-Za-z0-9_-]{1,120}$/
const codigo = (v: unknown) => { const t = txt(v, 120); return t && CODIGO.test(t) ? t : null }
const REF = /^(CR|AS)[0-9A-F]{12}$/

// Código que foi no link (?src= / ?sck=) e volta nos parâmetros de rastreio, quando a Vórtex Pay devolve: CR... é
// recarga de Créditos de IA, AS... é pagamento do plano (assinatura).
export function refDoAviso(corpo: unknown): string | null {
  const r = obj(corpo)
  if (!r) return null
  const t = obj(r.TrackingParameters) || obj(r.tracking) || obj(r.utm) || {}
  for (const v of [t.src, t.sck, t.utm_content, t.utm_term, r.src, r.sck, r.ref, obj(r.metadata)?.ref]) {
    const s = typeof v === 'string' ? v.trim().toUpperCase() : ''
    if (REF.test(s)) return s
  }
  return null
}

// Valor pago em centavos, só dos campos que se sabe que vêm em centavos. null = o aviso não diz (confere na API).
export function valorDoAviso(corpo: unknown): number | null {
  const r = obj(corpo)
  if (!r) return null
  for (const v of [obj(r.Commissions)?.charge_amount, r.totalCentavos, r.valorCentavos, r.total_centavos]) {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n
  }
  return null
}

export type Aviso =
  | { acao: 'pago'; pedido: string; produto: string; email: string | null; ref: string | null; valorCentavos: number | null }
  | { acao: 'estorno'; pedido: string; motivo: string }
  | { acao: 'ignorar'; motivo: string; pedido?: string | null }
  | { acao: 'invalido'; motivo: string }

const ESTORNO_EVENTO: Record<string, string> = { compra_reembolsada: 'Reembolso na Vórtex Pay', chargeback: 'Chargeback na Vórtex Pay' }
const ESTORNO_STATUS: Record<string, string> = { refunded: 'Reembolso na Vórtex Pay', chargedback: 'Chargeback na Vórtex Pay' }

// Só serve para decidir algo DEPOIS da assinatura conferida.
export function lerAviso(corpo: unknown): Aviso {
  const r = obj(corpo)
  if (!r) return { acao: 'invalido', motivo: 'O aviso não veio em JSON.' }
  const evento = txt(r.webhook_event_type, 60)
  const status = txt(r.order_status, 60)
  const pedido = codigo(r.order_id)
  // botão "Testar" da Vórtex Pay: pedido test_... com comprador de exemplo. Prova que chega; não credita.
  if (pedido?.startsWith('test_')) return { acao: 'ignorar', motivo: 'aviso de teste da Vórtex Pay (botão Testar)', pedido }
  const estorno = (evento && ESTORNO_EVENTO[evento]) || (status && ESTORNO_STATUS[status]) || null
  if (estorno) return pedido ? { acao: 'estorno', pedido, motivo: estorno } : { acao: 'invalido', motivo: 'O aviso veio sem o código do pedido.' }
  if (evento !== 'compra_aprovada' || status !== 'paid') return { acao: 'ignorar', motivo: `evento ${evento || '?'} / ${status || '?'}`, pedido }
  if (!pedido) return { acao: 'invalido', motivo: 'O aviso veio sem o código do pedido.' }
  const produto = codigo(obj(r.Product)?.product_id)
  if (!produto) return { acao: 'invalido', motivo: 'O aviso veio sem o código do produto.' }
  const email = txt(obj(r.Customer)?.email, 254)?.toLowerCase() ?? null
  return { acao: 'pago', pedido, produto, email, ref: refDoAviso(r), valorCentavos: valorDoAviso(r) }
}

// O pedido na lista da API (/api/integracao/pedidos?q=<pedido>) está pago com pelo menos o valor da recarga?
export function pedidoConfirmado(lista: unknown, pedido: string, minimoCentavos: number): 'pago' | 'nao_pago' | 'valor_menor' | 'nao_achado' {
  const itens = Array.isArray(lista) ? lista : []
  const p = itens.map(obj).find((x) => x && [x.id, x.pedido, x.codigo, x.orderId, x.order_id, x.ref].some((v) => typeof v === 'string' && v === pedido))
  if (!p) return 'nao_achado'
  if (p.status !== 'paid') return 'nao_pago'
  return Number(p.totalCentavos) >= minimoCentavos ? 'pago' : 'valor_menor'
}

// Link da oferta com o código da recarga nos parâmetros de rastreio (volta no aviso, se a Vórtex Pay devolver).
export function linkComRef(url: string, ref: string) {
  try {
    const u = new URL(url)
    for (const k of ['src', 'sck', 'utm_content']) u.searchParams.set(k, ref)
    return u.toString()
  } catch {
    return url
  }
}
