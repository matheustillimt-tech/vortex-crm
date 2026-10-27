import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Search, Layers, SlidersHorizontal, ArrowLeft, Send, Paperclip, Smile, Mic, Bot, CheckCheck,
  UserCheck, ArrowRightLeft, MoreVertical, Phone, Mail, Tag, Columns3, X, Zap, PanelRightClose, PanelRightOpen, MessageCircle,
  Clock3, AlertCircle, Loader2, Image as ImageIcon, Film, Music, FileText,
} from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { cx, fmtTime, hasAnyLabel } from '../lib/utils'
import { BACKEND } from '../lib/supabase'
import { buscarFotos, chatAiSet } from '../lib/backend'
import ContactCard from '../components/ContactCard'
import { Avatar, Field, LabelPicker, Modal, Select } from '../components/ui'
import Midia from '../components/Midia'
import StartFlowButton from '../components/fluxos/StartFlowButton'
import { CHANNELS, ChannelIcon, chatChannel, igHandle, igProfileUrl, igWindow, timeLeft } from '../components/Channel'

// Agente de IA da conversa e a situação dele nela (null = conversa sem agente ativo).
const digits = (s) => String(s || '').replace(/\D/g, '')
const variants = (d) => [d, d.length === 13 && d.startsWith('55') && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d.length === 12 && d.startsWith('55') ? d.slice(0, 4) + '9' + d.slice(4) : d]
function aiOf(db, chat, contact) {
  const agent = chat.aiAgentId ? db.agents.find((a) => a.id === chat.aiAgentId) : db.agents.find((a) => a.active && a.connectionId === chat.connectionId)
  if (!agent?.active) return null
  const tests = String(agent.settings?.testNumbers || '').split(/[,;\n]+/).map(digits).filter((d) => d.length >= 8)
  const mine = variants(digits(contact?.phone))
  if (tests.length && !tests.some((t) => variants(t).some((v) => mine.includes(v)))) return { agent, state: 'test', label: 'IA em teste (não atende este contato)' }
  if (!chat.botActive) return { agent, state: 'off', label: 'IA desligada' }
  if (chat.aiPaused) return chat.aiPauseReason === 'transferido' ? { agent, state: 'transfer', label: 'Transferido pela IA' } : { agent, state: 'paused', label: 'IA pausada' }
  return { agent, state: 'on', label: `IA · ${agent.name}` }
}
const AI_BADGE = { on: 'badge-primary', paused: 'badge-muted', off: 'badge-muted', transfer: 'badge-warning', test: 'badge-muted' }
// A IA não resolveu e a conversa espera alguém da equipe em Aguardando (o servidor marca; some quando alguém assume).
const needsHuman = (chat) => (chat.status === 'waiting' && chat.aiState?.precisaHumano) || null

// Etiquetas do contato em chips (as automáticas, marcadas com extra.automatica por uma rotina do servidor, vêm primeiro).
const AUTO_TITLE = 'Automática: atualizada sozinha pelo sistema'
function LabelChips({ ids, max }) {
  const db = useDB()
  const ls = (ids || []).map((id) => db.labels.find((l) => l.id === id)).filter(Boolean)
  if (!ls.length) return null
  const shown = max ? ls.slice(0, max) : ls
  return (
    <>
      {shown.map((l) => <span key={l.id} className="max-w-[160px] shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: l.color + '25', color: l.color }} title={l.automatica ? `${l.name} · ${AUTO_TITLE}` : l.name}>{l.name}</span>)}
      {shown.length < ls.length && <span className="shrink-0 text-[10px] text-text-muted" title={ls.slice(shown.length).map((l) => l.name).join(', ')}>+{ls.length - shown.length}</span>}
    </>
  )
}

// Colunas do Chat ao Vivo (não há mais "Resolvido"): IA = o agente de IA está atendendo; Humano = o resto (IA pausada
// ou transferida, conversa sem agente, ou a IA não resolveu e espera alguém da equipe). As automações (fluxos) seguem
// nas duas.
const COLUMNS = [
  { id: 'humano', label: 'Humano' },
  { id: 'ia', label: 'Atendimento IA' },
]
const columnOf = (db, chat, contact) => (aiOf(db, chat, contact)?.state === 'on' && !needsHuman(chat) ? 'ia' : 'humano')
const NO_FILTERS = { channel: '', connectionId: '', departmentId: '', labels: [] }

// Pausa ou devolve a IA numa conversa (no modo demonstração, só no navegador).
async function setChatAi(chatId, active) {
  if (BACKEND) return chatAiSet(chatId, active)
  useDB.setState((s) => ({ chats: s.chats.map((x) => (x.id === chatId ? { ...x, aiPaused: !active, aiPauseReason: active ? null : 'manual', botActive: true, ...(active && { assignedTo: null, status: 'attending' }) } : x)) }))
}
const AUTO_REPLIES = ['Perfeito, obrigado!', 'Pode me mandar o Pix?', 'Vou pensar e te aviso', 'Quanto fica o frete?', 'Fechado! 🙌', 'Me manda mais detalhes?']

// Anexo do Chat ao Vivo: até 64 MB (limite do armazenamento). Foto acima de 5 MB e vídeo ou áudio acima de 16 MB
// chegam ao cliente como documento (o servidor decide).
const MAX_FILE_MB = 64
const FILE_ICON = { image: ImageIcon, video: Film, audio: Music }
const fileKind = (f) => /^(image|video|audio)\//.exec(f.type)?.[1] || 'document'
const fmtSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

function AttachmentPreview({ file, onRemove }) {
  const kind = fileKind(file)
  const Icon = FILE_ICON[kind] || FileText
  const [thumb, setThumb] = useState(null)
  useEffect(() => {
    if (kind !== 'image') return
    const url = URL.createObjectURL(file)
    setThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [file, kind])
  return (
    <div className="chat-attachment mb-2 flex items-center gap-3 rounded-xl border border-border bg-surface-overlay px-3 py-2">
      {thumb ? <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-violet-300"><Icon size={18} /></span>}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{file.name}</p>
        <p className="text-xs text-text-muted">{fmtSize(file.size)} · {kind === 'audio' ? 'o texto, se houver, vai em seguida' : 'escreva uma legenda, se quiser'}</p>
      </div>
      <button className="btn-ghost p-1.5" onClick={onRemove} aria-label="Remover anexo" title="Remover anexo"><X size={16} /></button>
    </div>
  )
}

export default function Chats() {
  const db = useDB()
  const nav = useNavigate()
  const [column, setColumn] = useState('humano')
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [showInfo, setShowInfo] = useState(true)
  const [filters, setFilters] = useState(NO_FILTERS)
  const [modal, setModal] = useState(null)
  const activeFilters = (filters.channel ? 1 : 0) + (filters.connectionId ? 1 : 0) + (filters.departmentId ? 1 : 0) + (filters.labels.length ? 1 : 0)

  const contact = (id) => db.contacts.find((c) => c.id === id)
  const columns = useMemo(() => new Map(db.chats.map((c) => [c.id, columnOf(db, c, contact(c.contactId))])), [db.chats, db.contacts, db.agents]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    return db.chats
      .filter((c) => columns.get(c.id) === column)
      .filter((c) => !filters.channel || chatChannel(c, db.connections) === filters.channel)
      .filter((c) => !filters.connectionId || c.connectionId === filters.connectionId)
      .filter((c) => !filters.departmentId || c.departmentId === filters.departmentId)
      .filter((c) => hasAnyLabel(contact(c.contactId), filters.labels))
      .filter((c) => {
        if (!q) return true
        const ct = contact(c.contactId)
        return (ct?.name + ct?.phone + (ct?.instagramUsername ? '@' + ct.instagramUsername : '')).toLowerCase().includes(q.toLowerCase())
      })
      // quem espera alguém da equipe (a IA não resolveu) primeiro
      .sort((a, b) => (needsHuman(b) ? 1 : 0) - (needsHuman(a) ? 1 : 0) || b.lastMessageAt.localeCompare(a.lastMessageAt))
  }, [db.chats, columns, column, q, filters, db.contacts, db.connections])

  const counts = Object.fromEntries(COLUMNS.map((s) => [s.id, db.chats.filter((c) => columns.get(c.id) === s.id).length]))

  // Fotos de perfil: pede ao servidor as dos contatos da lista que ainda não foram procurados (uma vez por sessão)
  const pedidas = useRef(new Set())
  useEffect(() => {
    if (!BACKEND) return
    // a conversa aberta primeiro, depois a lista inteira (25 por vez; a próxima leva sai quando esta voltar)
    const ordem = [active, ...list].filter(Boolean)
    const ids = [...new Set(ordem.map((c) => contact(c.contactId)).filter((ct) => ct && !ct.avatarAt && !pedidas.current.has(ct.id)).map((ct) => ct.id))].slice(0, 25)
    if (!ids.length) return
    ids.forEach((id) => pedidas.current.add(id))
    buscarFotos(ids)
      .then(({ fotos }) => useDB.setState((st) => ({ contacts: st.contacts.map((ct) => (ct.id in (fotos || {}) ? { ...ct, avatarUrl: fotos[ct.id] || ct.avatarUrl, avatarAt: new Date().toISOString() } : ct)) })))
      .catch(() => {})
  }, [list, activeId, db.contacts]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = db.chats.find((c) => c.id === activeId)

  // ?chat=<id> (Kanban, Contatos): abre essa conversa, na coluna em que ela está.
  const [params, setParams] = useSearchParams()
  const pedido = params.get('chat')
  useEffect(() => {
    if (!pedido || !columns.has(pedido)) return
    setActiveId(pedido)
    setColumn(columns.get(pedido))
    setParams({}, { replace: true })
  }, [pedido, columns]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active && active.unread) db.update('chats', active.id, { unread: 0 })
  }, [activeId]) // eslint-disable-line

  return (
    <div className="flex h-[calc(100dvh-56px-64px)] overflow-hidden lg:h-dvh">
      {/* List */}
      <section className={cx('flex w-full shrink-0 flex-col border-r border-border bg-surface-sidebar md:w-[340px]', active && 'hidden md:flex')}>
        <div className="space-y-3 border-b border-border p-3">
          {/* sem o nome da empresa aqui: ele já aparece no menu ao lado */}
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input className="input pl-9" placeholder="Buscar chats..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="btn-ghost p-1.5" title="Ações em massa" onClick={() => setModal('mass')}><Layers size={15} /></button>
            <button className={cx('btn-ghost relative p-1.5', activeFilters && 'text-[var(--accent-text)]')} title={activeFilters ? `Filtros (${activeFilters} em uso)` : 'Filtros'} onClick={() => setModal('filters')}>
              <SlidersHorizontal size={15} />
              {activeFilters > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-primary px-0.5 text-[9px] font-bold text-accent-fg">{activeFilters}</span>}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-border p-1" style={{ background: 'var(--material-control)', boxShadow: 'var(--shadow-inset)' }}>
            {COLUMNS.map((s) => (
              <button key={s.id} onClick={() => setColumn(s.id)} className={cx('rounded-[10px] py-1.5 text-xs font-[650] transition', column === s.id ? 'is-selected' : 'text-text-secondary hover:text-text-primary')}>
                {s.label} <span className="opacity-70">{counts[s.id]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center">
              <MessageCircle size={32} className="mb-3 text-text-muted" />
              <p className="font-semibold">Nenhum chat encontrado</p>
              <p className="text-sm text-text-muted">Tente ajustar os filtros de busca</p>
            </div>
          ) : (
            list.map((c) => {
              const ct = contact(c.contactId)
              const ai = aiOf(db, c, ct)
              // prévia: a última mensagem carregada ou, se a conversa ainda não foi aberta, o texto guardado nela
              const last = db.messages[c.id]?.slice(-1)[0]
              const lastText = last?.text ?? c.lastMessageText
              const lastFrom = last?.from ?? c.lastMessageFrom
              return (
                <button key={c.id} onClick={() => setActiveId(c.id)} className={cx('flex w-full items-center gap-3 border-b border-border-subtle px-3 py-3 text-left transition hover:bg-surface-raised', activeId === c.id && 'bg-surface-raised')}>
                  <span className="relative shrink-0">
                    <Avatar name={ct?.name} src={ct?.avatarUrl} size={40} />
                    <ChannelIcon channel={chatChannel(c, db.connections)} size={16} className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[var(--surface-sidebar,#111)]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">{ct?.name}</p>
                      <span className="shrink-0 text-[10px] text-text-muted">{fmtTime(c.lastMessageAt)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs text-text-muted">
                        {lastText && lastFrom !== 'contact' && <CheckCheck size={12} className="mr-1 inline text-blue-400" />}
                        {lastText}
                      </p>
                      {c.unread > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-primary px-1.5 text-[10px] font-bold text-accent-fg">{c.unread}</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <span className="badge-muted inline-flex max-w-[150px] items-center gap-1 truncate">{db.connections.find((x) => x.id === c.connectionId)?.name}</span>
                      {needsHuman(c) ? <span className="badge-warning max-w-[150px] truncate" title={`A IA não resolveu: ${needsHuman(c).motivo}`}><AlertCircle size={10} /> IA não resolveu</span>
                        : ai ? <span className={cx(AI_BADGE[ai.state], 'max-w-[150px] truncate')}><Bot size={10} /> {ai.label}</span> : c.botActive && <span className="badge-primary"><Bot size={10} /> Bot</span>}
                    </div>
                    {ct?.labels?.length > 0 && <div className="mt-1 flex items-center gap-1 overflow-hidden"><LabelChips ids={ct.labels} max={2} /></div>}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </section>

      {/* Conversation */}
      {active ? (
        <Conversation key={active.id} chat={active} onBack={() => setActiveId(null)} showInfo={showInfo} setShowInfo={setShowInfo} />
      ) : (
        <div className="hidden flex-1 flex-col items-center justify-center bg-surface-base p-8 text-center md:flex">
          <div className="icon-tile mb-4 h-16 w-16 rounded-[20px]"><MessageCircle size={30} /></div>
          <p className="text-lg font-semibold">Selecione uma conversa</p>
          <p className="text-sm text-text-muted">Os chats aparecerão aqui quando houver conversas</p>
          <button className="btn-secondary mt-4" onClick={() => nav('/welcome')}>Voltar ao início</button>
        </div>
      )}

      <Modal open={modal === 'filters'} onClose={() => setModal(null)} title="Filtros" size="sm"
        footer={<><button className="btn-secondary" onClick={() => { setFilters(NO_FILTERS); setModal(null) }}>Limpar</button><button className="btn-primary" onClick={() => setModal(null)}>Aplicar</button></>}>
        {db.connections.some((c) => c.provider === 'instagram') && (
          <Field label="Canal"><Select value={filters.channel} onChange={(v) => setFilters({ ...filters, channel: v })} placeholder="Todos" options={Object.entries(CHANNELS).map(([value, c]) => ({ value, label: c.label }))} /></Field>
        )}
        <Field label="Conexão"><Select value={filters.connectionId} onChange={(v) => setFilters({ ...filters, connectionId: v })} placeholder="Todas" options={db.connections.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Departamento"><Select value={filters.departmentId} onChange={(v) => setFilters({ ...filters, departmentId: v })} placeholder="Todos" options={db.departments.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Etiquetas" hint="Conversas cujo contato tem qualquer uma das etiquetas escolhidas.">
          <LabelPicker labels={db.labels} value={filters.labels} onChange={(labels) => setFilters({ ...filters, labels })} />
        </Field>
      </Modal>
      <MassActionsModal open={modal === 'mass'} onClose={() => setModal(null)} />
    </div>
  )
}

function Conversation({ chat, onBack, showInfo, setShowInfo }) {
  const db = useDB()
  const [text, setText] = useState('')
  const [file, setFile] = useState(null) // anexo esperando o envio (o texto vira a legenda)
  const [transfer, setTransfer] = useState(false)
  const [card, setCard] = useState(false)
  const fileRef = useRef(null)
  const boxRef = useRef(null)
  const contentRef = useRef(null)
  const stickRef = useRef(true) // a conversa está (ou deve ficar) na última mensagem
  const ct = db.contacts.find((c) => c.id === chat.contactId)
  const msgs = db.messages[chat.id] || []
  const page = db.messagePages?.[chat.id] // o modo demonstração não tem paginação
  const qr = text.startsWith('/') ? db.quickReplies.filter((r) => r.shortcut.startsWith(text)) : []
  // Instagram: janela de resposta da Meta, a partir da última mensagem do cliente (carregada ou guardada na conversa)
  const channel = chatChannel(chat, db.connections)
  const isIg = channel === 'instagram'
  const lastContactAt = isIg ? ([...msgs].reverse().find((m) => m.from === 'contact')?.at ?? (chat.lastMessageFrom === 'contact' ? chat.lastMessageAt : null)) : null
  const win = isIg && (msgs.length || chat.lastMessageFrom) ? igWindow(lastContactAt) : null
  const blocked = win?.state === 'closed'

  // as 100 mensagens mais recentes desta conversa (o painel não carrega todas de uma vez)
  useEffect(() => { if (BACKEND && !useDB.getState().messagePages[chat.id]?.loaded) db.loadChatMessages(chat.id) }, [chat.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Abre já na última mensagem, sem animação, e fica presa nela enquanto as mensagens, fotos e vídeos carregam ou chega
  // mensagem nova. Se a pessoa rolar para cima para ler, solta; voltando ao fim (ou enviando), prende de novo.
  const toBottom = () => { const box = boxRef.current; if (box) box.scrollTop = box.scrollHeight }
  useLayoutEffect(toBottom, [])
  useEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (stickRef.current) toBottom() })
    ro.observe(contentRef.current)
    ro.observe(boxRef.current) // o campo de mensagem cresce (prévia do anexo, texto longo): a última continua à vista
    return () => ro.disconnect()
  }, [])
  // Só solta quando a pessoa rola para cima: o aviso de rolagem do próprio toBottom pode chegar depois de uma foto
  // aumentar a conversa e parecer "longe do fim".
  const lastTop = useRef(0)
  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    const up = box.scrollTop < lastTop.current
    lastTop.current = box.scrollTop
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) stickRef.current = true
    else if (up) stickRef.current = false
  }

  const pick = (e) => {
    const f = e.target.files?.[0]
    e.target.value = '' // escolher o mesmo arquivo de novo também dispara
    if (!f) return
    if (f.size > MAX_FILE_MB * 1024 * 1024) return toast(`Arquivo grande demais: o limite é ${MAX_FILE_MB} MB.`, 'error')
    setFile(f)
  }
  // troca de conversa: o anexo escolhido não vai para outra pessoa
  useEffect(() => setFile(null), [chat.id])

  const send = () => {
    if (!text.trim() && !file) return
    if (blocked) return toast('O Instagram só deixa responder até 7 dias depois da última mensagem do cliente.', 'error')
    stickRef.current = true // quem envia vê a própria mensagem
    db.sendMessage(chat.id, text.trim(), 'agent', file)
    setText('')
    setFile(null)
    // simula resposta do cliente
    // modo demonstração: simula a resposta do cliente (no banco real ela chega pelo WhatsApp)
    if (!BACKEND) setTimeout(() => db.sendMessage(chat.id, AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)], 'contact'), 2500)
  }

  // Agente de IA desta conversa: quem está atendendo e pausar/retomar só aqui
  const ai = aiOf(db, chat, ct)
  const owner = db.team.find((x) => x.id === chat.assignedTo)
  const attendant = ai?.state === 'on' ? `🤖 ${ai.agent.name} (IA)` : owner ? `👤 ${owner.name}` : ai?.state === 'transfer' ? 'Aguardando atendente (transferido pela IA)' : chat.status === 'waiting' ? 'Aguardando atendente' : '—'
  const [aiBusy, setAiBusy] = useState(false)
  // Assumir: a IA pausa nesta conversa e ela vai para o atendimento humano, com você como responsável.
  // Devolver: a IA volta a atender (coluna IA) e responde o que o cliente deixou sem resposta.
  const toggleAi = async () => {
    const devolver = ai.state !== 'on'
    setAiBusy(true)
    try {
      if (devolver) {
        await setChatAi(chat.id, true)
        toast('Conversa devolvida para a IA. Se o cliente estava esperando, ela responde agora.')
      } else {
        await setChatAi(chat.id, false)
        db.update('chats', chat.id, { assignedTo: db.memberId, status: 'attending' })
        toast('Você assumiu o atendimento. A IA pausou nesta conversa.')
      }
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setAiBusy(false)
    }
  }

  let lastDay = ''
  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-surface-base">
        <header className="flex items-center gap-3 border-b border-border bg-surface-sidebar px-4 py-2.5">
          <button className="btn-ghost p-1.5 md:hidden" onClick={onBack}><ArrowLeft size={18} /></button>
          <button onClick={() => setCard(true)} title="Ver contato" className="shrink-0 rounded-full"><Avatar name={ct?.name} src={ct?.avatarUrl} size={38} /></button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <ChannelIcon channel={channel} size={16} />
              <button onClick={() => setCard(true)} title="Ver contato" className="min-w-0 truncate text-left hover:underline" style={{ fontWeight: 650, letterSpacing: '-0.02em' }}>{ct?.name}</button>
              <span className="hidden min-w-0 items-center gap-1 sm:flex"><LabelChips ids={ct?.labels} max={2} /></span>
            </div>
            <p className="truncate text-xs text-text-muted">{isIg ? (igHandle(ct?.instagramUsername) || 'Instagram') : ct?.phone} · <span className={ai?.state === 'on' ? 'text-violet-300' : ''}>Atendimento: {attendant}</span></p>
          </div>
          {ai && ai.state !== 'test' ? (
            ai.state === 'on' ? (
              <button onClick={toggleAi} disabled={aiBusy} className="btn-primary shrink-0 px-3 py-1.5 text-xs" title="A IA pausa nesta conversa e ela passa para o atendimento humano">
                {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />} Assumir
              </button>
            ) : (
              <button onClick={toggleAi} disabled={aiBusy} className="btn shrink-0 bg-accent-soft px-2.5 py-1.5 text-xs text-violet-300" title="A IA volta a atender esta conversa">
                {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />} <span className="hidden sm:inline">Devolver para a IA</span>
              </button>
            )
          ) : isIg ? null : (
            <button onClick={() => db.update('chats', chat.id, { botActive: !chat.botActive })} className={cx('btn hidden px-2.5 py-1.5 text-xs sm:inline-flex', chat.botActive ? 'bg-accent-soft text-violet-300' : 'bg-surface-interactive text-text-muted')} title="Ligar/desligar bot neste chat">
              <Bot size={14} /> <span className="hidden 2xl:inline">{chat.botActive ? 'Bot ativo' : 'Bot pausado'}</span>
            </button>
          )}
          {/* fluxos no Instagram entram na Fase 2 */}
          {!isIg && <StartFlowButton where="chat" contactId={chat.contactId} chatId={chat.id} className="btn-ghost" compact />}
          <button className="btn-ghost p-1.5" title="Transferir atendimento" onClick={() => setTransfer(true)}><ArrowRightLeft size={16} /></button>
          <button className="btn-ghost hidden p-1.5 2xl:inline-flex" onClick={() => setShowInfo(!showInfo)} title="Dados do contato">{showInfo ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
        </header>
        {win && <IgWindowBar win={win} />}
        {needsHuman(chat) && (
          <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-400">
            <AlertCircle size={14} className="shrink-0" />
            <p className="min-w-0 flex-1"><b>A IA não resolveu:</b> {String(needsHuman(chat).motivo).replace(/[.\s]+$/, '')}. Assuma o atendimento para continuar.</p>
          </div>
        )}

        <div ref={boxRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0)', backgroundSize: '22px 22px' }}>
          <div ref={contentRef}>
          {BACKEND && page && !page.complete && (
            <div className="mb-3 text-center">
              <button className="btn-secondary px-3 py-1.5 text-xs" disabled={page.loading} onClick={() => db.loadChatMessages(chat.id, true)}>
                {page.loading ? <><Loader2 size={13} className="animate-spin" /> Carregando…</> : 'Carregar mensagens anteriores'}
              </button>
            </div>
          )}
          {msgs.map((m) => {
            const day = new Date(m.at).toLocaleDateString('pt-BR')
            const showDay = day !== lastDay
            lastDay = day
            const mine = m.from !== 'contact'
            return (
              <div key={m.id}>
                {showDay && <div className="my-3 text-center"><span className="rounded-full bg-surface-overlay px-3 py-1 text-[11px] text-text-muted">{day}</span></div>}
                {m.from === 'sys' ? (
                  <p className="my-2 text-center text-[11px] text-text-muted">{m.text} · {fmtTime(m.at)}</p>
                ) : (
                  <div className={cx('mb-2 flex', mine ? 'justify-end' : 'justify-start')}>
                    <div className={cx('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm', mine ? 'rounded-br-md bubble-mine' : 'rounded-bl-md bg-surface-overlay text-text-primary', m.delivery === 'failed' && 'ring-2 ring-red-500')}>
                      {m.from === 'bot' && <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase opacity-80"><Bot size={10} /> {m.agentName ? `${m.agentName} · IA` : 'Bot'}</p>}
                      {(m.mediaUrl || m.mediaLink) && <Midia path={m.mediaUrl} url={m.mediaLink} type={m.type} mine={mine} />}
                      <p className="whitespace-pre-wrap break-words">{m.text}</p>
                      {m.transcript && <p className="mt-1 whitespace-pre-wrap break-words text-xs italic opacity-80">📝 {m.transcript}</p>}
                      <p className={cx('mt-0.5 flex items-center justify-end gap-1 text-[10px]', mine ? 'text-white/70' : 'text-text-muted')}>
                        {fmtTime(m.at)} {mine && <Delivery d={m.delivery} />}
                      </p>
                      {mine && m.delivery === 'failed' && (
                        <details className="group mt-2">
                          <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-red-500 [&::-webkit-details-marker]:hidden">
                            <AlertCircle size={13} /> <span className="group-open:hidden">Ver o motivo do erro</span><span className="hidden group-open:inline">Esconder o motivo</span>
                          </summary>
                          <p className="mt-2 flex gap-2 rounded-xl border border-red-300/60 bg-red-600 px-3 py-2.5 text-[13px] font-medium leading-snug text-white shadow-md">
                            <AlertCircle size={16} className="mt-0.5 shrink-0" />
                            <span>{m.deliveryError || 'Não entregue. A Meta não informou o motivo desta falha; as mensagens que falharem a partir de agora mostram o motivo aqui.'}</span>
                          </p>
                        </details>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </div>

        <div className="relative border-t border-border bg-surface-sidebar p-3">
          {qr.length > 0 && (
            <div className="absolute bottom-full left-3 right-3 mb-2 menu-pop p-1">
              {qr.map((r) => (
                <button key={r.id} onClick={() => setText(r.content)} className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-interactive">
                  <Zap size={14} className="mt-0.5 text-violet-400" />
                  <span><b className="text-violet-300">{r.shortcut}</b> <span className="text-text-muted">{r.content}</span></span>
                </button>
              ))}
            </div>
          )}
          {file && <AttachmentPreview file={file} onRemove={() => setFile(null)} />}
          {blocked ? (
            <p className="flex items-center gap-2 rounded-xl bg-surface-overlay px-3 py-2.5 text-xs text-text-muted"><Clock3 size={14} className="shrink-0" /> Passaram 7 dias da última mensagem do cliente. O Instagram só libera a resposta quando ele escrever de novo.</p>
          ) : (
          <div className="flex items-end gap-2">
            <button className="btn-ghost p-2" title="Emoji" onClick={() => setText((t) => t + '😊')}><Smile size={18} /></button>
            <button className="btn-ghost p-2" title="Anexar foto, vídeo, áudio ou documento" aria-label="Anexar" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
            <input ref={fileRef} type="file" className="hidden" onChange={pick} />
            <textarea
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder={file ? 'Legenda (opcional)' : 'Digite uma mensagem ou / para respostas rápidas'}
              maxLength={file ? 1024 : 4096}
              className="input max-h-32 min-h-[40px] flex-1 resize-none"
            />
            {text || file ? (
              <button className="btn-primary h-10 w-10 p-0" onClick={send} aria-label="Enviar"><Send size={16} /></button>
            ) : (
              <button className="btn-secondary h-10 w-10 p-0" title="Gravar áudio" onClick={() => toast('Gravar áudio pelo painel ainda não está disponível. Para mandar um áudio, anexe o arquivo pelo clipe.', 'info')}><Mic size={16} /></button>
            )}
          </div>
          )}
        </div>
      </section>

      {showInfo && <ContactPanel chat={chat} contact={ct} />}
      {card && <ContactCard contact={ct} onClose={() => setCard(false)} />}

      <Modal open={transfer} onClose={() => setTransfer(false)} title="Transferir atendimento" size="sm">
        <p className="mb-3 text-sm text-text-secondary">Escolha um atendente ou departamento:</p>
        {db.team.map((u) => (
          <button key={u.id} onClick={() => { db.update('chats', chat.id, { assignedTo: u.id, status: 'attending' }); setTransfer(false); toast(`Transferido para ${u.name}.`) }} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:border-border-hover">
            <Avatar name={u.name} size={30} /> <span className="flex-1 text-sm">{u.name}</span> <span className="badge-muted">{u.role}</span>
          </button>
        ))}
        {db.departments.map((d) => (
          <button key={d.id} onClick={() => { db.update('chats', chat.id, { departmentId: d.id, status: 'waiting', assignedTo: null }); setTransfer(false); toast(`Transferido para ${d.name}.`) }} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:border-border-hover">
            <span className="h-3 w-3 rounded-full" style={{ background: d.color }} /> <span className="flex-1 text-sm">Departamento {d.name}</span>
          </button>
        ))}
      </Modal>
    </>
  )
}

// Faixa da janela de resposta do Instagram, no topo da conversa
function IgWindowBar({ win }) {
  if (win.state === 'open') {
    return <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[11px] text-text-muted"><Clock3 size={12} className="shrink-0" /> Instagram: pode responder por mais {timeLeft(win.until)}.</div>
  }
  if (win.state === 'human') {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-400">
        <Clock3 size={14} className="shrink-0" />
        <p className="min-w-0 flex-1"><b>Fora da janela de 24 h.</b> Só a equipe pode responder, por mais {timeLeft(win.until)}. Robô e IA não mandam nada.</p>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 border-b border-border bg-red-500/10 px-4 py-2 text-xs text-red-400">
      <AlertCircle size={14} className="shrink-0" />
      <p className="min-w-0 flex-1"><b>Janela fechada.</b> Passaram 7 dias da última mensagem do cliente.</p>
    </div>
  )
}

// Segue o perfil? (null = a Meta não informou, nunca "não segue")
function IgProfileInfo({ profile }) {
  const p = profile || {}
  const follow = p.isFollower === true ? 'Segue você' : p.isFollower === false ? 'Não segue você' : 'Não informado se segue'
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
      <span className={p.isFollower === true ? 'badge-success' : 'badge-muted'}>{follow}</span>
      {p.isVerified && <span className="badge-info">Verificado</span>}
      {Number.isFinite(p.followerCount) && <span className="text-text-muted">{p.followerCount.toLocaleString('pt-BR')} seguidores</span>}
    </p>
  )
}

// Status de entrega da mensagem enviada
function Delivery({ d }) {
  if (d === 'sending') return <Clock3 size={11} title="Enviando" />
  // falhou: o balão já mostra "Ver o motivo do erro" (com a borda vermelha); não repete aqui
  if (d === 'failed') return null
  if (d === 'local') return <span title="Número sem provedor conectado: ficou só no painel">só no painel</span>
  if (d === 'read') return <CheckCheck size={12} className="text-sky-300" />
  return <CheckCheck size={12} />
}

function ContactPanel({ chat, contact }) {
  const db = useDB()
  if (!contact) return null
  const cards = db.kanbans.flatMap((k) => k.cards.filter((c) => c.contactId === contact.id).map((c) => ({ ...c, board: k.name, col: k.columns.find((x) => x.id === c.columnId)?.name })))
  const toggleLabel = (id) => {
    const labels = contact.labels.includes(id) ? contact.labels.filter((l) => l !== id) : [...contact.labels, id]
    db.update('contacts', contact.id, { labels })
  }
  return (
    <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-border-subtle bg-surface-sidebar p-5 2xl:block">
      <div className="mb-4 flex flex-col items-center text-center">
        <Avatar name={contact.name} src={contact.avatarUrl} size={64} />
        <p className="mt-2 font-semibold">{contact.name}</p>
        {contact.instagramUsername && (
          <a href={igProfileUrl(contact.instagramUsername)} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-text-muted hover:underline">
            <ChannelIcon channel="instagram" size={13} className="rounded-[4px]" /> {igHandle(contact.instagramUsername)}
          </a>
        )}
        <span className={contact.status === 'ativo' ? 'badge-success mt-1' : 'badge-info mt-1'}>{contact.status === 'ativo' ? 'Cliente ativo' : 'Lead'}</span>
      </div>
      <div className="mb-4 space-y-2 text-sm">
        {contact.phone && <p className="flex items-center gap-2 text-text-secondary"><Phone size={14} /> {contact.phone}</p>}
        {contact.email && <p className="flex items-center gap-2 truncate text-text-secondary"><Mail size={14} /> {contact.email}</p>}
        {contact.instagramUsername && <IgProfileInfo profile={contact.instagramProfile} />}
      </div>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-text-muted"><Tag size={12} /> Etiquetas</p>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {db.labels.filter((l) => l.automatica && contact.labels.includes(l.id)).map((l) => (
          <span key={l.id} className="rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ background: l.color + '30', borderColor: l.color, color: l.color }} title={AUTO_TITLE}>{l.name}</span>
        ))}
        {db.labels.filter((l) => !l.automatica).map((l) => (
          <button key={l.id} onClick={() => toggleLabel(l.id)} className="rounded-full border px-2 py-0.5 text-[11px] font-medium transition" style={contact.labels.includes(l.id) ? { background: l.color + '30', borderColor: l.color, color: l.color } : { borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            {l.name}
          </button>
        ))}
      </div>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-text-muted"><Columns3 size={12} /> Kanban</p>
      {cards.length ? cards.map((c) => (
        <div key={c.id} className="mb-2 rounded-lg border border-border bg-surface-raised p-2.5 text-xs">
          <p className="font-semibold text-text-primary">{c.board}</p>
          <p className="text-text-muted">Etapa: {c.col}</p>
        </div>
      )) : <p className="mb-4 text-xs text-text-muted">Não está em nenhum quadro.</p>}
      <p className="mb-2 mt-4 text-xs font-semibold uppercase text-text-muted">Atendimento</p>
      <div className="space-y-1.5 text-xs text-text-secondary">
        <p>Canal: <b className="text-text-primary">{CHANNELS[chatChannel(chat, db.connections)].label}</b></p>
        <p>Conexão: <b className="text-text-primary">{db.connections.find((x) => x.id === chat.connectionId)?.name}</b></p>
        <p>Departamento: <b className="text-text-primary">{db.departments.find((x) => x.id === chat.departmentId)?.name || '—'}</b></p>
        <p>Responsável: <b className="text-text-primary">{db.team.find((x) => x.id === chat.assignedTo)?.name || (aiOf(db, chat, contact)?.state === 'on' ? `IA (${aiOf(db, chat, contact).agent.name})` : '—')}</b></p>
        <p>Origem: <b className="text-text-primary">{contact.origin}</b></p>
      </div>
    </aside>
  )
}

// Sem botão na lista de chats por enquanto (removido a pedido); mantido para reativar se precisar.
// eslint-disable-next-line no-unused-vars
function NewChatModal({ open, onClose, onCreated }) {
  const db = useDB()
  const [contactId, setContactId] = useState('')
  const [connectionId, setConnectionId] = useState(db.connections[0]?.id)
  const [text, setText] = useState('')
  const create = () => {
    if (!contactId) return toast('Escolha um contato.', 'error')
    const chat = db.add('chats', { contactId, connectionId, status: 'attending', unread: 0, answered: true, assignedTo: db.memberId, departmentId: null, lastMessageAt: new Date().toISOString(), botActive: false })
    db.setKey('messages', (m) => ({ ...m, [chat.id]: [] }))
    if (text) db.sendMessage(chat.id, text, 'agent')
    onCreated(chat.id)
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title="Criar novo chat" size="sm" footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={create}>Iniciar conversa</button></>}>
      <Field label="Contato"><Select value={contactId} onChange={setContactId} placeholder="Selecione..." options={db.contacts.map((c) => ({ value: c.id, label: `${c.name} · ${c.phone}` }))} /></Field>
      <Field label="Conexão"><Select value={connectionId} onChange={setConnectionId} options={db.connections.map((c) => ({ value: c.id, label: c.name }))} /></Field>
      <Field label="Primeira mensagem (opcional)"><textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
  )
}

const ACTIONS = ['Passar para atendimento humano', 'Devolver para a IA', 'Disparar Fluxo Bot', 'Parar Fluxo Bot', 'Transferir Atendimento', 'Aplicar/Remover Etiqueta']

function MassActionsModal({ open, onClose }) {
  const db = useDB()
  const [tab, setTab] = useState('humano')
  const [sel, setSel] = useState([])
  const [seq, setSeq] = useState([])
  const [action, setAction] = useState(ACTIONS[0])
  const list = db.chats.filter((c) => columnOf(db, c, db.contacts.find((x) => x.id === c.contactId)) === tab)
  const run = async () => {
    const ids = sel, acoes = seq
    setSel([]); setSeq([]); onClose()
    let falhas = 0
    for (const id of ids) {
      for (const a of acoes) {
        try {
          // uma conversa por vez: cada uma grava a nota de quem pausou ou devolveu
          if (a === 'Passar para atendimento humano') await setChatAi(id, false)
          if (a === 'Devolver para a IA') await setChatAi(id, true)
        } catch { falhas++ }
        if (a === 'Disparar Fluxo Bot') db.update('chats', id, { botActive: true })
        if (a === 'Parar Fluxo Bot') db.update('chats', id, { botActive: false })
      }
    }
    toast(`${acoes.length} ação(ões) aplicadas em ${ids.length} chat(s)${falhas ? ` (${falhas} sem agente de IA)` : ''}.`, falhas ? 'info' : undefined)
  }
  return (
    <Modal open={open} onClose={onClose} title="Ações em massa em lote" size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!sel.length || !seq.length} onClick={run}>Executar</button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 flex gap-1">
            {COLUMNS.map(({ id, label: l }) => <button key={id} onClick={() => { setTab(id); setSel([]) }} className={cx('rounded-md px-3 py-1 text-xs font-semibold', tab === id ? 'is-selected' : 'bg-surface-overlay text-text-secondary')}>{l}</button>)}
            <button className="btn-ghost ml-auto px-2 py-1 text-xs" onClick={() => setSel(list.map((c) => c.id))}>Selecionar Todos</button>
          </div>
          <p className="mb-2 text-xs text-text-muted">{sel.length} selecionados</p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {list.length === 0 && <p className="text-sm text-text-muted">Nenhum contato nesta fila</p>}
            {list.map((c) => {
              const ct = db.contacts.find((x) => x.id === c.contactId)
              return (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-overlay">
                  <input type="checkbox" className="accent-violet-500" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />
                  <span className="text-sm">{ct?.name}</span>
                </label>
              )
            })}
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-semibold">Configurar sequência de ações</p>
          <p className="mb-3 text-xs text-text-muted">Defina as ações que serão disparadas na ordem definida para os contatos selecionados.</p>
          <div className="mb-3 flex gap-2">
            <Select value={action} onChange={setAction} options={ACTIONS} />
            <button className="btn-secondary shrink-0" onClick={() => setSeq([...seq, action])}>Adicionar</button>
          </div>
          <p className="mb-2 text-xs font-semibold text-text-secondary">Sequência de Execução ({seq.length})</p>
          {seq.length === 0 ? <p className="text-xs text-text-muted">Nenhuma ação configurada ainda</p> : seq.map((a, i) => (
            <div key={i} className="panel-soft mb-1.5 flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-primary text-[10px] font-bold text-accent-fg">{i + 1}</span>
              <span className="flex-1">{a}</span>
              <button onClick={() => setSeq(seq.filter((_, j) => j !== i))} className="text-text-muted hover:text-red-400"><X size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
