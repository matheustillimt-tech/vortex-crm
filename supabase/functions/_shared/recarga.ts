// Avisos de pagamento da Vórtex Pay já com a assinatura conferida: recarga de Créditos de IA e pagamento do plano
// (assinatura). Usado pelo creditos-webhook (aviso novo ou reenviado) e pelo creditos (superadmin: "Processar de novo").
// Os créditos só entram por ai_recharge_confirm (uma vez por recarga e por pedido) e o plano só ativa por
// plan_payment_confirm (uma vez por pagamento e por pedido), sempre com o valor conferido: no próprio aviso ou na API
// da Vórtex Pay. Sem conferir, o pedido fica em análise para o superadmin.
import { lerAviso, pedidoConfirmado, type Aviso } from './pagamento-vortexpay.ts'

// Endereço da sua Vórtex Pay (ex.: https://pay.seu-dominio.com.br) e a chave da API de integração dela. Sem o endereço,
// a API não é usada: o link fixo do pacote/plano continua funcionando e o valor é conferido só pelo aviso.
export const PAY_URL = (Deno.env.get('VORTEXPAY_URL') || '').replace(/\/$/, '')
export const PAY_KEY = () => (PAY_URL ? Deno.env.get('VORTEXPAY_API_KEY') || '' : '')

type Recarga = { id: string; ref: string; price_cents: number; status: string; buyer_email: string; created_at: string }
type Nome = { um: string; varios: string; nenhum: string }
const RECARGA: Nome = { um: 'recarga', varios: 'recargas', nenhum: 'nenhuma recarga' }
const PLANO: Nome = { um: 'cobrança do plano', varios: 'cobranças do plano', nenhum: 'nenhuma cobrança do plano' }

// Qual pedido este pagamento paga: o do código que foi no link; sem ele, o do e-mail de quem comprou (o aberto com o
// mesmo valor; sem valor no aviso, só se houver um só, para não pagar o pedido errado). nome: como o pedido aparece no
// motivo (recarga ou cobrança do plano).
export function escolherRecarga(aviso: { ref: string | null; email: string | null; valorCentavos: number | null }, porRef: Recarga | null, porEmail: Recarga[], nome: Nome = RECARGA): { recarga: Recarga | null; motivo?: string } {
  if (porRef) return { recarga: porRef }
  if (aviso.ref) return { recarga: null, motivo: `${nome.nenhum} com o código ${aviso.ref}` }
  if (!aviso.email) return { recarga: null, motivo: `o aviso não trouxe o código da ${nome.um} nem o e-mail do comprador` }
  const abertas = porEmail.filter((r) => ['pendente', 'em_analise', 'cancelada'].includes(r.status))
  const candidatas = aviso.valorCentavos != null ? abertas.filter((r) => r.price_cents === aviso.valorCentavos) : abertas
  if (aviso.valorCentavos != null && candidatas.length) return { recarga: [...candidatas].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] }
  if (candidatas.length === 1) return { recarga: candidatas[0] }
  if (!candidatas.length) return { recarga: null, motivo: `${nome.nenhum} aberta para ${aviso.email}${aviso.valorCentavos != null ? ' com esse valor' : ''}` }
  return { recarga: null, motivo: `${candidatas.length} ${nome.varios} abertas para ${aviso.email}: vincule à mão` }
}

// O aviso pago é do plano? Pelo produto do plano; se o plano e os créditos usarem o mesmo produto, decide o código que
// foi no link (AS... plano, CR... recarga) e, sem código, fica como recarga (como era antes do plano).
export function avisoDoPlano(aviso: { produto: string; ref: string | null }, produtoPlano: string | null | undefined, produtoCreditos: string | null | undefined): boolean {
  if (!produtoPlano || aviso.produto !== produtoPlano) return false
  if (aviso.ref) return aviso.ref.startsWith('AS')
  return produtoPlano !== produtoCreditos
}

async function conferirNaApi(pedido: string, minimo: number): Promise<string> {
  const key = PAY_KEY()
  if (!key) return 'sem_api'
  try {
    const r = await fetch(`${PAY_URL}/api/integracao/pedidos?q=${encodeURIComponent(pedido)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return `erro_api_${r.status}`
    return pedidoConfirmado((await r.json())?.pedidos, pedido, minimo)
  } catch (e) {
    return `erro_api: ${(e as Error).message}`
  }
}

const CONFERENCIA: Record<string, string> = {
  nao_pago: 'a Vórtex Pay não mostra o pedido como pago', valor_menor: 'o valor pago é menor que o do pedido',
  nao_achado: 'o pedido não apareceu na API da Vórtex Pay', sem_api: 'sem a chave da API da Vórtex Pay para conferir o valor',
}
const dataBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

type Fim = (status: string, reason: string, recharge_id?: string | null, plan_payment_id?: string | null) => Promise<{ status: string; reason: string }>

// Processa um aviso guardado em ai_payment_events e grava o desfecho nele.
export async function processarAviso(admin: any, ev: { id: string; payload: any }) {
  const aviso: Aviso = lerAviso(ev.payload)
  const fim: Fim = async (status, reason, recharge_id = null, plan_payment_id = null) => {
    await admin.from('ai_payment_events').update({ status, reason: reason.slice(0, 300), recharge_id, plan_payment_id, processed_at: new Date().toISOString() }).eq('id', ev.id)
    return { status, reason }
  }
  if (aviso.acao === 'invalido') return fim('invalido', aviso.motivo)
  if (aviso.acao === 'ignorar') return fim('ignorado', aviso.motivo)
  if (aviso.acao === 'estorno') {
    const { data: r, error } = await admin.rpc('ai_recharge_reverse', { p_order: aviso.pedido, p_reason: aviso.motivo, p_event: ev.id })
    if (error) return fim('erro', error.message)
    if (r?.motivo !== 'pedido_sem_recarga') return fim('estornado', aviso.motivo)
    const { data: p, error: e2 } = await admin.rpc('plan_payment_reverse', { p_order: aviso.pedido, p_reason: aviso.motivo, p_event: ev.id })
    if (e2) return fim('erro', e2.message)
    return p?.motivo === 'pedido_sem_pagamento' ? fim('ignorado', 'estorno de um pedido que não é recarga de créditos nem do plano') : fim('estornado', aviso.motivo)
  }

  const [{ data: cfg }, { data: plano }] = await Promise.all([
    admin.from('ai_billing_settings').select('vortexpay_product_id').eq('id', true).single(),
    admin.from('plan_settings').select('vortexpay_product_id').eq('id', true).maybeSingle(),
  ])
  if (avisoDoPlano(aviso, plano?.vortexpay_product_id, cfg?.vortexpay_product_id)) return processarPlano(admin, ev.id, aviso, fim)
  if (!cfg?.vortexpay_product_id || aviso.produto !== cfg.vortexpay_product_id) return fim('ignorado', `produto ${aviso.produto} não é o dos Créditos de IA nem o do plano`)
  const { data: ja } = await admin.from('ai_recharges').select('id, status').eq('order_id', aviso.pedido).maybeSingle()
  if (ja?.status === 'paga') return fim('creditado', 'pedido já creditado', ja.id)

  const cols = 'id, ref, price_cents, status, buyer_email, created_at'
  const { data: porRef } = aviso.ref ? await admin.from('ai_recharges').select(cols).eq('ref', aviso.ref).maybeSingle() : { data: null }
  const desde = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: porEmail } = !porRef && !aviso.ref && aviso.email
    ? await admin.from('ai_recharges').select(cols).eq('buyer_email', aviso.email).gte('created_at', desde).in('status', ['pendente', 'em_analise', 'cancelada'])
    : { data: [] }
  const { recarga, motivo } = escolherRecarga(aviso, porRef, porEmail ?? [])
  if (!recarga) return fim('sem_vinculo', motivo || 'recarga não encontrada')

  // valor: o do aviso, ou o pedido na API da Vórtex Pay
  const conf = aviso.valorCentavos != null ? (aviso.valorCentavos >= recarga.price_cents ? 'pago' : 'valor_menor') : await conferirNaApi(aviso.pedido, recarga.price_cents)
  if (conf !== 'pago') {
    const porque = CONFERENCIA[conf] || `não deu para conferir o pedido (${conf})`
    await admin.from('ai_recharges').update({ status: 'em_analise', note: `Pagamento em análise: ${porque}`, updated_at: new Date().toISOString() }).eq('id', recarga.id).in('status', ['pendente', 'cancelada'])
    return fim('em_analise', porque, recarga.id)
  }
  const { data: res, error } = await admin.rpc('ai_recharge_confirm', { p_recharge: recarga.id, p_order: aviso.pedido, p_event: ev.id, p_note: '' })
  if (error) return fim('erro', error.message, recarga.id)
  if (!res?.ok) return fim('erro', `não creditou: ${res?.motivo}`, recarga.id)
  return fim('creditado', res.repetida ? 'recarga já estava paga' : `${res.creditos} créditos`, recarga.id)
}

// Pagamento do plano: acha a cobrança (código do link ou e-mail), confere o valor e ativa a assinatura por um mês.
async function processarPlano(admin: any, eventId: string, aviso: Extract<Aviso, { acao: 'pago' }>, fim: Fim) {
  const { data: ja } = await admin.from('plan_payments').select('id, status').eq('order_id', aviso.pedido).maybeSingle()
  if (ja?.status === 'paga') return fim('ativado', 'pedido já ativou o plano', null, ja.id)

  const cols = 'id, ref, price_cents, status, buyer_email, created_at'
  const { data: porRef } = aviso.ref ? await admin.from('plan_payments').select(cols).eq('ref', aviso.ref).maybeSingle() : { data: null }
  const desde = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: porEmail } = !porRef && !aviso.ref && aviso.email
    ? await admin.from('plan_payments').select(cols).eq('buyer_email', aviso.email).gte('created_at', desde).in('status', ['pendente', 'em_analise', 'cancelada'])
    : { data: [] }
  const { recarga: pg, motivo } = escolherRecarga(aviso, porRef, porEmail ?? [], PLANO)
  if (!pg) return fim('sem_vinculo', motivo || 'cobrança do plano não encontrada')

  const conf = aviso.valorCentavos != null ? (aviso.valorCentavos >= pg.price_cents ? 'pago' : 'valor_menor') : await conferirNaApi(aviso.pedido, pg.price_cents)
  if (conf !== 'pago') {
    const porque = CONFERENCIA[conf] || `não deu para conferir o pedido (${conf})`
    await admin.from('plan_payments').update({ status: 'em_analise', note: `Pagamento em análise: ${porque}`, updated_at: new Date().toISOString() }).eq('id', pg.id).in('status', ['pendente', 'cancelada'])
    return fim('em_analise', porque, null, pg.id)
  }
  const { data: res, error } = await admin.rpc('plan_payment_confirm', { p_payment: pg.id, p_order: aviso.pedido, p_event: eventId, p_note: '' })
  if (error) return fim('erro', error.message, null, pg.id)
  if (!res?.ok) return fim('erro', `não ativou o plano: ${res?.motivo}`, null, pg.id)
  return fim('ativado', res.repetida ? 'plano já estava pago' : `plano ativo até ${dataBR(res.ate)}`, null, pg.id)
}
