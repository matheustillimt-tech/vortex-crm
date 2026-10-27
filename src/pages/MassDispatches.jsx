import { useEffect, useState } from 'react'
import { Send, Plus, Info, XCircle, CheckCircle2, Loader2, Clock } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { cx, fmtDate } from '../lib/utils'
import { BACKEND } from '../lib/supabase'
import { fetchRows, fromRow } from '../lib/backend'
import { Confirm, EmptyState, Field, Modal, PageHeader, SearchInput, Select } from '../components/ui'

const STATUS = {
  andamento: { label: 'Em andamento', cls: 'badge-info', icon: Loader2 },
  concluido: { label: 'Concluído', cls: 'badge-success', icon: CheckCircle2 },
  cancelado: { label: 'Cancelado', cls: 'badge-danger', icon: XCircle },
  agendado: { label: 'Agendado', cls: 'badge-warning', icon: Clock },
}

export default function MassDispatches() {
  const db = useDB()
  const [wizard, setWizard] = useState(false)
  const [info, setInfo] = useState(false)
  const [cancel, setCancel] = useState(null)
  const remaining = db.dispatchQuota.total - db.dispatchQuota.used

  // Com o Supabase, quem envia é o servidor (flow-tick → _shared/disparos.ts): a tela só acompanha o progresso,
  // relendo os disparos a cada 5 s enquanto houver algum em andamento.
  const running = db.dispatches.some((d) => d.status === 'andamento')
  useEffect(() => {
    if (!BACKEND || !running) return
    const t = setInterval(async () => {
      try {
        const { rows } = await fetchRows('dispatches', useDB.getState().company.id)
        useDB.setState({ dispatches: rows.map(fromRow) })
      } catch (e) {
        console.error('disparos', e)
      }
    }, 5000)
    return () => clearInterval(t)
  }, [running])

  // modo demonstração: simula o progresso dos disparos em andamento
  useEffect(() => {
    if (BACKEND) return
    const t = setInterval(() => {
      useDB.getState().dispatches.filter((d) => d.status === 'andamento').forEach((d) => {
        const sent = Math.min(d.total, d.sent + 1)
        useDB.getState().update('dispatches', d.id, { sent, status: sent >= d.total ? 'concluido' : 'andamento' })
      })
    }, 1500)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={Send} title="Disparos em massa" subtitle="Envie um fluxo para muitos contatos de uma vez, com cota por ciclo da assinatura."
        actions={<><button className="btn-ghost p-2" title="Como funciona a cota de disparos em massa" onClick={() => setInfo(true)}><Info size={17} /></button><button className="btn-primary" onClick={() => setWizard(true)}><Plus size={15} /> Novo disparo em massa</button></>} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Restantes', remaining.toLocaleString('pt-BR'), 'text-violet-400'], ['Usados no ciclo', `${db.dispatchQuota.used} / ${db.dispatchQuota.total}`, ''], ['Em andamento', db.dispatches.filter((d) => d.status === 'andamento').length, 'text-blue-400'], ['Concluídos', db.dispatches.filter((d) => d.status === 'concluido').length, 'text-green-400']].map(([l, v, c]) => (
          <div key={l} className="card p-4"><p className={cx('text-2xl font-bold', c)}>{v}</p><p className="eyebrow-label mt-1.5 !text-text-muted">{l}</p></div>
        ))}
      </div>
      {db.dispatches.length === 0 ? (
        <EmptyState icon={Send} title="Nenhum disparo em massa ainda" hint="Crie o primeiro disparo em massa para enviar um fluxo a muitos contatos de uma vez." action={<button className="btn-primary" onClick={() => setWizard(true)}>Novo disparo em massa</button>} />
      ) : (
        <div className="space-y-3">
          {[...db.dispatches].reverse().map((d) => {
            const s = STATUS[d.status]
            const pct = (d.sent / d.total) * 100
            return (
              <div key={d.id} className="card p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <p className="flex-1 font-semibold">{d.name || `Disparo em massa #${d.id}`}</p>
                  <span className={s.cls}><s.icon size={11} className={d.status === 'andamento' ? 'animate-spin' : ''} /> {s.label}</span>
                  {d.status === 'andamento' && <button className="btn-ghost px-2 py-1 text-xs text-red-400" onClick={() => setCancel(d)}>Cancelar</button>}
                </div>
                <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                  <span>Fluxo: <b className="text-text-secondary">{db.flows.find((f) => f.id === d.flowId)?.name || `Fluxo #${d.flowId}`}</b></span>
                  <span>Número: <b className="text-text-secondary">{db.connections.find((c) => c.id === d.connectionId)?.name}</b></span>
                  <span>Intervalo: {d.interval}s</span>
                  <span>Criado em {fmtDate(d.createdAt)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-interactive"><div className={cx('h-full rounded-full transition-all', d.status === 'cancelado' ? 'bg-red-500' : 'bg-accent-primary')} style={{ width: pct + '%' }} /></div>
                  <span className="text-xs font-semibold">{d.sent}/{d.total}</span>
                </div>
                {d.reason && <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400"><Info size={13} className="mt-px shrink-0" /> {d.reason}</p>}
                {d.failed > 0 && (
                  <p className="mt-1 text-xs text-red-400" title={d.lastError || undefined}>
                    {d.failed} contato(s) não receberam o fluxo{d.lastError ? `. Último motivo: ${d.lastError}` : '.'}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
      {wizard && <Wizard onClose={() => setWizard(false)} />}
      <Modal open={info} onClose={() => setInfo(false)} title="Como funciona a cota" size="sm">
        <p className="text-sm text-text-secondary">Cada contato que recebe um disparo consome 1 da cota do ciclo da assinatura. A cota renova no próximo vencimento. Envios cancelados devolvem o saldo não usado.</p>
      </Modal>
      <Confirm open={!!cancel} onClose={() => setCancel(null)} title="Cancelar disparo em massa" message="Envios pendentes serão cancelados. Mensagens já enviadas não serão revertidas." confirmLabel="Confirmar cancelamento"
        onConfirm={() => { db.update('dispatches', cancel.id, { status: 'cancelado' }); db.setKey('dispatchQuota', (q) => ({ ...q, used: q.used - (cancel.total - cancel.sent) })); toast('Disparo em massa cancelado.') }} />
    </div>
  )
}

function Wizard({ onClose }) {
  const db = useDB()
  const [step, setStep] = useState(0)
  // Instagram não tem disparo: a Meta não deixa puxar conversa
  const [f, setF] = useState({ name: '', flowId: db.flows[0]?.id, connectionId: db.connections.find((c) => c.status === 'connected' && c.provider !== 'instagram')?.id, interval: 15, label: '', contacts: [] })
  const [q, setQ] = useState('')
  const audience = db.contacts.filter((c) => (!f.label || c.labels.includes(f.label)) && c.name.toLowerCase().includes(q.toLowerCase()))
  const steps = ['Dados', 'Configurações', 'Público']
  const create = () => {
    if (!f.contacts.length) return toast('Selecione ao menos um contato.', 'error')
    const remaining = db.dispatchQuota.total - db.dispatchQuota.used
    if (f.contacts.length > remaining) return toast('Cota insuficiente para esse público.', 'error')
    if (!f.flowId || !f.connectionId) return toast('Escolha o fluxo e o número que envia.', 'error')
    // contacts: a lista que o servidor percorre, na ordem, um contato por intervalo
    db.add('dispatches', { name: f.name, flowId: f.flowId, connectionId: f.connectionId, interval: Math.max(5, +f.interval || 15), contacts: f.contacts, total: f.contacts.length, sent: 0, status: 'andamento', createdAt: new Date().toISOString() })
    db.setKey('dispatchQuota', (qq) => ({ ...qq, used: qq.used + f.contacts.length }))
    toast('Disparo em massa criado com sucesso.')
    onClose()
  }
  return (
    <Modal open onClose={onClose} title="Novo disparo em massa" size="lg"
      footer={<>
        {step > 0 && <button className="btn-secondary mr-auto" onClick={() => setStep(step - 1)}>Voltar</button>}
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
        {step < 2 ? <button className="btn-primary" onClick={() => setStep(step + 1)}>Próximo</button> : <button className="btn-primary" onClick={create}>Criar disparo em massa</button>}
      </>}>
      <div className="mb-5 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold', i <= step ? 'bg-accent-primary text-accent-fg' : 'bg-surface-interactive text-text-muted')}>{i + 1}</span>
            <span className={cx('text-sm', i === step ? 'font-semibold' : 'text-text-muted')}>{s}</span>
            {i < 2 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>
      {step === 0 && (
        <>
          <Field label="Nome do disparo"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Promoção de outubro" /></Field>
          <Field label="Fluxo a ser enviado" hint="O fluxo precisa estar ativo. Na API Oficial, quem não falou com você nas últimas 24 h só recebe Template WhatsApp: comece o fluxo com esse bloco.">
            <Select value={f.flowId} onChange={(v) => setF({ ...f, flowId: v })} options={db.flows.map((x) => ({ value: x.id, label: `${x.name}${x.status === 'active' ? '' : ' (pausado)'}` }))} />
          </Field>
        </>
      )}
      {step === 1 && (
        <>
          <Field label="Número que envia"><Select value={f.connectionId} onChange={(v) => setF({ ...f, connectionId: v })} options={db.connections.filter((c) => c.provider !== 'instagram').map((c) => ({ value: c.id, label: `${c.name} ${c.status === 'connected' ? '' : '(desconectada)'}` }))} /></Field>
          <Field label="Intervalo entre envios (segundos)" hint="Intervalos maiores reduzem o risco de bloqueio do número."><input type="number" min={5} className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: +e.target.value })} /></Field>
        </>
      )}
      {step === 2 && (
        <>
          <div className="mb-3 flex gap-2">
            <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Buscar contato" />
            <Select className="w-48" value={f.label} onChange={(v) => setF({ ...f, label: v })} placeholder="Todas as etiquetas" options={db.labels.map((l) => ({ value: l.id, label: l.name }))} />
          </div>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-text-muted">{f.contacts.length} contato(s) selecionado(s)</span>
            <button className="text-violet-400" onClick={() => setF({ ...f, contacts: [...new Set([...f.contacts, ...audience.map((c) => c.id)])] })}>Selecionar todos os filtrados</button>
          </div>
          <div className="panel-soft max-h-64 space-y-1 overflow-y-auto p-1">
            {audience.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-surface-interactive">
                <input type="checkbox" className="accent-violet-500" checked={f.contacts.includes(c.id)} onChange={(e) => setF({ ...f, contacts: e.target.checked ? [...f.contacts, c.id] : f.contacts.filter((x) => x !== c.id) })} />
                <span className="flex-1 text-sm">{c.name}</span><span className="text-xs text-text-muted">{c.phone}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
