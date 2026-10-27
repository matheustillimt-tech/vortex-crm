import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Workflow, Plus, FolderPlus, Upload, Folder, FolderOpen, MoreVertical, Copy, Download, Pause, Play, Trash2, FolderInput } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { cx, fmtDate, uid } from '../lib/utils'
import { Confirm, EmptyState, Field, Modal, PageHeader, Pills, SearchInput, Select } from '../components/ui'
import { newStartData, startOf, triggerDef } from '../lib/triggers'

export const newFlowData = () => ({
  nodes: [{ id: 'start', type: 'start', position: { x: 80, y: 200 }, data: newStartData() }],
  edges: [],
})

// Cópia (duplicar ou importar): a URL de um webhook pertence a um fluxo só, então o gatilho da cópia pede uma URL nova
const copyNodes = (nodes) => (nodes || []).map((n) => (n.type === 'start' && Array.isArray(n.data?.triggers)
  ? { ...n, data: { ...n.data, triggers: n.data.triggers.map((t) => (t.type === 'webhook' ? { ...t, config: { ...t.config, webhookId: null } } : t)) } }
  : n))

export default function Flows() {
  const db = useDB()
  const nav = useNavigate()
  const fileRef = useRef()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [folder, setFolder] = useState(null) // null = todas; '' = sem pasta
  const [modal, setModal] = useState(null)
  const [menu, setMenu] = useState(null)
  const [del, setDel] = useState(null)
  const [name, setName] = useState('')
  const [targetFolder, setTargetFolder] = useState('')

  const list = db.flows
    .filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
    .filter((f) => (status === 'all' ? true : status === 'active' ? f.status === 'active' : f.status === 'paused'))
    .filter((f) => (folder === null ? true : folder === '' ? !f.folder : f.folder === folder))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const createFlow = () => {
    const f = db.add('flows', { name: name || 'Novo Fluxo', folder: targetFolder || null, status: 'active', updatedAt: new Date().toISOString(), ...newFlowData() })
    setModal(null)
    setName('')
    nav(`/flows/${f.id}/edit`)
  }

  const importFlow = (file) => {
    const r = new FileReader()
    r.onload = () => {
      try {
        const data = JSON.parse(r.result)
        db.add('flows', { name: (data.name || 'Fluxo importado') + ' (importado)', folder: null, status: 'paused', updatedAt: new Date().toISOString(), nodes: data.nodes ? copyNodes(data.nodes) : newFlowData().nodes, edges: data.edges || [] })
        toast('Fluxo importado com sucesso!')
      } catch {
        toast('Arquivo inválido. Use um JSON exportado do sistema.', 'error')
      }
    }
    r.readAsText(file)
  }

  const exportFlow = (f) => {
    const blob = new Blob([JSON.stringify({ name: f.name, nodes: f.nodes, edges: f.edges }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${f.name}.json`
    a.click()
  }

  const folders = db.flowFolders

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        icon={Workflow}
        title="Fluxos"
        subtitle="Automações e fluxos de atendimento"
        actions={
          <>
            <button className="btn-primary" onClick={() => setModal('new')}><Plus size={15} /> Novo fluxo</button>
            <button className="btn-secondary" onClick={() => setModal('folder')}><FolderPlus size={15} /> Pasta</button>
            <button className="btn-secondary" onClick={() => fileRef.current.click()}><Upload size={15} /> Importar</button>
            <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => e.target.files[0] && importFlow(e.target.files[0])} />
          </>
        }
      />
      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="card h-fit p-3 lg:w-60">
          <p className="eyebrow-label mb-2 px-2">Pastas</p>
          {[{ id: null, label: 'Todos os fluxos', n: db.flows.length }, ...folders.map((f) => ({ id: f, label: f, n: db.flows.filter((x) => x.folder === f).length })), { id: '', label: 'Sem pasta', n: db.flows.filter((x) => !x.folder).length }].map((f) => (
            <button key={String(f.id)} onClick={() => setFolder(f.id)} className={cx('flex min-h-9 w-full items-center gap-2 rounded-[12px] px-2 py-2 text-sm', folder === f.id ? 'nav-active font-[550]' : 'font-[550] text-text-secondary hover:bg-surface-interactive hover:text-text-primary')}>
              {folder === f.id ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span className="flex-1 truncate text-left">{f.label}</span>
              <span className="text-xs text-text-muted">{f.n}</span>
            </button>
          ))}
        </aside>
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Buscar fluxos…" />
            <Pills value={status} onChange={setStatus} options={[{ id: 'all', label: 'Todos' }, { id: 'active', label: 'Ativos' }, { id: 'paused', label: 'Pausados' }]} />
          </div>
          {list.length === 0 ? (
            <EmptyState icon={Workflow} title="Nenhum fluxo encontrado" hint="Crie seu primeiro fluxo de automação para começar." action={<button className="btn-primary" onClick={() => setModal('new')}>Criar Primeiro Fluxo</button>} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((f) => (
                <div key={f.id} className="card group relative cursor-pointer p-4 transition hover:border-border-hover hover:shadow-glow" onClick={() => nav(`/flows/${f.id}/edit`)}>
                  <div className="mb-3 flex items-start justify-between">
                    <div className="icon-tile h-9 w-9"><Workflow size={17} /></div>
                    <button className="btn-ghost p-1.5" onClick={(e) => { e.stopPropagation(); setMenu(menu === f.id ? null : f.id) }} aria-label="Mais opções"><MoreVertical size={15} /></button>
                  </div>
                  <h3 className="truncate font-semibold">{f.name}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span className={f.status === 'active' ? 'badge-success' : 'badge-warning'}>{f.status === 'active' ? 'ATIVO' : 'PAUSADO'}</span>
                    <span>{f.nodes.length} {f.nodes.length === 1 ? 'bloco' : 'blocos'}</span>·<span>{fmtDate(f.updatedAt)}</span>
                  </div>
                  <Starts flow={f} />
                  {f.folder && <p className="mt-2 flex items-center gap-1 text-xs text-text-muted"><Folder size={12} /> {f.folder}</p>}
                  {menu === f.id && (
                    <div className="animate-fade-in absolute right-3 top-12 z-20 w-52 menu-pop p-1" onClick={(e) => e.stopPropagation()}>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { db.update('flows', f.id, { status: f.status === 'active' ? 'paused' : 'active' }); setMenu(null) }}>{f.status === 'active' ? <><Pause size={13} /> Pausar</> : <><Play size={13} /> Ativar</>}</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { db.add('flows', { ...f, id: uid(), name: f.name + ' (cópia)', nodes: copyNodes(f.nodes), updatedAt: new Date().toISOString() }); setMenu(null); toast('Fluxo duplicado.') }}><Copy size={13} /> Duplicar</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { exportFlow(f); setMenu(null) }}><Download size={13} /> Exportar JSON</button>
                      <button className="btn-ghost w-full justify-start text-xs" onClick={() => { setModal({ move: f }); setTargetFolder(f.folder || ''); setMenu(null) }}><FolderInput size={13} /> Mover para pasta</button>
                      <button className="btn-ghost w-full justify-start text-xs text-red-400" onClick={() => { setDel(f); setMenu(null) }}><Trash2 size={13} /> Excluir</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={modal === 'new'} onClose={() => setModal(null)} title="Novo fluxo" size="sm" footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button><button className="btn-primary" onClick={createFlow}>Criar e abrir editor</button></>}>
        <Field label="Nome do fluxo"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Boas-vindas" /></Field>
        <Field label="Pasta"><Select value={targetFolder} onChange={setTargetFolder} placeholder="Sem pasta" options={folders} /></Field>
      </Modal>
      <Modal open={modal === 'folder'} onClose={() => setModal(null)} title="Nova pasta" size="sm" footer={<button className="btn-primary" onClick={() => { if (name && !folders.includes(name)) db.setKey('flowFolders', [...folders, name]); setName(''); setModal(null) }}>Criar pasta</button>}>
        <Field label="Nome da pasta"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!modal?.move} onClose={() => setModal(null)} title="Mover para pasta" size="sm" footer={<button className="btn-primary" onClick={() => { db.update('flows', modal.move.id, { folder: targetFolder || null }); setModal(null) }}>Mover</button>}>
        <Select value={targetFolder} onChange={setTargetFolder} placeholder="Sem pasta" options={folders} />
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir fluxo" message={`Excluir o fluxo "${del?.name}"? Esta ação não pode ser desfeita.`} onConfirm={() => { db.remove('flows', del.id); toast('Fluxo excluído.') }} />
    </div>
  )
}

// Como o fluxo começa (gatilhos ligados do bloco Início)
function Starts({ flow }) {
  const ts = startOf(flow.nodes).triggers.filter((t) => t.enabled !== false)
  if (!ts.length) return <p className="mt-2 text-xs text-text-muted">Sem gatilho de início</p>
  const labels = [...new Set(ts.map((t) => triggerDef(t.type).label))]
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {labels.slice(0, 3).map((l) => <span key={l} className="badge-muted">{l}</span>)}
      {labels.length > 3 && <span className="badge-muted">+{labels.length - 3}</span>}
    </div>
  )
}
