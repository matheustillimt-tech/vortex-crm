// Avisos das plataformas de pagamento → evento normalizado para public.intel_ingest. Puro (testado em
// supabase/tests/inteligencia.test.ts). Formatos reconhecidos, pelo próprio corpo (o cliente não configura nada):
// - Kiwify (webhook_event_type em inglês: order_approved, pix_created, order_rejected, order_refunded, chargeback,
//   billet_created; carrinho abandonado com status "abandoned") e a Vórtex Pay, no mesmo formato com os nomes em
//   português (compra_aprovada, pix_gerado, compra_recusada, compra_reembolsada, carrinho_abandonado).
//   Datas sem fuso ("2026-10-26 20:02", "28/10/2026 20:02") são do horário de Brasília. Valor em centavos em
//   Commissions.charge_amount.
// - Hotmart (event PURCHASE_*, data.purchase / data.buyer / data.product; valor em reais).
// - Vórtex Call (evento "comprou" com venda { pedido, valor, produto, comprada_em } e lead { nome, email, telefone }).
// O resto (formulários, agendamentos) não é pagamento e devolve null.

export type EventoPagamento = {
  fonte: string
  evento: 'compra_aprovada' | 'pix_gerado' | 'boleto_gerado' | 'pagamento_recusado' | 'reembolso' | 'chargeback' | 'carrinho_abandonado' | 'cancelado' | 'expirado'
  dedupe: string
  pedido: string
  tipo: 'pedido' | 'carrinho'
  status: 'abandonado' | 'pendente' | 'expirado' | 'recusado' | 'cancelado' | 'pago' | 'reembolsado' | 'chargeback'
  metodo: string
  valorCentavos: number | null
  moeda: string
  quando: string
  pixExpiraEm?: string | null
  tentativa?: string
  motivo?: string
  cliente: { email?: string; telefone?: string; nome?: string }
  produto: { id?: string; nome?: string }
}

const txt = (v: unknown) => (v == null ? '' : String(v)).trim()

// Data do aviso: ISO com fuso; "AAAA-MM-DD HH:MM[:SS]" ou "DD/MM/AAAA HH:MM" sem fuso = Brasília (-03:00); número = ms.
export function dataDoAviso(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString()
  const s = txt(v)
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(s)
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}-03:00`).toISOString()
  m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}-03:00`).toISOString()
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// Valor em reais ("1.997,00", "1997.00", 1997) → centavos
export function reaisParaCentavos(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null
  let s = txt(v).replace(/[^\d,.-]/g, '')
  if (!s) return null
  if (s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

const centavos = (v: unknown): number | null => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

export function metodoDe(v: unknown): string {
  const s = txt(v).toLowerCase()
  if (!s) return ''
  if (s.includes('pix')) return 'pix'
  if (s.includes('credit') || s.includes('cart') || s.includes('card')) return 'cartao'
  if (s.includes('billet') || s.includes('boleto') || s.includes('bank_slip')) return 'boleto'
  return 'outro'
}

const KIWI: Record<string, [EventoPagamento['evento'], EventoPagamento['status']]> = {
  order_approved: ['compra_aprovada', 'pago'], compra_aprovada: ['compra_aprovada', 'pago'], subscription_renewed: ['compra_aprovada', 'pago'],
  order_rejected: ['pagamento_recusado', 'recusado'], compra_recusada: ['pagamento_recusado', 'recusado'],
  order_refunded: ['reembolso', 'reembolsado'], compra_reembolsada: ['reembolso', 'reembolsado'],
  chargeback: ['chargeback', 'chargeback'],
  pix_created: ['pix_gerado', 'pendente'], pix_gerado: ['pix_gerado', 'pendente'],
  billet_created: ['boleto_gerado', 'pendente'], boleto_gerado: ['boleto_gerado', 'pendente'],
  carrinho_abandonado: ['carrinho_abandonado', 'abandonado'], abandoned_cart: ['carrinho_abandonado', 'abandonado'],
}
const KIWI_STATUS: Record<string, [EventoPagamento['evento'], EventoPagamento['status']]> = {
  paid: ['compra_aprovada', 'pago'], approved: ['compra_aprovada', 'pago'], refused: ['pagamento_recusado', 'recusado'],
  refunded: ['reembolso', 'reembolsado'], chargedback: ['chargeback', 'chargeback'],
}
const PT = new Set(['compra_aprovada', 'compra_recusada', 'compra_reembolsada', 'pix_gerado', 'boleto_gerado', 'carrinho_abandonado'])

function kiwify(b: any): EventoPagamento | null {
  const tipoEv = txt(b?.webhook_event_type).toLowerCase()
  // carrinho abandonado: corpo próprio, sem webhook_event_type
  if ((!tipoEv && txt(b?.status).toLowerCase() === 'abandoned' && (b?.checkout_link || b?.product_id)) || tipoEv === 'carrinho_abandonado' || tipoEv === 'abandoned_cart') {
    const id = txt(b?.id || b?.cart_id || b?.order_id)
    if (!id) return null
    const fonte = tipoEv === 'carrinho_abandonado' ? 'vortexpay' : 'kiwify'
    return {
      fonte, evento: 'carrinho_abandonado', dedupe: `${fonte}:carrinho:${id}`, pedido: id, tipo: 'carrinho', status: 'abandonado', metodo: '',
      valorCentavos: reaisParaCentavos(b?.price ?? b?.amount ?? null), moeda: 'BRL', quando: dataDoAviso(b?.created_at) || new Date().toISOString(),
      cliente: { email: txt(b?.email || b?.Customer?.email), telefone: txt(b?.phone || b?.Customer?.mobile), nome: txt(b?.name || b?.Customer?.full_name) },
      produto: { id: txt(b?.product_id || b?.Product?.product_id), nome: txt(b?.product_name || b?.Product?.product_name) },
    }
  }
  const map = KIWI[tipoEv] || (!tipoEv ? KIWI_STATUS[txt(b?.order_status).toLowerCase()] : null)
  if (!map) return null
  const pedido = txt(b?.order_id || b?.order_ref)
  if (!pedido) return null
  const [evento, status] = map
  const metodo = metodoDe(b?.payment_method) || (evento === 'pix_gerado' ? 'pix' : evento === 'boleto_gerado' ? 'boleto' : '')
  const c = b?.Customer || {}
  const fonte = PT.has(tipoEv) ? 'vortexpay' : 'kiwify'
  const quando = dataDoAviso(evento === 'compra_aprovada' ? b?.approved_date || b?.updated_at : evento === 'reembolso' || evento === 'chargeback' ? b?.refunded_at || b?.updated_at : b?.updated_at || b?.created_at)
    || dataDoAviso(b?.created_at) || new Date().toISOString()
  const valor = centavos(b?.Commissions?.charge_amount) ?? centavos(b?.Commissions?.product_base_price)
  const ultimos = txt(b?.card_last4digits)
  // tentativa: um Pix (ou boleto) por pedido; cada cartão recusado é uma tentativa
  const tentativa = metodo === 'pix' ? 'pix' : metodo === 'boleto' ? 'boleto' : metodo === 'cartao'
    ? `cartao:${ultimos || '?'}${evento === 'pagamento_recusado' ? `:${txt(b?.updated_at) || quando}` : ''}` : metodo || undefined
  return {
    fonte, evento, status, pedido, tipo: 'pedido', metodo, valorCentavos: valor, moeda: txt(b?.Commissions?.currency) || 'BRL', quando,
    dedupe: `${fonte}:${evento}:${pedido}${evento === 'pagamento_recusado' ? `:${txt(b?.updated_at)}:${ultimos}` : evento === 'pix_gerado' ? `:${txt(b?.pix_expiration)}` : ''}`,
    pixExpiraEm: dataDoAviso(b?.pix_expiration), tentativa, motivo: txt(b?.card_rejection_reason) || undefined,
    cliente: { email: txt(c.email), telefone: txt(c.mobile || c.phone), nome: txt(c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ')) },
    produto: { id: txt(b?.Product?.product_id), nome: txt(b?.Product?.product_name) },
  }
}

const HOTMART: Record<string, [EventoPagamento['evento'], EventoPagamento['status']]> = {
  PURCHASE_APPROVED: ['compra_aprovada', 'pago'], PURCHASE_COMPLETE: ['compra_aprovada', 'pago'],
  PURCHASE_CANCELED: ['pagamento_recusado', 'recusado'], PURCHASE_REFUNDED: ['reembolso', 'reembolsado'],
  PURCHASE_CHARGEBACK: ['chargeback', 'chargeback'], PURCHASE_BILLET_PRINTED: ['boleto_gerado', 'pendente'],
  PURCHASE_EXPIRED: ['expirado', 'expirado'], PURCHASE_OUT_OF_SHOPPING_CART: ['carrinho_abandonado', 'abandonado'],
}

function hotmart(b: any): EventoPagamento | null {
  const ev = txt(b?.event).toUpperCase()
  const map = HOTMART[ev]
  if (!map || typeof b?.data !== 'object') return null
  const d = b.data || {}
  const p = d.purchase || {}
  const [evento, status] = map
  const carrinho = evento === 'carrinho_abandonado'
  const pedido = txt(p.transaction || (carrinho ? b?.id : ''))
  if (!pedido) return null
  const metodo = metodoDe(p.payment?.type)
  const valor = reaisParaCentavos(p.price?.value ?? p.full_price?.value ?? p.value ?? null)
  const quando = dataDoAviso(evento === 'compra_aprovada' ? p.approved_date ?? b?.creation_date : b?.creation_date ?? p.order_date) || new Date().toISOString()
  const fone = txt(d.buyer?.checkout_phone || d.buyer?.phone || [d.buyer?.checkout_phone_code, d.buyer?.checkout_phone].filter(Boolean).join(''))
  return {
    fonte: 'hotmart', evento, status, pedido, tipo: carrinho ? 'carrinho' : 'pedido', metodo, valorCentavos: valor,
    moeda: txt(p.price?.currency_value) || 'BRL', quando,
    dedupe: `hotmart:${evento}:${pedido}${b?.id ? `:${txt(b.id)}` : ''}`,
    tentativa: carrinho ? undefined : metodo === 'pix' ? 'pix' : metodo === 'boleto' ? 'boleto' : metodo ? `${metodo}:${txt(b?.id) || quando}` : undefined,
    cliente: { email: txt(d.buyer?.email), telefone: fone, nome: txt(d.buyer?.name) },
    produto: { id: txt(d.product?.id), nome: txt(d.product?.name) },
  }
}

function vortexCall(b: any): EventoPagamento | null {
  if (txt(b?.evento) !== 'comprou' || typeof b?.venda !== 'object') return null
  const v = b.venda || {}
  const pedido = txt(v.pedido || b?.id_evento)
  if (!pedido) return null
  const l = b.lead || {}
  return {
    fonte: 'vortexcall', evento: 'compra_aprovada', status: 'pago', pedido, tipo: 'pedido', metodo: metodoDe(v.metodo || v.pagamento),
    valorCentavos: reaisParaCentavos(v.valor), moeda: 'BRL', quando: dataDoAviso(v.comprada_em || b?.enviado_em) || new Date().toISOString(),
    dedupe: `vortexcall:compra_aprovada:${pedido}`,
    cliente: { email: txt(l.email), telefone: txt(l.whatsapp || l.telefone), nome: txt(l.nome) },
    produto: { id: txt(v.produto_id || v.produto), nome: txt(v.produto) },
  }
}

export function lerPagamento(corpo: unknown): EventoPagamento | null {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return null
  const b = corpo as any
  if (b.webhook_event_type || b.order_status || (b.status && b.checkout_link)) return kiwify(b)
  if (typeof b.event === 'string' && b.event.toUpperCase().startsWith('PURCHASE_')) return hotmart(b)
  if (b.evento === 'comprou') return vortexCall(b)
  return null
}

// Registra o aviso (se for pagamento). Nunca lança: a coleta não pode atrapalhar o webhook nem o fluxo.
export async function registrarPagamento(admin: any, companyId: string, corpo: unknown, contatoId?: string | null) {
  try {
    const ev = lerPagamento(corpo)
    if (!ev) return null
    const { data, error } = await admin.rpc('intel_ingest', { p_company: companyId, p: { ...ev, ...(contatoId ? { contatoId } : {}) } })
    if (error) console.error('intel_ingest', error.message)
    return data ?? null
  } catch (e) {
    console.error('registrarPagamento', e)
    return null
  }
}
