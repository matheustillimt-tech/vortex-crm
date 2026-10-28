// Configuração real das conexões (modo banco): Zapbot (QR Code ou código), Z-API (instância própria), Evolution API e Cloud API da Meta.
import { useEffect, useMemo, useState } from 'react'
import { Copy, Loader2, QrCode, RefreshCw, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { toast, useDB } from '../lib/store'
import { callFn, waitFor } from '../lib/backend'
import { Field, Modal } from '../components/ui'

function CopyField({ label, value }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input readOnly className="input font-mono text-xs" value={value || ''} onFocus={(e) => e.target.select()} />
        <button className="btn-secondary shrink-0" onClick={() => { navigator.clipboard?.writeText(value); toast('Copiado!') }}><Copy size={14} /></button>
      </div>
    </Field>
  )
}

const qrSrc = (qr) => (!qr ? null : qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`)

/* ---------- Zapbot: WhatsApp não oficial, por QR Code ou código de pareamento ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ATTEMPT_MS = 120_000 // cada tentativa de pareamento vale por até 2 minutos
const onlyDigits = (s) => String(s || '').replace(/\D/g, '')

function ErrorNote({ children }) {
  return <p className="mb-3 w-full rounded-xl bg-red-500/10 p-3 text-left text-sm text-red-400">{children}</p>
}

function Waiting({ children }) {
  return <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="shrink-0 animate-spin" /> {children}</p>
}

// QR Code: pede a imagem a cada 2,5 s (o WhatsApp troca o código e só o mais recente vale) até conectar ou passar 2 minutos.
// Com `ready` falso (a conexão ainda está sendo criada no servidor), só mostra "Gerando QR Code…".
function QrPane({ call, onConnected, ready = true }) {
  const [run, setRun] = useState(0)
  const [image, setImage] = useState(null)
  const [phase, setPhase] = useState('loading') // loading | showing | expired | error
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ready) return
    let alive = true
    const until = Date.now() + ATTEMPT_MS
    setImage(null)
    setError('')
    setPhase('loading')
    ;(async () => {
      let failures = 0
      while (alive && Date.now() < until) {
        try {
          const r = await call('zapbot-qr')
          failures = 0
          if (!alive) return
          if (r.connected) return onConnected(r.phone)
          // pareamento recusado (ex.: número já conectado em outra conta): a mensagem vem uma vez só
          if (r.error) return (setError(r.error), setPhase('error'))
          if (r.image) {
            setImage(r.image)
            setPhase('showing')
          }
          await sleep(r.image ? 2500 : 1500)
        } catch (e) {
          if (++failures >= 3) return alive && (setError(e.message), setPhase('error'))
          await sleep(2500)
        }
      }
      if (alive) {
        setImage(null)
        setPhase('expired')
      }
    })()
    return () => { alive = false }
  }, [run, call, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const over = phase === 'expired' || phase === 'error'
  return (
    <div>
      <p className="mb-4 text-sm text-text-secondary">Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho e escaneie o QR Code.</p>
      {/* moldura redonda como no modelo; o QR fica inteiro dentro do círculo (cortar os cantos impede a leitura) */}
      <div className="mb-4 flex h-72 w-72 max-w-full items-center justify-center rounded-full border border-border bg-white">
        {image ? <img src={image} alt="QR Code do WhatsApp" className="h-[196px] w-[196px]" />
          : phase === 'loading' ? <Loader2 size={28} className="animate-spin text-gray-400" />
          : <QrCode size={56} className="text-gray-300" />}
      </div>
      {phase === 'error' && <ErrorNote>{error}</ErrorNote>}
      {phase === 'expired' && <p className="mb-3 text-sm text-text-muted">O QR Code expirou. Gere um novo para tentar de novo.</p>}
      {over ? (
        <button className="btn-primary" onClick={() => setRun((n) => n + 1)}><RefreshCw size={14} /> Gerar novo QR Code</button>
      ) : (
        <Waiting>{phase === 'loading' ? 'Gerando QR Code…' : 'Aguardando a leitura. O código se atualiza sozinho.'}</Waiting>
      )}
    </div>
  )
}

// Código de pareamento: a pessoa informa o número que vai conectar e digita o código no WhatsApp.
function CodePane({ call, onConnected }) {
  const [phone, setPhone] = useState('55')
  const [code, setCode] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const [run, setRun] = useState(0) // muda a cada código gerado: confere o status até conectar

  const request = async () => {
    const d = onlyDigits(phone)
    if (d.length < 10 || d.length > 15) return setError('Informe o número com DDI e DDD, só dígitos. Ex.: 55119XXXXXXXX.')
    setBusy(true)
    setError('')
    setExpired(false)
    try {
      for (let i = 0; i < 10; i++) {
        const r = await call('zapbot-code', { phone: d })
        if (r.connected) return onConnected(r.phone)
        if (r.error) return setError(r.error)
        if (r.code) {
          setCode(r.code)
          setRun((n) => n + 1)
          return
        }
        await sleep(1500)
      }
      setError('O WhatsApp demorou para gerar o código. Tente de novo.')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!run) return
    let alive = true
    const until = Date.now() + ATTEMPT_MS
    ;(async () => {
      let failures = 0
      while (alive && Date.now() < until) {
        await sleep(2500)
        if (!alive) return
        try {
          const r = await call('status')
          failures = 0
          if (!alive) return
          if (r.state === 'open') return onConnected(r.number)
          if (r.error) return (setCode(null), setError(r.error))
        } catch (e) {
          if (++failures >= 3) return alive && (setCode(null), setError(e.message))
        }
      }
      if (alive) {
        setCode(null)
        setExpired(true)
      }
    })()
    return () => { alive = false }
  }, [run, call]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trocar de número no meio da tentativa: encerra o pareamento atual antes
  const changeNumber = async () => {
    setBusy(true)
    setRun(0)
    try {
      const r = await call('zapbot-reset')
      if (r?.connected) return onConnected(r.phone)
      setCode(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (code) {
    return (
      <div>
        <p className="mb-4 text-sm text-text-secondary">Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone e digite o código:</p>
        <div className="mb-1 flex items-center gap-2">
          <p className="select-all rounded-2xl border border-border bg-surface-overlay px-5 py-3 font-mono text-[28px] font-bold tracking-[0.16em]">{code}</p>
          <button className="btn-secondary" title="Copiar código" onClick={() => { navigator.clipboard?.writeText(code); toast('Código copiado!') }}><Copy size={14} /></button>
        </div>
        <p className="mb-4 text-xs text-text-muted">Para o número +{onlyDigits(phone)}</p>
        <Waiting>Aguardando a confirmação no celular…</Waiting>
        <button className="btn-ghost mt-3 px-0 text-xs" disabled={busy} onClick={changeNumber}>Usar outro número</button>
      </div>
    )
  }
  return (
    <>
      <Field label="Número que vai ser conectado" hint="Com DDI e DDD, só dígitos. Ex.: 55119XXXXXXXX.">
        <input className="input font-mono" inputMode="numeric" autoComplete="tel" placeholder="55119XXXXXXXX" value={phone}
          onChange={(e) => setPhone(onlyDigits(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && !busy && request()} />
      </Field>
      {expired && <p className="mb-3 text-sm text-text-muted">O código expirou. Gere um novo para tentar de novo.</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <button className="btn-primary" disabled={busy} onClick={request}>
        {busy ? <><Loader2 size={15} className="animate-spin" /> Gerando o código…</> : expired ? 'Gerar novo código' : 'Gerar código'}
      </button>
    </>
  )
}

// Conexão pelo Zapbot. A tela só fala com o servidor (connection-setup); as credenciais do Zapbot nunca chegam ao navegador.
// `call` troca o servidor por respostas simuladas no modo demonstração; `onDemoConnect` mostra o botão "Simular leitura".
// `onConnected(phone)` avisa a lista de conexões assim que o número conecta.
export function WebSetup({ connection, onClose, onConnected, call: demoCall, onDemoConnect }) {
  const call = useMemo(() => demoCall || ((action, extra) => callFn('connection-setup', { action, connectionId: connection.id, ...extra })), [demoCall, connection.id])
  const isSuperadmin = useDB((s) => s.isSuperadmin)
  const [ready, setReady] = useState(false)
  const [startError, setStartError] = useState(null) // { message, hint }
  const [retry, setRetry] = useState(0)
  const [mode, setMode] = useState('qr') // abre direto no QR Code; o código fica como alternativa
  const [switching, setSwitching] = useState(false)
  const [done, setDone] = useState(null)

  // Cria a conexão no Zapbot com o webhook desta conexão (uma vez só; ao reabrir, o servidor reaproveita a mesma)
  useEffect(() => {
    let alive = true
    setStartError(null)
    ;(async () => {
      try {
        await waitFor(connection.id)
        await call('zapbot-start')
        if (alive) setReady(true)
      } catch (e) {
        if (alive) setStartError({ message: e.message, hint: e.hint })
      }
    })()
    return () => { alive = false }
  }, [call, connection.id, retry])

  const connected = (phone) => {
    const digits = onlyDigits(phone) || onlyDigits(connection.number)
    setDone({ phone: digits })
    onConnected?.(digits)
    toast('WhatsApp conectado com sucesso!')
  }

  // Um método por vez: ao voltar do código para o QR, cancela o código em andamento
  // (pedir um código já cancela o QR sozinho)
  const switchMode = async (m) => {
    if (m === mode || switching) return
    if (mode === 'code') {
      setSwitching(true)
      try {
        const r = await call('zapbot-reset')
        if (r?.connected) return connected(r.phone)
      } catch {} finally {
        setSwitching(false)
      }
    }
    setMode(m)
  }

  const footer = onDemoConnect && !done && ready
    ? <button className="btn-primary" onClick={() => { setDone({ phone: onlyDigits(onDemoConnect()) }); toast('WhatsApp conectado com sucesso! (simulado)') }}>Simular leitura</button>
    : undefined

  return (
    <Modal open onClose={onClose} title={`Conectar ${connection.name}`} subtitle="As mensagens saem do número que você conectar aqui." footer={footer}>
      {done ? (
        <div className="flex flex-col items-center py-6 text-center">
          <CheckCircle2 size={48} className="mb-3 text-green-400" />
          <p className="font-semibold">WhatsApp conectado com sucesso</p>
          {done.phone && <p className="mt-1 font-mono text-sm">+{done.phone}</p>}
          <p className="mt-1 text-sm text-text-muted">As mensagens desse número já chegam em Chats ao vivo.</p>
          <button className="btn-primary mt-4" onClick={onClose}>Fechar</button>
        </div>
      ) : startError ? (
        <div className="flex flex-col items-start py-2">
          <ErrorNote>{startError.message}</ErrorNote>
          {/* o que ajustar no servidor aparece só para o superadmin; o cliente nunca preenche credenciais */}
          {isSuperadmin && startError.hint && <p className="mb-3 text-xs text-text-muted"><b>Para o administrador:</b> {startError.hint}</p>}
          <button className="btn-primary" onClick={() => setRetry((n) => n + 1)}><RefreshCw size={14} /> Tentar de novo</button>
        </div>
      ) : switching || (mode === 'code' && !ready) ? (
        <div className="py-8"><Waiting>{switching ? 'Trocando o método…' : 'Preparando a conexão…'}</Waiting></div>
      ) : (
        <>
          {mode === 'qr' ? <QrPane call={call} onConnected={connected} ready={ready} /> : <CodePane call={call} onConnected={connected} />}
          <p className="mt-5 border-t border-border-subtle pt-3 text-xs text-text-muted">
            {mode === 'qr' ? 'Não consegue ler o QR Code? ' : 'Prefere ler o QR Code? '}
            <button className="font-semibold text-violet-400 hover:underline" onClick={() => switchMode(mode === 'qr' ? 'code' : 'qr')}>
              {mode === 'qr' ? 'Conectar com código' : 'Conectar com QR Code'}
            </button>
          </p>
        </>
      )}
    </Modal>
  )
}

/* ---------- Z-API: instância que a pessoa já tem ---------- */

// A pessoa cola o ID, o token e o Client-Token da instância (e, no avançado, a URL base). O servidor confere, aponta os
// webhooks da instância para esta conexão e guarda tudo; nada disso volta para o navegador. Depois o pareamento é o mesmo
// do Zapbot (QR Code ou código). Reabrir uma conexão já cadastrada (zapiHint) vai direto para o QR Code.
export function ZapiSetup({ connection, onClose, onConnected, call: demoCall, onDemoConnect }) {
  const call = useMemo(() => demoCall || ((action, extra) => callFn('connection-setup', { action, connectionId: connection.id, ...extra })), [demoCall, connection.id])
  const [step, setStep] = useState(connection.zapiHint ? 'pair' : 'form') // form | pair
  const [f, setF] = useState({ instanceId: '', instanceToken: '', clientToken: '', baseUrl: '' })
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('qr')
  const [switching, setSwitching] = useState(false)
  const [done, setDone] = useState(null)

  const connected = (phone) => {
    const digits = onlyDigits(phone) || onlyDigits(connection.number)
    setDone({ phone: digits })
    onConnected?.(digits)
    toast('WhatsApp conectado com sucesso!')
  }

  const submit = async () => {
    if (!f.instanceId.trim() || !f.instanceToken.trim()) return setError('Informe o ID e o token da instância. O Client-Token é opcional.')
    setBusy(true)
    setError('')
    try {
      await waitFor(connection.id)
      const r = await call('zapi-connect', f)
      if (r?.connected) return connected(r.phone)
      setMode('qr')
      setStep('pair')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const switchMode = async (m) => {
    if (m === mode || switching) return
    if (mode === 'code') {
      setSwitching(true)
      try {
        const r = await call('zapbot-reset')
        if (r?.connected) return connected(r.phone)
      } catch {} finally {
        setSwitching(false)
      }
    }
    setMode(m)
  }

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const footer = step === 'form' && !done
    ? <><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy} onClick={submit}>{busy ? <><Loader2 size={15} className="animate-spin" /> Conferindo…</> : 'Conferir e conectar'}</button></>
    : onDemoConnect && !done
      ? <button className="btn-primary" onClick={() => { setDone({ phone: onlyDigits(onDemoConnect()) }); toast('WhatsApp conectado com sucesso! (simulado)') }}>Simular leitura</button>
      : undefined

  return (
    <Modal open onClose={onClose} title={`Conectar ${connection.name}`} subtitle="Z-API: use uma instância que você já tem" footer={footer}>
      {done ? (
        <div className="flex flex-col items-center py-6 text-center">
          <CheckCircle2 size={48} className="mb-3 text-green-400" />
          <p className="font-semibold">WhatsApp conectado com sucesso</p>
          {done.phone && <p className="mt-1 font-mono text-sm">+{done.phone}</p>}
          <p className="mt-1 text-sm text-text-muted">As mensagens desse número já chegam em Chats ao vivo.</p>
          <button className="btn-primary mt-4" onClick={onClose}>Fechar</button>
        </div>
      ) : step === 'form' ? (
        <>
          <p className="mb-4 text-sm text-text-secondary">Copie os dados da instância no painel do Z-API, em Instâncias. Eles ficam guardados só no servidor.</p>
          <Field label="ID da instância">
            <input className="input font-mono text-xs" autoFocus autoComplete="off" value={f.instanceId} onChange={set('instanceId')} />
          </Field>
          <Field label="Token da instância">
            <input className="input font-mono text-xs" type="password" autoComplete="off" value={f.instanceToken} onChange={set('instanceToken')} />
          </Field>
          <Field label="Client-Token (opcional)" hint="Só preencha se você ligou o token de segurança da conta no Z-API.">
            <input className="input font-mono text-xs" type="password" autoComplete="off" value={f.clientToken} onChange={set('clientToken')} />
          </Field>
          {advanced ? (
            <Field label="URL base" hint="Endereço do Z-API. Deixe em branco para usar o padrão, https://api.z-api.io.">
              <input className="input font-mono text-xs" placeholder="https://api.z-api.io" value={f.baseUrl} onChange={set('baseUrl')} />
            </Field>
          ) : (
            <button className="btn-ghost mb-3 px-0 text-xs" onClick={() => setAdvanced(true)}>Avançado: trocar a URL base</button>
          )}
          <p className="mb-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-400">
            O Vórtex CRM configura sozinho os webhooks dessa instância para receber as mensagens. Se outro sistema usa os webhooks dela, ele deixa de receber.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </>
      ) : switching ? (
        <div className="py-8"><Waiting>Trocando o método…</Waiting></div>
      ) : (
        <>
          {mode === 'qr' ? <QrPane call={call} onConnected={connected} /> : <CodePane call={call} onConnected={connected} />}
          <p className="mt-5 border-t border-border-subtle pt-3 text-xs text-text-muted">
            {mode === 'qr' ? 'Não consegue ler o QR Code? ' : 'Prefere ler o QR Code? '}
            <button className="font-semibold text-violet-400 hover:underline" onClick={() => switchMode(mode === 'qr' ? 'code' : 'qr')}>
              {mode === 'qr' ? 'Conectar com código' : 'Conectar com QR Code'}
            </button>
          </p>
          <p className="mt-2 text-xs text-text-muted">
            {connection.zapiHint ? `Instância ${connection.zapiHint}. ` : ''}
            <button className="font-semibold text-violet-400 hover:underline" onClick={() => { setError(''); setStep('form') }}>Usar outra instância</button>
          </p>
        </>
      )}
    </Modal>
  )
}

// Evolution API (servidor próprio). Fora da tela de Conexões, que só oferece QR Code e código; mantida para reativar se precisar.
// Cria a instância, liga o webhook e mostra o QR Code. Confere o status a cada 4s.
export function EvolutionSetup({ connection, onClose }) {
  const [f, setF] = useState(() => {
    let baseUrl = ''
    try { baseUrl = localStorage.getItem('evo-base') || '' } catch {}
    return { baseUrl, apiKey: '', instance: '' }
  })
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState(null)
  const [pairing, setPairing] = useState(null)
  const [waiting, setWaiting] = useState(false)
  const [connected, setConnected] = useState(false)

  const start = async () => {
    if (!f.baseUrl || !f.apiKey) return toast('Informe a URL e a API Key da sua Evolution.', 'error')
    setBusy(true)
    try {
      await waitFor(connection.id)
      try { localStorage.setItem('evo-base', f.baseUrl) } catch {}
      const r = await callFn('connection-setup', { action: 'evolution-connect', connectionId: connection.id, ...f })
      setQr(r.qr)
      setPairing(r.pairingCode)
      setWaiting(true)
      if (!r.qr && !r.pairingCode) toast('A Evolution não devolveu QR. Talvez a instância já esteja conectada — vou conferir.', 'info')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const refreshQr = async () => {
    try {
      const r = await callFn('connection-setup', { action: 'qr', connectionId: connection.id })
      setQr(r.qr)
      setPairing(r.pairingCode)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  useEffect(() => {
    if (!waiting) return
    const t = setInterval(async () => {
      try {
        const r = await callFn('connection-setup', { action: 'status', connectionId: connection.id })
        if (r.state === 'open') {
          setConnected(true)
          setWaiting(false)
          toast(`WhatsApp conectado${r.number ? `: ${r.number}` : ''}!`)
        }
      } catch {}
    }, 4000)
    return () => clearInterval(t)
  }, [waiting, connection.id])

  return (
    <Modal open onClose={onClose} title={`Conectar ${connection.name}`} subtitle="Evolution API — conecta lendo o QR Code no WhatsApp do celular">
      {connected ? (
        <div className="flex flex-col items-center py-6 text-center">
          <CheckCircle2 size={48} className="mb-3 text-green-400" />
          <p className="font-semibold">Conectado!</p>
          <p className="text-sm text-text-muted">As mensagens desse número já chegam em Chats ao vivo.</p>
          <button className="btn-primary mt-4" onClick={onClose}>Fechar</button>
        </div>
      ) : waiting ? (
        <div className="flex flex-col items-center">
          {qr && <img src={qrSrc(qr)} alt="QR Code do WhatsApp" className="h-64 w-64 rounded-xl bg-white p-2" />}
          {pairing && <p className="mt-3 text-sm">Ou use o código de pareamento: <b className="font-mono text-violet-300">{pairing}</b></p>}
          <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho</p>
          <button className="btn-secondary mt-4" onClick={refreshQr}><RefreshCw size={14} /> Gerar novo QR</button>
        </div>
      ) : (
        <>
          <Field label="URL da sua Evolution API" hint="O endereço público do servidor onde a Evolution roda (precisa ser acessível pela internet).">
            <input className="input" placeholder="https://evolution.seudominio.com" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
          </Field>
          <Field label="API Key global" hint="A AUTHENTICATION_API_KEY configurada na sua Evolution. Fica guardada só no servidor.">
            <input className="input font-mono" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
          </Field>
          <Field label="Nome da instância (opcional)" hint="Se deixar vazio, crio uma instância nova com nome automático.">
            <input className="input" placeholder={`vortex-crm-${connection.id.slice(0, 8)}`} value={f.instance} onChange={(e) => setF({ ...f, instance: e.target.value })} />
          </Field>
          <button className="btn-primary w-full" disabled={busy} onClick={start}>
            {busy ? <><Loader2 size={15} className="animate-spin" /> Criando instância…</> : <><QrCode size={15} /> Gerar QR Code</>}
          </button>
        </>
      )}
    </Modal>
  )
}

function MetaWebhookSteps({ webhookUrl, verifyToken, header }) {
  return (
    <>
      {header}
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-text-secondary">
        <li>No app da Meta, vá em <b>WhatsApp → Configuração</b> → <b>Webhook → Editar</b>.</li>
        <li>Cole a <b>URL de callback</b> e o <b>Token de verificação</b> abaixo e clique em <b>Verificar e salvar</b>.</li>
        <li>Em <b>Campos do webhook</b>, clique em <b>Gerenciar</b> e assine <b>messages</b>.</li>
      </ol>
      <CopyField label="URL de callback" value={webhookUrl} />
      <CopyField label="Token de verificação" value={verifyToken} />
    </>
  )
}

// Cloud API da Meta, configuração manual (avançado, só superadmin): valida o token e devolve a URL do webhook
// + token de verificação para colar no app da Meta. O caminho normal é o "Entrar com o Facebook" (MetaSetup).
export function MetaManualSetup({ connection, onClose }) {
  const [f, setF] = useState({ phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const save = async () => {
    if (!f.phoneNumberId || !f.accessToken) return toast('Informe o Phone Number ID e o Access Token.', 'error')
    setBusy(true)
    try {
      await waitFor(connection.id)
      const r = await callFn('connection-setup', { action: 'save-meta', connectionId: connection.id, ...f })
      setDone(r)
      toast(`Número ${r.number} validado na Meta!`)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`Conectar ${connection.name}`} subtitle="Cloud API oficial da Meta" size="lg">
      {done ? (
        <MetaWebhookSteps webhookUrl={done.webhookUrl} verifyToken={done.verifyToken}
          header={<p className="mb-4 rounded-xl bg-green-500/10 p-3 text-sm text-green-400">✓ {done.name} ({done.number}) conectado. Falta só o último passo:</p>} />
      ) : (
        <>
          <p className="mb-4 text-sm text-text-secondary">
            No <b>developers.facebook.com</b>, abra seu app → <b>WhatsApp → Configuração da API</b>. Lá estão o Phone Number ID e o ID da conta (WABA).
            Para produção, use um token permanente de <b>usuário do sistema</b> (Business Manager → Usuários do sistema).
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Phone Number ID*"><input className="input font-mono" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} /></Field>
            <Field label="WhatsApp Business Account ID"><input className="input font-mono" value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} /></Field>
          </div>
          <Field label="Access Token*" hint="Fica guardado só no servidor; o painel nunca mais mostra.">
            <input className="input font-mono" type="password" autoComplete="off" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} />
          </Field>
          <Field label="App Secret (recomendado)" hint="Com ele, o webhook confere a assinatura da Meta e recusa chamadas falsas. Fica em Configurações do app → Básico.">
            <input className="input font-mono" type="password" autoComplete="off" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} />
          </Field>
          <button className="btn-primary w-full" disabled={busy} onClick={save}>
            {busy ? <><Loader2 size={15} className="animate-spin" /> Validando na Meta…</> : <><ShieldCheck size={15} /> Validar e conectar</>}
          </button>
        </>
      )}
    </Modal>
  )
}

export function WebhookInfo({ connection, onClose }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    callFn('connection-setup', { action: 'webhook-info', connectionId: connection.id })
      .then(setInfo)
      .catch((e) => { toast(e.message, 'error'); onClose() })
  }, [connection.id]) // eslint-disable-line
  return (
    <Modal open onClose={onClose} title="Webhook da Meta" subtitle={connection.name} size="lg">
      {info ? <MetaWebhookSteps webhookUrl={info.webhookUrl} verifyToken={info.verifyToken} /> : <p className="py-6 text-center text-sm text-text-muted"><Loader2 size={16} className="mr-2 inline animate-spin" />Carregando…</p>}
    </Modal>
  )
}
