import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, Plus, Radio, RefreshCw, X, KeyRound, ChevronDown, ChevronRight } from 'lucide-react'
import { useDB, toast } from '../../lib/store'
import { BACKEND, SUPABASE_URL } from '../../lib/supabase'
import { webhookEvents, webhookExtra } from '../../lib/backend'
import { cx, fmtDate } from '../../lib/utils'
import { flattenPaths, getPath } from '../../../supabase/functions/_shared/triggers-core.ts'
import { Field, Select, Toggle } from '../ui'
import { Note } from './parts'

// Gatilho "Webhook recebido": URL exclusiva, segredo, evento de teste com os dados reais, mapeamento para o contato,
// condições, id do evento e histórico. A configuração fica na tabela webhooks (a página Webhooks mostra a mesma).
export const WEBHOOK_BASE = BACKEND ? `${SUPABASE_URL}/functions/v1/inbound-webhook/` : 'https://api.seudominio.com/webhooks/'
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
const LISTEN_MS = 5 * 60_000
const STATUS = {
  ok: ['badge-success', 'Processado'], test: ['badge-info', 'Teste'], duplicate: ['badge-muted', 'Repetido'], ignored: ['badge-warning', 'Ignorado'],
  error: ['badge-danger', 'Erro'], received: ['badge-muted', 'Recebido'],
}
const SAMPLE = { event: 'PURCHASE_APPROVED', id: 'evt_demo_123', data: { buyer: { name: 'Ana Souza', email: 'ana@exemplo.com', phone: '+55 11 3888-7777' }, product: { name: 'Curso de exemplo' }, purchase: { transaction: 'HP0001', value: 97 } } }

export function newWebhook(db, flow) {
  return db.add('webhooks', {
    name: flow?.name || 'Webhook', connectionId: db.connections[0]?.id || null, flowId: flow?.id || null, token: token(), active: true, mapping: [],
    conditions: [], secret: '', secretHeader: 'X-Webhook-Secret', eventIdPath: '',
  })
}

export default function WebhookConfig({ trigger, flow, onChange, webhookId }) {
  const db = useDB()
  const id = trigger?.config?.webhookId ?? webhookId
  const w = db.webhooks.find((x) => x.id === id)
  const set = (patch) => db.update('webhooks', w.id, patch)
  const create = () => {
    const row = newWebhook(db, flow)
    onChange?.({ ...trigger, config: { ...(trigger?.config || {}), webhookId: row.id } })
  }

  if (!w) {
    return (
      <>
        <Note>Clique para gerar a URL exclusiva deste fluxo. Depois, cole a URL na plataforma que vai avisar o Vórtex CRM (checkout, site, CRM).</Note>
        <button className="btn-primary w-full" onClick={create} disabled={!flow}>Criar URL do webhook</button>
      </>
    )
  }
  const url = WEBHOOK_BASE + w.token
  const foreign = flow && w.flowId !== flow.id
  const paths = w.lastTest?.payload ? flattenPaths(w.lastTest.payload) : []

  return (
    <>
      {foreign && (
        <Note tone="warn">
          Esta URL pertence a outro fluxo ({db.flows.find((f) => f.id === w.flowId)?.name || 'sem fluxo'}). <button className="underline" onClick={create}>Criar uma URL nova para este fluxo</button>
        </Note>
      )}
      <Field label="URL do webhook (POST com JSON)">
        <input readOnly className="input font-mono text-[11px]" value={url} onFocus={(e) => e.target.select()} />
        <button className="btn-secondary mt-2 w-full text-xs" onClick={() => { navigator.clipboard?.writeText(url); toast('Link do webhook copiado!') }}><Copy size={13} /> Copiar link do webhook</button>
      </Field>
      <Field label="Nome"><input className="input" value={w.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Checkout Hotmart" /></Field>
      <Field label="Conexão para falar com o contato">
        <Select value={w.connectionId || ''} onChange={(v) => set({ connectionId: v || null })} placeholder="Nenhuma (só cria/atualiza o contato)" options={db.connections.map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      <Toggle label="Webhook ligado" description="Desligado, os eventos ficam no histórico como ignorados." checked={w.active !== false} onChange={(v) => set({ active: v })} />

      <Secret w={w} set={set} />
      <TestEvent w={w} set={set} />

      <Section title="Mapeamento para o contato" hint="Escolha de onde vem cada dado. Cada plataforma manda campos diferentes: use o evento de teste para ver os nomes reais.">
        <Mapping w={w} set={set} paths={paths} />
      </Section>
      <Section title="Condições (opcional)" hint="Só inicia o fluxo quando todas valerem. Ex.: event é igual a PURCHASE_APPROVED.">
        <Conditions w={w} set={set} paths={paths} />
      </Section>
      <Field label="Campo com o id do evento (evita processar duas vezes)" hint="Ex.: id ou data.purchase.transaction. Vazio: só um envio idêntico é considerado repetido.">
        <input className="input font-mono text-xs" list={`paths-${w.id}`} value={w.eventIdPath || ''} onChange={(e) => set({ eventIdPath: e.target.value.trim() })} placeholder="id" />
      </Field>
      <datalist id={`paths-${w.id}`}>{paths.map((p) => <option key={p.path} value={p.path}>{p.value}</option>)}</datalist>

      <Note>O evento não libera envio pelo WhatsApp: o fluxo segue as regras da conexão. Na API oficial, se o contato não escreveu nas últimas 24 h, só sai mensagem por <b>Template WhatsApp</b>. Variáveis disponíveis: os campos mapeados e o evento inteiro como {'{{evento.caminho}}'} (ex.: {'{{evento.data.product.name}}'}).</Note>
      <History w={w} />
    </>
  )
}

function Section({ title, hint, children }) {
  return (
    <div className="mb-4">
      <p className="label">{title}</p>
      {hint && <p className="-mt-1 mb-2 text-xs text-text-muted">{hint}</p>}
      {children}
    </div>
  )
}

function Secret({ w, set }) {
  return (
    <Section title="Segredo (opcional)" hint="Se preencher, a plataforma precisa mandar o mesmo valor no cabeçalho abaixo (ou em Authorization: Bearer). Sem ele, a chamada é recusada.">
      <div className="flex gap-2">
        <input className="input font-mono text-xs" value={w.secret || ''} onChange={(e) => set({ secret: e.target.value.trim() })} placeholder="sem segredo" />
        <button className="btn-secondary shrink-0 px-2.5" title="Gerar segredo" onClick={() => set({ secret: token() })}><KeyRound size={14} /></button>
      </div>
      {w.secret && <input className="input mt-2 font-mono text-xs" value={w.secretHeader || ''} onChange={(e) => set({ secretHeader: e.target.value.trim() })} placeholder="X-Webhook-Secret" />}
    </Section>
  )
}

// "Aguardar evento de teste": o servidor guarda o próximo evento sem rodar o fluxo; aqui ele aparece com os campos reais.
function TestEvent({ w, set }) {
  const [waiting, setWaiting] = useState(() => !!w.listenUntil && Date.parse(w.listenUntil) > Date.now())
  const since = useRef(w.lastTest?.at || '')
  useEffect(() => {
    if (!waiting) return
    if (!BACKEND) {
      const t = setTimeout(() => { set({ listenUntil: null, lastTest: { at: new Date().toISOString(), payload: SAMPLE, demo: true } }); setWaiting(false) }, 1500)
      return () => clearTimeout(t)
    }
    const until = Date.parse(w.listenUntil || 0) || Date.now() + LISTEN_MS
    const t = setInterval(async () => {
      const row = await webhookExtra(w.id).catch(() => null)
      const got = row?.extra?.lastTest
      if (got?.at && got.at !== since.current) {
        // só no painel: o servidor já gravou
        useDB.setState((s) => ({ webhooks: s.webhooks.map((x) => (x.id === w.id ? { ...x, lastTest: got, listenUntil: null, calls: row.calls } : x)) }))
        toast('Evento de teste recebido!')
        setWaiting(false)
      } else if (Date.now() > until) {
        setWaiting(false)
        toast('Nenhum evento chegou em 5 minutos. Tente de novo.', 'warning')
      }
    }, 2500)
    return () => clearInterval(t)
  }, [waiting]) // eslint-disable-line
  const start = () => {
    since.current = w.lastTest?.at || ''
    set({ listenUntil: new Date(Date.now() + LISTEN_MS).toISOString() })
    setWaiting(true)
  }
  const stop = () => { set({ listenUntil: null }); setWaiting(false) }
  return (
    <Section title="Evento de teste" hint="Clique e dispare um evento de teste na sua plataforma. O fluxo não roda com o evento de teste.">
      {waiting ? (
        <div className="flex items-center gap-2 rounded-[13px] border border-[var(--border-accent)] bg-accent-soft p-3 text-xs text-[var(--accent-text)]">
          <Loader2 size={14} className="animate-spin" /> <span className="flex-1">Aguardando o evento… envie para a URL acima.</span>
          <button className="btn-ghost p-1" onClick={stop} aria-label="Parar"><X size={13} /></button>
        </div>
      ) : (
        <button className="btn-secondary w-full text-xs" onClick={start}><Radio size={13} /> Aguardar evento de teste</button>
      )}
      {w.lastTest?.payload && (
        <details className="mt-2 rounded-[13px] border border-border p-2 text-xs" open={!waiting}>
          <summary className="cursor-pointer text-text-secondary">Dados recebidos {w.lastTest.demo ? '(exemplo da demonstração)' : `em ${fmtDate(w.lastTest.at)}`}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-text-muted">{JSON.stringify(w.lastTest.payload, null, 2)}</pre>
        </details>
      )}
    </Section>
  )
}

function Mapping({ w, set, paths }) {
  const db = useDB()
  const rows = w.mapping || []
  const targets = [
    { value: 'nome', label: 'Nome do contato' }, { value: 'telefone', label: 'Telefone (obrigatório para contato novo)' }, { value: 'email', label: 'E-mail' },
    ...db.customFields.map((f) => ({ value: f.key, label: `Campo: ${f.label}` })),
    { value: 'var:', label: 'Variável do fluxo…' },
  ]
  const setRow = (i, patch) => set({ mapping: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const has = (to) => rows.some((r) => r.to === to)
  // sugestões a partir do evento de teste (nomes comuns de nome, telefone e e-mail)
  const guess = (re) => paths.find((p) => re.test(p.path.split('.').pop() || ''))?.path
  const suggestions = paths.length ? [
    ['nome', guess(/^(name|nome|full_?name|customer_?name|buyer_?name)$/i)],
    ['telefone', guess(/(phone|telefone|celular|whats|mobile)/i)],
    ['email', guess(/^e?-?mail$/i)],
  ].filter(([to, from]) => from && !has(to)) : []
  return (
    <>
      {rows.map((r, i) => {
        const isVar = r.to?.startsWith('var:')
        return (
          <div key={i} className="mb-2 rounded-[13px] border border-border p-2">
            <div className="flex items-center gap-1.5">
              <input className="input py-1.5 font-mono text-[11px]" list={`paths-${w.id}`} placeholder="caminho no evento (ex.: buyer.phone)" value={r.from || ''} onChange={(e) => setRow(i, { from: e.target.value.trim() })} />
              <button className="btn-ghost p-1.5 text-red-400" onClick={() => set({ mapping: rows.filter((_, j) => j !== i) })} aria-label="Remover"><X size={13} /></button>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Select className="py-1.5 text-xs" value={isVar ? 'var:' : r.to} onChange={(v) => setRow(i, { to: v === 'var:' ? `var:${(r.from || 'valor').split('.').pop()}` : v })} options={targets} />
              {isVar && <input className="input py-1.5 text-xs" value={r.to.slice(4)} onChange={(e) => setRow(i, { to: `var:${e.target.value.replace(/[^\w]/g, '_')}` })} placeholder="nome_da_variavel" />}
            </div>
            {paths.length > 0 && r.from && <p className="mt-1 truncate text-[10px] text-text-muted">No teste: {String(getPath(w.lastTest.payload, r.from) ?? '—')}</p>}
          </div>
        )
      })}
      {suggestions.map(([to, from]) => (
        <button key={to} className="mb-1.5 block w-full rounded-[11px] border border-dashed border-border px-2 py-1.5 text-left text-[11px] text-text-muted hover:border-accent-primary" onClick={() => set({ mapping: [...rows, { from, to }] })}>
          Sugestão: <span className="font-mono">{from}</span> → {to}
        </button>
      ))}
      <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => set({ mapping: [...rows, { from: '', to: has('telefone') ? 'nome' : 'telefone' }] })}><Plus size={13} /> Adicionar campo</button>
    </>
  )
}

function Conditions({ w, set }) {
  const rows = w.conditions || []
  const setRow = (i, patch) => set({ conditions: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  return (
    <>
      {rows.map((r, i) => (
        <div key={i} className="mb-2 rounded-[13px] border border-border p-2">
          <div className="flex items-center gap-1.5">
            <input className="input py-1.5 font-mono text-[11px]" list={`paths-${w.id}`} placeholder="caminho (ex.: event)" value={r.path || ''} onChange={(e) => setRow(i, { path: e.target.value.trim() })} />
            <button className="btn-ghost p-1.5 text-red-400" onClick={() => set({ conditions: rows.filter((_, j) => j !== i) })} aria-label="Remover"><X size={13} /></button>
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <Select className="py-1.5 text-xs" value={r.op || 'equals'} onChange={(v) => setRow(i, { op: v })}
              options={[{ value: 'equals', label: 'é igual a' }, { value: 'not_equals', label: 'é diferente de' }, { value: 'contains', label: 'contém' }, { value: 'exists', label: 'existe' }, { value: 'not_exists', label: 'não existe' }]} />
            {!['exists', 'not_exists'].includes(r.op) && <input className="input py-1.5 text-xs" value={r.value || ''} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="valor" />}
          </div>
        </div>
      ))}
      <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => set({ conditions: [...rows, { path: 'event', op: 'equals', value: '' }] })}><Plus size={13} /> Adicionar condição</button>
    </>
  )
}

export function History({ w }) {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)
  const load = () => (BACKEND ? webhookEvents(w.id).then(setRows).catch((e) => { setRows([]); toast(e.message, 'error') }) : setRows([]))
  useEffect(() => { load() }, [w.id]) // eslint-disable-line
  return (
    <Section title={`Histórico de recebimentos (${(w.calls || 0).toLocaleString('pt-BR')} no total)`}>
      <button className="btn-ghost mb-1 px-2 py-1 text-xs" onClick={load}><RefreshCw size={12} /> Atualizar</button>
      {rows === null ? <p className="text-xs text-text-muted">Carregando…</p> : rows.length === 0 ? (
        <p className="text-xs text-text-muted">{BACKEND ? 'Nenhum evento recebido ainda.' : 'O histórico aparece com o servidor conectado.'}</p>
      ) : rows.map((r) => {
        const [cls, label] = STATUS[r.status] || STATUS.received
        return (
          <div key={r.id} className="border-b border-border-subtle py-1.5 text-xs last:border-0">
            <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
              {open === r.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className={cls}>{label}</span>
              <span className="ml-auto shrink-0 text-[10px] text-text-muted">{fmtDate(r.received_at)}</span>
            </button>
            {r.reason && <p className={cx('mt-0.5 pl-5 text-[11px]', r.status === 'error' ? 'text-red-400' : 'text-text-muted')}>{r.reason}</p>}
            {open === r.id && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all pl-5 font-mono text-[10px] text-text-muted">{JSON.stringify(r.payload, null, 2)}</pre>}
          </div>
        )
      })}
    </Section>
  )
}
