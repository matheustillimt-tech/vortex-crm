import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position, addEdge, useNodesState, useEdgesState, ReactFlowProvider, useReactFlow, useUpdateNodeInternals,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  ArrowLeft, Pencil, Sparkles, Pause, Play, Languages, Archive, LayoutGrid, PlayCircle, Search, X, Trash2, Copy, Plus, Send, RotateCcw, Check, Bot,
} from 'lucide-react'
import { useDB, useModules, toast } from '../lib/store'
import { BLOCK_MODULE } from '../lib/modules'
import { useBrand } from '../lib/palette'
import { BLOCKS, blockByKind, outputsOf, summaryOf } from '../lib/blocks'
import { brl, cx, uid } from '../lib/utils'
import { startData } from '../lib/triggers'
import { BACKEND } from '../lib/supabase'
import { flowNodeStats, flowRunStats, TEMPLATE_MEDIA, uploadTemplateMedia } from '../lib/backend'
import TemplatePreview from '../components/TemplatePreview'
import { Field, Modal, Select } from '../components/ui'
import { EMPTY_STATS, StartCtx, StartNode, StartPanel, summarizeStats } from '../components/fluxos/StartBlock'

/* ---------- Nós ---------- */

// Blocos em tons neutros, tipo janela de terminal; o verde-limão fica só no Início (um "LED").
// Usa variáveis CSS, então acompanha o modo claro/escuro sozinho.
const blockLook = () => ({
  header: 'var(--block-header)',
  tileBg: 'var(--surface-overlay)',
  tileFg: 'var(--text-primary)',
  tileBorder: '1px solid var(--border-hover)',
  handle: 'rgb(var(--accent))',
  icon: 'var(--eyebrow)',
})

// Sucessos / Alertas / Erros de cada bloco (flow_node_stats, a partir de flow_runs.steps), como o Início mostra para o fluxo.
// reason: o motivo do alerta/erro mais recente, no title dos contadores.
const NodeStatsCtx = createContext({})
const EMPTY_NODE = { ok: 0, alert: 0, error: 0, reason: '' }
function summarizeNodeStats(rows) {
  const out = {}
  for (const r of rows || []) {
    const s = (out[r.node_id] ||= { ok: 0, alert: 0, error: 0, reason: '', reasonAt: '' })
    if (!(r.status in EMPTY_NODE)) continue
    s[r.status] += +r.total
    if (r.last_reason && r.status !== 'ok' && String(r.last_at || '') >= s.reasonAt) Object.assign(s, { reason: r.last_reason, reasonAt: String(r.last_at || '') })
  }
  return out
}

const BlockStats = ({ id }) => {
  const s = useContext(NodeStatsCtx)[id] || EMPTY_NODE
  const { open } = useContext(StartCtx)
  return (
    <div className="grid grid-cols-3 border-t border-border py-1.5 text-center">
      {[['Sucessos', s.ok, 'text-green-400'], ['Alertas', s.alert, 'text-amber-400'], ['Erros', s.error, 'text-red-400']].map(([label, n, tone]) => (
        <button key={label} className="nodrag" onClick={(e) => { e.stopPropagation(); open({ tab: 'history' }) }}
          title={label !== 'Sucessos' && n && s.reason ? `Último motivo: ${s.reason}\nClique para ver o histórico` : 'Ver histórico'}>
          <p className="text-sm text-text-primary">{n.toLocaleString('pt-BR')}</p>
          <p className={cx('text-[10px]', n ? tone : 'text-text-muted')}>{label}</p>
        </button>
      ))}
    </div>
  )
}

const BlockNode = memo(({ id, data, selected }) => {
  const db = useDB()
  const b = blockByKind(data.kind)
  const look = blockLook()
  const outs = outputsOf(data.kind, data.config)
  const update = useUpdateNodeInternals()
  useEffect(() => { update(id) }, [outs.length, id, update])
  const Icon = b.icon
  return (
    <div className={cx('w-[260px] rounded-[20px] border bg-surface-raised shadow-[var(--shadow-panel)] transition', selected ? 'border-accent-primary shadow-glow-lg' : 'border-border')}>
      <Handle type="target" position={Position.Left} style={{ background: look.handle }} />
      <div className="flex items-center gap-2 rounded-t-[20px] px-3 py-2.5" style={{ background: look.header }}>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: look.tileBg, color: look.tileFg, border: look.tileBorder }}><Icon size={15} /></div>
        <span className="text-sm font-semibold text-text-primary">{b.label}</span>
      </div>
      <div className="line-clamp-3 px-3 py-2.5 text-xs text-text-secondary">{summaryOf(data.kind, data.config, db)}</div>
      {outs.length > 0 && (
        <div className="border-t border-border pb-1">
          {outs.map((o, i) => (
            <div key={i} className="relative flex h-8 items-center justify-end px-3 text-[11px] font-medium text-text-muted">
              {o ?? 'Próximo'}
              <Handle type="source" id={`out-${i}`} position={Position.Right} style={{ top: 16, background: look.handle }} />
            </div>
          ))}
        </div>
      )}
      <BlockStats id={id} />
    </div>
  )
})

const nodeTypes = { start: StartNode, block: BlockNode }

/* ---------- Editor ---------- */

export default function FlowEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  )
}

function Editor() {
  const { id } = useParams()
  const db = useDB()
  const brand = useBrand()
  const nav = useNavigate()
  const flow = db.flows.find((f) => f.id === id)
  // Bloco Início sempre no formato novo (o antigo, só com palavras-chave, vira o gatilho "Mensagem recebida") e sem excluir.
  // O bloco novo é mais largo: no formato antigo ele recua para não encostar no bloco seguinte.
  const [nodes, setNodes, onNodesChange] = useNodesState((flow?.nodes || []).map((n) => (n.type !== 'start' ? n : {
    ...n, deletable: false, data: startData(n.data),
    position: Array.isArray(n.data?.triggers) ? n.position : { ...n.position, x: (n.position?.x || 0) - 100 },
  })))
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow?.edges || [])
  const [panel, setPanel] = useState(null) // tools | sim | null
  const [drop, setDrop] = useState(null) // ligação solta no vazio: { nodeId, handleId, handleType, at (no fluxo), left, top (na tela) }
  const connecting = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(flow?.name || '')
  const [saved, setSaved] = useState(true)
  const [aiOpen, setAiOpen] = useState(false)
  const [startView, setStartView] = useState(null)
  const [stats, setStats] = useState(EMPTY_STATS)
  const [nodeStats, setNodeStats] = useState({})
  const wrapper = useRef(null)
  const rf = useReactFlow()
  const first = useRef(true)

  // auto-save
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setSaved(false)
    const t = setTimeout(() => {
      db.update('flows', id, { nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle })), updatedAt: new Date().toISOString() })
      setSaved(true)
    }, 600)
    return () => clearTimeout(t)
  }, [nodes, edges]) // eslint-disable-line

  // Contadores (Sucessos, Alertas, Erros) do bloco Início e de cada bloco
  const reloadStats = useCallback(() => {
    if (!BACKEND) return
    flowRunStats(id).then((rows) => setStats(summarizeStats(rows))).catch(() => {})
    flowNodeStats(id).then((rows) => setNodeStats(summarizeNodeStats(rows))).catch(() => {})
  }, [id])
  useEffect(() => {
    reloadStats()
    const t = setInterval(reloadStats, 20000)
    return () => clearInterval(t)
  }, [reloadStats])

  const onConnect = useCallback((p) => {
    connecting.current = null
    setEdges((eds) => addEdge({ ...p, id: uid(), animated: false }, eds.filter((e) => !(e.source === p.source && e.sourceHandle === p.sourceHandle))))
  }, [setEdges])

  // Ligação solta no vazio do canvas: abre a lista de blocos ali mesmo, e o bloco escolhido já nasce ligado
  const onConnectStart = useCallback((_, from) => { connecting.current = from }, [])
  const onConnectEnd = useCallback((e) => {
    const from = connecting.current
    connecting.current = null
    if (!from?.nodeId || !wrapper.current) return
    const pt = e.changedTouches?.[0] || e
    if (!document.elementFromPoint(pt.clientX, pt.clientY)?.classList.contains('react-flow__pane')) return
    const box = wrapper.current.getBoundingClientRect()
    setPanel((p) => (p === 'tools' ? null : p))
    setDrop({
      ...from, at: rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }),
      left: Math.max(12, Math.min(pt.clientX - box.left, box.width - 282)), top: Math.max(12, Math.min(pt.clientY - box.top, box.height - 392)),
    })
  }, [rf])

  const addBlock = (kind, position) => {
    const b = blockByKind(kind)
    const config = Object.fromEntries((b.fields || []).filter((f) => f.default != null).map((f) => [f.key, f.default]))
    if (b.dynamicOutputs === 'options') config.options = ['Opção 1', 'Opção 2']
    const pos = position || rf.screenToFlowPosition({ x: (wrapper.current?.getBoundingClientRect().left || 0) + 420, y: (wrapper.current?.getBoundingClientRect().top || 0) + 200 + Math.random() * 80 })
    const n = { id: uid(), type: 'block', position: pos, data: { kind, config } }
    setNodes((ns) => [...ns, n])
    setSelectedId(n.id)
    return n
  }

  // Saindo de uma saída, o bloco novo fica à direita com a entrada no ponto solto; saindo de uma entrada, fica à esquerda.
  const addConnected = (kind) => {
    const { nodeId, handleId, handleType, at } = drop
    setDrop(null)
    if (handleType === 'target') {
      const n = addBlock(kind, { x: at.x - 270, y: at.y - 100 })
      onConnect({ source: n.id, sourceHandle: 'out-0', target: nodeId })
    } else {
      const n = addBlock(kind, { x: at.x + 6, y: at.y - 60 })
      onConnect({ source: nodeId, sourceHandle: handleId, target: n.id })
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    const kind = e.dataTransfer.getData('application/flow-block')
    if (!kind) return
    addBlock(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    setPanel(null)
  }
  const closeTools = () => setPanel((p) => (p === 'tools' ? null : p))

  const selected = nodes.find((n) => n.id === selectedId && n.type === 'block')
  const selectedStart = nodes.find((n) => n.id === selectedId && n.type === 'start')
  const startNode = nodes.find((n) => n.type === 'start')
  const setStart = useCallback((fn) => setNodes((ns) => ns.map((n) => (n.type === 'start' ? { ...n, data: fn(n.data) } : n))), [setNodes])
  const startCtx = useMemo(() => ({
    flow, start: startNode?.data || startData({}), setStart, stats, view: startView, setView: setStartView, reloadStats,
    open: (view) => { setSelectedId(startNode?.id); setStartView(view) },
  }), [flow, startNode?.data, startNode?.id, setStart, stats, startView, reloadStats])
  const setConfig = (patch) => setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n)))
  const deleteSelected = () => {
    setNodes((ns) => ns.filter((n) => n.id !== selectedId))
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }
  const duplicateSelected = () => {
    if (!selected) return
    const n = { ...selected, id: uid(), position: { x: selected.position.x + 40, y: selected.position.y + 60 }, selected: false, data: JSON.parse(JSON.stringify(selected.data)) }
    setNodes((ns) => [...ns, n])
    setSelectedId(n.id)
  }

  if (!flow) return <div className="p-8 text-center text-text-muted">Fluxo não encontrado. <button className="text-violet-400" onClick={() => nav('/flows')}>Voltar</button></div>

  const active = flow.status === 'active'

  return (
    <div className="flex h-[calc(100dvh-56px-64px)] flex-col overflow-hidden lg:h-dvh">
      {/* Header */}
      <header className="glass-modal z-10 m-3 flex items-center gap-2 rounded-[18px] px-3 py-2">
        <button className="btn-ghost p-2" onClick={() => nav('/flows')} aria-label="Voltar para Fluxos"><ArrowLeft size={18} /></button>
        {editingTitle ? (
          <input autoFocus className="input max-w-xs py-1" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { db.update('flows', id, { name: title || 'Sem nome' }); setEditingTitle(false) }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        ) : (
          <button className="flex min-w-0 items-center gap-2 font-semibold" onClick={() => setEditingTitle(true)} title="Editar título">
            <span className="truncate">{flow.name}</span> <Pencil size={13} className="shrink-0 text-text-muted" />
          </button>
        )}
        <span className={cx('ml-1 hidden text-xs sm:inline', saved ? 'text-text-muted' : 'text-amber-400')}>{saved ? <><Check size={12} className="inline" /> Salvo</> : 'Salvando…'}</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="btn-primary h-9 w-9 p-0" title="Assistente de IA" onClick={() => setAiOpen(true)}><Sparkles size={16} /></button>
          <button className="btn-secondary h-9 w-9 p-0" title={active ? 'Pausar fluxo' : 'Ativar fluxo'} onClick={() => { db.update('flows', id, { status: active ? 'paused' : 'active' }); toast(active ? 'Fluxo pausado.' : 'Fluxo ativado.') }}>{active ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="btn-secondary hidden h-9 w-9 p-0 sm:inline-flex" title="Traduzir" onClick={() => toast('Tradução de fluxo: conecte uma API de IA para habilitar.', 'info')}><Languages size={15} /></button>
          <button className="btn-secondary hidden h-9 w-9 p-0 sm:inline-flex" title="Arquivar fluxo" onClick={() => { db.update('flows', id, { status: 'paused' }); nav('/flows'); toast('Fluxo arquivado (pausado).') }}><Archive size={15} /></button>
        </div>
      </header>

      <StartCtx.Provider value={startCtx}>
      <NodeStatsCtx.Provider value={nodeStats}>
      <div className="relative flex-1" ref={wrapper}>
        {/* Toolbar */}
        <div className="absolute left-3 top-0 z-10 flex gap-2">
          <button className={cx('btn px-3 py-2', panel === 'tools' ? 'is-selected' : 'btn-secondary')} onClick={() => setPanel(panel === 'tools' ? null : 'tools')}><LayoutGrid size={15} /> Ferramentas</button>
          <button className={cx('btn px-3 py-2', panel === 'sim' ? 'is-selected' : 'btn-secondary')} onClick={() => setPanel(panel === 'sim' ? null : 'sim')}><PlayCircle size={15} /> Simular</button>
        </div>

        {/* Ferramentas: abre pelo botão e fecha ao escolher, ao soltar no canvas ou ao clicar no fluxo (não fica por cima dos blocos) */}
        {panel === 'tools' && (
          <BlockPicker draggable className="absolute left-3 top-12 z-20 max-h-[min(560px,calc(100%-3.75rem))]" hint="Clique ou arraste para o canvas"
            onPick={(k) => { addBlock(k); setPanel(null) }} onClose={() => setPanel(null)} />
        )}
        {panel === 'sim' && <Simulator nodes={nodes} edges={edges} onClose={() => setPanel(null)} onHighlight={() => {}} />}
        {drop && (
          <>
            <div className="absolute inset-0 z-30" onPointerDown={() => setDrop(null)} />
            <BlockPicker className="absolute z-40 h-[min(380px,calc(100%-1.5rem))]" style={{ left: drop.left, top: drop.top }} hint="Escolha o bloco que vai ficar ligado aqui"
              filter={(b) => drop.handleType !== 'target' || !b.terminal} onPick={addConnected} onClose={() => setDrop(null)} />
          </>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => { if (n.id !== selectedId) setStartView(null); setSelectedId(n.id); closeTools() }}
          onPaneClick={() => { setSelectedId(null); closeTools() }}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
          onNodesDelete={(ns) => ns.some((n) => n.id === selectedId) && setSelectedId(null)}
          deleteKeyCode={['Delete', 'Backspace']}
          defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 2 } }}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={brand.canvasDot} gap={22} size={1.4} />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap className="!hidden sm:!block" position="bottom-right" pannable zoomable nodeColor={(n) => (n.type === 'start' ? brand.accent : brand.minimapNode)} maskColor={brand.minimapMask} />
        </ReactFlow>

        {selected && (
          <ConfigPanel node={selected} setConfig={setConfig} onDelete={deleteSelected} onDuplicate={duplicateSelected} onClose={() => setSelectedId(null)} />
        )}
        {selectedStart && <StartPanel onClose={() => setSelectedId(null)} />}
      </div>
      </NodeStatsCtx.Provider>
      </StartCtx.Provider>

      <AiAssistant open={aiOpen} onClose={() => setAiOpen(false)} onGenerate={(ns, es) => { setNodes((cur) => [...cur.filter((n) => n.type === 'start'), ...ns]); setEdges(es); setTimeout(() => rf.fitView({ padding: 0.3 }), 50) }} />
    </div>
  )
}

/* ---------- Lista de blocos ---------- */

// Usada no botão Ferramentas (clique ou arraste) e no seletor que abre ao soltar uma ligação no canvas.
// Enter escolhe o primeiro da busca; Esc fecha.
function BlockPicker({ onPick, onClose, draggable, hint, className, style, filter = () => true }) {
  const [q, setQ] = useState('')
  const modules = useModules()
  // blocos que dependem de outro módulo só aparecem se a empresa tiver esse módulo
  const list = BLOCKS.filter((b) => filter(b) && (!BLOCK_MODULE[b.kind] || modules.includes(BLOCK_MODULE[b.kind])) && (b.label + b.desc).toLowerCase().includes(q.toLowerCase()))
  return (
    <div className={cx('animate-fade-in flex w-[270px] flex-col glass-modal rounded-[20px]', className)} style={style}>
      <div className="flex items-center gap-2 border-b border-border-subtle p-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input autoFocus className="input py-1.5 pl-8" placeholder="Buscar blocos…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && list[0]) onPick(list[0].kind) }} />
        </div>
        <button className="btn-ghost p-1.5" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {list.length === 0 && <p className="p-4 text-center text-xs text-text-muted">Nenhum bloco encontrado</p>}
        {list.map((b) => (
          <button
            key={b.kind}
            draggable={draggable}
            onDragStart={draggable ? (e) => { e.dataTransfer.setData('application/flow-block', b.kind); e.dataTransfer.effectAllowed = 'move' } : undefined}
            onClick={() => onPick(b.kind)}
            title={b.desc}
            className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-interactive', draggable && 'cursor-grab active:cursor-grabbing')}
          >
            <b.icon size={17} style={{ color: blockLook().icon }} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">{b.label}</span>
              <span className="block truncate text-[11px] text-text-muted">{b.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="border-t border-border-subtle p-2 text-center text-[10px] text-text-muted">{hint}</p>
    </div>
  )
}

/* ---------- Painel de configuração ---------- */

// Variáveis {{1}}, {{2}}… do corpo de um template (a mesma regra de supabase/functions/_shared/templates.ts)
const templateVars = (body) => [...new Set([...String(body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)

// Bloco Template WhatsApp: escolhe entre os templates sincronizados da Meta e preenche cada variável
// (aceita {{nome}}, {{telefone}}, campos personalizados e variáveis globais). Sem templates sincronizados, digita o nome.
function TemplateField({ c, setConfig }) {
  const db = useDB()
  const [uploading, setUploading] = useState(false)
  const rank = (t) => (t.status === 'APROVADO' ? 0 : 1)
  const all = [...db.whatsappTemplates].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const key = c.template ? `${c.template}|${c.language || 'pt_BR'}` : ''
  const chosen = all.find((t) => `${t.name}|${t.language}` === key)
  // o mesmo template pode existir em mais de um número: uma opção por nome e idioma
  const options = [...new Map(all.map((t) => [`${t.name}|${t.language}`, { value: `${t.name}|${t.language}`, label: `${t.name} · ${t.language}${t.status === 'APROVADO' ? '' : ` (${String(t.status).toLowerCase()})`}` }])).values()]
  if (key && !chosen) options.unshift({ value: key, label: `${c.template} · ${c.language || 'pt_BR'}` })
  const params = Array.isArray(c.params) ? c.params : []
  const vars = templateVars(chosen?.body)
  if (!all.length) {
    return (
      <div className="space-y-2">
        <input className="input" placeholder="nome_do_template" value={c.template || ''} onChange={(e) => setConfig({ template: e.target.value })} />
        <Select value={c.language || 'pt_BR'} onChange={(v) => setConfig({ language: v })} options={['pt_BR', 'en_US', 'es_ES']} />
        <p className="text-[11px] text-text-muted">Sincronize em Configurações → Templates WhatsApp para escolher da lista e preencher as variáveis.</p>
      </div>
    )
  }
  const media = TEMPLATE_MEDIA[chosen?.header?.format]
  const headerUrl = c.headerUrl || chosen?.header?.mediaUrl || ''
  const pickMedia = async (file) => {
    if (!file) return
    if (!BACKEND) return setConfig({ headerUrl: URL.createObjectURL(file), headerName: file.name })
    setUploading(true)
    try {
      setConfig({ headerUrl: await uploadTemplateMedia(db.company.id, chosen.header.format, file), headerName: file.name })
    } catch (err) {
      toast(`Não foi possível enviar o arquivo: ${err.message}`, 'error')
    } finally {
      setUploading(false)
    }
  }
  return (
    <div className="space-y-2">
      <Select value={key} onChange={(v) => { const [template, language] = v.split('|'); setConfig({ template, language, params: [], headerUrl: '', headerName: '' }) }} placeholder="Selecione o template..." options={options} />
      {chosen && chosen.status !== 'APROVADO' && <p className="text-[11px] text-amber-400">Este template ainda não está aprovado pela Meta ({String(chosen.status).toLowerCase()}): o envio vai falhar até a aprovação.</p>}
      {chosen && <TemplatePreview header={{ ...chosen.header, mediaUrl: headerUrl }} body={chosen.body} footer={chosen.footer} buttons={chosen.buttons} />}
      {media && (
        <div className="space-y-1.5">
          <span className="block text-[11px] text-text-muted">Arquivo do cabeçalho ({media.label})</span>
          {!headerUrl && <p className="text-[11px] text-amber-400">Escolha o arquivo: sem ele a Meta não envia este template.</p>}
          <label className={cx('btn-secondary w-full cursor-pointer justify-center py-1.5 text-xs', uploading && 'pointer-events-none opacity-60')}>
            {uploading ? 'Enviando arquivo…' : c.headerUrl ? 'Trocar arquivo deste bloco' : headerUrl ? 'Usar outro arquivo neste bloco' : 'Escolher arquivo'}
            <input type="file" className="hidden" accept={media.accept} onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {c.headerUrl && chosen?.header?.mediaUrl && <button className="btn-ghost w-full py-1 text-[11px]" onClick={() => setConfig({ headerUrl: '', headerName: '' })}>Voltar ao arquivo do template</button>}
        </div>
      )}
      {vars.map((n) => (
        <label key={n} className="block">
          <span className="mb-1 block text-[11px] text-text-muted">{`Valor de {{${n}}}`}</span>
          <input className="input" placeholder={n === 1 ? '{{nome}}' : 'texto ou {{variavel}}'} value={params[n - 1] || ''}
            onChange={(e) => setConfig({ params: vars.map((m) => (m === n ? e.target.value : params[m - 1] || '')) })} />
        </label>
      ))}
    </div>
  )
}

// Bloco Kanban: as colunas do Kanban escolhido. Grava o nome (o servidor procura sem diferenciar maiúsculas);
// uma coluna digitada antes, ou que foi renomeada/apagada, continua aparecendo com o aviso.
function ColumnField({ kanbanId, value, onChange }) {
  const db = useDB()
  const k = db.kanbans.find((x) => x.id === kanbanId)
  if (!k) return <select className="input" disabled><option>Escolha o Kanban primeiro</option></select>
  const names = [...new Set((k.columns || []).map((x) => x.name).filter(Boolean))]
  const current = names.find((n) => n.toLowerCase() === String(value || '').toLowerCase()) ?? (value || '')
  const lost = current && !names.includes(current)
  return (
    <>
      <Select value={current} onChange={onChange} placeholder="Selecione a coluna..." options={lost ? [{ value: current, label: `${current} (não existe neste Kanban)` }, ...names] : names} />
      {lost && <p className="mt-1 text-[11px] text-amber-400">Essa coluna não existe neste Kanban: o negócio vai para a primeira coluna. Escolha outra.</p>}
    </>
  )
}

// Produto dos blocos de venda: escolhe da lista ou cria ali mesmo (nome, valor e moeda), sem sair do fluxo.
// O produto criado vai para Configurações → Produtos com faixa de preço = valor.
function ProductField({ value, onChange }) {
  const db = useDB()
  const [draft, setDraft] = useState(null) // { name, price, currency } enquanto cria
  const create = () => {
    const price = +draft.price || 0
    const p = db.add('products', { name: draft.name.trim(), price, min: price, max: price, currency: draft.currency })
    onChange(p.id)
    setDraft(null)
    toast('Produto criado.')
  }
  if (draft) {
    return (
      <div className="panel-soft space-y-2 p-2.5">
        <input autoFocus className="input" placeholder="Nome do produto" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); if (e.key === 'Enter' && draft.name.trim()) create() }} />
        <div className="flex gap-2">
          <input type="number" min={0} step="0.01" className="input min-w-0 flex-1" placeholder="Valor" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
          <Select className="w-24" value={draft.currency} onChange={(v) => setDraft({ ...draft, currency: v })} options={['BRL', 'USD', 'EUR', 'MXN']} />
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary flex-1 py-1.5 text-xs" onClick={() => setDraft(null)}>Cancelar</button>
          <button className="btn-primary flex-1 py-1.5 text-xs" disabled={!draft.name.trim()} onClick={create}>Criar produto</button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <Select value={value} onChange={onChange} placeholder="Selecione..." options={db.products.map((p) => ({ value: p.id, label: `${p.name} · ${brl(p.price, p.currency)}` }))} />
      <button className="btn-ghost w-full justify-center py-1 text-xs" onClick={() => setDraft({ name: '', price: '', currency: 'BRL' })}><Plus size={13} /> Criar produto</button>
    </div>
  )
}

function ConfigPanel({ node, setConfig, onDelete, onDuplicate, onClose }) {
  const db = useDB()
  const b = blockByKind(node.data.kind)
  const look = blockLook()
  const c = node.data.config || {}
  const sources = {
    labels: db.labels.map((l) => ({ value: l.id, label: l.name })),
    flows: db.flows.map((f) => ({ value: f.id, label: f.name })),
    pixels: db.pixels.map((p) => ({ value: p.id, label: p.name })),
    departments: db.departments.map((d) => ({ value: d.id, label: d.name })),
    agents: db.agents.map((a) => ({ value: a.id, label: a.name })),
    kanbans: db.kanbans.map((k) => ({ value: k.id, label: k.name })),
    team: (db.team || []).map((u) => ({ value: u.id, label: u.name })),
  }
  return (
    <div className="animate-fade-in absolute bottom-3 right-3 top-0 z-20 flex w-[320px] flex-col glass-modal rounded-[20px]">
      <div className="flex items-center gap-2 border-b border-border-subtle p-3.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: look.tileBg, color: look.tileFg, border: look.tileBorder }}><b.icon size={16} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{b.label}</p>
          <p className="truncate text-[11px] text-text-muted">{b.desc}</p>
        </div>
        <button className="btn-ghost p-1.5" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {b.fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === 'textarea' && <textarea className="input" rows={4} placeholder={f.placeholder} value={c[f.key] || ''} onChange={(e) => setConfig({ [f.key]: e.target.value })} />}
            {f.type === 'text' && <input className="input" placeholder={f.placeholder} value={c[f.key] || ''} onChange={(e) => setConfig({ [f.key]: e.target.value })} />}
            {f.type === 'number' && <input type="number" className="input" value={c[f.key] ?? ''} onChange={(e) => setConfig({ [f.key]: e.target.value })} />}
            {f.type === 'select' && <Select value={c[f.key]} onChange={(v) => setConfig({ [f.key]: v, ...f.reset })} placeholder="Selecione..." options={f.source ? sources[f.source] : f.options} />}
            {f.type === 'column' && <ColumnField kanbanId={c[f.kanban]} value={c[f.key]} onChange={(v) => setConfig({ [f.key]: v })} />}
            {f.type === 'product' && <ProductField value={c[f.key]} onChange={(v) => setConfig({ [f.key]: v })} />}
            {f.type === 'template' && <TemplateField c={c} setConfig={setConfig} />}
            {f.type === 'multi' && (
              <div className="flex flex-wrap gap-1.5">
                {sources[f.source].map((o) => {
                  const on = (c[f.key] || []).includes(o.value)
                  return <button key={o.value} onClick={() => setConfig({ [f.key]: on ? c[f.key].filter((x) => x !== o.value) : [...(c[f.key] || []), o.value] })} className={cx('rounded-full border px-2.5 py-1 text-xs', on ? 'chip-on' : 'border-border text-text-muted')}>{o.label}</button>
                })}
              </div>
            )}
            {f.type === 'list' && (
              <div className="space-y-1.5">
                {(c[f.key] || []).map((v, i) => (
                  <div key={i} className="flex gap-1.5">
                    <input className="input py-1.5" value={v} onChange={(e) => setConfig({ [f.key]: c[f.key].map((x, j) => (j === i ? e.target.value : x)) })} />
                    <button className="btn-ghost p-1.5 text-red-400" onClick={() => setConfig({ [f.key]: c[f.key].filter((_, j) => j !== i) })}><X size={14} /></button>
                  </div>
                ))}
                <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => setConfig({ [f.key]: [...(c[f.key] || []), `Opção ${(c[f.key] || []).length + 1}`] })}><Plus size={13} /> Adicionar</button>
              </div>
            )}
          </Field>
        ))}
        <div className="panel-soft p-3 text-[11px] text-text-muted">
          Variáveis disponíveis: <code className="text-violet-300">{'{{nome}}'}</code>, <code className="text-violet-300">{'{{primeiro_nome}}'}</code>, <code className="text-violet-300">{'{{telefone}}'}</code>, <code className="text-violet-300">{'{{email}}'}</code>, campos personalizados e variáveis globais.
        </div>
      </div>
      <div className="flex gap-2 border-t border-border p-3">
        <button className="btn-secondary flex-1" onClick={onDuplicate}><Copy size={14} /> Duplicar</button>
        <button className="btn-danger flex-1" onClick={onDelete}><Trash2 size={14} /> Excluir</button>
      </div>
    </div>
  )
}

/* ---------- Simulador ---------- */

function Simulator({ nodes, edges, onClose, onHighlight }) {
  const db = useDB()
  const [log, setLog] = useState([])
  const [waiting, setWaiting] = useState(null)
  const [vars, setVars] = useState({ nome: 'Cliente Teste', primeiro_nome: 'Cliente', telefone: '+55 11 9XXXX-XXXX' })
  const [input, setInput] = useState('')
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log.length, waiting])

  const fill = (t, v) => String(t || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => v[k] ?? db.globalVars.find((g) => g.name === k)?.value ?? `{{${k}}}`)
  const nextOf = (nodeId, idx = 0) => edges.find((e) => e.source === nodeId && (e.sourceHandle || 'out-0') === `out-${idx}`)?.target

  const run = (startId, v = vars, acc = []) => {
    let cur = startId
    let steps = 0
    const out = [...acc]
    while (cur && steps++ < 60) {
      const n = nodes.find((x) => x.id === cur)
      if (!n) break
      onHighlight(n.id)
      if (n.type === 'start') { cur = nextOf(n.id); continue }
      const { kind, config: c = {} } = n.data
      const b = blockByKind(kind)
      const sys = (t) => out.push({ from: 'sys', text: t })
      switch (kind) {
        case 'message':
          out.push({ from: 'bot', text: fill(c.text || '(mensagem vazia)', v) }); cur = nextOf(n.id); break
        case 'whatsapp_template': {
          const tpl = db.whatsappTemplates.find((t) => t.name === c.template && t.language === (c.language || 'pt_BR'))
          const params = (c.params || []).map((p) => fill(p, v))
          const text = tpl?.body ? tpl.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, k) => params[k - 1] || m) : `[template] ${c.template || '(escolha o template)'}`
          out.push({ from: 'bot', text }); cur = nextOf(n.id); break
        }
        case 'pix':
          out.push({ from: 'bot', text: `${fill(c.text || 'Pagamento via Pix', v)}\n💠 Pix: ${c.key || 'chave-pix'} · R$ ${c.amount || '0,00'}` }); cur = nextOf(n.id); break
        case 'interactive_menu':
        case 'menu':
        case 'carousel':
          out.push({ from: 'bot', text: fill(c.text || 'Escolha uma opção:', v) })
          setLog(out); setVars(v); setWaiting({ type: 'menu', nodeId: n.id, options: c.options || [] }); return
        case 'wait_response':
          sys('⏳ Aguardando resposta do cliente…')
          setLog(out); setVars(v); setWaiting({ type: 'input', nodeId: n.id, variable: c.variable || 'resposta' }); return
        case 'condition': {
          const val = String(v[c.variable] ?? '').toLowerCase()
          const target = String(c.value || '').toLowerCase()
          const ok = c.operator === 'é igual a' ? val === target : c.operator === 'não contém' ? !val.includes(target) : c.operator === 'existe' ? !!val : val.includes(target)
          sys(`🔀 Condição ${ok ? 'verdadeira' : 'falsa'}`); cur = nextOf(n.id, ok ? 0 : 1); break
        }
        case 'distributor': {
          const i = Math.floor(Math.random() * Math.max(2, +c.count || 2)); sys(`🎲 Distribuído para a saída ${i + 1}`); cur = nextOf(n.id, i); break
        }
        case 'smart_interval':
          sys(`⏱ Aguardou ${c.amount || 5} ${c.unit || 'segundos'}`); cur = nextOf(n.id); break
        case 'ai':
          out.push({ from: 'bot', text: '🤖 (Resposta gerada pela IA a partir do prompt configurado)' }); cur = nextOf(n.id, 0); break
        case 'integration':
          sys(`🌐 Integração ${c.method || 'POST'} ${c.url || ''}: sucesso`); cur = nextOf(n.id, 0); break
        case 'kieai_integration':
          sys(`🪄 Kie.ai (${c.generationType || 'Imagem'}): sucesso`); cur = nextOf(n.id, 0); break
        case 'payment':
        case 'vortexpay':
          sys('💳 Cobrança gerada'); cur = nextOf(n.id, 0); break
        case 'connection_flow':
          sys(`↪ Redirecionado para o fluxo "${db.flows.find((f) => f.id === c.flowId)?.name || '—'}"`); cur = null; break
        case 'ai_agent':
          sys(c.mode === 'Remover agente do chat' ? '🤖 Agente de IA removido do chat' : `🤖 Conversa entregue a ${db.agents.find((a) => a.id === c.agentId)?.name || 'agente de IA'}`); cur = nextOf(n.id); break
        case 'tags':
          sys(`🏷 Etiquetas: ${(c.labels || []).map((id) => db.labels.find((l) => l.id === id)?.name).join(', ') || '—'}`); cur = nextOf(n.id); break
        case 'approved_sale':
          sys(`✅ Venda aprovada: ${db.products.find((p) => p.id === c.productId)?.name || 'produto'} (${c.amount || 0})`); cur = nextOf(n.id); break
        case 'possible_sale': {
          const p = db.products.find((x) => x.id === c.productId)
          sys(`🛒 Possível venda: ${p?.name || 'produto'} (${brl(+c.amount || p?.price, p?.currency)}) no Kanban ${db.kanbans.find((k) => k.id === c.crmId)?.name || '—'}`); cur = nextOf(n.id); break
        }
        case 'manipulator':
          v = { ...v, [c.field || 'campo']: fill(c.value, v) }; sys(`✏️ Campo ${c.field} = ${fill(c.value, v)}`); cur = nextOf(n.id); break
        default:
          sys(`▸ ${b.label}`); cur = nextOf(n.id)
      }
    }
    out.push({ from: 'sys', text: '🏁 Fim do fluxo' })
    setLog(out); setVars(v); setWaiting(null); onHighlight(null)
  }

  const start = () => { setWaiting(null); run('start', { nome: 'Cliente Teste', telefone: '+55 11 9XXXX-XXXX' }, []) }
  const choose = (i, label) => {
    const out = [...log, { from: 'user', text: label }]
    setWaiting(null)
    run(nextOf(waiting.nodeId, i), vars, out)
  }
  const reply = () => {
    if (!input || waiting?.type !== 'input') return
    const v = { ...vars, [waiting.variable]: input }
    const out = [...log, { from: 'user', text: input }]
    setInput('')
    setWaiting(null)
    run(nextOf(waiting.nodeId, 0), v, out)
  }

  return (
    <div className="animate-fade-in absolute bottom-3 left-3 top-12 z-20 flex w-[330px] flex-col glass-modal rounded-[20px]">
      <div className="flex items-center justify-between border-b border-border-subtle p-3.5">
        <p className="flex items-center gap-2 text-sm font-semibold"><PlayCircle size={16} className="text-violet-400" /> Simulador</p>
        <div className="flex gap-1">
          <button className="btn-ghost p-1.5" title="Reiniciar" onClick={start}><RotateCcw size={14} /></button>
          <button className="btn-ghost p-1.5" onClick={onClose}><X size={15} /></button>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0)', backgroundSize: '18px 18px' }}>
        {log.length === 0 && (
          <div className="py-10 text-center">
            <Bot size={28} className="mx-auto mb-2 text-violet-400" />
            <p className="text-sm text-text-secondary">Teste o fluxo como se fosse o cliente.</p>
            <button className="btn-primary mt-3" onClick={start}><Play size={14} /> Iniciar simulação</button>
          </div>
        )}
        {log.map((m, i) =>
          m.from === 'sys' ? (
            <p key={i} className="text-center text-[11px] text-text-muted">{m.text}</p>
          ) : (
            <div key={i} className={cx('flex', m.from === 'user' ? 'justify-end' : 'justify-start')}>
              <p className={cx('max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm', m.from === 'user' ? 'rounded-br-sm bubble-mine' : 'rounded-bl-sm border border-border-subtle bg-surface-overlay')}>{m.text}</p>
            </div>
          ),
        )}
        {waiting?.type === 'menu' && (
          <div className="flex flex-col gap-1.5 pl-2">
            {waiting.options.map((o, i) => <button key={i} className="rounded-[13px] border border-[var(--border-accent)] bg-accent-soft px-3 py-1.5 text-sm font-[550] text-[var(--accent-text)] transition hover:bg-violet-500/20" onClick={() => choose(i, o)}>{o}</button>)}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-border-subtle p-2">
        <input className="input py-1.5" placeholder={waiting?.type === 'input' ? 'Responda como o cliente…' : 'Aguardando o fluxo…'} disabled={waiting?.type !== 'input'} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply()} />
        <button className="btn-primary px-3" disabled={waiting?.type !== 'input'} onClick={reply}><Send size={14} /></button>
      </div>
    </div>
  )
}

/* ---------- Assistente de IA (gera um rascunho de fluxo) ---------- */

function AiAssistant({ open, onClose, onGenerate }) {
  const [text, setText] = useState('')
  const [options, setOptions] = useState('Quero comprar, Tirar dúvida, Falar com atendente')
  const generate = () => {
    const opts = options.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
    const welcome = { id: uid(), type: 'block', position: { x: 360, y: 200 }, data: { kind: 'message', config: { text: text ? `Oi {{nome}}! ${text}` : 'Oi {{nome}}! Que bom te ver por aqui 😊', typing: 2 } } }
    const menu = { id: uid(), type: 'block', position: { x: 680, y: 170 }, data: { kind: 'interactive_menu', config: { text: 'Como posso te ajudar?', options: opts } } }
    const branches = opts.map((o, i) => ({ id: uid(), type: 'block', position: { x: 1020, y: 40 + i * 170 }, data: { kind: 'message', config: { text: `Você escolheu: ${o}. Já vou te ajudar!` } } }))
    const edges = [
      { id: uid(), source: 'start', target: welcome.id, sourceHandle: 'out-0' },
      { id: uid(), source: welcome.id, target: menu.id, sourceHandle: 'out-0' },
      ...branches.map((b, i) => ({ id: uid(), source: menu.id, target: b.id, sourceHandle: `out-${i}` })),
    ]
    onGenerate([welcome, menu, ...branches], edges)
    toast('Rascunho de fluxo gerado! Ajuste os blocos como quiser.')
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title="Assistente de IA" subtitle="Descreva o objetivo e gere um rascunho do fluxo"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={generate}><Sparkles size={14} /> Gerar fluxo</button></>}>
      <Field label="Mensagem de boas-vindas / objetivo"><textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex.: Atender quem chega do anúncio do kit e levar para o Pix" /></Field>
      <Field label="Opções do menu (separadas por vírgula)" hint="Isto substitui os blocos atuais do canvas (o Início é mantido)."><input className="input" value={options} onChange={(e) => setOptions(e.target.value)} /></Field>
    </Modal>
  )
}
