import { useState } from 'react'
import { CheckCircle2, Clock, ExternalLink, KeyRound, Loader2, ShieldCheck, UserCheck } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import { callFn } from '../lib/backend'
import { ChannelIcon, igHandle } from '../components/Channel'
import { Modal } from '../components/ui'
import { cx } from '../lib/utils'

// Conexão do Instagram (Direct) pela chave da Zernio de quem conecta.
// O login no Instagram é feito só na Zernio (zernio.com). Aqui a pessoa cola a chave da API dela, o CRM lista os
// Instagrams que já estão conectados nessa conta e ela escolhe um. O servidor guarda a chave no Vault e cadastra o
// webhook desta conexão na conta dela (connection-setup: instagram-key-check / instagram-key-connect).

const RULES = [
  [ShieldCheck, 'Login só na Zernio', 'O Instagram é conectado no painel da Zernio, pela API oficial da Meta. O CRM não pede senha nem abre login.'],
  [UserCheck, 'Só quem escreveu primeiro', 'O CRM responde quem mandou Direct. Não dá para puxar conversa nem fazer disparo em massa.'],
  [Clock, 'Janela de resposta', 'Até 24 h depois da última mensagem do cliente, normal. De 24 h a 7 dias, só a equipe responde. Depois disso, espere ele escrever.'],
]

export function InstagramIntro() {
  return (
    <div className="mb-4 space-y-2.5">
      {RULES.map(([I, t, d]) => (
        <div key={t} className="flex gap-2.5 rounded-xl border border-border-subtle p-2.5">
          <I size={16} className="mt-0.5 shrink-0 text-violet-400" />
          <div><p className="text-xs font-semibold">{t}</p><p className="text-xs text-text-muted">{d}</p></div>
        </div>
      ))}
    </div>
  )
}

// Conexão recém-criada: a gravação no banco corre em paralelo, então tenta de novo enquanto ela não aparece (404)
async function call(body) {
  for (let i = 0; ; i++) {
    try {
      return await callFn('connection-setup', body)
    } catch (e) {
      if (i >= 4 || !/não encontrada/i.test(e.message)) throw e
      await new Promise((r) => setTimeout(r, 600))
    }
  }
}

// Modo demonstração: responde como o servidor
const DEMO_ACCOUNTS = [
  { accountId: 'demo-ig-1', username: 'vortex.demo', displayName: 'Vórtex Demo', picture: null, taken: false },
  { accountId: 'demo-ig-2', username: 'loja.demo', displayName: 'Loja Demo', picture: null, taken: false },
]
async function demoCall({ action, apiKey, accountId }) {
  await new Promise((r) => setTimeout(r, 700))
  if (action === 'instagram-key-check') {
    if (!/^(sk|zrk)_[A-Za-z0-9_-]{16,}$/.test(String(apiKey || '').trim())) throw new Error('Cole a chave da API da Zernio (começa com sk_ ou zrk_).')
    return { accounts: DEMO_ACCOUNTS, keyHint: `••••${apiKey.trim().slice(-4)}` }
  }
  const a = DEMO_ACCOUNTS.find((x) => x.accountId === accountId)
  return { connected: true, username: a.username, displayName: a.displayName }
}

export function InstagramKeySetup({ connection, onClose }) {
  const db = useDB()
  const [key, setKey] = useState('')
  const [accounts, setAccounts] = useState(null)
  const [hint, setHint] = useState('')
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = BACKEND ? call : demoCall

  const check = async () => {
    setBusy(true); setErr('')
    try {
      const r = await run({ action: 'instagram-key-check', connectionId: connection.id, apiKey: key.trim() })
      if (!r.accounts?.length) { setErr(r.error || 'Nenhum Instagram nessa conta da Zernio.'); return }
      setAccounts(r.accounts)
      setHint(r.keyHint || '')
      const free = r.accounts.filter((a) => !a.taken)
      if (free.length === 1) setPick(free[0].accountId)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    setBusy(true); setErr('')
    try {
      const r = await run({ action: 'instagram-key-connect', connectionId: connection.id, apiKey: key.trim(), accountId: pick })
      const a = accounts.find((x) => x.accountId === pick)
      // o servidor já gravou; aqui só atualiza a tela na hora (o tempo real confirma em seguida)
      if (BACKEND) useDB.setState((s) => ({ connections: s.connections.map((c) => (c.id === connection.id ? { ...c, status: 'connected', number: igHandle(r.username), igName: a?.displayName, keyHint: hint } : c)) }))
      else db.update('connections', connection.id, { status: 'connected', number: igHandle(r.username), igName: a?.displayName, keyHint: hint, alert: null })
      toast(`Instagram ${igHandle(r.username)} conectado!`)
      setKey('')
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Conectar Instagram" subtitle={`Conexão "${connection.name}"${BACKEND ? '' : ' · modo demonstração'}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
        {accounts
          ? <button className="btn-primary" disabled={!pick || busy} onClick={connect}>{busy && <Loader2 size={14} className="animate-spin" />} Conectar</button>
          : <button className="btn-primary" disabled={key.trim().length < 10 || busy} onClick={check}>{busy && <Loader2 size={14} className="animate-spin" />} Buscar Instagrams</button>}
      </>}>
      {!accounts ? (
        <>
          <p className="mb-3 text-sm text-text-secondary">
            Cole a <b className="text-text-primary">chave da API da Zernio</b> da conta onde o seu Instagram já está conectado. O CRM mostra os
            Instagrams dessa conta e você escolhe qual vai nesta conexão.
          </p>
          <label className="mb-1 block text-xs font-semibold text-text-secondary">Chave da API da Zernio</label>
          <div className="relative">
            <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input className="input pl-9 font-mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk_… ou zrk_…" value={key}
              onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim().length >= 10) check() }} autoFocus />
          </div>
          <p className="mt-2 text-xs text-text-muted">
            Gere em zernio.com → Settings → API Keys. Prefira uma chave restrita (zrk_) só com contas, mensagens e webhooks. Ela fica guardada
            criptografada no servidor e não aparece de novo.
          </p>
          <a href="https://zernio.com/dashboard" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-violet-300 hover:underline">
            Abrir a Zernio <ExternalLink size={12} />
          </a>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-text-secondary">Instagrams conectados na conta da chave <span className="font-mono">{hint}</span>:</p>
          <div className="space-y-2">
            {accounts.map((a) => (
              <button key={a.accountId} disabled={a.taken} onClick={() => setPick(a.accountId)}
                className={cx('flex w-full items-center gap-3 rounded-[14px] border p-3 text-left transition disabled:opacity-50', pick === a.accountId ? 'choice-on' : 'border-border hover:border-border-hover')}>
                {a.picture ? <img src={a.picture} alt="" className="h-9 w-9 rounded-full object-cover" /> : <ChannelIcon channel="instagram" size={36} className="rounded-full" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{a.displayName || igHandle(a.username)}</p>
                  <p className="truncate text-xs text-text-muted">{igHandle(a.username)}{a.taken ? ' · já está em outra conexão' : ''}</p>
                </div>
                {pick === a.accountId && <CheckCircle2 size={17} className="text-green-400" />}
              </button>
            ))}
          </div>
          <button className="btn-ghost mt-3 px-2 py-1 text-xs" onClick={() => { setAccounts(null); setPick('') }}>Usar outra chave</button>
        </>
      )}
      {err && <p className="mt-3 rounded-xl bg-red-500/10 p-2.5 text-xs text-red-400">{err}</p>}
    </Modal>
  )
}
