// Botão "Suporte" (canto inferior direito) e janela de atendimento com a equipe Vórtex CRM.
// É separado do Chat Ao Vivo: aqui a conversa é entre quem usa o painel e o suporte da plataforma.
// Minimizar e fechar só escondem a janela: a conversa fica no banco e o rascunho fica guardado.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, MessageCircle, MessageSquarePlus, Minus, X } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BRAND } from '../lib/brand'
import {
  closeSupport, isPending, minimizeSupport, newSupport, openSupport, openTicket, sendSupport, setDraft, showTicket, supportHome,
  useMyTickets, useMyUnread, useSupport,
} from '../lib/support'
import { cx } from '../lib/utils'
import { SupportComposer, SupportMessages, SupportStatusBadge, TeamMark, ago } from './SupportThread'

const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches
const phone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches

// No celular, o teclado cobre a parte de baixo da tela: a janela sobe junto (visualViewport)
function useKeyboardInset(active) {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!active || !vv) return
    const h = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    h()
    vv.addEventListener('resize', h)
    vv.addEventListener('scroll', h)
    return () => {
      vv.removeEventListener('resize', h)
      vv.removeEventListener('scroll', h)
      setInset(0)
    }
  }, [active])
  return inset > 80 ? inset : 0
}

const countLabel = (n) => (n > 9 ? '9+' : String(n))

export default function SupportWidget({ place = 'default' }) {
  const ui = useSupport((s) => s.ui)
  const unread = useMyUnread()
  const open = ui === 'open'

  return (
    <div className="support-dock" data-place={place}>
      {open && <SupportWindow />}
      {ui === 'minimized' && <MinimizedBar unread={unread} />}
      <button
        type="button"
        onClick={() => (open ? closeSupport() : openSupport())}
        className={cx('support-bubble', open && 'max-sm:hidden')}
        aria-label={open ? 'Fechar suporte' : unread ? `Abrir suporte (${unread} ${unread === 1 ? 'mensagem nova' : 'mensagens novas'})` : 'Abrir suporte'}
        aria-expanded={open}
        title={`Suporte ${BRAND.name}`}
      >
        {open ? <ChevronDown size={17} strokeWidth={2.4} /> : <MessageCircle size={16} strokeWidth={2} fill="currentColor" />}
        Suporte
        {!open && unread > 0 && <span className="support-count">{countLabel(unread)}</span>}
      </button>
    </div>
  )
}

function MinimizedBar({ unread }) {
  const { view, activeId } = useSupport()
  const tickets = useMyTickets()
  const t = tickets.find((x) => x.id === activeId)
  const label = view === 'chat' && t ? `Atendimento #${t.number}` : view === 'new' ? 'Novo atendimento' : 'Seus atendimentos'
  return (
    <div className="support-pill glass-modal animate-fade-in">
      <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left" onClick={() => openSupport()} title="Abrir a conversa">
        <TeamMark size={24} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-text-primary" style={{ fontWeight: 650 }}>{label}</span>
          <span className="block truncate text-[11px] text-text-muted">Suporte {BRAND.name}</span>
        </span>
        {unread > 0 && <span className="support-count static ml-auto">{countLabel(unread)}</span>}
      </button>
      <button className="btn-ghost h-8 w-8 shrink-0 p-0" onClick={closeSupport} aria-label="Fechar suporte" title="Fechar">
        <X size={15} />
      </button>
    </div>
  )
}

function SupportWindow() {
  const { view, activeId, drafts, messages, msgLoaded, loadedMine } = useSupport()
  const tickets = useMyTickets()
  const userName = useDB((s) => s.user.name)
  const meId = useDB((s) => s.user.id)
  const ticket = tickets.find((t) => t.id === activeId)
  const keyboard = useKeyboardInset(true)
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)

  // abriu a conversa de um atendimento que não é desta empresa (troca de empresa): volta para a lista
  useEffect(() => {
    if (view === 'chat' && loadedMine && !ticket) supportHome()
  }, [view, loadedMine, ticket])

  // no computador o cursor já vai para o campo; no celular, não (abriria o teclado sem a pessoa pedir)
  useEffect(() => {
    if ((view === 'new' || view === 'chat') && finePointer()) inputRef.current?.focus()
  }, [view, activeId])

  const draftKey = view === 'new' ? 'new' : activeId
  const draft = drafts[draftKey] || ''

  const sendNew = async () => {
    const body = draft
    setBusy(true)
    try {
      await openTicket(body)
      setDraft('new', '')
    } catch (e) {
      toast(`Não foi possível abrir o atendimento: ${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  const sendReply = () => {
    const body = draft
    setDraft(activeId, '')
    sendSupport(activeId, body)
  }

  const style = keyboard && phone() ? { bottom: keyboard + 8, top: 8 } : undefined

  return (
    <section
      className="support-window glass-modal animate-fade-in"
      style={style}
      role="dialog"
      aria-label={`Suporte ${BRAND.name}`}
      onKeyDown={(e) => e.key === 'Escape' && minimizeSupport()}
    >
      <header className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-3">
        {view !== 'home' ? (
          <button className="btn-ghost h-9 w-9 shrink-0 p-0" onClick={supportHome} aria-label="Voltar para seus atendimentos" title="Seus atendimentos">
            <ArrowLeft size={18} />
          </button>
        ) : (
          <span className="pl-1"><TeamMark size={34} /></span>
        )}
        <div className="min-w-0 flex-1">
          {view === 'chat' && ticket ? (
            <>
              <p className="flex items-center gap-2 text-[15px] text-text-primary" style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>
                Atendimento #{ticket.number} <SupportStatusBadge status={ticket.status} />
              </p>
              <p className="truncate text-xs text-text-muted" title={ticket.subject}>{ticket.subject}</p>
            </>
          ) : (
            <>
              <p className="text-[15px] text-text-primary" style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>{view === 'new' ? 'Novo atendimento' : `Suporte ${BRAND.name}`}</p>
              <p className="truncate text-xs text-text-muted">Fale com a nossa equipe por aqui</p>
            </>
          )}
        </div>
        <button className="btn-ghost h-9 w-9 shrink-0 p-0" onClick={minimizeSupport} aria-label="Minimizar" title="Minimizar">
          <Minus size={18} />
        </button>
        <button className="btn-ghost h-9 w-9 shrink-0 p-0" onClick={closeSupport} aria-label="Fechar" title="Fechar">
          <X size={18} />
        </button>
      </header>

      {view === 'home' && <Home tickets={tickets} loaded={loadedMine} name={userName} />}

      {view === 'new' && (
        <>
          <SupportMessages
            messages={[]}
            viewer="user"
            meId={meId}
            intro={`Olá${userName ? ', ' + userName.split(' ')[0] : ''}! Conte o que está acontecendo. A equipe ${BRAND.name} responde nesta mesma conversa.`}
          />
          <SupportComposer inputRef={inputRef} value={draft} onChange={(v) => setDraft('new', v)} onSend={sendNew} busy={busy} placeholder="Descreva sua dúvida ou problema…" />
        </>
      )}

      {view === 'chat' && ticket && (
        <>
          <SupportMessages
            key={ticket.id}
            messages={messages[ticket.id] || []}
            viewer="user"
            meId={meId}
            loading={!msgLoaded[ticket.id]}
            onRetry={(m) => sendSupport(ticket.id, m.body, { retry: m })}
          />
          {ticket.status === 'resolved' ? (
            <div className="border-t border-border-subtle p-3 text-center" style={{ background: 'var(--material-control)' }}>
              <p className="text-sm text-text-secondary">Este atendimento foi resolvido.</p>
              <button className="btn-primary mt-2 w-full" onClick={newSupport}><MessageSquarePlus size={16} /> Iniciar novo atendimento</button>
            </div>
          ) : (
            <SupportComposer
              inputRef={inputRef}
              value={draft}
              onChange={(v) => setDraft(ticket.id, v)}
              onSend={sendReply}
              hint={isPending(ticket) && ticket.status === 'open' ? 'Recebemos sua mensagem. A resposta aparece aqui, e o botão Suporte avisa quando chegar.' : undefined}
            />
          )}
        </>
      )}
    </section>
  )
}

function Home({ tickets, loaded, name }) {
  const active = tickets.filter((t) => t.status !== 'resolved')
  const resolved = tickets.filter((t) => t.status === 'resolved')
  const [showAll, setShowAll] = useState(false)
  const shownResolved = showAll ? resolved : resolved.slice(0, 3)

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain p-3.5">
      <div className="panel-soft p-4">
        <p className="text-[17px] text-text-primary" style={{ fontWeight: 700, letterSpacing: '-0.03em' }}>Olá{name ? `, ${name.split(' ')[0]}` : ''}!</p>
        <p className="mt-1 text-sm text-text-secondary">Como podemos ajudar? Escreva para a equipe {BRAND.name} e acompanhe a resposta aqui mesmo.</p>
        <button className="btn-primary mt-3 w-full" onClick={newSupport}>
          <MessageSquarePlus size={16} /> Iniciar novo atendimento
        </button>
      </div>

      {!loaded && (
        <p className="flex items-center justify-center gap-2 py-8 text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando seus atendimentos…</p>
      )}

      {active.length > 0 && (
        <TicketGroup title={active.length === 1 ? 'Continue seu atendimento' : 'Em andamento'}>
          {active.map((t) => <TicketRow key={t.id} t={t} />)}
        </TicketGroup>
      )}

      {resolved.length > 0 && (
        <TicketGroup title="Resolvidos">
          {shownResolved.map((t) => <TicketRow key={t.id} t={t} />)}
          {resolved.length > 3 && (
            <button className="link-accent w-full py-1.5 text-center text-xs" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Mostrar menos' : `Ver todos (${resolved.length})`}
            </button>
          )}
        </TicketGroup>
      )}

      {loaded && !tickets.length && (
        <p className="px-4 py-8 text-center text-xs text-text-muted">Você ainda não abriu nenhum atendimento. O histórico das conversas fica guardado aqui.</p>
      )}
    </div>
  )
}

function TicketGroup({ title, children }) {
  return (
    <div className="mt-4">
      <p className="eyebrow-label mb-2 px-1">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

function TicketRow({ t }) {
  const unread = t.userUnread > 0
  return (
    <button onClick={() => showTicket(t.id)} className="card flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:border-border-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <SupportStatusBadge status={t.status} />
          <span className="text-[11px] text-text-muted">#{t.number}</span>
          <span className="ml-auto shrink-0 text-[11px] text-text-muted">{ago(t.lastMessageAt)}</span>
        </div>
        <p className={cx('mt-1 truncate text-sm', unread ? 'text-text-primary' : 'text-text-secondary')} style={{ fontWeight: unread ? 700 : 600 }}>{t.subject}</p>
        <p className="truncate text-xs text-text-muted">{t.lastSender === 'admin' ? `Equipe ${BRAND.name}: ` : 'Você: '}{t.lastMessagePreview}</p>
      </div>
      {unread ? <span className="support-count static">{countLabel(t.userUnread)}</span> : <ChevronRight size={16} className="shrink-0 text-text-muted" />}
    </button>
  )
}
