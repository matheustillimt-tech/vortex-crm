// Boas-vindas das empresas (referência: Datacrazy), aberta por "Adicionar empresa" no seletor do menu.
// A pessoa já está logada: entra numa empresa, cria uma nova (cadastro guiado) ou aceita um convite, sem novo login.
// O banco confere tudo: my_companies, switch_company, create_company, my_invitations e accept_invitation.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Building2, Check, KeyRound, Loader2, LogOut, MailOpen, Plus, Search } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { cx } from '../lib/utils'
import { Logo } from '../components/Layout'
import { planLabel } from '../components/CompanySwitcher'
import { Avatar, Field, Select } from '../components/ui'

const TIMEZONES = [
  { value: 'America/Sao_Paulo', label: 'Brasília (America/Sao_Paulo)' },
  { value: 'America/Manaus', label: 'Manaus (America/Manaus)' },
  { value: 'America/Mexico_City', label: 'Cidade do México' },
  { value: 'Europe/Lisbon', label: 'Lisboa' },
]

// Depois de criar, trocar ou aceitar: vai para o início e carrega a empresa nova do zero
function useEnter() {
  const nav = useNavigate()
  return async (message) => {
    nav('/welcome', { replace: true })
    await useDB.getState().enterCompany()
    if (message) toast(message)
  }
}

export default function Companies() {
  const user = useDB((s) => s.user)
  const noCompany = useDB((s) => s.noCompany)
  const [params, setParams] = useSearchParams()
  const creating = params.get('acao') === 'criar'
  const nav = useNavigate()
  const firstName = (user.name || '').split(' ')[0]

  return (
    <div className="min-h-screen bg-surface-base">
      <header className="glass-bar sticky top-0 z-30 border-b border-border-subtle">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            {!noCompany && <Link to="/welcome" className="btn-secondary px-3 py-1.5 text-xs"><ArrowLeft size={14} /> Voltar ao painel</Link>}
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={async () => { await useDB.getState().logout(); nav('/login') }}><LogOut size={14} /> Sair</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        {creating ? (
          <CreateCompany onCancel={() => setParams({})} />
        ) : (
          <>
            <h1 className="page-heading page-heading-lg">Bem-vindo(a){firstName ? `, ${firstName}` : ''}!</h1>
            <p className="page-subtitle mt-1">Escolha uma empresa para entrar, crie uma nova ou use um convite. Você continua com o mesmo login.</p>
            <div className="mt-7 grid items-start gap-5 lg:grid-cols-[1.35fr_1fr]">
              <AvailableCompanies />
              <div className="space-y-5">
                <section className="card p-5">
                  <div className="icon-tile mb-3 h-10 w-10"><Building2 size={18} /></div>
                  <h2 className="text-[17px] font-semibold text-text-primary">Criar nova empresa</h2>
                  <p className="mt-1 text-sm text-text-secondary">Um ambiente separado, com contatos, conexões, automações e configurações próprios. Você será o administrador.</p>
                  <button className="btn-primary mt-4 w-full justify-center" onClick={() => setParams({ acao: 'criar' })}><Plus size={15} /> Criar empresa</button>
                </section>
                <InviteCard />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/* ---------- Empresas disponíveis ---------- */

function AvailableCompanies() {
  const companies = useDB((s) => s.companies)
  const current = useDB((s) => s.company.id)
  const noCompany = useDB((s) => s.noCompany)
  const enter = useEnter()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(null)

  useEffect(() => { useDB.getState().refreshCompanies().catch(() => {}) }, [])

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return companies.filter((c) => !t || c.name.toLowerCase().includes(t))
  }, [companies, q])

  const open = async (c) => {
    if (busy) return
    setBusy(c.id)
    try {
      const isCurrent = !noCompany && String(c.id) === String(current)
      if (!isCurrent) await useDB.getState().switchCompany(c.id)
      await enter(isCurrent ? null : `Você está em ${c.name}.`)
    } catch (e) {
      toast(e.message, 'error')
      setBusy(null)
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-[17px] font-semibold text-text-primary">Empresas disponíveis para você</h2>
      <p className="mt-1 text-sm text-text-secondary">Só aparecem as empresas das quais você participa.</p>
      {companies.length > 5 && (
        <label className="input mt-4 flex items-center gap-2">
          <Search size={15} className="shrink-0 text-text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar empresa" aria-label="Pesquisar empresa" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      )}
      <ul className="mt-4 space-y-2">
        {list.map((c) => {
          const isCurrent = !noCompany && String(c.id) === String(current)
          return (
            <li key={c.id} className={cx('flex items-center gap-3 rounded-[16px] border p-3', isCurrent ? 'choice-on' : 'border-border')}>
              <Avatar name={c.name} size={40} letters={1} src={c.logoUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-text-primary">{c.name}</p>
                <p className="truncate text-xs text-text-muted">{[planLabel(c), c.role].filter(Boolean).join(' · ')}</p>
              </div>
              {isCurrent && <span className="badge-success hidden sm:inline-flex">Atual</span>}
              <button className={cx('shrink-0 text-xs', isCurrent ? 'btn-secondary' : 'btn-primary')} disabled={!!busy} onClick={() => open(c)}>
                {busy === c.id ? <Loader2 size={14} className="animate-spin" /> : <>{isCurrent ? 'Abrir' : 'Entrar'} <ArrowRight size={13} /></>}
              </button>
            </li>
          )
        })}
      </ul>
      {!companies.length && <p className="mt-4 rounded-[14px] border border-dashed border-border p-4 text-center text-sm text-text-muted">Você ainda não participa de nenhuma empresa. Crie uma nova ou entre por convite.</p>}
      {companies.length > 0 && !list.length && <p className="mt-4 text-center text-sm text-text-muted">Nenhuma empresa encontrada</p>}
    </section>
  )
}

/* ---------- Entrar por convite ---------- */

function InviteCard() {
  const user = useDB((s) => s.user)
  const enter = useEnter()
  const [invites, setInvites] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    useDB.getState().listInvitations().then(setInvites).catch(() => setInvites([]))
  }, [])

  const accept = async ({ id, code: c, companyName }) => {
    if (busy) return
    setError('')
    setBusy(id || 'code')
    try {
      await useDB.getState().acceptInvitation({ id, code: c })
      await enter(companyName ? `Convite aceito! Você está em ${companyName}.` : 'Convite aceito! Você já está na empresa.')
    } catch (e) {
      setError(e.message)
      setBusy(null)
    }
  }

  const submitCode = (e) => {
    e.preventDefault()
    const clean = code.replace(/[^a-z0-9]/gi, '')
    if (clean.length < 6) return setError('Digite o código do convite que o administrador enviou.')
    accept({ code })
  }

  return (
    <section className="card p-5">
      <div className="icon-tile mb-3 h-10 w-10"><MailOpen size={18} /></div>
      <h2 className="text-[17px] font-semibold text-text-primary">Entrar por convite</h2>
      <p className="mt-1 text-sm text-text-secondary">Participe de uma empresa que convidou você, com a função definida pelo administrador.</p>

      {invites === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Procurando convites…</p>
      ) : invites.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 rounded-[16px] border border-border p-3">
              <Avatar name={i.companyName} size={34} letters={1} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">{i.companyName}</p>
                <p className="truncate text-xs text-text-muted">{[i.role, i.department].filter(Boolean).join(' · ')}</p>
              </div>
              <button className="btn-primary shrink-0 text-xs" disabled={!!busy} onClick={() => accept({ id: i.id, companyName: i.companyName })}>
                {busy === i.id ? <Loader2 size={14} className="animate-spin" /> : <><Check size={13} /> Aceitar</>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-text-muted">Nenhum convite pendente para <b className="text-text-secondary">{user.email}</b>.</p>
      )}

      <form onSubmit={submitCode} className="mt-4 border-t border-border-subtle pt-4">
        <Field label="Tenho um código de convite" hint="O administrador encontra o código em Configurações → Equipe → Convites pendentes.">
          <div className="flex gap-2">
            <input className="input font-mono uppercase" value={code} onChange={(e) => { setCode(e.target.value); setError('') }} placeholder="Ex.: A1B2-C3D4-E5F6" aria-label="Código do convite" maxLength={20} />
            <button className="btn-secondary shrink-0" disabled={!!busy}>{busy === 'code' ? <Loader2 size={14} className="animate-spin" /> : <><KeyRound size={14} /> Validar</>}</button>
          </div>
        </Field>
        {error && <p className="-mt-1 rounded-xl bg-red-500/10 p-3 text-sm text-red-400">{error}</p>}
      </form>
    </section>
  )
}

/* ---------- Criar nova empresa (cadastro guiado) ---------- */

const STEPS = ['Empresa', 'Contato', 'Revisão']

function Steps({ step }) {
  return (
    <ol className="mb-6 flex items-center" aria-label="Etapas do cadastro">
      {STEPS.map((label, i) => {
        const done = i < step
        const now = i === step
        return (
          <li key={label} className={cx('flex items-center', i < STEPS.length - 1 && 'flex-1')} aria-current={now ? 'step' : undefined}>
            <span className="flex items-center gap-2">
              <span
                className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold transition',
                  done ? 'border-transparent text-white' : now ? 'text-text-primary' : 'border-border text-text-muted')}
                style={done ? { background: 'rgb(var(--accent))' } : now ? { borderColor: 'rgb(var(--accent))', boxShadow: '0 0 0 3px rgb(var(--accent) / 0.18)' } : undefined}
              >
                {done ? <Check size={15} /> : i + 1}
              </span>
              <span className={cx('text-[13px] font-semibold', now ? 'text-text-primary' : 'text-text-muted', !now && 'hidden sm:inline')}>{label}</span>
            </span>
            {i < STEPS.length - 1 && <span className="mx-3 h-px flex-1" style={{ background: done ? 'rgb(var(--accent))' : 'var(--border-subtle)' }} />}
          </li>
        )
      })}
    </ol>
  )
}

function CreateCompany({ onCancel }) {
  const enter = useEnter()
  const [step, setStep] = useState(0)
  const [f, setF] = useState({ name: '', description: '', phone: '', timezone: 'America/Sao_Paulo' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setError('') }
  const tzLabel = TIMEZONES.find((t) => t.value === f.timezone)?.label || f.timezone

  const next = async (e) => {
    e?.preventDefault()
    if (step === 0) {
      const n = f.name.trim().length
      if (n < 2 || n > 80) return setError('Informe o nome da empresa (de 2 a 80 caracteres).')
    }
    if (step < STEPS.length - 1) return setStep(step + 1)
    setBusy(true)
    try {
      await useDB.getState().createCompany(f)
      await enter(`Empresa ${f.name.trim()} criada! Você já está nela.`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <button className="link-accent mb-4 inline-flex items-center gap-1 text-sm" onClick={onCancel}><ArrowLeft size={14} /> Voltar</button>
      <form onSubmit={next} className="card p-6">
        <h1 className="page-heading">Criar nova empresa</h1>
        <p className="page-subtitle mb-6 mt-1">Leva menos de um minuto. Você continua logado com a mesma conta.</p>
        <Steps step={step} />

        {step === 0 && (
          <>
            <Field label="Nome da empresa*">
              <input className="input" autoFocus value={f.name} onChange={set('name')} placeholder="Ex.: Minha Empresa" maxLength={80} />
            </Field>
            <Field label="Descrição (opcional)">
              <input className="input" value={f.description} onChange={set('description')} placeholder="O que a empresa faz" maxLength={300} />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <Field label="WhatsApp da empresa (opcional)" hint="Fica nos dados da empresa. A conexão do WhatsApp para atender é feita depois, em Conexões.">
              <input className="input" autoFocus value={f.phone} onChange={set('phone')} placeholder="(11) 9XXXX-XXXX" inputMode="tel" maxLength={30} />
            </Field>
            <Field label="Fuso horário" hint="Usado no painel, nos fluxos e no horário comercial.">
              <Select value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} options={TIMEZONES} />
            </Field>
          </>
        )}
        {step === 2 && (
          <>
            <dl className="divide-y divide-border-subtle rounded-[16px] border border-border text-sm">
              {[['Empresa', f.name.trim()], ['Descrição', f.description.trim() || '—'], ['WhatsApp', f.phone.trim() || '—'], ['Fuso horário', tzLabel]].map(([k, v]) => (
                <div key={k} className="flex gap-3 px-4 py-2.5">
                  <dt className="w-28 shrink-0 text-text-muted">{k}</dt>
                  <dd className="min-w-0 flex-1 break-words font-medium text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 rounded-[14px] p-3 text-[13px] text-text-secondary" style={{ background: 'rgb(var(--accent) / 0.08)' }}>
              Você será o proprietário, com acesso de administrador. A empresa começa com 7 dias de teste e os módulos do pacote padrão. Contatos, conexões, automações e configurações ficam só nela.
            </p>
          </>
        )}

        {error && <p className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex items-center justify-between gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => (step ? setStep(step - 1) : onCancel())}>
            {step ? <><ArrowLeft size={14} /> Voltar</> : 'Cancelar'}
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? <><Loader2 size={15} className="animate-spin" /> Criando…</> : step < STEPS.length - 1 ? <>Continuar <ArrowRight size={14} /></> : <><Check size={15} /> Criar empresa</>}
          </button>
        </div>
      </form>
    </div>
  )
}
