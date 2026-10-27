// Acesso ao desenvolvedor (superadmin): usuários (empresas), assinaturas, módulos por empresa, pacotes e colaboradores.
// As telas abrem dentro do painel principal; os itens ficam no menu lateral (SUPER_NAV, usado em Layout.jsx).
// Tudo passa pelas funções sa_* do banco, que recusam quem não é superadmin (esconder a tela não é o bloqueio).
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Building2, CalendarClock, Coins, CreditCard, Headset, History, Lock, Package, Pencil, Plus, ShieldCheck, Trash2, UserCog, UserPlus,
} from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { sa } from '../lib/superadmin'
import { saPlano } from '../lib/assinatura'
import { MODULES, SUB_STATUS, closure, moduleName, requiredBy, why } from '../lib/modules'
import { cx } from '../lib/utils'
import { Avatar, Confirm, Field, Modal, PageHeader, Pills, SearchInput, Select, Table, Toggle } from '../components/ui'

/* ---------- utilitários ---------- */

function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      setState({ data: await fn(), loading: false, error: null })
    } catch (e) {
      setState({ data: null, loading: false, error: e.message })
    }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—')
const toInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const fromInput = (v) => (v ? new Date(v + 'T12:00:00').toISOString() : null)
const sortedKey = (a) => [...(a || [])].sort().join(',')
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0] || '')

function StatusBadge({ status }) {
  const s = SUB_STATUS[status] || SUB_STATUS.trial
  return <span className={s.badge}>{s.label}</span>
}

function SourceTag({ source }) {
  return source === 'provider'
    ? <span className="badge-success" title="Status confirmado pelo provedor de pagamento">Confirmado pelo provedor</span>
    : <span className="badge-muted" title="Status registrado manualmente no painel">Informado manualmente</span>
}

function ErrorBox({ error, onRetry }) {
  return (
    <div className="card flex flex-col items-center px-6 py-10 text-center">
      <div className="icon-tile mb-3 h-12 w-12"><AlertTriangle size={20} /></div>
      <p className="text-sm text-text-primary">Não foi possível carregar.</p>
      <p className="mt-1 max-w-md text-xs text-text-muted">{error}</p>
      <button className="btn-secondary mt-4" onClick={onRetry}>Tentar de novo</button>
    </div>
  )
}

// Plano à venda em Cobrança e Assinatura: preço e oferta na Vórtex Pay. O pagamento confirmado ativa a assinatura sozinho
// por um mês (aparece como "Confirmado pelo provedor"); o que for salvo à mão na empresa fica "Informado manualmente".
const reaisNum = (s) => Number(String(s).includes(',') ? String(s).replace(/\./g, '').replace(',', '.') : s)
function PlanModal({ onClose }) {
  const [f, setF] = useState(null)
  const [erro, setErro] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    saPlano.load().then((p) => setF({ ...p, price: (p.priceCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) })).catch((e) => setErro(e.message))
  }, [])
  const save = async () => {
    const priceCents = Math.round(reaisNum(f.price) * 100)
    if (!(priceCents > 0)) return toast('Preço inválido.', 'error')
    setSaving(true)
    try {
      await saPlano.save({ ...f, priceCents })
      toast('Plano salvo.')
      onClose()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Plano e pagamento" subtitle="O que o cliente paga em Cobrança e Assinatura (botão Ativar plano)"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!f || saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar'}</button></>}>
      {erro ? <p className="text-sm text-red-400">{erro}</p> : !f ? <p className="text-sm text-text-muted">Carregando…</p> : (
        <>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Nome do plano"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Pro" /></Field>
            <Field label="Preço por mês (R$)"><input className="input" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          </div>
          <Field label="Produto da Vórtex Pay para o plano" hint="O id do produto do plano na Vórtex Pay. É por ele que o aviso de pagamento sabe que é o plano.">
            <input className="input" placeholder="ex.: cmv8ic2hw0000l504nhm4tmhh" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value.trim() })} />
          </Field>
          <Field label="Link da oferta na Vórtex Pay" hint="Crie a oferta com o mesmo preço no produto do plano (aba Ofertas) e cole o link. Sem produto e link, o botão Ativar plano fica desligado.">
            <input className="input" placeholder="https://pay.seu-dominio.com.br/..." value={f.checkoutUrl} onChange={(e) => setF({ ...f, checkoutUrl: e.target.value.trim() })} />
          </Field>
          <p className="text-xs text-text-muted">O aviso de pagamento usa o mesmo webhook dos Créditos de IA (creditos-webhook). Cada pagamento confirmado deixa a assinatura ativa por 1 mês e gera a fatura do cliente.</p>
        </>
      )}
    </Modal>
  )
}

/* ---------- layout ---------- */

// Itens que aparecem abaixo de "Acesso ao desenvolvedor" no menu lateral.
// Pacotes de módulos saiu do menu (a pedido); a tela continua em /superadmin/pacotes e os pacotes seguem aplicáveis na tela de cada empresa.
export const SUPER_NAV = [
  { to: '/superadmin', label: 'Usuários', icon: UserCog, match: (p) => p === '/superadmin' || p.startsWith('/superadmin/empresas') },
  { to: '/superadmin/suporte', label: 'Suporte', icon: Headset, count: true },
  { to: '/superadmin/creditos', label: 'Créditos de IA', icon: Coins },
  { to: '/superadmin/admins', label: 'Colaboradores', icon: ShieldCheck },
]

/* ---------- empresas ---------- */

export function Metric({ label, value, icon: Icon, tone, onClick, active }) {
  return (
    <button onClick={onClick} className={cx('card p-4 text-left transition hover:border-border-hover', active && 'choice-on')}>
      <div className="flex items-center justify-between">
        <p className="eyebrow-label">{label}</p>
        {Icon && <Icon size={15} className="text-text-muted" />}
      </div>
      <p className={cx('mt-2 font-display text-[26px] leading-none', tone)} style={{ fontWeight: 650, letterSpacing: '-0.04em' }}>{value}</p>
    </button>
  )
}

function ModuleIcons({ effective }) {
  return (
    <div className="flex flex-wrap gap-1">
      {MODULES.map((m) => {
        const on = effective.includes(m.key)
        return (
          <span key={m.key} title={`${m.name}: ${on ? 'liberado' : 'não liberado'}`} className={cx('flex h-6 w-6 items-center justify-center rounded-[8px] border', on ? 'border-[var(--border-accent)] bg-accent-soft text-[var(--accent-text)]' : 'border-border-subtle text-text-muted opacity-40')}>
            <m.icon size={12} />
          </span>
        )
      })}
    </div>
  )
}

function renewal(c) {
  if (c.status === 'canceled') return `Cancelada em ${day(c.canceledAt)}`
  if (c.status === 'trial') return c.trialEndsAt ? `Teste até ${day(c.trialEndsAt)}` : 'Em teste'
  return c.renewsAt ? day(c.renewsAt) : '—'
}

export function SuperCompanies() {
  const nav = useNavigate()
  const { data, loading, error, reload } = useLoad(() => sa.companies())
  const [q, setQ] = useState('')
  const [st, setSt] = useState('all')
  const [planOpen, setPlanOpen] = useState(false)
  const all = data || []
  const count = (s) => all.filter((c) => c.displayStatus === s).length
  const rows = all.filter((c) => (st === 'all' || c.displayStatus === st) && `${c.name} ${c.ownerName || ''} ${c.ownerEmail || ''}`.toLowerCase().includes(q.toLowerCase()))
  const filter = (s) => setSt((cur) => (cur === s ? 'all' : s))

  return (
    <div>
      <PageHeader icon={UserCog} title="Usuários" subtitle="Contas dos clientes, assinaturas e módulos liberados para cada empresa"
        actions={<button className="btn-secondary" onClick={() => setPlanOpen(true)}><CreditCard size={15} /> Plano e pagamento</button>} />
      {planOpen && <PlanModal onClose={() => setPlanOpen(false)} />}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Metric label="Usuários" value={all.length} icon={Building2} onClick={() => setSt('all')} active={st === 'all'} />
        <Metric label="Ativas" value={count('active')} tone="text-green-400" onClick={() => filter('active')} active={st === 'active'} />
        <Metric label="Em teste" value={count('trial')} tone="text-blue-400" onClick={() => filter('trial')} active={st === 'trial'} />
        <Metric label="Vencidas" value={count('past_due')} tone="text-amber-400" onClick={() => filter('past_due')} active={st === 'past_due'} />
        <Metric label="Canceladas" value={count('canceled')} tone="text-red-400" onClick={() => filter('canceled')} active={st === 'canceled'} />
      </div>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchInput className="md:w-80" value={q} onChange={setQ} placeholder="Buscar empresa, responsável ou e-mail…" />
        <Pills
          value={st}
          onChange={setSt}
          options={[{ id: 'all', label: 'Todas' }, { id: 'active', label: 'Ativas' }, { id: 'trial', label: 'Em teste' }, { id: 'past_due', label: 'Vencidas' }, { id: 'canceled', label: 'Canceladas' }]}
        />
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <Table
          rows={rows}
          onRowClick={(c) => nav('/superadmin/empresas/' + c.id)}
          empty={loading ? 'Carregando…' : 'Nenhuma empresa encontrada.'}
          columns={[
            { key: 'name', label: 'Empresa', render: (c) => <div><p className="text-text-primary" style={{ fontWeight: 650 }}>{c.name}</p><p className="text-xs text-text-muted">#{c.publicId} · {c.members} {c.members === 1 ? 'membro' : 'membros'}</p></div> },
            { key: 'owner', label: 'Responsável', render: (c) => <div><p className="text-text-primary">{c.ownerName || '—'}</p><p className="text-xs text-text-muted">{c.ownerEmail}</p></div> },
            { key: 'plan', label: 'Plano', render: (c) => c.plan || '—' },
            { key: 'status', label: 'Situação', render: (c) => <div className="flex flex-col items-start gap-1"><StatusBadge status={c.displayStatus} />{c.source !== 'provider' && <span className="text-[10px] text-text-muted">informado manualmente</span>}</div> },
            { key: 'createdAt', label: 'Cadastro', render: (c) => day(c.createdAt) },
            { key: 'renewal', label: 'Renovação', render: (c) => <span className="whitespace-nowrap">{renewal(c)}</span> },
            { key: 'modules', label: 'Módulos', render: (c) => <div className="space-y-1"><ModuleIcons effective={c.effective} /><p className="text-[11px] text-text-muted">{c.effective.length} de {MODULES.length}{c.packageName ? ` · ${c.packageName}${c.customized ? ' (personalizado)' : ''}` : ''}</p></div> },
          ]}
        />
      )}
    </div>
  )
}

/* ---------- seleção de módulos com dependências (empresa e pacote) ---------- */

// selected = o que foi marcado; o que entra por dependência é calculado (closure)
function ModuleGrid({ selected, onChange, saved }) {
  const [ask, setAsk] = useState(null) // { key, dependents, wasSelected }
  const eff = closure(selected)

  const toggle = (key) => {
    if (!eff.includes(key)) return onChange([...selected, key])
    const dependents = requiredBy(key, selected.filter((s) => s !== key))
    if (dependents.length) return setAsk({ key, dependents, wasSelected: selected.includes(key) })
    onChange(selected.filter((s) => s !== key))
  }
  const disableAll = () => {
    const out = new Set([ask.key, ...ask.dependents])
    onChange(selected.filter((s) => !out.has(s)))
    setAsk(null)
  }
  const keepAsDependency = () => {
    onChange(selected.filter((s) => s !== ask.key))
    setAsk(null)
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: 'rgb(var(--accent))' }} /> Selecionado por você</span>
        <span className="flex items-center gap-1.5"><Lock size={11} /> Liberado automaticamente (dependência)</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-border" /> Desativado</span>
      </div>
      <div className="grid gap-2.5 md:grid-cols-2">
        {MODULES.map((m) => {
          const state = selected.includes(m.key) ? 'selected' : eff.includes(m.key) ? 'auto' : 'off'
          const deps = closure([m.key]).filter((k) => k !== m.key)
          const was = saved ? closure(saved).includes(m.key) : null
          const change = saved && (state !== 'off') !== was ? (state === 'off' ? 'Será suspenso' : 'Será liberado') : null
          return (
            <div
              key={m.key}
              className={cx(
                'flex gap-3 rounded-[16px] border p-3.5 transition',
                state === 'selected' && 'choice-on',
                state === 'auto' && 'border-dashed border-[var(--border-accent)]',
                state === 'off' && 'border-border',
              )}
              style={state === 'auto' ? { background: 'var(--material-secondary)' } : undefined}
            >
              <div className={cx('icon-tile h-9 w-9 shrink-0', state === 'off' && 'opacity-50')}><m.icon size={16} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm text-text-primary" style={{ fontWeight: 650 }}>{m.name}</p>
                  {state === 'selected' && <span className="badge-primary">Selecionado</span>}
                  {state === 'auto' && <span className="badge-info"><Lock size={10} /> Automático</span>}
                  {change && <span className={state === 'off' ? 'badge-warning' : 'badge-success'}>{change}</span>}
                </div>
                <p className="mt-0.5 text-xs text-text-muted">{m.desc}</p>
                {state === 'auto' && <p className="mt-1.5 text-xs text-[var(--accent-text)]">{why(m.key, selected)}.</p>}
                {state !== 'off' && deps.length > 0 && <p className="mt-1.5 text-xs text-text-secondary">Precisa de: {list(deps.map(moduleName))}.</p>}
              </div>
              <div className="shrink-0 pt-0.5">
                <Toggle checked={state !== 'off'} onChange={() => toggle(m.key)} />
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask ? `${moduleName(ask.key)} é usado por outros módulos` : ''}
        size="sm"
        footer={
          ask && (
            <>
              <button className="btn-secondary" onClick={() => setAsk(null)}>Cancelar</button>
              {ask.wasSelected && <button className="btn-secondary" onClick={keepAsDependency}>Manter como dependência</button>}
              <button className="btn bg-red-500 text-white hover:bg-red-600" onClick={disableAll}>Desativar todos</button>
            </>
          )
        }
      >
        {ask && (
          <div className="space-y-3 text-sm text-text-secondary">
            <p>{why(ask.key, selected)}.</p>
            <p>Para desativar <b className="text-text-primary">{moduleName(ask.key)}</b>, também serão desativados: <b className="text-text-primary">{list(ask.dependents.map(moduleName))}</b>.</p>
            {ask.wasSelected && <p className="text-xs text-text-muted">Ou mantenha {moduleName(ask.key)} só como dependência: ele deixa de estar selecionado, mas continua liberado enquanto {list(ask.dependents.map(moduleName))} precisar dele.</p>}
          </div>
        )}
      </Modal>
    </>
  )
}

/* ---------- empresa ---------- */

export function SuperCompany() {
  const { id } = useParams()
  const companies = useLoad(() => sa.companies())
  const packages = useLoad(() => sa.packages())
  const audit = useLoad(() => sa.audit(id), [id])
  const c = companies.data?.find((x) => String(x.id) === id)
  const refresh = () => { companies.reload(); audit.reload(); packages.reload() }

  if (companies.error) return <ErrorBox error={companies.error} onRetry={companies.reload} />
  if (!c) return <p className="py-10 text-center text-sm text-text-muted">{companies.loading ? 'Carregando…' : 'Empresa não encontrada.'}</p>

  return (
    <div>
      <Link to="/superadmin" className="link-accent mb-4 inline-flex items-center gap-1 text-sm"><ArrowLeft size={14} /> Usuários</Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="icon-tile h-11 w-11 shrink-0"><Building2 size={20} /></div>
          <div>
            <h1 className="page-heading">{c.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              #{c.publicId} · cadastro em {day(c.createdAt)} · {c.members} {c.members === 1 ? 'membro' : 'membros'}
            </p>
            <p className="text-sm text-text-muted">Responsável: <span className="text-text-secondary">{c.ownerName || '—'}</span>{c.ownerEmail && ` · ${c.ownerEmail}`}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={c.displayStatus} />
          <SourceTag source={c.source} />
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <ModulesCard key={`${sortedKey(c.selected)}|${c.packageId}`} company={c} packages={packages.data || []} onSaved={refresh} />
        <div className="space-y-5">
          <SubscriptionCard key={`${c.status}|${c.plan}|${c.renewsAt}|${c.trialEndsAt}|${c.notes}`} company={c} onSaved={refresh} />
          <HistoryCard items={audit.data || []} loading={audit.loading} />
        </div>
      </div>
    </div>
  )
}

function ModulesCard({ company, packages, onSaved }) {
  const [sel, setSel] = useState(company.selected)
  const [pkgId, setPkgId] = useState(company.packageId)
  const [pick, setPick] = useState(company.packageId || '')
  const [askSave, setAskSave] = useState(false)
  const [saving, setSaving] = useState(false)

  const eff = closure(sel)
  const saved = closure(company.selected)
  const added = eff.filter((k) => !saved.includes(k))
  const removed = saved.filter((k) => !eff.includes(k))
  const dirty = sortedKey(sel) !== sortedKey(company.selected) || (pkgId || null) !== (company.packageId || null)
  const pkg = packages.find((p) => p.id === pkgId)
  const samePkg = pkg && sortedKey(closure(pkg.modules)) === sortedKey(eff)

  const applyPackage = () => {
    const p = packages.find((x) => x.id === pick)
    if (!p) return toast('Escolha um pacote.', 'warning')
    setSel(p.modules)
    setPkgId(p.id)
  }
  const save = async () => {
    setSaving(true)
    try {
      await sa.setModules(company.id, sel, pkgId || null)
      toast(removed.length ? 'Módulos salvos. O acesso foi suspenso sem apagar dados.' : 'Módulos salvos.')
      onSaved()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
      setAskSave(false)
    }
  }

  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-base text-text-primary" style={{ fontWeight: 650 }}><Lock size={16} className="text-[var(--accent-text)]" /> Módulos e permissões</h2>
        <p className="text-sm text-text-muted">Vale para a empresa toda: ninguém da equipe usa um módulo que a empresa não tem. O bloqueio é feito no banco e no servidor, não só no menu.</p>
      </div>

      <div className="panel-soft mb-4 flex flex-col gap-3 p-3.5 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow-label">Pacote</p>
          <p className="mt-1 text-sm text-text-secondary">
            {pkg ? (samePkg ? <>Idêntico ao pacote <b className="text-text-primary">{pkg.name}</b></> : <>Baseado no pacote <b className="text-text-primary">{pkg.name}</b>, personalizado para esta empresa</>) : 'Sem pacote: configuração própria desta empresa'}
          </p>
        </div>
        <div className="flex gap-2">
          <Select className="min-w-0 lg:w-52" value={pick} onChange={setPick} placeholder="Escolher pacote…" options={packages.map((p) => ({ value: p.id, label: p.name }))} />
          <button className="btn-secondary shrink-0" onClick={applyPackage}>Aplicar</button>
          {pkgId && <button className="btn-ghost shrink-0 px-2 text-xs" onClick={() => setPkgId(null)} title="Manter os módulos e tirar o vínculo com o pacote">Desvincular</button>}
        </div>
      </div>

      <ModuleGrid selected={sel} onChange={setSel} saved={company.selected} />

      {dirty && (
        <div className="sticky bottom-3 mt-4 flex flex-col gap-3 rounded-[16px] border border-[var(--border-accent)] p-3.5 sm:flex-row sm:items-center" style={{ background: 'var(--material-panel)', boxShadow: 'var(--shadow-hero)', backdropFilter: 'blur(14px)' }}>
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-text-primary" style={{ fontWeight: 650 }}>Alterações não salvas</p>
            <p className="text-xs text-text-muted">
              {added.length > 0 && <>Serão liberados: {list(added.map(moduleName))}. </>}
              {removed.length > 0 && <>Serão suspensos: {list(removed.map(moduleName))} (os dados ficam guardados). </>}
              {!added.length && !removed.length && 'Mesmos módulos liberados; muda só a seleção ou o pacote.'}
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => { setSel(company.selected); setPkgId(company.packageId); setPick(company.packageId || '') }}>Descartar</button>
            <button className="btn-primary" disabled={saving} onClick={() => (removed.length ? setAskSave(true) : save())}>{saving ? 'Salvando…' : 'Salvar módulos'}</button>
          </div>
        </div>
      )}

      <Modal
        open={askSave}
        onClose={() => setAskSave(false)}
        title="Suspender módulos"
        size="sm"
        footer={<><button className="btn-secondary" onClick={() => setAskSave(false)}>Cancelar</button><button className="btn bg-red-500 text-white hover:bg-red-600" disabled={saving} onClick={save}>Suspender e salvar</button></>}
      >
        <div className="space-y-3 text-sm text-text-secondary">
          <p><b className="text-text-primary">{company.name}</b> vai perder o acesso a: <b className="text-text-primary">{list(removed.map(moduleName))}</b>.</p>
          <p>Nada é apagado: contatos, conversas, fluxos e os demais dados ficam guardados e voltam quando você reativar.</p>
          {removed.includes('fluxos') && <p>Automações de fluxo em andamento serão canceladas, para não dispararem atrasadas quando o módulo voltar.</p>}
          {removed.includes('conexoes') && <p>Mensagens que chegarem pelo WhatsApp enquanto Conexões estiver suspenso não serão registradas.</p>}
        </div>
      </Modal>
    </section>
  )
}

function SubscriptionCard({ company, onSaved }) {
  const [f, setF] = useState({ plan: company.plan || '', status: company.status || 'trial', trialEndsAt: toInput(company.trialEndsAt), renewsAt: toInput(company.renewsAt), notes: company.notes || '' })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await sa.setSubscription(company.id, { ...f, trialEndsAt: fromInput(f.trialEndsAt), renewsAt: fromInput(f.renewsAt) })
      toast('Assinatura atualizada.')
      onSaved()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="card p-5">
      <h2 className="mb-1 flex items-center gap-2 text-base text-text-primary" style={{ fontWeight: 650 }}><CalendarClock size={16} className="text-[var(--accent-text)]" /> Assinatura</h2>
      <p className="mb-4 text-xs text-text-muted">O pagamento do plano pela Vórtex Pay ativa e renova sozinho; o que você salvar aqui fica como <b>informado manualmente</b>. A situação não bloqueia o acesso sozinha: quem decide o acesso são os módulos.</p>
      <div className="grid gap-x-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <Field label="Plano"><input className="input" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} placeholder="Ex.: Pro" /></Field>
        <Field label="Situação"><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={Object.entries(SUB_STATUS).map(([value, s]) => ({ value, label: s.label }))} /></Field>
        <Field label="Teste até"><input type="date" className="input" value={f.trialEndsAt} onChange={(e) => setF({ ...f, trialEndsAt: e.target.value })} /></Field>
        <Field label="Próxima renovação"><input type="date" className="input" value={f.renewsAt} onChange={(e) => setF({ ...f, renewsAt: e.target.value })} /></Field>
      </div>
      <Field label="Observações"><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Ex.: pagou por Pix até dezembro" /></Field>
      {company.status === 'canceled' && company.canceledAt && <p className="mb-3 text-xs text-text-muted">Cancelada em {day(company.canceledAt)}.</p>}
      <button className="btn-primary w-full" disabled={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar assinatura'}</button>
    </section>
  )
}

const ACTIONS = {
  modulos: 'Módulos alterados',
  assinatura: 'Assinatura alterada',
  assinatura_paga: 'Plano pago na Vórtex Pay',
  assinatura_estornada: 'Pagamento do plano estornado',
  pacote: 'Pacote salvo',
  pacote_excluido: 'Pacote excluído',
  superadmin_adicionado: 'Superadmin adicionado',
  superadmin_removido: 'Superadmin removido',
}

function auditDetail(a) {
  const d = a.detail || {}
  if (a.action === 'modulos') {
    const before = d.antes || []
    const after = d.depois || []
    const on = after.filter((k) => !before.includes(k)).map(moduleName)
    const off = before.filter((k) => !after.includes(k)).map(moduleName)
    return [on.length && `Liberou: ${list(on)}`, off.length && `Suspendeu: ${list(off)}`].filter(Boolean).join(' · ') || 'Sem mudança nos módulos liberados'
  }
  if (a.action === 'assinatura') return `${SUB_STATUS[d.depois?.situacao]?.label || d.depois?.situacao || ''}${d.depois?.plano ? ` · plano ${d.depois.plano}` : ''}`
  if (a.action === 'assinatura_paga') return d.ate ? `Ativa até ${new Date(d.ate).toLocaleDateString('pt-BR')}` : ''
  if (a.action === 'assinatura_estornada') return d.motivo || ''
  return ''
}

function HistoryCard({ items, loading }) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-base text-text-primary" style={{ fontWeight: 650 }}><History size={16} className="text-[var(--accent-text)]" /> Histórico</h2>
      {items.length === 0 ? (
        <p className="text-xs text-text-muted">{loading ? 'Carregando…' : 'Nenhuma alteração registrada ainda.'}</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((a) => (
            <li key={a.id} className="panel-soft px-3 py-2.5">
              <p className="text-sm text-text-primary" style={{ fontWeight: 600 }}>{ACTIONS[a.action] || a.action}</p>
              {auditDetail(a) && <p className="text-xs text-text-secondary">{auditDetail(a)}</p>}
              <p className="mt-0.5 text-[11px] text-text-muted">{new Date(a.at).toLocaleString('pt-BR')} · {a.actorEmail || '—'}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ---------- pacotes ---------- */

export function SuperPackages() {
  const { data, loading, error, reload } = useLoad(() => sa.packages())
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  const remove = async (p) => {
    try {
      await sa.deletePackage(p.id)
      toast('Pacote excluído. As empresas mantêm os módulos que já tinham.')
      reload()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  return (
    <div>
      <PageHeader
        icon={Package}
        title="Pacotes de módulos"
        subtitle="Conjuntos prontos para aplicar a uma empresa. Depois de aplicar, você pode personalizar a empresa sem mudar o pacote dos outros clientes."
        actions={<button className="btn-primary whitespace-nowrap" onClick={() => setEdit({ name: '', description: '', modules: [], isDefault: false })}><Plus size={15} /> Novo pacote</button>}
      />
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(data || []).map((p) => (
            <div key={p.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-base text-text-primary" style={{ fontWeight: 650 }}>{p.name}</p>
                  {p.description && <p className="mt-0.5 text-xs text-text-muted">{p.description}</p>}
                </div>
                {p.isDefault && <span className="badge-success shrink-0">Padrão</span>}
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {p.effective.map((k) => (
                  <span key={k} className={p.modules.includes(k) ? 'badge-primary' : 'badge-muted'} title={p.modules.includes(k) ? 'Selecionado' : 'Entra como dependência'}>
                    {!p.modules.includes(k) && <Lock size={10} />} {moduleName(k)}
                  </span>
                ))}
              </div>
              {p.isDefault && <p className="mt-3 text-xs text-[var(--accent-text)]">Aplicado automaticamente a cada empresa nova.</p>}
              <div className="mt-auto flex items-center justify-between pt-4 text-xs text-text-muted">
                <span>{p.companies} {p.companies === 1 ? 'empresa usa' : 'empresas usam'}</span>
                <div className="flex">
                  <button className="btn-ghost p-1.5" title="Editar" onClick={() => setEdit(p)}><Pencil size={14} /></button>
                  <button className="btn-ghost p-1.5 text-red-400" title="Excluir" onClick={() => setDel(p)}><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
          {!loading && !data?.length && <p className="text-sm text-text-muted">Nenhum pacote ainda.</p>}
        </div>
      )}
      {edit && <PackageModal pkg={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload() }} />}
      <Confirm
        open={!!del}
        onClose={() => setDel(null)}
        title="Excluir pacote"
        message={`Excluir o pacote "${del?.name}"? As empresas que usam esse pacote mantêm os módulos atuais; só perdem o vínculo com ele.`}
        onConfirm={() => remove(del)}
      />
    </div>
  )
}

function PackageModal({ pkg, onClose, onSaved }) {
  const [f, setF] = useState({ ...pkg, modules: pkg.modules || [] })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!f.name.trim()) return toast('Dê um nome ao pacote.', 'error')
    setSaving(true)
    try {
      await sa.savePackage(f)
      toast('Pacote salvo. Empresas que já usam este pacote não mudam até você aplicá-lo de novo.')
      onSaved()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={pkg.id ? 'Editar pacote' : 'Novo pacote'}
      subtitle="As dependências entram sozinhas no pacote"
      size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar pacote'}</button></>}
    >
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Atendimento" /></Field>
        <Field label="Descrição"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Para quem é este pacote" /></Field>
      </div>
      <ModuleGrid selected={f.modules} onChange={(modules) => setF({ ...f, modules })} />
      <div className="mt-3 border-t border-border-subtle pt-2">
        <Toggle checked={!!f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} label="Pacote padrão" description="Aplicado automaticamente a cada empresa que se cadastrar na plataforma." />
      </div>
    </Modal>
  )
}

/* ---------- superadministradores ---------- */

export function SuperAdmins() {
  const me = useDB((s) => s.user)
  const { data, error, reload } = useLoad(() => sa.admins())
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(null)
  const admins = data || []

  const add = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return toast('Informe um e-mail válido.', 'error')
    setBusy(true)
    try {
      await sa.addAdmin(email.trim())
      toast('Colaborador adicionado.')
      setEmail('')
      reload()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (a) => {
    try {
      await sa.removeAdmin(a.userId)
      toast('Colaborador removido.')
      reload()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader icon={ShieldCheck} title="Colaboradores" subtitle="Quem tem acesso ao desenvolvedor: vê todas as contas e controla módulos, pacotes e assinaturas" />
      <div className="card mb-5 p-5">
        <p className="label">Adicionar colaborador</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="email@empresa.com" />
          <button className="btn-primary shrink-0" disabled={busy} onClick={add}><UserPlus size={15} /> Adicionar</button>
        </div>
        <p className="mt-2 text-xs text-text-muted">A pessoa precisa já ter uma conta na plataforma. Administradores de clientes não conseguem se adicionar: só um colaborador adiciona outro.</p>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <div className="space-y-2.5">
          {admins.map((a) => (
            <div key={a.userId} className="card flex items-center gap-3 p-4">
              <Avatar name={a.email} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary" style={{ fontWeight: 650 }}>{a.email}{a.userId === me.id && <span className="ml-2 text-xs text-text-muted">(você)</span>}</p>
                <p className="text-xs text-text-muted">Desde {day(a.createdAt)}{a.addedByEmail ? ` · adicionado por ${a.addedByEmail}` : ''}</p>
              </div>
              <button
                className="btn-ghost p-2 text-red-400 disabled:opacity-30"
                title={admins.length <= 1 ? 'É preciso manter pelo menos um colaborador' : 'Remover'}
                disabled={admins.length <= 1}
                onClick={() => setDel(a)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Confirm
        open={!!del}
        onClose={() => setDel(null)}
        title="Remover colaborador"
        message={`Remover ${del?.email}? A pessoa continua com a conta e as empresas dela, mas perde o acesso ao desenvolvedor.${del?.userId === me.id ? ' Você está removendo o seu próprio acesso.' : ''}`}
        confirmLabel="Remover"
        onConfirm={() => remove(del)}
      />
    </div>
  )
}
