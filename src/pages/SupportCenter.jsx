// Central de suporte do superadmin: atendimentos abertos pelo botão Suporte em todas as empresas.
// Ler todos e responder como equipe é permitido só ao superadmin (políticas e funções support_* do banco).
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Building2, Clock, Inbox, LifeBuoy, Loader2, Mail, UserRound } from 'lucide-react'
import { useDB } from '../lib/store'
import { SUPPORT_STATUS, isPending, sendSupport, setAdminActive, setDraft, setSupportStatus, useSupport } from '../lib/support'
import { cx, fmtDate } from '../lib/utils'
import { Avatar, PageHeader, SearchInput } from '../components/ui'
import { SupportComposer, SupportMessages, SupportStatusBadge, ago } from '../components/SupportThread'
import { Metric } from './SuperAdmin'

const EMPTY = []
const FILTERS = {
  pending: { label: 'Aguardando resposta', test: isPending },
  open: { label: 'Abertos', test: (t) => t.status === 'open' },
  in_progress: { label: 'Em atendimento', test: (t) => t.status === 'in_progress' },
  resolved: { label: 'Resolvidos', test: (t) => t.status === 'resolved' },
  all: { label: 'Todos', test: () => true },
}

export function SuperSupport() {
  const { id } = useParams()
  const nav = useNavigate()
  const all = useSupport((s) => s.all)
  const loaded = useSupport((s) => s.loadedAll)
  const [q, setQ] = useState('')
  const [st, setSt] = useState('all')

  // conversa aberta: carrega as mensagens e marca como lida (e de novo a cada mensagem nova enquanto estiver aberta)
  useEffect(() => {
    setAdminActive(id)
    return () => setAdminActive(null)
  }, [id])

  const count = (k) => all.filter(FILTERS[k].test).length
  const unreadTickets = all.filter((t) => t.adminUnread > 0).length
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^#/, '')
    return all.filter((t) => FILTERS[st].test(t) && (!term || `${t.number} ${t.userName} ${t.userEmail} ${t.companyName} ${t.subject}`.toLowerCase().includes(term)))
  }, [all, st, q])
  const selected = all.find((t) => t.id === id)
  const pick = (k) => setSt((cur) => (cur === k && k !== 'all' ? 'all' : k))

  return (
    <div>
      <div className={cx(id && 'hidden lg:block')}>
        <PageHeader icon={LifeBuoy} title="Central de suporte" subtitle="Atendimentos abertos pelo botão Suporte em todas as empresas. Atualiza sozinha." />
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Metric label="Aguardando resposta" value={count('pending')} icon={Clock} tone={count('pending') ? 'text-amber-400' : undefined} onClick={() => pick('pending')} active={st === 'pending'} />
          <Metric label="Abertos" value={count('open')} onClick={() => pick('open')} active={st === 'open'} />
          <Metric label="Em atendimento" value={count('in_progress')} tone="text-blue-400" onClick={() => pick('in_progress')} active={st === 'in_progress'} />
          <Metric label="Resolvidos" value={count('resolved')} tone="text-green-400" onClick={() => pick('resolved')} active={st === 'resolved'} />
          <Metric label="Todos" value={all.length} icon={Inbox} onClick={() => setSt('all')} active={st === 'all'} />
        </div>
      </div>

      <div className="card flex h-[calc(100dvh-150px)] min-h-[460px] overflow-hidden p-0 lg:h-[calc(100dvh-330px)] lg:min-h-[520px]">
        {/* Lista */}
        <aside className={cx('w-full flex-col border-r border-border-subtle lg:flex lg:w-[380px] lg:shrink-0', id ? 'hidden' : 'flex')}>
          <div className="space-y-2.5 border-b border-border-subtle p-3">
            <SearchInput value={q} onChange={setQ} placeholder="Usuário, e-mail, empresa ou #número…" />
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>{FILTERS[st].label} · {rows.length}</span>
              {unreadTickets > 0 && <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" /> {unreadTickets} com mensagem nova</span>}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!loaded ? (
              <p className="flex items-center justify-center gap-2 py-10 text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando atendimentos…</p>
            ) : rows.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-text-muted">{all.length ? 'Nenhum atendimento neste filtro.' : 'Nenhum atendimento ainda. Quando um usuário escrever pelo botão Suporte, o atendimento aparece aqui na hora.'}</p>
            ) : (
              rows.map((t) => <TicketRow key={t.id} t={t} active={t.id === id} onClick={() => nav('/superadmin/suporte/' + t.id)} />)
            )}
          </div>
        </aside>

        {/* Conversa */}
        <section className={cx('min-w-0 flex-1 flex-col', id ? 'flex' : 'hidden lg:flex')}>
          {selected ? (
            <Conversation key={selected.id} t={selected} onBack={() => nav('/superadmin/suporte')} />
          ) : id && !loaded ? (
            <p className="m-auto flex items-center gap-2 text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando…</p>
          ) : (
            <div className="m-auto max-w-xs px-6 text-center">
              <div className="icon-tile mx-auto mb-3 h-12 w-12"><LifeBuoy size={20} /></div>
              <p className="text-sm text-text-primary" style={{ fontWeight: 650 }}>{id ? 'Atendimento não encontrado' : 'Escolha um atendimento'}</p>
              <p className="mt-1 text-xs text-text-muted">{id ? 'Ele pode ter sido removido junto com a empresa.' : 'A conversa, o histórico e a resposta ficam aqui.'}</p>
              {id && <Link to="/superadmin/suporte" className="btn-secondary mt-4 text-xs"><ArrowLeft size={14} /> Ver todos</Link>}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TicketRow({ t, active, onClick }) {
  const unread = t.adminUnread > 0
  return (
    <button onClick={onClick} className={cx('flex w-full gap-3 border-b border-border-subtle px-3.5 py-3 text-left transition', active ? 'is-selected' : 'hover:bg-surface-interactive')}>
      <Avatar name={t.userName || t.userEmail} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-text-primary" style={{ fontWeight: unread ? 750 : 600 }}>{t.userName || t.userEmail}</p>
          <span className="ml-auto shrink-0 text-[11px] text-text-muted">{ago(t.lastMessageAt)}</span>
        </div>
        <p className="flex items-center gap-1 truncate text-[11px] text-text-muted"><Building2 size={11} className="shrink-0" /> <span className="truncate">{t.companyName || 'Empresa sem nome'}</span></p>
        <p className={cx('mt-1 truncate text-xs', unread ? 'text-text-primary' : 'text-text-secondary')}>{t.lastSender === 'admin' ? 'Equipe: ' : ''}{t.lastMessagePreview}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <SupportStatusBadge status={t.status} />
          <span className="text-[11px] text-text-muted">#{t.number}</span>
          {isPending(t) && <span className="badge-danger"><Clock size={10} /> Aguardando resposta</span>}
        </div>
      </div>
      {unread && <span className="support-count static self-center" title="Mensagens novas">{t.adminUnread > 9 ? '9+' : t.adminUnread}</span>}
    </button>
  )
}

function Conversation({ t, onBack }) {
  const meId = useDB((s) => s.user.id)
  const messages = useSupport((s) => s.messages[t.id]) || EMPTY
  const loaded = useSupport((s) => !!s.msgLoaded[t.id])
  const draftKey = 'admin:' + t.id
  const draft = useSupport((s) => s.drafts[draftKey]) || ''

  const send = () => {
    const body = draft
    setDraft(draftKey, '')
    sendSupport(t.id, body, { asAdmin: true })
  }

  return (
    <>
      <header className="border-b border-border-subtle px-4 py-3">
        <div className="flex items-start gap-3">
          <button className="btn-ghost -ml-1 h-9 w-9 shrink-0 p-0 lg:hidden" onClick={onBack} aria-label="Voltar para a lista"><ArrowLeft size={18} /></button>
          <Avatar name={t.userName || t.userEmail} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] text-text-primary" style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>{t.userName || t.userEmail}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
              <span className="flex min-w-0 items-center gap-1"><Mail size={12} className="shrink-0" /> <span className="truncate">{t.userEmail}</span></span>
              <Link to={`/superadmin/empresas/${t.companyId}`} className="link-accent flex min-w-0 items-center gap-1" title="Abrir a empresa no painel"><Building2 size={12} className="shrink-0" /> <span className="truncate">{t.companyName || 'Empresa'}</span></Link>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-xs text-text-muted">
            <b className="text-text-primary">#{t.number}</b> · aberto em {fmtDate(t.createdAt)}
            {t.assignedName && <> · <UserRound size={11} className="inline" /> {t.assignedName}</>}
          </p>
          <div className="seg shrink-0" role="radiogroup" aria-label="Status do atendimento">
            {Object.entries(SUPPORT_STATUS).map(([k, s]) => (
              <button
                key={k}
                role="radio"
                aria-checked={t.status === k}
                onClick={() => t.status !== k && setSupportStatus(t.id, k)}
                className={cx('px-2.5 py-1 text-xs transition', t.status === k ? 'is-selected' : 'text-text-secondary hover:text-text-primary')}
                style={{ fontWeight: 650 }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <SupportMessages messages={messages} viewer="admin" meId={meId} loading={!loaded} onRetry={(m) => sendSupport(t.id, m.body, { asAdmin: true, retry: m })} />
      <SupportComposer
        value={draft}
        onChange={(v) => setDraft(draftKey, v)}
        onSend={send}
        placeholder={`Responder ${t.userName ? t.userName.split(' ')[0] : 'o usuário'}…`}
        hint={t.status === 'resolved' ? 'Este atendimento está resolvido. Responder reabre o atendimento como "Em atendimento".' : t.status === 'open' ? 'A primeira resposta muda o status para "Em atendimento".' : undefined}
      />
    </>
  )
}
