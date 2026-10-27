// API do painel do superadministrador.
// Banco real: funções sa_* do Supabase (cada uma confere no servidor se quem chama é superadmin).
// Modo demonstração: mesmos formatos, guardados no store local.
import { BACKEND, supabase } from './supabase'
import { useDB } from './store'
import { closure } from './modules'
import { uid } from './utils'

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camelize = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [camel(k), v]))

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

// Mesma regra do banco para "vencida": teste que acabou, ou renovação (manual ou paga) que passou da data
export function displayStatus(c) {
  const now = Date.now()
  if (c.status === 'canceled' || c.status === 'past_due') return c.status
  if (c.status === 'trial' && c.trialEndsAt && new Date(c.trialEndsAt) < now) return 'past_due'
  if (c.status === 'active' && c.renewsAt && new Date(c.renewsAt) < now) return 'past_due'
  return c.status || 'trial'
}

/* ---------- Modo demonstração ---------- */

const P = () => useDB.getState().platform
const setP = (patch) => useDB.setState({ platform: { ...P(), ...patch } })
const me = () => useDB.getState().user
const log = (action, companyId, detail) => setP({ audit: [{ id: uid(), actorEmail: me().email, action, companyId, detail, at: new Date().toISOString() }, ...P().audit].slice(0, 200) })
const sorted = (a) => [...a].sort()
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

function updateCompany(id, patch) {
  setP({ companies: P().companies.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  // empresa da própria sessão demo: o acesso do app muda junto
  const s = useDB.getState()
  if (id === s.company.id) {
    const c = P().companies.find((x) => x.id === id)
    useDB.setState({ access: { selected: c.selected, effective: closure(c.selected), packageId: c.packageId, customized: c.customized } })
  }
}

const demo = {
  async companies() {
    const pk = P().packages
    return P().companies.map((c) => {
      const effective = closure(c.selected)
      return { ...c, effective, packageName: pk.find((p) => p.id === c.packageId)?.name || null, displayStatus: displayStatus(c) }
    })
  },
  async setModules(companyId, selected, packageId = null) {
    const sel = sorted([...new Set(selected)])
    const eff = closure(sel)
    const pkg = P().packages.find((p) => p.id === packageId)
    const customized = !!pkg && !sameSet(closure(pkg.modules), eff)
    const before = closure(P().companies.find((c) => c.id === companyId)?.selected || [])
    updateCompany(companyId, { selected: sel, packageId: pkg ? pkg.id : null, customized })
    log('modulos', companyId, { antes: before, depois: eff, selecionados: sel, pacote: packageId })
    return { selected: sel, effective: eff, customized }
  },
  async applyPackage(companyId, packageId) {
    const pkg = P().packages.find((p) => p.id === packageId)
    if (!pkg) throw new Error('Pacote não encontrado')
    return demo.setModules(companyId, pkg.modules, packageId)
  },
  async setSubscription(companyId, s) {
    const prev = P().companies.find((c) => c.id === companyId)
    updateCompany(companyId, {
      plan: s.plan || 'Trial', status: s.status, source: 'manual', confirmedAt: null, notes: s.notes || '',
      trialEndsAt: s.trialEndsAt || null, renewsAt: s.renewsAt || null, canceledAt: s.status === 'canceled' ? prev?.canceledAt || new Date().toISOString() : null,
    })
    log('assinatura', companyId, { antes: { plano: prev?.plan, situacao: prev?.status }, depois: { plano: s.plan, situacao: s.status } })
    if (companyId === useDB.getState().company.id) useDB.setState({ subscription: { plan: s.plan, status: s.status, source: 'manual', renewsAt: s.renewsAt, trialEndsAt: s.trialEndsAt } })
  },
  async packages() {
    return P().packages.map((p) => ({ ...p, effective: closure(p.modules), companies: P().companies.filter((c) => c.packageId === p.id).length }))
  },
  async savePackage(p) {
    if (!p.name?.trim()) throw new Error('Dê um nome ao pacote')
    let list = P().packages.map((x) => (p.isDefault ? { ...x, isDefault: false } : x))
    const id = p.id || uid()
    const row = { id, name: p.name.trim(), description: p.description || '', modules: p.modules, isDefault: !!p.isDefault, updatedAt: new Date().toISOString() }
    list = p.id ? list.map((x) => (x.id === id ? row : x)) : [...list, row]
    setP({ packages: list })
    log('pacote', null, { id, nome: row.name, modulos: row.modules, padrao: row.isDefault })
    return id
  },
  async deletePackage(id) {
    setP({ packages: P().packages.filter((p) => p.id !== id), companies: P().companies.map((c) => (c.packageId === id ? { ...c, packageId: null } : c)) })
    log('pacote_excluido', null, { id })
  },
  async admins() {
    return P().admins
  },
  async addAdmin(email) {
    const e = email.trim().toLowerCase()
    if (P().admins.some((a) => a.email.toLowerCase() === e)) return
    // no modo demonstração não existem outras contas: aceita o e-mail para mostrar o fluxo
    setP({ admins: [...P().admins, { userId: uid(), email: e, createdAt: new Date().toISOString(), addedByEmail: me().email }] })
    log('superadmin_adicionado', null, { email: e })
  },
  async removeAdmin(userId) {
    if (P().admins.length <= 1) throw new Error('É preciso manter pelo menos um superadministrador.')
    const a = P().admins.find((x) => x.userId === userId)
    setP({ admins: P().admins.filter((x) => x.userId !== userId) })
    log('superadmin_removido', null, { email: a?.email })
  },
  async audit(companyId) {
    return P().audit.filter((a) => !companyId || String(a.companyId) === String(companyId)).slice(0, 30)
  },
}

/* ---------- Banco real ---------- */

const real = {
  companies: async () => (await rpc('sa_companies')).map(camelize),
  setModules: (companyId, selected, packageId = null) => rpc('sa_set_company_modules', { p_company: companyId, p_selected: selected, p_package: packageId }),
  applyPackage: (companyId, packageId) => rpc('sa_apply_package', { p_company: companyId, p_package: packageId }),
  setSubscription: (companyId, s) =>
    rpc('sa_set_subscription', {
      p_company: companyId, p_plan: s.plan, p_status: s.status, p_trial_ends_at: s.trialEndsAt || null, p_renews_at: s.renewsAt || null, p_notes: s.notes || '',
    }),
  packages: async () => (await rpc('sa_packages')).map(camelize),
  savePackage: (p) => rpc('sa_save_package', { p_id: p.id || null, p_name: p.name, p_description: p.description || '', p_modules: p.modules, p_default: !!p.isDefault }),
  deletePackage: (id) => rpc('sa_delete_package', { p_id: id }),
  admins: async () => (await rpc('sa_admins')).map(camelize),
  addAdmin: (email) => rpc('sa_add_admin', { p_email: email }),
  removeAdmin: (userId) => rpc('sa_remove_admin', { p_user: userId }),
  audit: async (companyId) => (await rpc('sa_audit', { p_company: companyId || null, p_limit: 30 })).map(camelize),
}

export const sa = BACKEND ? real : demo
