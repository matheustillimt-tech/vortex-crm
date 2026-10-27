// Assinatura do plano (migration 0033): o cliente paga a oferta do plano na Vórtex Pay e o plano ativa sozinho quando o
// aviso de pagamento confirmar (creditos-webhook → plan_payment_confirm), por um mês a cada pagamento.
// Banco real: plan_settings, plan_payments e a função assinatura. Modo demonstração: ativa na hora.
import { BACKEND, supabase } from './supabase'
import { callFn, fetchRows, fromRow } from './backend'
import { useDB } from './store'

// Plano à venda enquanto a 0033 não estiver no banco (sem pagamento online)
const PADRAO = { name: 'Pro', priceCents: 40000, paymentReady: false }

// Ativa enquanto o mês pago (ou a renovação informada pelo superadmin) não passou
export function planoAtivo(db) {
  const renova = db.subscription?.renewsAt
  return db.billing.status === 'active' && !(renova && new Date(renova) < Date.now())
}

const mesQueVem = (de) => { const d = new Date(de); d.setMonth(d.getMonth() + 1); return d.toISOString() }

const demo = {
  plano: async () => ({ ...PADRAO, paymentReady: true }),
  cobrancas: async () => [],
  // sem Vórtex Pay: o pagamento é simulado e o plano ativa na hora (mesma regra do banco para o mês pago)
  pagar: async () => {
    const s = useDB.getState()
    const emDia = planoAtivo(s) && s.subscription?.renewsAt
    const ini = emDia ? s.subscription.renewsAt : new Date().toISOString()
    const fim = mesQueVem(ini)
    useDB.setState({ subscription: { ...(s.subscription || {}), plan: PADRAO.name, status: 'active', source: 'provider', renewsAt: fim } })
    s.setKey('billing', (b) => ({ ...b, plan: PADRAO.name, status: 'active', nextDue: fim }))
    s.add('invoices', { number: 'AS' + Math.random().toString(16).slice(2, 14).toUpperCase().padEnd(12, '0'), date: new Date().toISOString(), amount: PADRAO.priceCents / 100, status: 'paga' })
    return { simulado: true, ate: fim }
  },
  faturas: async () => useDB.getState().invoices,
}

const real = {
  plano: async () => {
    const { data, error } = await supabase.from('plan_settings').select('name, price_cents, vortexpay_product_id, checkout_url').maybeSingle()
    if (error || !data) return PADRAO
    return { name: data.name, priceCents: data.price_cents, paymentReady: Boolean(data.vortexpay_product_id && data.checkout_url) }
  },
  cobrancas: async (companyId) => {
    const { data, error } = await supabase.from('plan_payments').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(10)
    return error ? [] : data.map(fromRow)
  },
  pagar: () => callFn('assinatura', { action: 'pagar' }),
  faturas: async (companyId) => (await fetchRows('invoices', companyId)).rows.map(fromRow),
}

export const assinatura = BACKEND ? real : demo

/* ---------- Superadmin ---------- */

export const saPlano = {
  save: BACKEND
    ? async (p) => {
      const { error } = await supabase.rpc('sa_plan_settings_save', { p_name: p.name, p_price_cents: p.priceCents, p_product_id: p.productId, p_checkout_url: p.checkoutUrl })
      if (error) throw new Error(error.message)
    }
    : async () => {},
  load: BACKEND
    ? async () => {
      const { data, error } = await supabase.from('plan_settings').select('*').maybeSingle()
      if (error) throw new Error(error.message.includes('plan_settings') ? 'Falta aplicar a migration 0033 (assinatura) no banco.' : error.message)
      return { name: data.name, priceCents: data.price_cents, productId: data.vortexpay_product_id, checkoutUrl: data.checkout_url }
    }
    : async () => ({ name: PADRAO.name, priceCents: PADRAO.priceCents, productId: '', checkoutUrl: '' }),
}
