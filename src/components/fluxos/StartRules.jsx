import { useEffect, useState } from 'react'
import { Plus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useDB, toast } from '../../lib/store'
import { BACKEND } from '../../lib/supabase'
import { flowJobsPending, flowRuns } from '../../lib/backend'
import { cx, fmtDate } from '../../lib/utils'
import { ORIGINS, TIMEZONES, UNITS, WEEKDAYS, triggerDef } from '../../lib/triggers'
import { Field, Select, Toggle } from '../ui'
import { Chips, Note } from './parts'
import { FIELD_OPTIONS } from './TriggerForm'

// Regras de entrada do bloco Início (valem para todos os gatilhos do fluxo) e o histórico de execuções.

function Group({ title, children }) {
  return (
    <div className="mb-4 rounded-[16px] border border-border p-3">
      <p className="mb-2 text-xs font-[650] text-text-primary">{title}</p>
      {children}
    </div>
  )
}

export function RulesForm({ rules, onChange }) {
  const db = useDB()
  const r = rules || {}
  const set = (patch) => onChange({ ...r, ...patch })
  const h = r.hours || {}
  const f = r.filters || {}
  const s = r.stopOn || {}
  const setH = (patch) => set({ hours: { ...h, ...patch } })
  const setF = (patch) => set({ filters: { ...f, ...patch } })
  const setS = (patch) => set({ stopOn: { ...s, ...patch } })
  const labels = db.labels.map((l) => ({ value: l.id, label: l.name }))
  const cols = (kid) => (db.kanbans.find((k) => k.id === kid)?.columns || []).map((c) => ({ value: c.id, label: c.name }))
  return (
    <>
      <Group title="Entrada do contato">
        <Field label="Quantas vezes o mesmo contato pode entrar">
          <Select value={r.reentry || 'always'} onChange={(v) => set({ reentry: v })}
            options={[{ value: 'always', label: 'Toda vez que o evento acontecer' }, { value: 'once', label: 'Só uma vez por contato' }, { value: 'interval', label: 'De novo só depois de um intervalo' }]} />
        </Field>
        {r.reentry === 'interval' && (
          <Field label="Intervalo mínimo entre entradas">
            <div className="flex gap-2">
              <input type="number" min={1} className="input w-24" value={r.interval?.amount ?? 1} onChange={(e) => set({ interval: { ...(r.interval || {}), amount: Math.max(1, +e.target.value || 1) } })} />
              <Select value={r.interval?.unit || 'dias'} onChange={(v) => set({ interval: { ...(r.interval || {}), unit: v } })} options={UNITS} />
            </div>
          </Field>
        )}
        <Field label="Se o contato já estiver neste fluxo">
          <Select value={r.ifInFlow || 'ignore'} onChange={(v) => set({ ifInFlow: v })} options={[{ value: 'ignore', label: 'Ignorar o novo evento' }, { value: 'restart', label: 'Recomeçar do início' }]} />
        </Field>
        <Field label="Se o contato estiver em outro fluxo" hint="Não vale para mensagens: se o outro fluxo espera uma resposta, a mensagem continua aquele fluxo." className="mb-0">
          <Select value={r.ifOtherFlow || 'replace'} onChange={(v) => set({ ifOtherFlow: v })} options={[{ value: 'replace', label: 'Interromper o outro e começar este' }, { value: 'skip', label: 'Não começar este' }]} />
        </Field>
      </Group>

      <Group title="Dias e horários permitidos">
        <Toggle label="Só começar em dias e horários definidos" checked={!!h.enabled} onChange={(v) => setH({ enabled: v })} />
        {h.enabled && (
          <>
            <Field label="Dias"><Chips options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} value={h.days || []} onChange={(v) => setH({ days: v })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Das"><input type="time" className="input" value={h.from || '08:00'} onChange={(e) => setH({ from: e.target.value })} /></Field>
              <Field label="Até"><input type="time" className="input" value={h.to || '18:00'} onChange={(e) => setH({ to: e.target.value })} /></Field>
            </div>
            <Field label="Fuso"><Select value={h.tz} onChange={(v) => setH({ tz: v })} options={TIMEZONES} /></Field>
            <Field label="Fora do horário" className="mb-0">
              <Select value={h.outside || 'wait'} onChange={(v) => setH({ outside: v })} options={[{ value: 'wait', label: 'Aguardar a próxima janela e começar' }, { value: 'ignore', label: 'Ignorar o evento' }]} />
            </Field>
          </>
        )}
      </Group>

      <Group title="Filtros (o contato precisa passar em todos)">
        <Field label="Conexão"><Chips options={db.connections.map((c) => ({ value: c.id, label: c.name }))} value={f.connections || []} onChange={(v) => setF({ connections: v })} empty="Nenhuma conexão." /></Field>
        <Field label="Tem alguma destas etiquetas"><Chips options={labels} value={f.labelsAny || []} onChange={(v) => setF({ labelsAny: v })} empty="Nenhuma etiqueta." /></Field>
        <Field label="Não tem estas etiquetas"><Chips options={labels} value={f.labelsNone || []} onChange={(v) => setF({ labelsNone: v })} empty="Nenhuma etiqueta." /></Field>
        <Field label="Origem"><Chips options={ORIGINS} value={f.origins || []} onChange={(v) => setF({ origins: v })} /></Field>
        <Field label="Responsável pela conversa"><Chips options={db.team.map((m) => ({ value: m.id, label: m.name }))} value={f.assignees || []} onChange={(v) => setF({ assignees: v })} empty="Ninguém na equipe." /></Field>
        <Field label="Está no funil">
          <Select value={f.kanbanId || ''} onChange={(v) => setF({ kanbanId: v, columns: [] })} placeholder="Qualquer (sem filtro)" options={db.kanbans.map((k) => ({ value: k.id, label: k.name }))} />
        </Field>
        {f.kanbanId && <Field label="Na etapa"><Chips options={cols(f.kanbanId)} value={f.columns || []} onChange={(v) => setF({ columns: v })} /></Field>}
        <p className="label">Campos personalizados</p>
        {(f.fields || []).map((x, i) => (
          <div key={i} className="mb-2 flex flex-wrap gap-1.5">
            <Select className="min-w-0 flex-1 py-1.5 text-xs" value={x.key} onChange={(v) => setF({ fields: f.fields.map((y, j) => (j === i ? { ...y, key: v } : y)) })} placeholder="Campo" options={FIELD_OPTIONS(db)} />
            <Select className="w-32 py-1.5 text-xs" value={x.op || 'equals'} onChange={(v) => setF({ fields: f.fields.map((y, j) => (j === i ? { ...y, op: v } : y)) })}
              options={[{ value: 'equals', label: 'igual a' }, { value: 'not_equals', label: 'diferente de' }, { value: 'contains', label: 'contém' }, { value: 'filled', label: 'preenchido' }, { value: 'empty', label: 'vazio' }]} />
            {!['filled', 'empty'].includes(x.op) && <input className="input min-w-0 flex-1 py-1.5 text-xs" value={x.value || ''} onChange={(e) => setF({ fields: f.fields.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} placeholder="valor" />}
            <button className="btn-ghost p-1.5 text-red-400" onClick={() => setF({ fields: f.fields.filter((_, j) => j !== i) })} aria-label="Remover"><X size={13} /></button>
          </div>
        ))}
        <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => setF({ fields: [...(f.fields || []), { key: '', op: 'equals', value: '' }] })}><Plus size={13} /> Adicionar filtro de campo</button>
      </Group>

      <Group title="Interromper o fluxo quando">
        <Toggle label="O cliente responder" description="Para o fluxo que estava parado num Intervalo Inteligente e o que esperava o horário." checked={!!s.reply} onChange={(v) => setS({ reply: v })} />
        <Field label="Receber a etiqueta" hint="Ex.: compra aprovada → etiqueta “Comprou” (colocada pelo fluxo do webhook)."><Chips options={labels} value={s.labels || []} onChange={(v) => setS({ labels: v })} empty="Nenhuma etiqueta." /></Field>
        <Field label="O negócio chegar no funil">
          <Select value={s.kanbanId || ''} onChange={(v) => setS({ kanbanId: v, columns: [] })} placeholder="Não interromper por negócio" options={db.kanbans.map((k) => ({ value: k.id, label: k.name }))} />
        </Field>
        {s.kanbanId && <Field label="Na etapa" hint="Nenhuma marcada = etapa de conversão (ganho)." className="mb-0"><Chips options={cols(s.kanbanId)} value={s.columns || []} onChange={(v) => setS({ columns: v })} /></Field>}
      </Group>

      <Note>
        <span className="flex items-center gap-1 font-[650] text-text-secondary"><ShieldCheck size={12} /> Proteções automáticas</span>
        O mesmo evento nunca inicia este fluxo duas vezes (mesmo que dois gatilhos peguem o mesmo evento). Um fluxo não é disparado de novo pelas próprias ações (etiqueta, campo, negócio), nem em cadeia com mais de 5 fluxos. O mesmo contato entra no máximo 20 vezes em 10 minutos.
      </Note>
    </>
  )
}

const RUN = {
  running: ['badge-info', 'Rodando'], waiting: ['badge-info', 'Esperando'], done: ['badge-success', 'Concluído'], alert: ['badge-warning', 'Alerta'],
  error: ['badge-danger', 'Erro'], cancelled: ['badge-muted', 'Cancelado'], skipped: ['badge-muted', 'Não iniciou'],
}

export function RunHistory({ flow, onRefresh }) {
  const db = useDB()
  const [data, setData] = useState(null)
  const load = () => {
    if (!BACKEND) return setData({ runs: [], jobs: [] })
    Promise.all([flowRuns(flow.id), flowJobsPending(flow.id)]).then(([runs, jobs]) => setData({ runs, jobs })).catch((e) => { setData({ runs: [], jobs: [] }); toast(e.message, 'error') })
    onRefresh?.()
  }
  useEffect(() => { load() }, [flow.id]) // eslint-disable-line
  const contact = (id) => db.contacts.find((c) => c.id === id)?.name || 'Contato'
  if (!data) return <p className="p-2 text-xs text-text-muted">Carregando…</p>
  return (
    <>
      <button className="btn-ghost mb-2 px-2 py-1 text-xs" onClick={load}><RefreshCw size={12} /> Atualizar</button>
      {!BACKEND && <Note>O histórico aparece com o servidor conectado.</Note>}
      {data.jobs.length > 0 && (
        <div className="mb-4">
          <p className="label">Agendados</p>
          {data.jobs.map((j) => (
            <div key={j.id} className="border-b border-border-subtle py-1.5 text-xs last:border-0">
              <div className="flex items-center gap-2"><span className="badge-info">Agendado</span><span className="truncate">{j.contact_id ? contact(j.contact_id) : 'Público do gatilho'}</span></div>
              <p className="mt-0.5 text-[11px] text-text-muted">{j.kind === 'window' ? 'Esperando o horário permitido' : triggerDef(j.kind).label} · {fmtDate(j.run_at)}</p>
            </div>
          ))}
        </div>
      )}
      <p className="label">Últimas execuções</p>
      {data.runs.length === 0 ? <p className="text-xs text-text-muted">Nenhuma execução ainda.</p> : data.runs.map((r) => {
        const [cls, label] = RUN[r.status] || RUN.done
        return (
          <div key={r.id} className="border-b border-border-subtle py-1.5 text-xs last:border-0">
            <div className="flex items-center gap-2">
              <span className={cls}>{label}</span>
              <span className="min-w-0 flex-1 truncate">{contact(r.contact_id)}</span>
              <span className="shrink-0 text-[10px] text-text-muted">{fmtDate(r.started_at)}</span>
            </div>
            <p className={cx('mt-0.5 text-[11px]', r.status === 'error' ? 'text-red-400' : 'text-text-muted')}>{triggerDef(r.trigger_type).label}{r.reason ? ` · ${r.reason}` : ''}</p>
          </div>
        )
      })}
    </>
  )
}
