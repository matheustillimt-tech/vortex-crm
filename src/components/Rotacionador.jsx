import { useEffect, useState } from 'react'
import { AlertTriangle, Bot, Check, Clock, Copy, ExternalLink, MousePointerClick, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import { rotatorStats } from '../lib/backend'
import { DEFAULT_MESSAGE, ROTATOR_SITE, SLUG_RE, agentFor, canRotate, isLive, liveNumbers, nextNumber, rotatorNumbers, rotatorUrl, slugify } from '../lib/rotacionador'
import { cx, fmtDate } from '../lib/utils'
import { Confirm, EmptyState, Field, Modal, SearchInput, Select, Toggle } from './ui'

const MODES = [
  ['clique', 'A cada clique', 'Cada pessoa que clica vai para o próximo número da roda.', MousePointerClick],
  ['hora', 'A cada hora', 'Um número recebe todos os cliques durante uma hora; na hora seguinte, o próximo.', Clock],
]
const blank = () => ({ name: '', slug: '', connectionIds: [], mode: 'clique', message: DEFAULT_MESSAGE, agentId: null, active: true })

// Conexões → Rotacionador: lista, criação e edição dos links que revezam os números
export default function RotatorsModal({ onClose, onNewConnection }) {
  const db = useDB()
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)

  // a contagem de cliques muda no servidor a cada clique: relê ao abrir
  useEffect(() => {
    if (!BACKEND || !db.company.id) return
    rotatorStats(db.company.id).then((rows) => {
      const byId = new Map(rows.map((r) => [r.id, r]))
      useDB.setState((s) => ({ rotators: s.rotators.map((r) => (byId.has(r.id) ? { ...r, ...byId.get(r.id) } : r)) }))
    }).catch(() => {})
  }, [db.company.id])

  if (edit) return <RotatorForm initial={edit} onBack={() => setEdit(null)} onClose={onClose} onNewConnection={onNewConnection} />

  return (
    <Modal open onClose={onClose} size="lg" title="Rotacionador" subtitle="Um link só que reveza quem clica entre os seus números. Número que cai sai da roda sozinho."
      footer={<><button className="btn-secondary" onClick={onClose}>Fechar</button><button className="btn-primary" onClick={() => setEdit(blank())}><Plus size={15} /> Novo rotacionador</button></>}>
      {db.rotators.length === 0 ? (
        <EmptyState icon={Shuffle} title="Nenhum rotacionador ainda" hint="Junte os seus números conectados num link só, para pôr nos grupos e na área de membros." action={<button className="btn-primary" onClick={() => setEdit(blank())}><Plus size={15} /> Criar rotacionador</button>} />
      ) : (
        <div className="space-y-3">
          {db.rotators.map((r) => <RotatorCard key={r.id} rot={r} onEdit={() => setEdit(r)} onDelete={() => setDel(r)} />)}
        </div>
      )}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir rotacionador" message={`Excluir "${del?.name}"? O link ${del ? rotatorUrl(del.slug) : ''} para de funcionar onde estiver divulgado.`}
        onConfirm={() => { db.remove('rotators', del.id); toast('Rotacionador excluído.') }} />
    </Modal>
  )
}

const copy = (url) => navigator.clipboard.writeText(url).then(() => toast('Link copiado!'), () => toast('Não deu para copiar. Selecione o link e copie.', 'error'))

function RotatorCard({ rot, onEdit, onDelete }) {
  const db = useDB()
  const hasAgents = !!db.access?.effective?.includes('agentes')
  const url = rotatorUrl(rot.slug)
  const nums = rotatorNumbers(rot, db.connections)
  const live = liveNumbers(rot, db.connections)
  const next = nextNumber(rot, db.connections)
  const agent = db.agents.find((a) => a.id === rot.agentId)

  // Modo demonstração: não há servidor para o link, então o "Testar" anda a roda aqui mesmo
  const testDemo = () => {
    if (!next) return toast('Nenhum número no ar: quem clicar vê a página de atendimento indisponível.', 'warning')
    db.update('rotators', rot.id, (r) => ({ turn: (Number(r.turn) || 0) + 1, clicks: (Number(r.clicks) || 0) + 1, counts: { ...r.counts, [next.id]: (Number(r.counts?.[next.id]) || 0) + 1 }, lastClickAt: new Date().toISOString() }))
    toast(`Clique de teste foi para ${next.name} (${next.number}).`, 'info')
  }

  return (
    <div className={cx('card p-4', !rot.active && 'opacity-70')}>
      <div className="mb-3 flex items-start gap-3">
        <div className="icon-tile h-10 w-10 shrink-0"><Shuffle size={18} /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{rot.name}</p>
          <p className="text-xs text-text-muted">{MODES.find(([m]) => m === rot.mode)?.[1] || 'A cada clique'} · {Number(rot.clicks) || 0} cliques{rot.lastClickAt ? ` · último em ${fmtDate(rot.lastClickAt)}` : ''}</p>
        </div>
        <Toggle checked={!!rot.active} onChange={(v) => { db.update('rotators', rot.id, { active: v }); toast(v ? 'Link ligado.' : 'Link desligado: quem clicar vê a página de indisponível.', v ? 'success' : 'warning') }} />
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-[12px] border border-border px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs text-text-primary">{url.replace(/^https:\/\//, '')}</code>
        <button className="btn-ghost p-1.5" title="Copiar link" onClick={() => copy(url)}><Copy size={14} /></button>
        {BACKEND
          ? <a className="btn-ghost p-1.5" title="Abrir (conta como um clique)" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
          : <button className="btn-ghost px-2 py-1 text-xs" onClick={testDemo}>Testar</button>}
      </div>

      <div className="mb-3 space-y-1.5">
        {nums.map((c, i) => {
          const on = isLive(c)
          return (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <span className="w-5 text-right text-text-muted">{i + 1}º</span>
              <span className={cx('h-2 w-2 shrink-0 rounded-full', on ? 'bg-green-400' : 'bg-red-400')} />
              <span className={cx('min-w-0 flex-1 truncate', on ? 'text-text-primary' : 'text-text-muted line-through')}>{c.name}{c.number ? ` · ${c.number}` : ''}</span>
              {!on && <span className="badge-danger">Fora da roda</span>}
              {rot.active && on && next?.id === c.id && <span className="badge-success">{rot.mode === 'hora' ? 'Nesta hora' : 'Próximo'}</span>}
              <span className="w-16 text-right text-text-muted">{Number(rot.counts?.[c.id]) || 0} cliques</span>
            </div>
          )
        })}
      </div>

      {rot.active && live.length < 2 && (
        <p className="mb-3 flex gap-2 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-400">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {live.length === 0 ? 'Nenhum número no ar: quem clicar vê a página de atendimento indisponível até um número reconectar.' : `Só ${live[0].name} está no ar: todos os cliques vão para ele até outro número reconectar.`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {hasAgents && (
          <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-xs', agent ? 'text-text-secondary' : 'text-text-muted')}>
            <Bot size={13} className={agent?.active ? 'text-violet-300' : ''} />
            <span className="truncate">{agent ? <>Agente <b className="text-text-primary">{agent.name}</b> em todos os números{agent.active ? '' : ' (pausado)'}</> : 'Cada número com o agente dele'}</span>
          </span>
        )}
        <span className="flex-1" />
        <button className="btn-secondary text-xs" onClick={onEdit}><Pencil size={13} /> Editar</button>
        <button className="btn-ghost p-2 text-red-400" onClick={onDelete}><Trash2 size={14} /></button>
      </div>
    </div>
  )
}

function RotatorForm({ initial, onBack, onClose, onNewConnection }) {
  const db = useDB()
  const hasAgents = !!db.access?.effective?.includes('agentes')
  const isNew = !initial.id
  // rotacionador novo já nasce com todos os números conectados marcados
  const [f, setF] = useState(() => ({ ...blank(), ...initial, connectionIds: isNew && !initial.connectionIds?.length ? db.connections.filter(isLive).map((c) => c.id) : [...(initial.connectionIds || [])] }))
  // enquanto o endereço não for mexido à mão, ele acompanha o nome
  const [slugTouched, setSlugTouched] = useState(!isNew)
  const [q, setQ] = useState('')
  const set = (patch) => setF((x) => ({ ...x, ...patch }))
  // para escolher: os números conectados; um que já estava na roda e caiu continua aparecendo (para poder tirar)
  const options = db.connections.filter((c) => canRotate(c) && (isLive(c) || f.connectionIds.includes(c.id)))
  const offline = db.connections.filter((c) => canRotate(c) && !options.includes(c)).length
  // a ordem da roda é a ordem em que os números foram marcados; conexão excluída sai da lista
  const chosen = f.connectionIds.filter((id) => options.some((c) => c.id === id))
  const toggle = (id) => set({ connectionIds: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] })
  const shown = options.filter((c) => (c.name + c.number).toLowerCase().includes(q.trim().toLowerCase()))
  const agent = db.agents.find((a) => a.id === f.agentId)

  const save = () => {
    const name = f.name.trim()
    const slug = f.slug.replace(/-+$/, '')
    if (!name) return toast('Dê um nome para o rotacionador.', 'error')
    if (!SLUG_RE.test(slug)) return toast('O endereço do link precisa de 3 a 60 letras, números ou hífens.', 'error')
    if (db.rotators.some((r) => r.id !== f.id && r.slug === slug)) return toast('Esse endereço de link já está em uso. Escolha outro.', 'error')
    if (!chosen.length) return toast('Escolha pelo menos 1 número conectado.', 'error')
    const data = { name, slug, connectionIds: chosen, mode: f.mode, message: f.message.trim(), agentId: hasAgents ? f.agentId || null : f.agentId, active: !!f.active }
    if (isNew) db.add('rotators', { ...data, turn: 0, clicks: 0, counts: {}, misses: 0, createdAt: new Date().toISOString() })
    else db.update('rotators', f.id, data)
    toast(isNew ? 'Rotacionador criado! Copie o link e divulgue.' : 'Rotacionador salvo!')
    onBack()
  }

  return (
    <Modal open onClose={onClose} size="lg" title={isNew ? 'Novo rotacionador' : 'Editar rotacionador'} subtitle="Quem clicar no link cai no WhatsApp de um dos números, com a mensagem já escrita."
      footer={<><button className="btn-secondary" onClick={onBack}>Voltar</button><button className="btn-primary" onClick={save}><Check size={15} /> {isNew ? 'Criar rotacionador' : 'Salvar'}</button></>}>
      <Field label="Nome">
        <input className="input" autoFocus placeholder="Ex.: Aluno me chamou" value={f.name}
          onChange={(e) => set({ name: e.target.value, ...(!slugTouched && { slug: slugify(e.target.value) }) })} />
      </Field>
      <Field label="Endereço do link" hint="É o link que vai nos grupos e na área de membros. Se mudar depois, o link antigo para de funcionar.">
        <div className="flex items-center overflow-hidden rounded-[14px] border border-border">
          <span className="shrink-0 border-r border-border px-3 py-2.5 text-sm text-text-muted">{ROTATOR_SITE.replace(/^https?:\/\//, '')}/r/</span>
          <input className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm outline-none" placeholder="aluno-me-chamou" value={f.slug}
            onChange={(e) => { setSlugTouched(true); set({ slug: slugify(e.target.value) }) }} />
        </div>
      </Field>

      <Field label="Números da roda" hint={`Os números conectados em Conexões. Revezam na ordem em que foram marcados; se um cair, fica fora da roda até reconectar.${offline ? ` ${offline} desconectado${offline > 1 ? 's' : ''} não aparece${offline > 1 ? 'm' : ''} aqui.` : ''}`}>
        {options.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-border p-4 text-sm text-text-secondary">
            Nenhum número de WhatsApp conectado. Conecte um em Conexões para escolher aqui.
            {onNewConnection && <button className="btn-secondary ml-2 mt-2 text-xs" onClick={onNewConnection}><Plus size={13} /> Nova Conexão</button>}
          </div>
        ) : (
          <div className="space-y-1.5">
            {options.length > 6 && <SearchInput className="mb-2" value={q} onChange={setQ} placeholder="Buscar número conectado por nome ou número" />}
            {shown.length === 0 && <p className="py-2 text-center text-xs text-text-muted">Nenhum número conectado com “{q}”.</p>}
            {shown.map((c) => {
              const pos = chosen.indexOf(c.id)
              const on = isLive(c)
              // quem vai atender neste número com o que está na tela (o agente ativo próprio vence o do rotacionador)
              const who = hasAgents && pos >= 0 && agentFor(c.id, db.agents, f.agentId ? [{ ...f, active: true, connectionIds: chosen }] : []).agent
              return (
                <button key={c.id} type="button" onClick={() => toggle(c.id)} className={cx('flex w-full items-center gap-3 rounded-[14px] border px-3 py-2.5 text-left', pos >= 0 ? 'choice-on' : 'border-border hover:border-border-hover')}>
                  <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', pos >= 0 ? 'border-transparent text-white' : 'border-border text-transparent')}
                    style={pos >= 0 ? { background: 'var(--material-primary)' } : undefined}>{pos >= 0 ? pos + 1 : '·'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.name}</span>
                    <span className="block truncate text-xs text-text-muted">{c.number || 'Sem número vinculado'}{who?.active ? ` · agente ${who.name}` : ''}</span>
                  </span>
                  <span className={on ? 'badge-success' : 'badge-danger'}>{on ? 'No ar' : 'Caiu · fora da roda'}</span>
                </button>
              )
            })}
            {chosen.length === 1 && (
              <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-amber-400">
                <AlertTriangle size={12} /> Com 1 número, todos os cliques vão para ele. Quando conectar outro, é só voltar aqui e marcar.
                {onNewConnection && <button className="btn-secondary px-2 py-1 text-xs" onClick={onNewConnection}><Plus size={12} /> Nova Conexão</button>}
              </p>
            )}
          </div>
        )}
      </Field>

      <Field label="Como revezar">
        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map(([id, t, d, I]) => (
            <button key={id} type="button" onClick={() => set({ mode: id })} className={cx('rounded-[16px] border p-3 text-left', f.mode === id ? 'choice-on' : 'border-border')}>
              <I size={18} className="mb-1 text-violet-400" /><p className="text-sm font-semibold">{t}</p><p className="text-xs text-text-muted">{d}</p>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Mensagem pronta" hint="Já aparece escrita no WhatsApp de quem clicou; a pessoa só aperta enviar. Em branco, abre a conversa vazia.">
        <textarea className="input" rows={2} value={f.message} onChange={(e) => set({ message: e.target.value })} />
      </Field>

      {hasAgents && (
        <Field label="Agente de IA nos números da roda" hint="Atende em todos os números deste rotacionador. Número que já tem agente ativo próprio continua com o dele.">
          <Select value={f.agentId || ''} onChange={(v) => set({ agentId: v || null })} placeholder="Nenhum (cada número com o agente dele)"
            options={db.agents.map((a) => ({ value: a.id, label: `${a.name}${a.active ? '' : ' (pausado)'}` }))} />
          {agent && !agent.active && <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-400"><AlertTriangle size={12} /> Esse agente está pausado: ative em Agentes de IA para ele responder.</p>}
        </Field>
      )}

      <div className="rounded-[14px] border border-border px-3 py-1">
        <Toggle checked={!!f.active} onChange={(v) => set({ active: v })} label={f.active ? 'Link ligado' : 'Link desligado'}
          description={f.active ? 'Quem clicar cai num dos números no ar' : 'Quem clicar vê a página de atendimento indisponível'} />
      </div>
    </Modal>
  )
}
