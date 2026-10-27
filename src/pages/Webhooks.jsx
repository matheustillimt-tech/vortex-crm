import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Webhook, Plus, Copy, Pencil, Trash2, Workflow } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { newTrigger, startOf } from '../lib/triggers'
import { Confirm, EmptyState, Field, Modal, PageHeader, SearchInput, Select, Toggle } from '../components/ui'
import WebhookConfig, { WEBHOOK_BASE, newWebhook } from '../components/fluxos/WebhookConfig'

// Webhooks de entrada: cada um é o gatilho "Webhook recebido" de um fluxo (a configuração é a mesma do editor).
const triggerOf = (flow, hookId) => (flow ? startOf(flow.nodes).triggers.find((t) => t.type === 'webhook' && t.config?.webhookId === hookId) : null)

export default function Webhooks() {
  const db = useDB()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState(null)
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState(null)
  const list = db.webhooks.filter((w) => (w.name || '').toLowerCase().includes(q.toLowerCase()))
  const total = db.webhooks.reduce((a, w) => a + (w.calls || 0), 0)

  // tira o gatilho do fluxo junto (sem ele a URL não teria fluxo para iniciar)
  const remove = (w) => {
    const flow = db.flows.find((f) => f.id === w.flowId)
    if (flow && triggerOf(flow, w.id)) {
      db.update('flows', flow.id, { nodes: flow.nodes.map((n) => (n.type === 'start' ? { ...n, data: { ...n.data, triggers: startOf(flow.nodes).triggers.filter((t) => t.config?.webhookId !== w.id) } } : n)) })
    }
    db.remove('webhooks', w.id)
    toast('Webhook excluído.')
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={Webhook} title="Webhooks" subtitle="URLs que outros sistemas chamam para iniciar um fluxo. Cada uma é o gatilho “Webhook recebido” de um fluxo." actions={<button className="btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> Novo webhook</button>} />
      <div className="card mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
        <span className="text-text-secondary">Webhooks: <b className="text-text-primary">{db.webhooks.length}</b></span>
        <span className="text-text-secondary">Eventos recebidos: <b className="text-text-primary">{total.toLocaleString('pt-BR')}</b></span>
      </div>
      <SearchInput className="mb-4 max-w-md" value={q} onChange={setQ} placeholder="Buscar webhook pelo nome…" />
      {db.webhooks.length === 0 ? (
        <EmptyState icon={Webhook} title="Nenhum webhook cadastrado" hint="Crie um webhook escolhendo o fluxo que ele inicia, ou adicione o gatilho “Webhook recebido” no editor do fluxo." action={<button className="btn-primary" onClick={() => setCreating(true)}>Criar webhook</button>} />
      ) : (
        <div className="space-y-3">
          {list.map((w) => {
            const flow = db.flows.find((f) => f.id === w.flowId)
            const trig = triggerOf(flow, w.id)
            return (
              <div key={w.id} className="card flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="icon-tile h-10 w-10 shrink-0"><Webhook size={18} /></div>
                  <div className="min-w-0">
                    <p className="font-semibold">{w.name}</p>
                    <p className="truncate font-mono text-xs text-text-muted">{WEBHOOK_BASE}{w.token}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="badge-muted">{db.connections.find((c) => c.id === w.connectionId)?.name || 'Sem conexão'}</span>
                  {flow ? <span className={trig ? 'badge-primary' : 'badge-warning'} title={trig ? '' : 'O fluxo não tem mais este gatilho'}>{flow.name}{trig ? '' : ' (sem gatilho)'}</span> : <span className="badge-warning">Sem fluxo</span>}
                  {trig?.enabled === false && <span className="badge-muted">gatilho desligado</span>}
                  <span className="badge-info">{(w.calls || 0).toLocaleString('pt-BR')} recebidos</span>
                </div>
                <div className="flex items-center gap-1">
                  <Toggle checked={w.active !== false} onChange={(v) => db.update('webhooks', w.id, { active: v })} />
                  <button className="btn-ghost p-2" title="Copiar URL" onClick={() => { navigator.clipboard?.writeText(WEBHOOK_BASE + w.token); toast('URL copiada!') }}><Copy size={15} /></button>
                  {flow && <button className="btn-ghost p-2" title="Abrir o fluxo" onClick={() => nav(`/flows/${flow.id}/edit`)}><Workflow size={15} /></button>}
                  <button className="btn-ghost p-2" title="Configurar" onClick={() => setEdit(w)}><Pencil size={15} /></button>
                  <button className="btn-ghost p-2 text-red-400" title="Excluir" onClick={() => setDel(w)}><Trash2 size={15} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {creating && <NewWebhook onClose={() => setCreating(false)} onCreated={(w) => { setCreating(false); setEdit(w) }} />}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.name || 'Webhook'} subtitle="URL, segredo, evento de teste, mapeamento e histórico" footer={<button className="btn-primary" onClick={() => setEdit(null)}>Pronto</button>}>
          <WebhookConfig webhookId={edit.id} flow={db.flows.find((f) => f.id === edit.flowId)} />
        </Modal>
      )}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir webhook" message={`Excluir "${del?.name}"? Chamadas para essa URL deixarão de funcionar e o gatilho sai do fluxo.`} onConfirm={() => remove(del)} />
    </div>
  )
}

// Novo webhook: escolhe o fluxo e o gatilho "Webhook recebido" entra no bloco Início dele.
function NewWebhook({ onClose, onCreated }) {
  const db = useDB()
  const [flowId, setFlowId] = useState('')
  const create = () => {
    const flow = db.flows.find((f) => f.id === flowId)
    if (!flow) return toast('Escolha o fluxo que o webhook vai iniciar.', 'error')
    const w = newWebhook(db, flow)
    const t = newTrigger('webhook')
    t.config.webhookId = w.id
    const start = flow.nodes.find((n) => n.type === 'start')
    const triggers = [...startOf(flow.nodes).triggers, t]
    db.update('flows', flow.id, {
      nodes: start ? flow.nodes.map((n) => (n.type === 'start' ? { ...n, data: { ...n.data, keywords: undefined, triggers } } : n)) : [{ id: 'start', type: 'start', position: { x: 80, y: 200 }, data: { label: 'Início do fluxo', triggers } }, ...flow.nodes],
      updatedAt: new Date().toISOString(),
    })
    toast('Webhook criado e ligado ao fluxo.')
    onCreated(w)
  }
  return (
    <Modal open onClose={onClose} title="Novo webhook" size="sm" footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={create}>Criar</button></>}>
      <Field label="Fluxo que o webhook inicia" hint="O gatilho “Webhook recebido” entra no bloco Início deste fluxo.">
        <Select value={flowId} onChange={setFlowId} placeholder="Escolha o fluxo" options={db.flows.map((f) => ({ value: f.id, label: `${f.name}${f.status !== 'active' ? ' (pausado)' : ''}` }))} />
      </Field>
    </Modal>
  )
}
