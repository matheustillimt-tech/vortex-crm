import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  CalendarDays, Columns3, Plus, Trash2, ArrowLeft, ArrowRight, MoreHorizontal, Target, EyeOff, Pencil, Download, Filter, LayoutGrid, BarChart3, GripVertical, Eye, CircleX, MessageCircle, HandCoins, PauseCircle } from 'lucide-react'
import { useDB, useHasModule, toast } from '../lib/store'
import { brl, cx, downloadCsv, fmtDate, uid } from '../lib/utils'
import { LABEL_COLORS } from '../lib/seed'
import { Avatar, Confirm, EmptyState, Field, Modal, PageHeader, SearchInput, Select, Tabs } from '../components/ui'
import { ChannelIcons, contactChannels, igHandle } from '../components/Channel'
import { FunilLinhaDoTempo, PessoaResumo } from '../components/FunilPessoa'
import StartFlowButton from '../components/fluxos/StartFlowButton'

const TEMPLATES = {
  vendas: ['Novo lead', 'Em negociação', 'Proposta enviada', 'Comprou', 'Perdido'],
  atendimento: ['Aberto', 'Em andamento', 'Aguardando cliente', 'Resolvido'],
  vazio: ['Coluna 1', 'Coluna 2', 'Coluna 3'],
}

// Agente de IA que organiza o quadro (Agentes de IA → Kanban). Ele move pelas regras dele; o que a equipe arrasta fica
// onde ela pôs até a decisão das regras mudar.
const boardAgent = (db, k) => db.agents.find((a) => a.kanban?.ativo && a.kanban.quadroId === k.id)

// Ordem das colunas: tira `from` e põe no lugar de `to` (arrastando para a direita fica depois dela; para a esquerda, antes).
const moveTo = (cols, from, to) => {
  const i = cols.findIndex((c) => c.id === from)
  const j = cols.findIndex((c) => c.id === to)
  if (i < 0 || j < 0 || i === j) return cols
  const out = [...cols]
  out.splice(j, 0, ...out.splice(i, 1))
  return out
}

const boardStats = (k) => {
  const value = k.cards.reduce((a, c) => a + (+c.value || 0), 0)
  const convCols = k.columns.filter((c) => c.conversion).map((c) => c.id)
  const converted = k.cards.filter((c) => convCols.includes(c.columnId)).length
  return { value, converted, rate: k.cards.length ? (converted / k.cards.length) * 100 : 0 }
}

export function KanbanList() {
  const db = useDB()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(false)
  const [del, setDel] = useState(null)
  const [form, setForm] = useState({ name: '', template: 'vendas', color: '#7fee64' })
  const list = db.kanbans.filter((k) => k.name.toLowerCase().includes(q.toLowerCase()))
  const totals = db.kanbans.reduce((a, k) => { const s = boardStats(k); return { cards: a.cards + k.cards.length, value: a.value + s.value, rate: a.rate + s.rate } }, { cards: 0, value: 0, rate: 0 })

  const create = () => {
    if (!form.name) return toast('Dê um nome ao Kanban.', 'error')
    const k = db.add('kanbans', { name: form.name, color: form.color, columns: TEMPLATES[form.template].map((n, i) => ({ id: uid(), name: n, color: LABEL_COLORS[i % LABEL_COLORS.length], conversion: n === 'Comprou' || n === 'Resolvido', lost: n === 'Perdido' })), cards: [] })
    setModal(false)
    nav('/crms/' + k.id)
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={Columns3} title="Kanbans" subtitle="Pipeline de vendas e gestão visual" actions={<button className="btn-primary" onClick={() => setModal(true)}><Plus size={16} /> Novo Kanban</button>} />
      {db.kanbans.length === 0 ? (
        <EmptyState icon={Columns3} title="Nenhum Kanban criado" hint="Crie seu primeiro quadro para acompanhar o pipeline de vendas em um só lugar." action={<button className="btn-primary" onClick={() => setModal(true)}><Plus size={16} /> Novo Kanban</button>} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[['Quadros', db.kanbans.length], ['Negócios no pipeline', totals.cards], ['Valor no pipeline', brl(totals.value)], ['Conversão média', (totals.rate / db.kanbans.length).toFixed(1) + '%']].map(([l, v]) => (
              <div key={l} className="card p-4"><p className="text-xs text-text-muted">{l}</p><p className="mt-1 text-xl font-bold">{v}</p></div>
            ))}
          </div>
          <SearchInput className="mb-4 max-w-sm" value={q} onChange={setQ} placeholder="Buscar kanban..." />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((k) => {
              const s = boardStats(k)
              return (
                <Link key={k.id} to={'/crms/' + k.id} className="card group p-5 transition hover:border-border-hover hover:shadow-glow">
                  <div className="mb-4 flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-[13px]" style={{ background: k.color + '25', color: k.color }}><Columns3 size={18} /></div>
                      <div>
                        <p className="font-semibold">{k.name}</p>
                        <p className="text-xs text-text-muted">{k.columns.length} colunas{boardAgent(db, k) && <span className="badge-muted ml-2" title="As regras ficam no agente: Agentes de IA → Kanban">Agente: {boardAgent(db, k).name}</span>}</p>
                      </div>
                    </div>
                    <button className="btn-ghost p-1.5 opacity-0 group-hover:opacity-100" onClick={(e) => { e.preventDefault(); setDel(k) }}><Trash2 size={15} className="text-red-400" /></button>
                  </div>
                  <div className="mb-4 flex h-2 overflow-hidden rounded-full bg-surface-interactive">
                    {k.columns.map((c) => <div key={c.id} style={{ width: `${(k.cards.filter((x) => x.columnId === c.id).length / Math.max(k.cards.length, 1)) * 100}%`, background: c.color }} />)}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div><p className="text-lg font-bold">{k.cards.length}</p><p className="text-[11px] text-text-muted">{k.cards.length === 1 ? 'negócio' : 'negócios'}</p></div>
                    <div><p className="text-lg font-bold text-green-400">{brl(s.value).replace(',00', '')}</p><p className="text-[11px] text-text-muted">Valor total</p></div>
                    <div><p className="text-lg font-bold text-violet-400">{s.rate.toFixed(0)}%</p><p className="text-[11px] text-text-muted">Conversão</p></div>
                  </div>
                </Link>
              )
            })}
            <button onClick={() => setModal(true)} className="flex min-h-[180px] flex-col items-center justify-center rounded-[20px] border border-dashed border-border text-text-muted transition hover:border-accent-primary hover:text-violet-400">
              <Plus size={22} /><span className="mt-1 text-sm font-medium">Novo quadro</span>
            </button>
          </div>
        </>
      )}
      <Modal open={modal} onClose={() => setModal(false)} title="Novo Kanban" footer={<><button className="btn-secondary" onClick={() => setModal(false)}>Cancelar</button><button className="btn-primary" onClick={create}>Criar Kanban</button></>}>
        <Field label="Nome do Kanban"><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Funil de vendas" /></Field>
        <Field label="Modelo de colunas">
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(TEMPLATES).map(([id, cols]) => (
              <button key={id} onClick={() => setForm({ ...form, template: id })} className={cx('rounded-[13px] border p-3 text-left text-xs', form.template === id ? 'choice-on' : 'border-border')}>
                <p className="mb-1 font-semibold capitalize">{id}</p>
                <p className="text-text-muted">{cols.join(' → ')}</p>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Cor">
          <div className="flex gap-2">{LABEL_COLORS.map((c) => <button key={c} onClick={() => setForm({ ...form, color: c })} className={cx('h-7 w-7 rounded-full', form.color === c && 'ring-2 ring-white ring-offset-2 ring-offset-surface-raised')} style={{ background: c }} />)}</div>
        </Field>
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir Kanban" message={`Tem certeza que deseja excluir o Kanban "${del?.name}"? Esta ação não pode ser desfeita.`} onConfirm={() => { db.remove('kanbans', del.id); toast('Kanban excluído.') }} />
    </div>
  )
}

// Trocar de quadro (faixa no topo) remonta a página: busca, filtros e colunas ocultas são de cada quadro.
export function KanbanBoard() {
  const { id } = useParams()
  return <Board key={id} id={id} />
}

// Todos os quadros da empresa no topo, para trocar sem voltar à lista.
function BoardSwitcher({ current }) {
  const db = useDB()
  const nav = useNavigate()
  if (db.kanbans.length < 2) return null
  return (
    <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Kanbans">
      {db.kanbans.map((k) => (
        <button key={k.id} role="tab" aria-selected={k.id === current} onClick={() => k.id !== current && nav('/crms/' + k.id)}
          className={cx('flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-[600] transition', k.id === current ? 'chip-on' : 'border-border text-text-secondary hover:border-border-hover hover:text-text-primary')}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: k.color }} />
          {k.name}
          <span className="opacity-70">{k.cards.length}</span>
        </button>
      ))}
    </div>
  )
}

function Board({ id }) {
  const db = useDB()
  const nav = useNavigate()
  const board = db.kanbans.find((k) => k.id === id)
  const [view, setView] = useState('board')
  const [q, setQ] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [labelFilter, setLabelFilter] = useState('')
  // Filtro de datas: cada coluna mostra quem chegou naquela etapa no período (comentou hoje, entrou no grupo hoje...)
  const [periodo, setPeriodo] = useState('todas')
  const [de, setDe] = useState(hojeISO())
  const [ate, setAte] = useState(hojeISO())
  const [dragId, setDragId] = useState(null)
  const [dragCol, setDragCol] = useState(null)
  const [overCol, setOverCol] = useState(null)
  const [cardModal, setCardModal] = useState(null)
  const [delCard, setDelCard] = useState(null)
  const [colMenu, setColMenu] = useState(null)
  const [rename, setRename] = useState(null)
  const [hidden, setHidden] = useState([])
  // Coluna com muitos cards (funil do Instagram): mostra os 50 mais recentes e carrega mais sob demanda
  const [limite, setLimite] = useState({})

  if (!board) return <EmptyState icon={Columns3} title="Kanban não encontrado" action={<button className="btn-primary" onClick={() => nav('/crms')}>Voltar</button>} />

  const save = (patch) => db.update('kanbans', board.id, patch)
  const setCards = (fn) => save((k) => ({ cards: fn(k.cards) }))
  const setCols = (fn) => save((k) => ({ columns: fn(k.columns) }))
  const contact = (cid) => db.contacts.find((c) => c.id === cid)
  const visibleCards = board.cards.filter((c) => (c.title + (contact(c.contactId)?.phone || '') + (contact(c.contactId)?.instagramUsername ? '@' + contact(c.contactId).instagramUsername : '')).toLowerCase().includes(q.toLowerCase()) && (!labelFilter || c.labels?.includes(labelFilter)))

  const drop = (colId) => {
    if (dragCol) {
      setCols((cols) => moveTo(cols, dragCol, colId))
      setDragCol(null)
      setOverCol(null)
      return
    }
    if (!dragId) return
    setCards((cards) => cards.map((c) => (c.id === dragId ? { ...c, columnId: colId, updatedAt: new Date().toISOString() } : c)))
    const col = board.columns.find((c) => c.id === colId)
    if (col?.conversion) toast(`🎉 Conversão! Negócio movido para "${col.name}".`)
    setDragId(null)
    setOverCol(null)
  }

  const exportCsv = () => downloadCsv(`${board.name}.csv`, board.cards.map((c) => ({ nome: c.title, telefone: contact(c.contactId)?.phone, etapa: board.columns.find((x) => x.id === c.columnId)?.name, valor: c.value, atualizado: fmtDate(c.updatedAt) })))

  return (
    <div className="flex h-full flex-col">
      <BoardSwitcher current={board.id} />
      <div className="mb-4 flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div className="flex items-center gap-3">
          <button className="btn-ghost p-2" onClick={() => nav('/crms')}><ArrowLeft size={18} /></button>
          <h1 className="page-heading">{board.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={view} onChange={setView} tabs={[{ id: 'board', label: 'Quadro', icon: LayoutGrid }, { id: 'funnel', label: 'Funil', icon: BarChart3 }]} />
          <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou telefone" className="w-56" />
          <div className="flex items-center gap-1.5">
            <CalendarDays size={15} className="text-text-muted" />
            <Select className="w-40" value={periodo} onChange={setPeriodo} options={PERIODOS} />
            {periodo === 'periodo' && (
              <>
                <input type="date" className="input w-36 py-1.5" value={de} max={ate} onChange={(e) => setDe(e.target.value)} aria-label="De" />
                <span className="text-xs text-text-muted">até</span>
                <input type="date" className="input w-36 py-1.5" value={ate} min={de} onChange={(e) => setAte(e.target.value)} aria-label="Até" />
              </>
            )}
          </div>
          <button className={cx('btn-secondary', showFilters && 'border-accent-primary')} onClick={() => setShowFilters((v) => !v)}><Filter size={15} /> Filtros</button>
          <button className="btn-secondary" onClick={exportCsv}><Download size={15} /> Exportar</button>
          <button className="btn-primary" onClick={() => setCardModal({ columnId: board.columns[0]?.id })}><Plus size={15} /> Novo negócio</button>
        </div>
      </div>
      {showFilters && (
        <div className="card mb-4 flex flex-wrap items-center gap-3 p-3">
          <span className="text-xs font-semibold text-text-muted">Etiquetas (qualquer uma):</span>
          <Select className="w-48" value={labelFilter} onChange={setLabelFilter} placeholder="Todas" options={db.labels.map((l) => ({ value: l.id, label: l.name }))} />
          {hidden.length > 0 && <button className="btn-ghost text-xs" onClick={() => setHidden([])}><Eye size={14} /> Mostrar {hidden.length} coluna(s) oculta(s)</button>}
          <button className="btn-ghost text-xs" onClick={() => { setLabelFilter(''); setQ('') }}>Limpar</button>
        </div>
      )}

      {view === 'funnel' ? (
        <Funnel board={board} />
      ) : (
        <div className="-mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 lg:-mx-8 lg:px-8">
          {board.columns.filter((c) => !hidden.includes(c.id)).map((col) => {
            const faixa = faixaDoPeriodo(periodo, de, ate)
            const cards = visibleCards.filter((c) => c.columnId === col.id && dentro(dataDaEtapa(c, col.id), faixa))
              .sort((a, b) => String(dataDaEtapa(b, col.id) || '').localeCompare(String(dataDaEtapa(a, col.id) || '')))
            const total = cards.reduce((a, c) => a + (+c.value || 0), 0)
            const max = limite[col.id] || 50
            const shown = cards.slice(0, max)
            return (
              <div
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.id) }}
                onDragLeave={() => setOverCol(null)}
                onDrop={() => drop(col.id)}
                className={cx('flex w-[290px] shrink-0 flex-col rounded-[20px] border transition', overCol === col.id ? 'border-accent-primary' : 'border-border', dragCol === col.id && 'opacity-40')}
                style={{ background: 'var(--material-panel)', boxShadow: 'var(--shadow-panel)' }}
              >
                {/* Arrastar pelo topo muda a coluna de lugar */}
                <div
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragCol(col.id) }}
                  onDragEnd={() => { setDragCol(null); setOverCol(null) }}
                  className="relative cursor-grab border-b border-border p-3 active:cursor-grabbing"
                  style={{ borderTop: `3px solid ${col.color}`, borderRadius: '20px 20px 0 0' }}
                  title="Arraste para mudar a coluna de lugar"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">{col.name}</p>
                      <span className="badge-muted">{cards.length}</span>
                      {col.conversion && <span className="badge-success" title="Meta de conversão"><Target size={10} /></span>}
                      {col.lost && <span className="badge-danger" title="Etapa de perda"><CircleX size={10} /></span>}
                      {col.pausa && <span className="badge-muted" title="IA e disparos pausados pra quem está aqui"><PauseCircle size={10} /></span>}
                    </div>
                    <button className="btn-ghost p-1" onClick={() => setColMenu(colMenu === col.id ? null : col.id)} aria-label="Ações da coluna"><MoreHorizontal size={15} /></button>
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">{brl(total)}</p>
                  {colMenu === col.id && (
                    <div className="animate-fade-in absolute right-2 top-10 z-20 w-56 menu-pop p-1">
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setRename(col); setColMenu(null) }}><Pencil size={13} /> Renomear coluna</button>
                      {board.columns[0]?.id !== col.id && <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setCols((cols) => moveTo(cols, col.id, cols[cols.findIndex((c) => c.id === col.id) - 1].id)); setColMenu(null) }}><ArrowLeft size={13} /> Mover para a esquerda</button>}
                      {board.columns[board.columns.length - 1]?.id !== col.id && <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setCols((cols) => moveTo(cols, col.id, cols[cols.findIndex((c) => c.id === col.id) + 1].id)); setColMenu(null) }}><ArrowRight size={13} /> Mover para a direita</button>}
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setCols((cols) => cols.map((c) => (c.id === col.id ? { ...c, conversion: !c.conversion } : c))); setColMenu(null) }}><Target size={13} /> {col.conversion ? 'Remover marcação conversão' : 'Marcar como conversão'}</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setCols((cols) => cols.map((c) => (c.id === col.id ? { ...c, lost: !c.lost } : c))); setColMenu(null) }} title="Usada pelo gatilho de fluxo “Negócio perdido”"><CircleX size={13} /> {col.lost ? 'Remover marcação de perda' : 'Marcar como perda'}</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setCols((cols) => cols.map((c) => (c.id === col.id ? { ...c, pausa: !c.pausa } : c))); setColMenu(null) }} title="Quem tem negócio nesta coluna não recebe IA, mensagem de fluxo nem disparo (o chat manual continua)"><PauseCircle size={13} /> {col.pausa ? 'Voltar IA e disparos' : 'Pausar IA e disparos'}</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setHidden([...hidden, col.id]); setColMenu(null) }}><EyeOff size={13} /> Ocultar coluna</button>
                      <button className="btn-ghost w-full justify-start text-xs text-red-400" onClick={() => { if (cards.length) return toast('Mova os negócios antes de excluir a coluna.', 'warning'); setCols((cols) => cols.filter((c) => c.id !== col.id)); setColMenu(null) }}><Trash2 size={13} /> Excluir coluna</button>
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-2" style={{ maxHeight: 'calc(100vh - 260px)' }}>
                  {cards.length === 0 && <p className="rounded-[13px] border border-dashed border-border py-6 text-center text-xs text-text-muted">Arraste negócios aqui</p>}
                  {shown.map((c) => {
                    const ct = contact(c.contactId)
                    return (
                      <div
                        key={c.id}
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); setDragId(c.id) }}
                        onDragEnd={() => setDragId(null)}
                        onClick={() => setCardModal(c)}
                        className={cx('panel-soft group cursor-grab p-3 transition hover:border-border-hover active:cursor-grabbing', dragId === c.id && 'opacity-40')}
                      >
                        <div className="flex items-start gap-2">
                          <Avatar name={c.title} src={ct?.avatarUrl} size={28} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{c.title}</p>
                            <p className="flex items-center gap-1 truncate text-xs text-text-muted"><ChannelIcons channels={contactChannels(ct)} size={13} /> <span className="truncate">{ct?.phone || igHandle(ct?.instagramUsername)}</span></p>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              title="Excluir negócio"
                              aria-label="Excluir negócio"
                              className="btn-ghost p-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                              onClick={(e) => { e.stopPropagation(); setDelCard(c) }}
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              <Trash2 size={14} className="text-red-400" />
                            </button>
                            <GripVertical size={14} className="text-text-muted opacity-0 group-hover:opacity-100" />
                          </div>
                        </div>
                        {c.labels?.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {c.labels.map((lid) => { const l = db.labels.find((x) => x.id === lid); return l && <span key={lid} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: l.color + '25', color: l.color }}>{l.name}</span> })}
                          </div>
                        )}
                        {/* produto da "Possível venda" ou da "Venda aprovada" do fluxo (extra.venda, gravado pelo servidor) */}
                        {c.venda?.produto && <p className="mt-2 flex items-center gap-1 text-[11px] text-text-muted" title={c.venda.status === 'aprovada' ? 'Produto vendido' : 'Produto da possível venda'}><HandCoins size={12} className="shrink-0" /><span className="truncate">{c.venda.produto}</span></p>}
                        <div className="mt-2 flex items-center justify-between text-xs">
                          <span className="font-semibold text-green-400">{brl(c.value, c.venda?.moeda)}</span>
                          <span className="text-text-muted" title="Quando chegou nesta etapa">{quandoCurto(dataDaEtapa(c, col.id))}</span>
                        </div>
                      </div>
                    )
                  })}
                  {cards.length > max && (
                    <button className="w-full rounded-[12px] border border-dashed border-border py-2 text-xs text-text-muted hover:text-text-primary" onClick={() => setLimite((l) => ({ ...l, [col.id]: max + 100 }))}>
                      Mostrar mais ({(cards.length - max).toLocaleString('pt-BR')} restantes)
                    </button>
                  )}
                </div>
                <button className="m-2 rounded-[12px] py-2 text-xs font-[550] text-text-muted hover:bg-surface-interactive hover:text-text-primary" onClick={() => setCardModal({ columnId: col.id })}><Plus size={13} className="mr-1 inline" />Adicionar negócio</button>
              </div>
            )
          })}
          <button onClick={() => setCols((cols) => [...cols, { id: uid(), name: 'Nova coluna', color: LABEL_COLORS[cols.length % LABEL_COLORS.length] }])} className="flex w-[260px] shrink-0 items-center justify-center gap-2 rounded-[20px] border border-dashed border-border text-sm text-text-muted hover:border-accent-primary hover:text-violet-300">
            <Plus size={16} /> Nova coluna
          </button>
        </div>
      )}

      {cardModal && <CardModal board={board} card={cardModal} onClose={() => setCardModal(null)} setCards={setCards} />}
      <Confirm open={!!delCard} onClose={() => setDelCard(null)} title="Excluir negócio" message={`Excluir o negócio "${delCard?.title}" deste Kanban? O contato e as conversas continuam no CRM.`} onConfirm={() => { setCards((cards) => cards.filter((x) => x.id !== delCard.id)); toast('Card excluído.') }} />
      <Modal open={!!rename} onClose={() => setRename(null)} title="Renomear coluna" size="sm" footer={<button className="btn-primary" onClick={() => { setCols((cols) => cols.map((c) => (c.id === rename.id ? { ...c, name: rename.name, color: rename.color } : c))); setRename(null) }}>Salvar</button>}>
        {rename && (
          <>
            <Field label="Nome"><input className="input" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} /></Field>
            <Field label="Cor"><div className="flex gap-2">{LABEL_COLORS.map((c) => <button key={c} onClick={() => setRename({ ...rename, color: c })} className={cx('h-7 w-7 rounded-full', rename.color === c && 'ring-2 ring-white')} style={{ background: c }} />)}</div></Field>
          </>
        )}
      </Modal>
    </div>
  )
}

/* ---------- Filtro de datas (quando a pessoa chegou na etapa) ---------- */

const PERIODOS = [
  { value: 'todas', label: 'Todas as datas' }, { value: 'hoje', label: 'Hoje' }, { value: 'ontem', label: 'Ontem' },
  { value: '7d', label: 'Últimos 7 dias' }, { value: '30d', label: 'Últimos 30 dias' }, { value: 'periodo', label: 'Escolher período' },
]
const DIA = 86_400_000
const inicioDoDia = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function hojeISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// [início, fim) no fuso de quem está vendo; null = sem filtro
function faixaDoPeriodo(periodo, de, ate) {
  const hoje = inicioDoDia(new Date())
  if (periodo === 'hoje') return [hoje, new Date(+hoje + DIA)]
  if (periodo === 'ontem') return [new Date(+hoje - DIA), hoje]
  if (periodo === '7d') return [new Date(+hoje - 6 * DIA), new Date(+hoje + DIA)]
  if (periodo === '30d') return [new Date(+hoje - 29 * DIA), new Date(+hoje + DIA)]
  if (periodo === 'periodo' && de && ate) return [new Date(`${de}T00:00:00`), new Date(+new Date(`${ate}T00:00:00`) + DIA)]
  return null
}
const dentro = (iso, faixa) => !faixa || (!!iso && Date.parse(iso) >= +faixa[0] && Date.parse(iso) < +faixa[1])

// Quando o card chegou na etapa da coluna: a data dessa etapa no funil; sem funil, a última atualização do card
function dataDaEtapa(card, colId) {
  const f = card?.funil
  if (f && f[colId]) return f[colId]
  if (f && Object.keys(f).length) return Object.values(f).sort().slice(-1)[0]
  return card?.updatedAt
}

// "hoje 14:32", "ontem 09:10", "22/10 18:05"
function quandoCurto(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const dias = Math.round((+inicioDoDia(new Date()) - +inicioDoDia(d)) / DIA)
  if (dias === 0) return `hoje ${hora}`
  if (dias === 1) return `ontem ${hora}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hora}`
}

function CardModal({ board, card, onClose, setCards }) {
  const db = useDB()
  const nav = useNavigate()
  const hasChat = useHasModule('chat')
  const isNew = !card.id
  const [f, setF] = useState({ title: '', contactId: '', value: 0, labels: [], assignee: db.memberId, notes: '', ...card })
  // Abre a conversa do contato no Chat ao Vivo (a mais recente); sem conversa, cria uma no número dele.
  const openChat = () => {
    const ct = db.contacts.find((c) => c.id === f.contactId)
    if (!ct) return toast('Escolha o contato do negócio para conversar.', 'error')
    let chat = db.chats.filter((x) => x.contactId === ct.id).sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''))[0]
    // No Instagram é o cliente quem começa: sem conversa, não dá para abrir uma
    if (!chat && !contactChannels(ct).includes('whatsapp')) return toast('No Instagram é o cliente quem começa a conversa. Ela aparece no Chat quando ele mandar Direct.', 'info')
    if (!chat) {
      const connectionId = ct.connectionId || db.connections.find((c) => c.status === 'connected')?.id || db.connections[0]?.id
      if (!connectionId) return toast('Conecte um número em Conexões para conversar.', 'error')
      chat = db.add('chats', { contactId: ct.id, connectionId, status: 'attending', unread: 0, answered: true, assignedTo: db.memberId, lastMessageAt: new Date().toISOString(), botActive: false })
      db.setKey('messages', (m) => ({ ...m, [chat.id]: [] }))
    }
    nav(`/chats?chat=${chat.id}`)
  }
  const save = () => {
    const ct = db.contacts.find((c) => c.id === f.contactId)
    const data = { ...f, title: f.title || ct?.name || 'Sem nome', value: +f.value, updatedAt: new Date().toISOString() }
    if (isNew) setCards((cards) => [...cards, { ...data, id: uid() }])
    else setCards((cards) => cards.map((c) => (c.id === card.id ? data : c)))
    toast(isNew ? 'Negócio criado.' : 'Negócio atualizado.')
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={isNew ? 'Novo negócio' : f.title}
      footer={<>
        {!isNew && <button className="btn-danger mr-auto" onClick={() => { setCards((cards) => cards.filter((c) => c.id !== card.id)); onClose() }}><Trash2 size={14} /> Excluir</button>}
        {!isNew && <StartFlowButton where="deal" contactId={card.contactId} cardId={card.id} />}
        {!isNew && hasChat && f.contactId && <button className="btn-secondary" onClick={openChat}><MessageCircle size={14} /> Conversar</button>}
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn-primary" onClick={save}>Salvar</button>
      </>}>
      {!isNew && db.contacts.find((c) => c.id === card.contactId) && (
        <div className="mb-4 space-y-4 border-b border-border-subtle pb-4">
          <PessoaResumo contact={db.contacts.find((c) => c.id === card.contactId)} compacto />
          {card.funil && Object.keys(card.funil).length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase text-text-muted">Caminho no funil</p>
              <FunilLinhaDoTempo card={card} />
            </div>
          )}
        </div>
      )}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Contato"><Select value={f.contactId} onChange={(v) => setF({ ...f, contactId: v, title: f.title || db.contacts.find((c) => c.id === v)?.name })} placeholder="Selecione..." options={db.contacts.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Título"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Etapa"><Select value={f.columnId} onChange={(v) => setF({ ...f, columnId: v })} options={board.columns.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Valor (R$)"><input type="number" className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        <Field label="Responsável"><Select value={f.assignee} onChange={(v) => setF({ ...f, assignee: v })} options={db.team.map((u) => ({ value: u.id, label: u.name }))} /></Field>
      </div>
      <Field label="Etiquetas">
        <div className="flex flex-wrap gap-1.5">
          {db.labels.map((l) => {
            const on = f.labels?.includes(l.id)
            return <button key={l.id} onClick={() => setF({ ...f, labels: on ? f.labels.filter((x) => x !== l.id) : [...(f.labels || []), l.id] })} className="rounded-full border px-2.5 py-1 text-xs" style={on ? { background: l.color + '30', borderColor: l.color, color: l.color } : { borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>{l.name}</button>
          })}
        </div>
      </Field>
      <Field label="Anotações"><textarea className="input" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  )
}

function Funnel({ board }) {
  const total = board.cards.length
  const s = boardStats(board)
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Total de Leads', total], ['Taxa de Conversão Geral', s.rate.toFixed(1) + '%'], ['Total de Compras', s.converted], ['Faturamento Total', brl(board.cards.filter((c) => board.columns.find((x) => x.id === c.columnId)?.conversion).reduce((a, c) => a + +c.value, 0))]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs text-text-muted">{l}</p><p className="mt-1 text-xl font-bold">{v}</p></div>
        ))}
      </div>
      <div className="card p-5">
        <p className="font-semibold">Etapas do funil</p>
        <p className="mb-5 text-xs text-text-muted">Acompanhe a jornada dos seus leads em cada etapa do funil. Percentuais calculados com base no total de leads do Kanban.</p>
        <div className="flex flex-col items-center gap-1.5">
          {board.columns.map((c, i) => {
            const n = board.cards.filter((x) => x.columnId === c.id).length
            const pct = total ? (n / total) * 100 : 0
            const width = 100 - (i * 55) / Math.max(board.columns.length - 1, 1)
            return (
              <div key={c.id} className="flex items-center justify-between rounded-[13px] px-4 py-3 text-sm text-white" style={{ width: `${width}%`, background: c.color }}>
                <span className="font-semibold">{c.name} {c.conversion && '🎯'}</span>
                <span>{n} leads · {pct.toFixed(0)}% do total</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
