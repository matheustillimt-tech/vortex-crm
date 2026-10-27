import { createContext, memo, useContext, useState } from 'react'
import { Handle, Position } from 'reactflow'
import { ArrowLeft, Play, Plus, Trash2, X } from 'lucide-react'
import { useDB, useModules } from '../../lib/store'
import { cx } from '../../lib/utils'
import { TRIGGER_GROUPS, TRIGGERS, availability, newTrigger, triggerDef, triggerSummary } from '../../lib/triggers'
import { Confirm, Tabs, Toggle } from '../ui'
import { Note } from './parts'
import TriggerForm from './TriggerForm'
import { RulesForm, RunHistory } from './StartRules'
import { newWebhook } from './WebhookConfig'

// Bloco "Início do fluxo": vários gatilhos (qualquer um inicia o mesmo fluxo), regras de entrada e contadores.
// O editor (FlowEditor) fornece o contexto: dados do bloco, como alterá-los, contadores e qual tela do painel abrir.
export const StartCtx = createContext(null)
const useStart = () => useContext(StartCtx)

export const EMPTY_STATS = { total: { ok: 0, alert: 0, error: 0 }, byTrigger: {} }
const BUCKET = { done: 'ok', running: 'ok', waiting: 'ok', alert: 'alert', skipped: 'alert', error: 'error' }
// linhas do flow_run_stats → Sucessos / Alertas / Erros (cancelados não contam)
export function summarizeStats(rows) {
  const out = { total: { ok: 0, alert: 0, error: 0 }, byTrigger: {} }
  for (const r of rows || []) {
    const b = BUCKET[r.status]
    if (!b) continue
    out.total[b] += +r.total
    const t = (out.byTrigger[r.trigger_id] ||= { ok: 0, alert: 0, error: 0 })
    t[b] += +r.total
  }
  return out
}

export const StartNode = memo(({ selected }) => {
  const db = useDB()
  const { start, stats, open } = useStart()
  const s = stats.total
  return (
    <div className={cx('w-[300px] rounded-[20px] border bg-surface-raised shadow-[var(--shadow-panel)] transition', selected ? 'border-accent-primary shadow-glow-lg' : 'border-border')}>
      <div className="px-4 pt-3.5">
        <p className="flex items-center gap-2 text-[15px] font-[650] text-text-primary"><Play size={16} className="text-[var(--accent-text)]" /> Início do fluxo</p>
        <p className="mt-1 text-xs text-text-muted">Defina quando esta automação deve começar.</p>
      </div>
      <div className="space-y-1.5 px-3 pt-3">
        {start.triggers.map((t) => {
          const Icon = triggerDef(t.type).icon
          return (
            <button key={t.id} className={cx('nodrag flex w-full items-start gap-2 rounded-[12px] border px-2.5 py-2 text-left text-[11px] transition hover:border-accent-primary', t.enabled === false ? 'border-border opacity-50' : 'border-border-hover')}
              onClick={(e) => { e.stopPropagation(); open({ triggerId: t.id }) }} title="Editar gatilho">
              <Icon size={13} className="mt-0.5 shrink-0 text-[var(--accent-text)]" />
              <span className="line-clamp-2 min-w-0 flex-1 text-text-secondary">{triggerSummary(t, db)}</span>
              {t.enabled === false && <span className="badge-muted shrink-0">desligado</span>}
            </button>
          )
        })}
        <button className="nodrag flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-accent-primary px-3 py-2.5 text-xs font-[650] text-[var(--accent-text)] transition hover:bg-accent-soft"
          onClick={(e) => { e.stopPropagation(); open({ picker: true }) }}>
          <Plus size={14} /> Adicionar gatilho para iniciar o fluxo
        </button>
      </div>
      <div className="relative mt-1 flex h-9 items-center justify-end px-4 text-[11px] text-text-muted">
        Quando o evento ocorrer, então
        <Handle type="source" id="out-0" position={Position.Right} style={{ top: 18, background: 'rgb(var(--accent))' }} />
      </div>
      <div className="grid grid-cols-3 border-t border-border py-2 text-center">
        {[['Sucessos', s.ok, 'text-green-400'], ['Alertas', s.alert, 'text-amber-400'], ['Erros', s.error, 'text-red-400']].map(([label, n, tone]) => (
          <button key={label} className="nodrag" onClick={(e) => { e.stopPropagation(); open({ tab: 'history' }) }} title="Ver histórico">
            <p className="text-base text-text-primary">{n.toLocaleString('pt-BR')}</p>
            <p className={cx('text-[11px]', n ? tone : 'text-text-muted')}>{label}</p>
          </button>
        ))}
      </div>
    </div>
  )
})

export function StartPanel({ onClose }) {
  const db = useDB()
  const modules = useModules()
  const { flow, start, setStart, stats, view, setView, reloadStats } = useStart()
  const [del, setDel] = useState(null)
  const setTriggers = (fn) => setStart((d) => ({ ...d, triggers: fn(d.triggers || []) }))
  const update = (t) => setTriggers((ts) => ts.map((x) => (x.id === t.id ? t : x)))
  const add = (type) => {
    const t = newTrigger(type)
    if (type === 'webhook') t.config.webhookId = newWebhook(db, flow).id
    setTriggers((ts) => [...ts, t])
    setView({ triggerId: t.id })
  }
  const remove = (t) => {
    const w = t.type === 'webhook' && db.webhooks.find((x) => x.id === t.config?.webhookId)
    if (w && w.flowId === flow.id) db.remove('webhooks', w.id)
    setTriggers((ts) => ts.filter((x) => x.id !== t.id))
    setView(null)
  }
  const editing = view?.triggerId && start.triggers.find((t) => t.id === view.triggerId)
  const tab = view?.tab || 'triggers'
  // Fluxos Padrões (Configurações) que apontam para este fluxo continuam valendo
  const defaults = Object.entries(db.connectionFlowConfigs || {}).flatMap(([cid, cfg]) => [
    cfg?.welcome === flow.id && `Boas-vindas de ${db.connections.find((c) => c.id === cid)?.name || 'uma conexão'}`,
    cfg?.reopen === flow.id && `Reabertura de ${db.connections.find((c) => c.id === cid)?.name || 'uma conexão'}`,
  ]).filter(Boolean)

  return (
    <div className="animate-fade-in absolute bottom-3 right-3 top-0 z-20 flex w-[380px] max-w-[calc(100%-24px)] flex-col glass-modal rounded-[20px]">
      <div className="flex items-center gap-2 border-b border-border-subtle p-3.5">
        {(editing || view?.picker) && <button className="btn-ghost p-1.5" onClick={() => setView(null)} aria-label="Voltar"><ArrowLeft size={15} /></button>}
        <div className="icon-tile h-8 w-8 shrink-0"><Play size={15} /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{editing ? triggerDef(editing.type).label : view?.picker ? 'Adicionar gatilho' : 'Início do fluxo'}</p>
          <p className="truncate text-[11px] text-text-muted">{editing ? triggerDef(editing.type).desc : view?.picker ? 'Qualquer gatilho do bloco inicia este fluxo' : 'Quando esta automação deve começar'}</p>
        </div>
        <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Fechar"><X size={15} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {view?.picker ? <Picker modules={modules} onPick={add} /> : editing ? (
          <>
            <div className="mb-3 rounded-[13px] border border-border px-3">
              <Toggle label="Gatilho ligado" description="Desligado, ele não inicia o fluxo (os outros continuam valendo)." checked={editing.enabled !== false} onChange={(v) => update({ ...editing, enabled: v })} />
            </div>
            <TriggerForm trigger={editing} flow={flow} onChange={update} />
            <button className="btn-danger mt-2 w-full" onClick={() => setDel(editing)}><Trash2 size={14} /> Remover gatilho</button>
          </>
        ) : (
          <>
            <Tabs className="mb-3" value={tab} onChange={(t) => setView({ tab: t })} tabs={[{ id: 'triggers', label: 'Gatilhos' }, { id: 'rules', label: 'Regras' }, { id: 'history', label: 'Histórico' }]} />
            {tab === 'triggers' && (
              <>
                {start.triggers.length === 0 && (
                  <Note>Nenhum gatilho ainda. Sem gatilho, este fluxo só começa por outro fluxo, por um agente de IA ou pelos Fluxos Padrões das Configurações.</Note>
                )}
                {start.triggers.map((t) => {
                  const def = triggerDef(t.type)
                  const st = stats.byTrigger[t.id] || { ok: 0, alert: 0, error: 0 }
                  return (
                    <div key={t.id} className={cx('mb-2 rounded-[16px] border p-3', t.enabled === false ? 'border-border opacity-60' : 'border-border-hover')}>
                      <div className="flex items-center gap-2">
                        <def.icon size={15} className="shrink-0 text-[var(--accent-text)]" />
                        <button className="min-w-0 flex-1 text-left" onClick={() => setView({ triggerId: t.id })}>
                          <p className="truncate text-sm font-[600]">{def.label}</p>
                        </button>
                        <Toggle checked={t.enabled !== false} onChange={(v) => update({ ...t, enabled: v })} />
                      </div>
                      <button className="mt-1 block w-full text-left text-xs text-text-secondary" onClick={() => setView({ triggerId: t.id })}>{triggerSummary(t, db)}</button>
                      <div className="mt-2 flex items-center gap-3 text-[11px] text-text-muted">
                        <span>{st.ok} sucessos</span><span className={st.alert ? 'text-amber-400' : ''}>{st.alert} alertas</span><span className={st.error ? 'text-red-400' : ''}>{st.error} erros</span>
                        <button className="ml-auto text-[var(--accent-text)]" onClick={() => setView({ triggerId: t.id })}>Editar</button>
                        <button className="text-red-400" onClick={() => setDel(t)}>Remover</button>
                      </div>
                    </div>
                  )
                })}
                <button className="flex w-full items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-accent-primary px-3 py-3 text-sm font-[650] text-[var(--accent-text)] hover:bg-accent-soft" onClick={() => setView({ picker: true })}>
                  <Plus size={15} /> Adicionar gatilho para iniciar o fluxo
                </button>
                {defaults.length > 0 && <Note>Também começa pelos Fluxos Padrões (Configurações → Fluxos Padrões): {defaults.join(', ')}.</Note>}
              </>
            )}
            {tab === 'rules' && <RulesForm rules={start.rules} onChange={(rules) => setStart((d) => ({ ...d, rules }))} />}
            {tab === 'history' && <RunHistory flow={flow} onRefresh={reloadStats} />}
          </>
        )}
      </div>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Remover gatilho" confirmLabel="Remover"
        message={del?.type === 'webhook' ? 'A URL deste webhook deixa de funcionar e o histórico de recebimentos é apagado. Continuar?' : `Remover o gatilho "${triggerDef(del?.type).label}"? Os outros gatilhos continuam valendo.`}
        onConfirm={() => remove(del)} />
    </div>
  )
}

function Picker({ modules, onPick }) {
  return TRIGGER_GROUPS.map((g) => (
    <div key={g.id} className="mb-4">
      <p className="eyebrow-label mb-1.5 px-1">{g.label}</p>
      {TRIGGERS.filter((t) => t.group === g.id).map((t) => {
        const a = availability(t, modules)
        return (
          <button key={t.type} disabled={!a.ok} onClick={() => onPick(t.type)}
            className={cx('mb-1 flex w-full items-start gap-3 rounded-[13px] px-2.5 py-2 text-left', a.ok ? 'hover:bg-surface-interactive' : 'cursor-not-allowed opacity-60')}>
            <t.icon size={17} className="mt-0.5 shrink-0 text-[var(--accent-text)]" />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">{t.label} {!a.ok && <span className="badge-muted">Indisponível</span>}</span>
              <span className="block text-[11px] text-text-muted">{a.ok ? t.desc : a.reason}</span>
            </span>
          </button>
        )
      })}
    </div>
  ))
}
