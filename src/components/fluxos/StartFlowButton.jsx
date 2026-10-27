import { useState } from 'react'
import { Loader2, Workflow } from 'lucide-react'
import { useDB, useHasModule, toast } from '../../lib/store'
import { BACKEND } from '../../lib/supabase'
import { startFlowManual } from '../../lib/backend'
import { cx } from '../../lib/utils'
import { startOf } from '../../lib/triggers'
import { EmptyState, Modal } from '../ui'

// Gatilho "Início manual": a equipe escolhe um fluxo para o contato, a conversa ou o negócio (where: contact | chat | deal).
const manualFlows = (db, where) => db.flows.filter((f) => f.status === 'active'
  && startOf(f.nodes).triggers.some((t) => t.type === 'manual' && t.enabled !== false && (!t.config?.where?.length || t.config.where.includes(where))))

export default function StartFlowButton({ where, contactId, chatId, cardId, className, compact }) {
  const db = useDB()
  const hasFlows = useHasModule('fluxos')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  if (!hasFlows || !contactId) return null
  const flows = manualFlows(db, where)
  const start = async (f) => {
    if (!BACKEND) {
      toast(`Fluxo "${f.name}" iniciado (demonstração).`)
      return setOpen(false)
    }
    setBusy(f.id)
    try {
      const r = await startFlowManual({ flowId: f.id, contactId, chatId: chatId || undefined, cardId: cardId || undefined })
      toast(r.message || 'Fluxo iniciado.')
      setOpen(false)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <button type="button" className={cx(className || 'btn-secondary', compact && 'p-1.5')} title="Iniciar fluxo" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <Workflow size={compact ? 14 : 15} /> {!compact && 'Iniciar fluxo'}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Iniciar fluxo" subtitle="Fluxos ativos com o gatilho “Início manual”" size="sm">
        {flows.length === 0 ? (
          <EmptyState icon={Workflow} title="Nenhum fluxo disponível" hint="No editor do fluxo, adicione o gatilho “Início manual” no bloco Início do fluxo." />
        ) : flows.map((f) => (
          <button key={f.id} disabled={!!busy} onClick={() => start(f)} className="mb-2 flex w-full items-center gap-3 rounded-[13px] border border-border p-3 text-left hover:border-border-hover">
            <div className="icon-tile h-9 w-9 shrink-0"><Workflow size={16} /></div>
            <span className="min-w-0 flex-1 truncate text-sm font-[600]">{f.name}</span>
            {busy === f.id && <Loader2 size={15} className="animate-spin" />}
          </button>
        ))}
      </Modal>
    </>
  )
}
