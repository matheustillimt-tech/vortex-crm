// API Oficial do WhatsApp pelo "Entrar com o Facebook" (WhatsApp Embedded Signup da Meta).
// A tela só abre a janela da Meta e acompanha as etapas; quem troca o código pelo token, confere a conta e o número,
// assina os webhooks e registra o número é o servidor (connection-setup: meta-start, meta-complete, meta-finish).
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { toast, useDB } from '../lib/store'
import { callFn, waitFor } from '../lib/backend'
import { demoEmbeddedSignup, startEmbeddedSignup, useMetaSdk } from '../lib/meta'
import { cx } from '../lib/utils'
import { Field, Modal } from '../components/ui'

const onlyDigits = (s) => String(s || '').replace(/\D/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ErrorNote({ children }) {
  return <p className="mb-3 w-full rounded-xl bg-red-500/10 p-3 text-left text-sm text-red-400">{children}</p>
}

function FacebookLogo({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
    </svg>
  )
}

// Botão principal da API Oficial: azul da Meta (reconhecível), com o raio e a tipografia do Vórtex CRM
export function FacebookButton({ onClick, disabled, loading }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading}
      className="btn w-full py-2.5 text-white hover:brightness-110" style={{ background: '#1877F2', borderRadius: 'var(--radius-primary)' }}>
      {loading ? <Loader2 size={17} className="animate-spin" /> : <FacebookLogo />} Entrar com o Facebook
    </button>
  )
}

const SIGNUP_STEPS = [
  'Entre com sua conta do Facebook',
  'Escolha ou crie o portfólio empresarial',
  'Escolha ou crie a conta do WhatsApp Business',
  'Escolha ou cadastre o número',
  'Confirme o número e conceda as permissões pedidas pela Meta',
  'Volte para o Vórtex CRM: a conexão termina sozinha',
]

export function MetaIntro() {
  return (
    <>
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-violet-400" /> Conecte seu WhatsApp oficial com segurança pela Meta.</p>
      <ol className="mb-4 space-y-1.5 text-sm text-text-secondary">
        {SIGNUP_STEPS.map((s, i) => (
          <li key={s} className="flex gap-2">
            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-interactive text-[11px] font-bold text-text-primary">{i + 1}</span>{s}
          </li>
        ))}
      </ol>
      <p className="mb-4 rounded-xl border border-border-subtle p-3 text-xs text-text-muted">
        Você não copia tokens nem IDs: a Meta entrega tudo direto para o Vórtex CRM. As conversas são cobradas pela Meta na forma de
        pagamento da sua conta do WhatsApp Business; o Vórtex CRM cobra só a assinatura. Ao conectar, você concorda com os{' '}
        <a className="underline hover:text-text-primary" href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a> e a{' '}
        <a className="underline hover:text-text-primary" href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a>.
      </p>
    </>
  )
}

// Aviso quando o botão não pode ser usado (plataforma sem o app da Meta configurado, ou login da Meta bloqueado)
export function MetaSdkNotice({ sdk }) {
  const isSuperadmin = useDB((s) => s.isSuperadmin)
  if (sdk.state === 'off') {
    return (
      <>
        <ErrorNote>A conexão pela Meta ainda não foi ativada na plataforma. Avise o administrador.</ErrorNote>
        {isSuperadmin && (
          <p className="mb-3 text-xs text-text-muted">
            <b>Para o administrador:</b> configure nos segredos das Edge Functions: {sdk.missing.join(', ')}. O passo a passo está no README (API Oficial pelo Embedded Signup).
          </p>
        )}
      </>
    )
  }
  if (sdk.state === 'error') {
    return (
      <div className="mb-3">
        <ErrorNote>{sdk.error}</ErrorNote>
        <button className="btn-secondary text-xs" onClick={sdk.retry}><RefreshCw size={14} /> Tentar de novo</button>
      </div>
    )
  }
  return null
}

function SelectedAccount({ info }) {
  const rows = [['Conta do WhatsApp Business', info.wabaName || info.wabaId], ['Portfólio empresarial', info.businessName || info.businessId]].filter(([, v]) => v)
  return (
    <div className="mb-4 rounded-[16px] border border-border p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-green-500/15 text-green-400"><Smartphone size={18} /></div>
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold">{info.number || 'Número selecionado'}</p>
          {info.verifiedName && <p className="truncate text-xs text-text-muted">{info.verifiedName}</p>}
        </div>
      </div>
      {rows.length > 0 && (
        <dl className="mt-3 space-y-1 text-xs">
          {rows.map(([l, v]) => <div key={l} className="flex justify-between gap-3"><dt className="text-text-muted">{l}</dt><dd className="truncate font-semibold">{v}</dd></div>)}
        </dl>
      )}
      {info.nameStatus === 'PENDING_REVIEW' && <p className="mt-2 text-xs text-amber-400">O nome de exibição está em análise pela Meta.</p>}
      {info.nameStatus === 'DECLINED' && <p className="mt-2 text-xs text-red-400">A Meta recusou o nome de exibição. Ajuste no Gerenciador do WhatsApp.</p>}
    </div>
  )
}

const STEP_STATE = {
  ok: ['Pronto', CheckCircle2, 'text-green-400'],
  skipped: ['Já estava registrado', CheckCircle2, 'text-green-400'],
  pending: ['Falta cadastrar', AlertTriangle, 'text-amber-400'],
  unknown: ['Confira na Meta', Info, 'text-text-muted'],
}

// Etapas do servidor depois da autorização. `running`: meta-finish em andamento (ainda sem resultado)
function StepList({ steps, running }) {
  const rows = [
    ['Autorização da Meta', 'ok'],
    ['Recebimento de mensagens', steps.webhooks],
    ['Registro do número na API oficial', steps.register],
    ['Forma de pagamento na Meta', steps.payment],
  ]
  return (
    <ul className="mb-4 space-y-2 text-sm">
      {rows.map(([label, st]) => {
        const known = STEP_STATE[st]
        const [text, Icon, color] = known || ['Em andamento…', Loader2, 'text-text-muted']
        return (
          <li key={label} className="flex items-center gap-2">
            <Icon size={16} className={cx('shrink-0', color, !known && running && 'animate-spin')} />
            <span className="flex-1">{label}</span>
            <span className={cx('text-xs', color)}>{text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function PaymentNotice({ info, onRecheck, checking }) {
  if (info.payment === 'ok') return null
  return (
    <div className="mb-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-400">
      <p className="font-semibold">{info.payment === 'pending' ? 'Falta cadastrar a forma de pagamento na Meta' : 'Confira a forma de pagamento na Meta'}</p>
      <p className="mt-1 text-xs">
        As conversas do WhatsApp oficial são cobradas pela Meta direto no cartão da sua empresa; o Vórtex CRM cobra só a assinatura.
        Sem forma de pagamento, a Meta bloqueia as mensagens pagas, como os templates que iniciam conversa.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {info.paymentUrl && <a className="btn-secondary text-xs" href={info.paymentUrl} target="_blank" rel="noreferrer">Adicionar forma de pagamento <ExternalLink size={13} /></a>}
        {onRecheck && <button className="btn-ghost text-xs" disabled={checking} onClick={onRecheck}>{checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Já adicionei, conferir</button>}
      </div>
    </div>
  )
}

function Centered({ title, text, spin, icon: Icon, children }) {
  return (
    <div className="flex flex-col items-center py-6 text-center">
      {spin ? <Loader2 size={36} className="mb-3 animate-spin text-violet-400" /> : Icon && <Icon size={40} className="mb-3 text-amber-400" />}
      <p className="font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-text-muted">{text}</p>}
      {children && <div className="mt-4 w-full max-w-sm">{children}</div>}
    </div>
  )
}

// Respostas simuladas do servidor no modo demonstração (sem Supabase)
async function demoMetaCall(action) {
  await sleep(800)
  if (action === 'meta-start') return { sessionId: 'demo' }
  if (action === 'meta-event') return { ok: true }
  const info = { number: '+55 11 4002-8922', verifiedName: 'Minha Empresa', wabaId: '100000000000001', wabaName: 'Minha Empresa', businessName: 'Minha Empresa Ltda', payment: 'pending', paymentUrl: 'https://business.facebook.com/wa/manage/home/' }
  if (action === 'meta-complete') return { ...info, status: 'authorized' }
  return { ...info, status: 'connected', steps: { webhooks: 'ok', register: 'ok', payment: 'pending' } }
}

// Conecta a API Oficial pelo Embedded Signup. `flow`: janela da Meta já aberta no clique da tela "Nova Conexão".
// Fases: idle → authorizing (janela da Meta) → processing (código trocado e conta conferida no servidor) →
// finishing (webhooks, registro do número e pagamento) → done. Desvios: cancelled, error, needs_pin (número com PIN
// próprio) e resume (autorizou mas não terminou: reabrir a conexão continua de onde parou).
export function MetaSetup({ connection, onClose, flow: launched, onManual }) {
  const db = useDB()
  const isSuperadmin = useDB((s) => s.isSuperadmin)
  const live = useDB((s) => s.connections.find((c) => c.id === connection.id)) || connection
  const sdk = useMetaSdk()
  const call = useMemo(() => (sdk.demo ? demoMetaCall : async (action, extra) => {
    await waitFor(connection.id)
    return callFn('connection-setup', { action, connectionId: connection.id, ...extra })
  }), [sdk.demo, connection.id])

  const saved = live.meta?.status
  const [phase, setPhase] = useState(launched ? 'authorizing' : saved === 'needs_pin' ? 'needs_pin' : saved === 'authorized' ? 'resume' : 'idle')
  const [info, setInfo] = useState(live.meta?.phoneNumberId ? { ...live.meta, number: live.number } : null)
  const [steps, setSteps] = useState({})
  const [error, setError] = useState(null) // { message, hint, retry: 'auth' | 'finish' }
  const [cancelStep, setCancelStep] = useState(null)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [checking, setChecking] = useState(false)
  const session = useRef(null)
  const runId = useRef(0) // muda a cada tentativa: respostas de uma tentativa abandonada são ignoradas
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const fail = (e, retry = 'auth') => {
    setError({ message: e.message, hint: e.hint, retry })
    setPhase('error')
  }

  const finish = async (withPin) => {
    const id = runId.current
    setError(null)
    setPinError('')
    setSteps({})
    setPhase('finishing')
    try {
      const r = await call('meta-finish', { sessionId: session.current, ...(withPin ? { pin: withPin } : {}) })
      if (!alive.current || runId.current !== id) return
      if (r.needsPin) {
        setPinError(r.error || '')
        return setPhase('needs_pin')
      }
      setInfo(r)
      setSteps(r.steps || {})
      setPhase('done')
      if (sdk.demo) db.update('connections', connection.id, { provider: 'oficial', status: 'connected', number: r.number, meta: r })
      toast('WhatsApp oficial conectado!')
    } catch (e) {
      if (alive.current && runId.current === id) fail(e, e.code === 'meta_reauth' ? 'auth' : 'finish')
    }
  }

  const run = async (flow) => {
    const id = ++runId.current
    const stale = () => !alive.current || runId.current !== id
    setError(null)
    setCancelStep(null)
    setPhase('authorizing')
    const sessionP = call('meta-start').then((r) => r.sessionId)
    sessionP.catch(() => {})
    const response = await flow.login
    const code = response?.authResponse?.code
    // o evento com os IDs costuma chegar antes do retorno do login; se ainda não chegou, espera um pouco (o código vale 30 s)
    const ev = await Promise.race([flow.finished, sleep(code ? 3000 : 800).then(() => null)])
    flow.cleanup()
    if (stale()) return
    let sessionId
    try {
      sessionId = await sessionP
    } catch (e) {
      return fail(e)
    }
    session.current = sessionId
    const d = ev?.data || {}
    if (!code) {
      const isError = ev?.event === 'ERROR' || !!d.error_message
      call('meta-event', { sessionId, event: isError ? 'ERROR' : 'CANCEL', step: d.current_step, errorMessage: d.error_message, errorCode: d.error_code ?? d.error_id, metaSessionId: d.session_id }).catch(() => {})
      if (isError) return fail(new Error(d.error_message ? `A Meta não concluiu a conexão: ${d.error_message}` : 'A Meta não concluiu a conexão. Tente de novo.'))
      setCancelStep(d.current_step || null)
      return setPhase('cancelled')
    }
    setPhase('processing')
    try {
      const finishType = String(ev?.event || '').startsWith('FINISH') ? ev.event : null
      const r = await call('meta-complete', { sessionId, code, wabaId: d.waba_id, phoneNumberId: d.phone_number_id, businessId: d.business_id, finishType })
      if (stale()) return
      setInfo(r)
    } catch (e) {
      if (!stale()) fail(e)
      return
    }
    await finish()
  }

  // Abre a janela da Meta no próprio clique (sem await antes), senão o navegador bloqueia o pop-up
  const launch = () => {
    if (sdk.state !== 'ready') return
    run(sdk.demo ? demoEmbeddedSignup() : startEmbeddedSignup(sdk.config.configId))
  }

  // Janela aberta pela tela "Nova Conexão": acompanha uma vez só (o StrictMode roda o efeito duas vezes)
  useEffect(() => {
    if (launched && !launched.taken) {
      launched.taken = true
      run(launched)
    }
  }, [launched]) // eslint-disable-line react-hooks/exhaustive-deps

  const recheck = async () => {
    setChecking(true)
    try {
      const r = await call('meta-sync')
      setInfo(r)
      setSteps((s) => ({ ...s, payment: r.payment }))
      toast(r.payment === 'ok' ? 'Forma de pagamento encontrada na Meta!' : 'A Meta ainda não mostra a forma de pagamento. Pode levar alguns minutos.', r.payment === 'ok' ? 'success' : 'info')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setChecking(false)
    }
  }

  const button = <FacebookButton onClick={launch} disabled={sdk.state !== 'ready'} loading={sdk.state === 'loading'} />
  const footer = phase === 'done' ? <button className="btn-primary" onClick={onClose}>Concluir</button> : undefined

  return (
    <Modal open onClose={onClose} title={`Conectar ${live.name}`} subtitle="API Oficial do WhatsApp (Meta)" footer={footer}>
      {phase === 'idle' && (
        <>
          <MetaIntro />
          <MetaSdkNotice sdk={sdk} />
          {button}
          {isSuperadmin && !sdk.demo && onManual && (
            <button className="btn-ghost mt-3 w-full text-xs" onClick={onManual}>Configurar com token manual (avançado)</button>
          )}
        </>
      )}

      {phase === 'resume' && (
        <>
          {info && <SelectedAccount info={info} />}
          <p className="mb-4 text-sm text-text-secondary">A Meta já autorizou esta conta, mas a conexão não terminou. Conclua para começar a receber as mensagens.</p>
          <button className="btn-primary w-full" onClick={() => finish()}><ShieldCheck size={15} /> Concluir conexão</button>
          <button className="btn-ghost mt-2 w-full text-xs" onClick={() => setPhase('idle')}>Conectar outra conta ou número</button>
        </>
      )}

      {phase === 'authorizing' && (
        <Centered spin title="Conclua as etapas na janela da Meta"
          text="Entre com o Facebook, escolha o portfólio, a conta do WhatsApp Business e o número. Não vê a janela? Ela pode ter aberto atrás desta.">
          <button className="btn-ghost text-xs" onClick={() => { runId.current++; setPhase('idle') }}>Cancelar</button>
        </Centered>
      )}

      {phase === 'processing' && <Centered spin title="Validando a autorização com a Meta…" text="Conferindo a conta e o número escolhidos." />}

      {(phase === 'finishing' || phase === 'done') && info && (
        <>
          {phase === 'done' && (
            <div className="mb-4 flex items-center gap-3">
              <CheckCircle2 size={30} className="shrink-0 text-green-400" />
              <div>
                <p className="font-semibold">WhatsApp oficial conectado</p>
                <p className="text-sm text-text-muted">As mensagens desse número já chegam em Chats ao vivo.</p>
              </div>
            </div>
          )}
          <SelectedAccount info={info} />
          <StepList steps={steps} running={phase === 'finishing'} />
          {phase === 'done' && <PaymentNotice info={info} onRecheck={recheck} checking={checking} />}
        </>
      )}

      {phase === 'needs_pin' && (
        <>
          {info && <SelectedAccount info={info} />}
          <Field label="PIN da verificação em duas etapas"
            hint="Esse número já usa a verificação em duas etapas do WhatsApp. Informe o PIN de 6 dígitos. Se não lembrar, redefina no Gerenciador do WhatsApp (Números de telefone → Configurações → Verificação em duas etapas).">
            <input className="input font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••" value={pin}
              onChange={(e) => setPin(onlyDigits(e.target.value).slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && pin.length === 6 && finish(pin)} />
          </Field>
          {pinError && <ErrorNote>{pinError}</ErrorNote>}
          <button className="btn-primary w-full" disabled={pin.length !== 6} onClick={() => finish(pin)}><ShieldCheck size={15} /> Concluir conexão</button>
        </>
      )}

      {phase === 'cancelled' && (
        <Centered icon={AlertTriangle} title="A conexão não foi concluída"
          text={`Você fechou a janela da Meta antes de terminar${cancelStep === 'PHONE_NUMBER_SETUP' ? ', no cadastro do número' : ''}. Se a janela nem abriu, libere os pop-ups deste site no navegador.`}>
          {button}
        </Centered>
      )}

      {phase === 'error' && error && (
        <div className="flex flex-col items-stretch py-2">
          <ErrorNote>{error.message}</ErrorNote>
          {isSuperadmin && error.hint && <p className="mb-3 text-xs text-text-muted"><b>Para o administrador:</b> {error.hint}</p>}
          {error.retry === 'finish'
            ? <button className="btn-primary" onClick={() => finish()}><RefreshCw size={14} /> Tentar de novo</button>
            : button}
        </div>
      )}
    </Modal>
  )
}

export { PaymentNotice }
