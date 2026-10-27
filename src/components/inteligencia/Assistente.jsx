// Aba Assistente: conversa com o Vórtex Inteligência. Cada resposta traz o texto da IA e os blocos (cards, gráficos e
// tabelas) que vieram das consultas do servidor, com período, filtros e definições das métricas.
import { useEffect, useRef, useState } from 'react'
import { History, Loader2, MessageSquarePlus, Send, Sparkles, Trash2, X } from 'lucide-react'
import { useDB, toast } from '../../lib/store'
import { intel } from '../../lib/inteligencia'
import { cx } from '../../lib/utils'
import { Blocos, Rodape } from './Blocos'

// Sem perguntas prontas: o cliente escreve a pergunta do jeito dele.
export default function Assistente({ onAcao, pedido, onPedidoUsado }) {
  const cid = useDB((s) => s.company.id)
  const [conversas, setConversas] = useState([])
  const [atual, setAtual] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [historico, setHistorico] = useState(false)
  const fim = useRef(null)
  const campo = useRef(null)

  const carregarConversas = () => intel.conversas(cid).then(setConversas).catch(() => {})
  useEffect(() => { carregarConversas() }, [cid]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [msgs, enviando])

  const abrir = async (id) => {
    setHistorico(false)
    setAtual(id)
    try { setMsgs(await intel.mensagens(id)) } catch (e) { toast(e.message, 'error') }
  }
  const nova = () => { setAtual(null); setMsgs([]); setHistorico(false); campo.current?.focus() }

  const enviar = async (t = texto) => {
    const q = String(t || '').trim()
    if (!q || enviando) return
    setTexto('')
    setMsgs((m) => [...m, { id: `u${Date.now()}`, role: 'user', text: q }])
    setEnviando(true)
    try {
      const r = await intel.perguntar(cid, atual, q)
      if (!atual) { setAtual(r.conversaId); carregarConversas() }
      setMsgs((m) => [...m, r.mensagem])
    } catch (e) {
      setMsgs((m) => [...m, { id: `e${Date.now()}`, role: 'assistant', text: `Não consegui responder: ${e.message}`, erro: true }])
    } finally {
      setEnviando(false)
    }
  }

  // pedido vindo de um botão de ação ("Comparar com o período anterior", sugestões)
  useEffect(() => {
    if (pedido) { enviar(pedido); onPedidoUsado?.() }
  }, [pedido]) // eslint-disable-line react-hooks/exhaustive-deps

  const acao = (a, meta) => (a?.tipo === 'perguntar' ? enviar(a.texto) : onAcao?.(a, meta))

  // Campo da pergunta: no centro enquanto a conversa está vazia, embaixo depois da primeira resposta
  const campoPergunta = (grande) => (
    <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); enviar() }}>
      <textarea ref={campo} autoFocus rows={grande ? 3 : 1} className={cx('input flex-1 resize-none', grande ? 'min-h-[88px] text-[15px]' : 'max-h-40 min-h-[44px]')}
        placeholder="Digite sua pergunta sobre vendas, recuperação, atendimento ou agentes…" value={texto}
        onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }} maxLength={2000} />
      <button type="submit" className="btn-primary h-[44px] px-4" disabled={!texto.trim() || enviando} aria-label="Enviar pergunta"><Send size={16} /> {grande && 'Perguntar'}</button>
    </form>
  )

  return (
    <div className="flex min-h-[560px] gap-4">
      {/* histórico */}
      <aside className={cx('w-64 shrink-0 flex-col gap-2', historico ? 'fixed inset-0 z-[150] flex bg-surface-base p-4 lg:static lg:z-auto lg:bg-transparent lg:p-0' : 'hidden lg:flex')}>
        <div className="flex items-center justify-between">
          <p className="eyebrow-label">Conversas</p>
          <button className="btn-ghost p-1.5 lg:hidden" onClick={() => setHistorico(false)} aria-label="Fechar"><X size={16} /></button>
        </div>
        <button className="btn-secondary justify-start text-xs" onClick={nova}><MessageSquarePlus size={14} /> Nova conversa</button>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {conversas.map((c) => (
            <div key={c.id} className={cx('group flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs', c.id === atual ? 'is-selected' : 'hover:bg-surface-interactive')}>
              <button className="min-w-0 flex-1 truncate text-left text-text-secondary" onClick={() => abrir(c.id)} title={c.title}>{c.title}</button>
              <button className="hidden p-1 text-text-muted hover:text-red-400 group-hover:block" title="Apagar conversa" aria-label="Apagar conversa"
                onClick={async () => { await intel.apagarConversa(c.id).catch((e) => toast(e.message, 'error')); if (c.id === atual) nova(); carregarConversas() }}><Trash2 size={12} /></button>
            </div>
          ))}
          {!conversas.length && <p className="px-2 text-xs text-text-muted">As conversas ficam guardadas aqui.</p>}
        </div>
      </aside>

      {/* conversa */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2 lg:hidden">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setHistorico(true)}><History size={14} /> Conversas</button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={nova}><MessageSquarePlus size={14} /> Nova</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto pb-4">
          {!msgs.length && (
            <div className="card p-6 text-center">
              <div className="icon-tile mx-auto mb-3 h-12 w-12"><Sparkles size={22} /></div>
              <p className="text-base text-text-primary" style={{ fontWeight: 650 }}>Pergunte sobre a sua operação</p>
              <p className="mx-auto mt-1 max-w-lg text-sm text-text-muted">Escreva o que quer saber, do seu jeito. A resposta vem com os números do sistema. A IA só consulta: não envia mensagens nem altera nada.</p>
              <div className="mx-auto mt-5 max-w-2xl text-left">{campoPergunta(true)}</div>
              <p className="mt-2 text-[11px] text-text-muted">Enter envia · Shift + Enter quebra a linha</p>
            </div>
          )}
          {msgs.map((m) => (m.role === 'user'
            ? <div key={m.id} className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-sm" style={{ background: 'var(--material-primary)', color: 'var(--accent-fg)' }}>{m.text}</p></div>
            : (
              <div key={m.id} className="flex gap-2.5">
                <div className="icon-tile mt-0.5 h-8 w-8 shrink-0"><Sparkles size={15} /></div>
                <div className="min-w-0 flex-1">
                  <p className={cx('mb-3 whitespace-pre-wrap text-sm leading-relaxed', m.erro ? 'text-red-400' : 'text-text-primary')}>{m.text}</p>
                  {m.blocks?.length > 0 && <Blocos blocos={m.blocks} onAcao={(a) => acao(a, m.meta)} />}
                  {m.meta && <Rodape meta={m.meta} />}
                </div>
              </div>
            )))}
          {enviando && <div className="flex items-center gap-2 pl-10 text-sm text-text-muted"><Loader2 size={15} className="animate-spin" /> Consultando os dados…</div>}
          <div ref={fim} />
        </div>
        {msgs.length > 0 && campoPergunta(false)}
      </section>
    </div>
  )
}
