// Créditos de IA (migration 0031): saldo pré-pago da empresa para a IA da plataforma.
// Banco real: funções ai_wallet_* / ai_recharge_* (empresa) e sa_ai_* (superadmin), que conferem quem chama.
// A compra passa pela função creditos (oferta na Vórtex Pay); o crédito só entra pelo aviso de pagamento confirmado.
// Modo demonstração: os mesmos formatos, guardados aqui mesmo.
import { BACKEND, supabase } from './supabase'
import { callFn } from './backend'
import { uid } from './utils'

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camelize = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [camel(k), v]))
const num = (v) => (v == null ? v : Number(v))

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}
async function rows(q) {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data.map(camelize)
}

/* ---------- Formatos ---------- */

// Créditos: frações aparecem (uma resposta da IA custa menos de 1 crédito); valores grandes sem casas
export function fmtCred(n, { sinal = false } = {}) {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  const casas = abs >= 1000 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : abs > 0 ? 3 : 0
  const s = v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
  return sinal && v > 0 ? `+${s}` : s
}
export const reais = (cents) => (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
export const brl4 = (v) => `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`

export const KIND = { recarga: ['badge-success', 'Recarga'], consumo: ['badge-muted', 'Consumo'], ajuste: ['badge-info', 'Ajuste'], estorno: ['badge-danger', 'Estorno'] }
export const MODALITY = { texto: 'Texto', audio: 'Áudio (transcrição)', voz: 'Voz (resposta em áudio)' }
export const ORIGIN = {
  atendimento: 'Atendimento', teste: 'Teste do agente', verificacao: 'Teste da chave', vendas: 'Agente de vendas',
  inteligencia: 'Vórtex Inteligência', melhoria: 'Melhoria do agente', validacao: 'Validação do agente',
}
export const RECHARGE = {
  pendente: ['badge-warning', 'Aguardando pagamento'], paga: ['badge-success', 'Paga'], cancelada: ['badge-muted', 'Cancelada'],
  em_analise: ['badge-warning', 'Pagamento em análise'], estornada: ['badge-danger', 'Estornada'],
}

/* ---------- Modo demonstração ---------- */

const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString()
const D = {
  summary: { exists: true, active: true, mode: 'prepago', balance: 1840.52, reserved: 1.2, available: 1839.32, alertCredits: 2000, ownAlert: false, lowAlertAt: ago(5), blockedAt: null, creditBrl: 0.01, paymentReady: true },
  packages: [
    { id: 'p1', name: 'Essencial', description: '~500 atendimentos', credits: 10000, bonus: 0, priceCents: 10000, active: true, highlight: false, sort: 1 },
    { id: 'p2', name: 'Mensal', description: '~1.500 atendimentos · o mês com 50 por dia', credits: 30000, bonus: 1500, priceCents: 30000, active: true, highlight: true, sort: 2 },
    { id: 'p3', name: 'Volume', description: '~3.000 atendimentos', credits: 60000, bonus: 6000, priceCents: 60000, active: true, highlight: false, sort: 3 },
  ],
  recharges: [{ id: 'r1', packageName: 'Mensal', credits: 30000, bonus: 1500, priceCents: 30000, status: 'paga', ref: 'CR0A1B2C3D4E5F', createdAt: ago(240), paidAt: ago(239), checkoutUrl: null }],
  ledger: [],
  usage: null,
}
{
  let saldo = 31500
  const l = [{ id: uid(), n: 1, kind: 'recarga', credits: 31500, balanceAfter: 31500, description: 'Recarga · Mensal (com bônus)', createdAt: ago(239) }]
  for (let i = 0; i < 18; i++) {
    const audio = i % 5 === 0
    const c = audio ? 0.31 : 3.2 + (i % 4) * 0.6
    saldo -= c
    l.push({ id: uid(), n: l.length + 1, kind: 'consumo', credits: -c, balanceAfter: saldo, description: audio ? 'Transcrição de áudio (14 s)' : 'Resposta da IA', agentId: 'a1', modality: audio ? 'audio' : 'texto', origin: 'atendimento', createdAt: ago(200 - i * 10) })
  }
  D.ledger = l.reverse()
  D.summary.balance = 1840.52
}
const demo = {
  summary: async () => D.summary,
  packages: async () => D.packages.filter((p) => p.active),
  recharges: async () => D.recharges,
  ledger: async () => D.ledger,
  usage: async () => ({
    byAgent: [{ agentId: 'a1', name: 'Leo', ops: 15800, credits: 29659.48 }],
    byModality: [{ modality: 'texto', ops: 12100, credits: 28120.2 }, { modality: 'audio', ops: 3700, credits: 1539.28 }],
    byOrigin: [{ origin: 'atendimento', ops: 15750, credits: 29590.1 }, { origin: 'teste', ops: 50, credits: 69.38 }],
    byDay: Array.from({ length: 10 }, (_, i) => ({ day: new Date(Date.now() - (9 - i) * 86400e3).toISOString().slice(0, 10), ops: 1500 + i * 30, credits: 2800 + i * 60, chats: 48 + i })),
  }),
  buy: async () => { throw new Error('No modo demonstração a compra não abre a Vórtex Pay.') },
  cancelRecharge: async (id) => { D.recharges = D.recharges.map((r) => (r.id === id ? { ...r, status: 'cancelada' } : r)) },
  setAlert: async (_c, v) => { D.summary = { ...D.summary, alertCredits: v ?? 2000, ownAlert: v != null } },
}

/* ---------- Banco real ---------- */

const LEDGER_COLS = 'id, n, kind, credits, balance_after, description, agent_id, chat_id, origin, modality, recharge_id, created_at'
const real = {
  summary: (companyId) => rpc('ai_wallet_summary', { p_company: companyId }).then((s) => ({ ...s, balance: num(s.balance), reserved: num(s.reserved), available: num(s.available), alertCredits: num(s.alertCredits) })),
  packages: () => rows(supabase.from('ai_credit_packages').select('*').eq('active', true).order('sort').order('price_cents')),
  recharges: (companyId) => rows(supabase.from('ai_recharges').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(30)),
  ledger: (companyId, before) => {
    let q = supabase.from('ai_ledger').select(LEDGER_COLS).eq('company_id', companyId).order('n', { ascending: false }).limit(50)
    if (before) q = q.lt('n', before)
    return rows(q).then((l) => l.map((x) => ({ ...x, credits: num(x.credits), balanceAfter: num(x.balanceAfter) })))
  },
  usage: (companyId, from) => rpc('ai_wallet_usage', { p_company: companyId, p_from: from }),
  buy: (packageId) => callFn('creditos', { action: 'comprar', packageId }),
  cancelRecharge: (id) => rpc('ai_recharge_cancel', { p_id: id }),
  setAlert: (companyId, credits) => rpc('ai_wallet_set_alert', { p_company: companyId, p_credits: credits }),
}

export const creditos = BACKEND ? real : demo

/* ---------- Superadmin ---------- */

const saDemo = {
  settings: async () => ({
    settings: { creditBrl: 0.01, multiplier: 2, usdBrl: 5.0826, surchargePct: 9, alertCredits: 2000, reserveMinutes: 10, vortexpayProductId: '' },
    prices: [
      { id: 'x1', provider: 'google', model: 'gemini-2.5-flash', unit: 'input_mtok', usd: 0.3, source: 'ai.google.dev, 26/10/2026' },
      { id: 'x2', provider: 'google', model: 'gemini-2.5-flash', unit: 'output_mtok', usd: 2.5, source: 'ai.google.dev, 26/10/2026' },
      { id: 'x3', provider: 'elevenlabs', model: 'scribe_v2', unit: 'stt_hour', usd: 0.22, source: 'elevenlabs.io, 26/10/2026' },
    ],
    packages: D.packages,
  }),
  saveSettings: async () => {}, savePrice: async () => {}, deletePrice: async () => {}, savePackage: async () => {}, deletePackage: async () => {},
  wallets: async () => [{ id: 'demo', name: 'Minha Empresa', hasWallet: true, active: true, mode: 'prepago', balance: 1840.52, multiplier: null, alertCredits: null, reserved: 1.2, ops: 15800, creditsUsed: 29659.48, revenueBrl: 296.59, costBrl: 148.3, rechargedCents: 30000, pendingRecharges: 0 }],
  setWallet: async () => {}, adjust: async () => ({ saldo: 0 }), ledger: async () => D.ledger.map((l) => ({ ...l, costBrl: Math.abs(l.credits) * 0.005, multiplier: 2 })),
  payments: async () => ({ recharges: D.recharges.map((r) => ({ ...r, companyName: 'Minha Empresa' })), events: [] }),
  linkPayment: async () => {}, reprocess: async () => ({}),
  history: async () => ({ models: [{ provider: 'compat', model: 'google/gemini-2.5-flash', runs: 7, chats: 1, inputTokens: 75027, outputTokens: 420, costUsd: 0.02356 }], transcripts: { n: 2, chars: 147 }, voice: { n: 0, chars: 0 }, days: 1 }),
}
const saReal = {
  settings: async () => {
    const r = await rpc('sa_ai_settings')
    return { settings: camelize(r.settings), prices: r.prices.map(camelize), packages: r.packages.map(camelize) }
  },
  saveSettings: (s) => rpc('sa_ai_settings_save', { p_credit_brl: s.creditBrl, p_multiplier: s.multiplier, p_usd_brl: s.usdBrl, p_surcharge_pct: s.surchargePct, p_alert_credits: s.alertCredits, p_reserve_minutes: s.reserveMinutes, p_product: s.vortexpayProductId || '' }),
  savePrice: (p) => rpc('sa_ai_price_save', { p_id: p.id || null, p_provider: p.provider || '', p_model: p.model, p_unit: p.unit, p_usd: p.usd, p_source: p.source || '' }),
  deletePrice: (id) => rpc('sa_ai_price_delete', { p_id: id }),
  savePackage: (p) => rpc('sa_ai_package_save', { p_id: p.id || null, p_name: p.name, p_description: p.description || '', p_credits: p.credits, p_bonus: p.bonus || 0, p_price_cents: p.priceCents, p_active: !!p.active, p_highlight: !!p.highlight, p_sort: p.sort || 0, p_checkout_url: (p.checkoutUrl || '').trim() }),
  deletePackage: (id) => rpc('sa_ai_package_delete', { p_id: id }),
  wallets: async (from, to) => (await rpc('sa_ai_wallets', { p_from: from, p_to: to })).map(camelize),
  setWallet: (companyId, w) => rpc('sa_ai_wallet_set', { p_company: companyId, p_active: !!w.active, p_mode: w.mode, p_multiplier: w.multiplier ?? null, p_alert_credits: w.alertCredits ?? null }),
  adjust: (companyId, credits, reason) => rpc('sa_ai_wallet_adjust', { p_company: companyId, p_credits: credits, p_reason: reason }),
  ledger: async (companyId, before) => (await rpc('sa_ai_ledger', { p_company: companyId, p_limit: 100, p_before: before || null })).map(camelize),
  payments: async () => { const r = await rpc('sa_ai_payments', { p_limit: 100 }); return { recharges: r.recharges.map(camelize), events: r.events.map(camelize) } },
  linkPayment: (eventId, rechargeId) => rpc('sa_ai_link_payment', { p_event: eventId, p_recharge: rechargeId }),
  reprocess: (eventId) => callFn('creditos', { action: 'reprocessar', eventId }),
  history: async (companyId, from) => { const r = await rpc('sa_ai_history', { p_company: companyId, p_from: from }); return { ...r, models: r.models.map(camelize) } },
}
export const saCreditos = BACKEND ? saReal : saDemo
