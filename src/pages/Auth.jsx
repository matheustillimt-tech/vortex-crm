import { useEffect, useId, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Mail, Lock, Eye, EyeOff, User, Phone, Building2, ArrowLeft, ArrowRight, Sun, Moon, MessageCircle, Workflow, Bot, Columns3, Send, UserPlus, KeyRound,
} from 'lucide-react'
import { useDB, useTheme, toast } from '../lib/store'
import { BRAND } from '../lib/brand'
import { BACKEND } from '../lib/supabase'
import { cx } from '../lib/utils'
import { Logo } from '../components/Layout'

// Erros que a Supabase devolve na URL (#error_code=...) quando alguém abre um link de e-mail
const AUTH_NOTICES = {
  otp_expired: 'Este link de confirmação já foi usado ou expirou. Se você já confirmou seu e-mail, é só entrar abaixo. Se não, entre com seu e-mail e senha para pedir um novo link.',
  access_denied: 'O link do e-mail não é mais válido. Se você já confirmou seu e-mail, é só entrar abaixo.',
}

// Seletor claro/escuro em pílula (como o da referência; sem a opção "sistema", que o app não tem)
export function ThemeSwitch() {
  const { theme, toggle } = useTheme()
  const opts = [
    { id: 'light', icon: Sun, label: 'Tema claro' },
    { id: 'dark', icon: Moon, label: 'Tema escuro' },
  ]
  return (
    <div role="radiogroup" aria-label="Tema" className="flex items-center gap-1 rounded-full border border-border p-1" style={{ background: 'var(--material-control)', boxShadow: 'var(--shadow-inset)' }}>
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={theme === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => theme !== o.id && toggle()}
          className={cx('flex h-9 w-9 items-center justify-center rounded-full transition', theme === o.id ? 'is-selected' : 'text-text-muted hover:text-text-primary')}
        >
          <o.icon size={15} />
        </button>
      ))}
    </div>
  )
}

// Recursos do próprio Vórtex CRM (nomes e descrições já usados nas telas do app)
const FEATURES = [
  { icon: Workflow, title: 'Fluxos', desc: 'Automações e fluxos de atendimento' },
  { icon: Bot, title: 'Agentes de IA', desc: 'Atendente no WhatsApp que tira dúvida e dispara o fluxo' },
  { icon: Columns3, title: 'Kanban', desc: 'Pipeline de vendas e gestão visual' },
]

const IconTile = ({ icon: Icon, size = 48 }) => (
  <div
    className="flex shrink-0 items-center justify-center border border-border"
    style={{ width: size, height: size, borderRadius: 'var(--radius-btn)', background: 'var(--material-secondary)', boxShadow: 'var(--shadow-inset)', color: 'var(--accent-text)' }}
  >
    <Icon size={size * 0.4} />
  </div>
)

function AuthShell({ title, subtitle, eyebrow = BRAND.name, icon = MessageCircle, children, footer }) {
  return (
    <div className="flex min-h-screen flex-col px-5 sm:px-8 lg:px-11">
      <header className="mx-auto flex w-full max-w-[1120px] items-center justify-between border-b border-border-subtle py-5 sm:py-7">
        <Logo />
        <ThemeSwitch />
      </header>

      <main className="mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_460px] lg:gap-16 lg:py-12">
        {/* apresentação (no celular fica só o título, como na referência) */}
        <section>
          <p className="eyebrow-label eyebrow-dot mb-5" style={{ color: 'var(--accent-text)' }}>{BRAND.name}</p>
          <h1 className="max-w-[560px] text-[34px] leading-[1.06] sm:text-[44px] lg:text-[52px]" style={{ letterSpacing: '-0.055em', fontWeight: 550 }}>
            CRM, chatbot e IA para vender no <em className="not-italic" style={{ color: 'var(--accent-text)', fontWeight: 650 }}>WhatsApp.</em>
          </h1>
          <div className="glass-hero mt-10 hidden max-w-[460px] p-5 lg:block">
            <ul className="space-y-4">
              {FEATURES.map((f) => (
                <li key={f.title} className="flex items-center gap-3.5">
                  <IconTile icon={f.icon} size={40} />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-text-primary" style={{ fontWeight: 650 }}>{f.title}</span>
                    <span className="block text-xs text-text-muted">{f.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-6 hidden items-center gap-6 text-xs text-text-muted lg:flex">
            <span className="flex items-center gap-2"><MessageCircle size={14} /> Chats ao vivo</span>
            <span className="flex items-center gap-2"><Send size={14} /> Disparos em massa</span>
          </div>
        </section>

        {/* card de acesso */}
        <div className="w-full">
          <div className="glass-hero p-6 sm:p-9">
            <div className="mb-6"><IconTile icon={icon} /></div>
            {eyebrow && <p className="eyebrow-label mb-3">{eyebrow}</p>}
            <h2 className="text-[26px] leading-tight sm:text-[27px]">{title}</h2>
            <p className="mb-7 mt-2 text-sm text-text-secondary">{subtitle}</p>
            {children}
            {footer && <div className="mt-7 border-t border-border-subtle pt-6 text-center text-[13px] text-text-secondary">{footer}</div>}
          </div>
          <p className="mt-6 text-center text-xs text-text-muted">
            © {new Date().getFullYear()} {BRAND.name}. Todos os direitos reservados.
            {/* páginas estáticas em public/ (link comum, não do roteador) */}
            {' · '}<a className="hover:text-text-primary" href="/privacidade">Privacidade</a>
            {' · '}<a className="hover:text-text-primary" href="/termos">Termos de Uso</a>
            {/* dados oficiais da empresa (Cartão CNPJ): a Meta confere o site na verificação da empresa */}
            <span className="mt-1 block">{BRAND.company.legalName} · CNPJ {BRAND.company.cnpj} · {BRAND.company.address} · {BRAND.company.phone}</span>
          </p>
        </div>
      </main>
    </div>
  )
}

function IconInput({ icon: Icon, label, type = 'text', right, ...props }) {
  const id = useId()
  return (
    <div className="mb-4">
      {label && <label htmlFor={id} className="label mb-2">{label}</label>}
      <div className="relative">
        <Icon size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
        <input id={id} type={type} className="input h-[52px] pl-11 pr-11 text-[13px]" {...props} />
        {right && <div className="absolute right-3.5 top-1/2 -translate-y-1/2">{right}</div>}
      </div>
    </div>
  )
}

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  // aviso vindo de um link de e-mail da Supabase (guardado em main.jsx antes do roteador limpar a URL)
  const [notice] = useState(() => {
    try {
      const code = sessionStorage.getItem('auth-notice')
      return code ? AUTH_NOTICES[code] || 'Não foi possível validar o link do e-mail. Tente entrar com sua senha.' : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try { sessionStorage.removeItem('auth-notice') } catch {} // mostra o aviso uma vez só
  }, [])
  const login = useDB((s) => s.login)
  const resendConfirmation = useDB((s) => s.resendConfirmation)
  const session = useDB((s) => s.session)
  const [params] = useSearchParams()

  const submit = async (e) => {
    e.preventDefault()
    if (!email || !password) return toast('Informe e-mail e senha.', 'error')
    setBusy(true)
    const error = await login(email, password)
    setBusy(false)
    if (error) {
      setUnconfirmed(error.startsWith('Confirme seu e-mail'))
      return toast(error, 'error')
    }
    // com a sessão no app, o <Navigate> abaixo leva para o painel
  }

  const resend = async () => {
    if (!email) return toast('Digite seu e-mail para reenviar a confirmação.', 'error')
    const error = await resendConfirmation(email)
    if (error) return toast(error, 'error')
    toast('Enviamos um novo link de confirmação. Use o e-mail mais recente.')
    setUnconfirmed(false)
  }

  // já logado (acabou de entrar, ou abriu /login com a sessão salva): vai direto para o painel
  if (session) return <Navigate to={params.get('redirect') || '/welcome'} replace />

  return (
    <AuthShell
      title="Bem-vindo!"
      subtitle="Informe suas credenciais para entrar"
      footer={<>É novo por aqui? <Link to="/register" className="link-accent rounded-lg px-1 hover:underline">Crie uma conta agora</Link></>}
    >
      <form onSubmit={submit}>
        {notice && <p className="mb-5 border border-border p-3 text-[13px] text-text-secondary" style={{ borderRadius: 'var(--radius-btn)', background: 'var(--material-secondary)' }}>{notice}</p>}
        <IconInput icon={Mail} label="E-mail" type="email" placeholder="Digite seu e-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <IconInput
          icon={Lock}
          label="Senha"
          type={show ? 'text' : 'password'}
          placeholder="Digite sua senha"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          right={
            <button type="button" onClick={() => setShow((v) => !v)} className="text-text-muted hover:text-text-primary" aria-label="Mostrar senha">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          }
        />
        <div className="mb-6 flex items-center justify-between gap-3 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-text-secondary" style={{ fontWeight: 550 }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-violet-500" />
            Lembrar-me
          </label>
          <Link to="/forgot-password" className="rounded-lg py-1 text-text-secondary hover:text-text-primary" style={{ fontWeight: 550 }}>Esqueci minha senha</Link>
        </div>
        <button className="btn-primary h-[52px] w-full px-6 text-[13px]" disabled={busy}>{busy ? 'Entrando…' : <>Entrar <ArrowRight size={16} /></>}</button>
        {unconfirmed && (
          <button type="button" className="btn-secondary mt-3 w-full" onClick={resend}>Reenviar e-mail de confirmação</button>
        )}
        {!BACKEND && <p className="mt-3 text-center text-[11px] text-text-muted">Modo demonstração: qualquer e-mail e senha entram.</p>}
      </form>
    </AuthShell>
  )
}

export function Register() {
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', password: '' })
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmSent, setConfirmSent] = useState(false)
  const register = useDB((s) => s.register)
  const nav = useNavigate()
  const b = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) })

  const submit = async (e) => {
    e.preventDefault()
    if (!f.name || !f.email || f.password.length < 6) return toast('Preencha nome, e-mail e uma senha com 6+ caracteres.', 'error')
    setBusy(true)
    const { error, needsConfirm } = await register(f)
    setBusy(false)
    if (error) return toast(error, 'error')
    if (needsConfirm) return setConfirmSent(true)
    toast('Conta criada com sucesso!')
    nav('/welcome')
  }

  if (confirmSent)
    return (
      <AuthShell icon={Mail} title="Confirme seu e-mail" subtitle={`Enviamos um link de confirmação para ${f.email}`}
        footer={<Link to="/login" className="link-accent rounded-lg px-1 hover:underline">Já confirmei, quero entrar</Link>}>
        <p className="bg-green-500/10 p-4 text-center text-sm text-green-400" style={{ borderRadius: 'var(--radius-btn)' }}>Abra o e-mail, clique no link e depois entre com seu e-mail e senha. Sua empresa já foi criada.</p>
      </AuthShell>
    )

  return (
    <AuthShell
      icon={UserPlus}
      title="Crie sua conta"
      subtitle="Comece a automatizar seu WhatsApp em minutos"
      footer={<>Já tem uma conta? <Link to="/login" className="link-accent rounded-lg px-1 hover:underline">Entrar</Link></>}
    >
      <form onSubmit={submit}>
        <IconInput icon={User} placeholder="Seu nome completo" {...b('name')} />
        <IconInput icon={Mail} type="email" placeholder="Seu melhor e-mail" {...b('email')} />
        <IconInput icon={Phone} placeholder="WhatsApp com DDD" {...b('phone')} />
        <IconInput icon={Building2} placeholder="Nome da empresa" {...b('company')} />
        <IconInput
          icon={Lock}
          type={show ? 'text' : 'password'}
          placeholder="Crie uma senha"
          {...b('password')}
          right={<button type="button" onClick={() => setShow((v) => !v)} className="text-text-muted">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>}
        />
        <button className="btn-primary mt-2 h-[52px] w-full text-[13px]" disabled={busy}>{busy ? 'Criando…' : 'Criar conta'}</button>
      </form>
    </AuthShell>
  )
}

export function ResetPassword() {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const updatePassword = useDB((s) => s.updatePassword)
  const nav = useNavigate()
  const submit = async (e) => {
    e.preventDefault()
    if (pw.length < 8) return toast('Use pelo menos 8 caracteres.', 'error')
    setBusy(true)
    const error = await updatePassword(pw)
    setBusy(false)
    if (error) return toast(error, 'error')
    toast('Senha alterada!')
    nav('/welcome')
  }
  return (
    <AuthShell icon={Lock} title="Nova senha" subtitle="Escolha a nova senha da sua conta">
      <form onSubmit={submit}>
        <IconInput icon={Lock} type="password" placeholder="Nova senha (8+ caracteres)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn-primary h-[52px] w-full text-[13px]" disabled={busy}>Salvar nova senha</button>
      </form>
    </AuthShell>
  )
}

export function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const resetPassword = useDB((s) => s.resetPassword)
  return (
    <AuthShell
      icon={KeyRound}
      title="Esqueceu a senha?"
      subtitle="Enviaremos um link para redefinir sua senha"
      footer={<Link to="/login" className="link-accent inline-flex items-center gap-1 rounded-lg px-1 hover:underline"><ArrowLeft size={14} /> Voltar para o login</Link>}
    >
      {sent ? (
        <p className="bg-green-500/10 p-4 text-center text-sm text-green-400" style={{ borderRadius: 'var(--radius-btn)' }}>Se existir uma conta com {email}, você receberá um e-mail com as instruções.</p>
      ) : (
        <form onSubmit={async (e) => {
          e.preventDefault()
          if (!email) return
          const error = await resetPassword(email)
          if (error) return toast(error, 'error')
          setSent(true)
        }}>
          <IconInput icon={Mail} type="email" placeholder="Digite seu e-mail" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-primary h-[52px] w-full text-[13px]">Enviar link</button>
        </form>
      )}
    </AuthShell>
  )
}
