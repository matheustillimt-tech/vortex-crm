// Vórtex Inteligência: Assistente (chat com dados reais e gráficos), Visão Geral, Funil e Recuperação, Suporte e
// Evolução dos Agentes ("Melhorar agente"). Números e gráficos vêm do servidor (intel_m_* e função inteligencia).
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BarChart3, Filter, Headphones, Loader2, MessagesSquare, RefreshCw, Settings2, Sparkles, TrendingUp, Wand2 } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { intel, PERIODOS } from '../lib/inteligencia'
import { PageHeader, Modal, Pills, Select, Tabs, Field } from '../components/ui'
import { Blocos, Rodape } from '../components/inteligencia/Blocos'
import Assistente from '../components/inteligencia/Assistente'
import Evolucao from '../components/inteligencia/Evolucao'

const ABAS = [
  { id: 'assistente', label: 'Assistente', icon: MessagesSquare },
  { id: 'visao', label: 'Visão Geral', icon: BarChart3 },
  { id: 'funil', label: 'Funil e Recuperação', icon: TrendingUp },
  { id: 'suporte', label: 'Suporte', icon: Headphones },
  { id: 'evolucao', label: 'Evolução dos Agentes', icon: Wand2 },
]

export default function Inteligencia() {
  const cid = useDB((s) => s.company.id)
  const [params, setParams] = useSearchParams()
  const aba = ABAS.some((a) => a.id === params.get('aba')) ? params.get('aba') : 'assistente'
  const setAba = (id) => setParams((p) => { p.set('aba', id); return p }, { replace: true })
  const [me, setMe] = useState(null)
  const [erro, setErro] = useState(null)
  const [registros, setRegistros] = useState(null)
  const [config, setConfig] = useState(false)
  const [pedido, setPedido] = useState(null)
  const [agenteEvolucao, setAgenteEvolucao] = useState(null)
  const [abrirMelhorar, setAbrirMelhorar] = useState(false)

  useEffect(() => { intel.me(cid).then(setMe).catch((e) => setErro(e.message)) }, [cid])

  // ações dos blocos: abrir registros, perguntar, abrir agente
  const onAcao = useCallback((a, meta) => {
    if (!a) return
    if (a.tipo === 'registros') setRegistros({ ...a, periodo: meta?.periodos?.[0] })
    else if (a.tipo === 'perguntar') { setPedido(a.texto); setAba('assistente') }
    else if (a.tipo === 'abrir' && a.destino === 'agente') { setAgenteEvolucao(a.id); setAba('evolucao') }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (erro) return <div className="card p-6 text-sm text-red-400">{erro}</div>
  if (!me) return <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando…</p>
  if (!me.pode?.consultar) return <div className="card p-6 text-sm text-text-secondary">Seu papel nesta empresa não tem acesso ao Vórtex Inteligência. Peça a um administrador.</div>

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={Sparkles} title="Vórtex Inteligência" subtitle="Pergunte sobre vendas, recuperação e atendimento e melhore seus agentes com base nas conversas reais."
        actions={<>
          {me.pode.configurar && <button className="btn-secondary" onClick={() => setConfig(true)}><Settings2 size={15} /> Configurar</button>}
          {me.agentes && <button className="btn-primary" disabled={!me.pode.melhorar} onClick={() => { setAba('evolucao'); setAbrirMelhorar(true) }}><Wand2 size={15} /> Melhorar agente</button>}
        </>} />
      <Tabs className="mb-5" value={aba} onChange={setAba} tabs={ABAS.filter((t) => t.id !== 'evolucao' || me.agentes)} />
      {aba === 'assistente' && <Assistente onAcao={onAcao} pedido={pedido} onPedidoUsado={() => setPedido(null)} />}
      {['visao', 'funil', 'suporte'].includes(aba) && <Painel key={aba} aba={aba} onAcao={onAcao} />}
      {aba === 'evolucao' && me.agentes && <Evolucao pode={me.pode} agenteInicial={agenteEvolucao} abrirMelhorar={abrirMelhorar} onMelhorarAberto={() => setAbrirMelhorar(false)} />}
      <Registros r={registros} onClose={() => setRegistros(null)} />
      {config && <Configurar me={me} onClose={() => setConfig(false)} onSalvo={(cfg) => setMe({ ...me, config: cfg })} />}
    </div>
  )
}

/* ---------- Painéis (sem IA) ---------- */

function Painel({ aba, onAcao }) {
  const cid = useDB((s) => s.company.id)
  const [periodo, setPeriodo] = useState('ultimos_30_dias')
  const [comparar, setComparar] = useState(true)
  const [produto, setProduto] = useState('')
  const [agente, setAgente] = useState('')
  const [opcoes, setOpcoes] = useState(null)
  const [dados, setDados] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState(null)
  useEffect(() => { intel.opcoes(cid).then(setOpcoes).catch(() => {}) }, [cid])
  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      setDados(await intel.painel(cid, aba, { periodo }, comparar ? 'periodo_anterior' : null, { produto: produto || undefined, agente: agente || undefined }))
      setErro(null)
    } catch (e) { setErro(e.message) } finally { setCarregando(false) }
  }, [cid, aba, periodo, comparar, produto, agente])
  useEffect(() => { carregar() }, [carregar])
  const meta = dados && { periodos: [{ rotulo: dados.periodo?.rotulo, de: dados.periodo?.de, ate: dados.periodo?.ate, comparacao: dados.comparacao?.rotulo }], atualizadoEm: dados.atualizadoEm, fuso: dados.fuso,
    filtros: { produto: opcoes?.produtos?.find((p) => p.id === produto)?.nome || null, agente: opcoes?.agentes?.find((a) => a.id === agente)?.nome || null } }
  const acao = (a) => onAcao(a, meta)
  return (
    <div>
      <div className="card mb-4 flex flex-col gap-3 p-3 lg:flex-row lg:items-center">
        <div className="no-scrollbar -mx-1 overflow-x-auto px-1"><Pills options={PERIODOS.map((p) => ({ id: p.id, label: p.label }))} value={periodo} onChange={setPeriodo} /></div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Filter size={14} className="text-text-muted" />
          {aba !== 'suporte' && <Select className="h-9 w-44 py-1 text-xs" value={produto} onChange={setProduto} placeholder="Todos os produtos" options={(opcoes?.produtos || []).map((p) => ({ value: p.id, label: p.nome }))} />}
          {aba !== 'funil' && <Select className="h-9 w-40 py-1 text-xs" value={agente} onChange={setAgente} placeholder="Todos os agentes" options={(opcoes?.agentes || []).map((a) => ({ value: a.id, label: a.nome }))} />}
          <label className="flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" checked={comparar} onChange={(e) => setComparar(e.target.checked)} /> Comparar com o período anterior</label>
          <button className="btn-ghost p-2" onClick={carregar} title="Atualizar" aria-label="Atualizar"><RefreshCw size={14} className={carregando ? 'animate-spin' : ''} /></button>
        </div>
      </div>
      {erro && <p className="mb-3 text-sm text-red-400">{erro}</p>}
      {!dados && carregando && <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Calculando…</p>}
      {dados && (
        <div className={carregando ? 'opacity-60 transition' : 'transition'}>
          <div className="space-y-6">
            {dados.secoes.map((s) => (
              <section key={s.titulo}>
                <h2 className="mb-2 text-sm font-semibold text-text-primary">{s.titulo}</h2>
                <Blocos blocos={s.blocos} onAcao={acao} />
              </section>
            ))}
          </div>
          <Rodape meta={meta} definicoes={dados.secoes.flatMap((s) => s.definicoes || [])} />
        </div>
      )}
    </div>
  )
}

/* ---------- Registros por trás de um número ---------- */

function Registros({ r, onClose }) {
  const cid = useDB((s) => s.company.id)
  const [bloco, setBloco] = useState(null)
  const [pagina, setPagina] = useState(0)
  const [erro, setErro] = useState(null)
  useEffect(() => { setPagina(0) }, [r])
  useEffect(() => {
    if (!r) { setBloco(null); return }
    setBloco(null); setErro(null)
    intel.registros(cid, { tipo: r.registro, filtros: r.filtros || {}, titulo: r.titulo, pagina, ...(r.periodo?.de ? { de: r.periodo.de, ate: r.periodo.ate } : { periodo: { periodo: 'ultimos_30_dias' } }) })
      .then((x) => setBloco(x.bloco)).catch((e) => setErro(e.message))
  }, [r, pagina, cid])
  return (
    <Modal open={!!r} onClose={onClose} size="xl" title={r?.titulo || 'Registros'} subtitle={r?.periodo?.rotulo}
      footer={<><button className="btn-secondary" disabled={!pagina} onClick={() => setPagina(pagina - 1)}>Anterior</button><button className="btn-secondary" disabled={(bloco?.linhas?.length || 0) < 50} onClick={() => setPagina(pagina + 1)}>Próxima</button><button className="btn-primary" onClick={onClose}>Fechar</button></>}>
      {erro && <p className="text-sm text-red-400">{erro}</p>}
      {!bloco && !erro && <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Buscando…</p>}
      {bloco && <Blocos blocos={[{ ...bloco, titulo: `${bloco.linhas.length} registro(s)${pagina ? ` · página ${pagina + 1}` : ''}` }]} />}
      <p className="mt-2 text-[11px] text-text-muted">Clique numa linha para abrir a conversa no Chat ao vivo.</p>
    </Modal>
  )
}

/* ---------- Configuração (permissões, limites, atribuição) ---------- */

const PERMS = [['consultar', 'Consultar dados e usar o assistente'], ['conversas', 'Ver o conteúdo das conversas'], ['melhorar', 'Iniciar "Melhorar agente"'],
  ['aprovar', 'Aprovar mudanças protegidas'], ['restaurar', 'Restaurar versões'], ['configurar', 'Configurar o módulo']]
const PAPEIS = ['Admin', 'Membro']

function Configurar({ me, onClose, onSalvo }) {
  const cid = useDB((s) => s.company.id)
  const cfg = me.config || {}
  const [perm, setPerm] = useState(cfg.permissoes || {})
  const [lim, setLim] = useState(cfg.limites || {})
  const [atr, setAtr] = useState(cfg.atribuicao || {})
  const [salvando, setSalvando] = useState(false)
  const [importando, setImportando] = useState(false)
  const marca = (p, papel, on) => setPerm({ ...perm, [p]: on ? [...new Set([...(perm[p] || []), papel])] : (perm[p] || []).filter((x) => x !== papel) })
  const num = (set, obj, k) => ({ value: obj[k] ?? '', onChange: (e) => set({ ...obj, [k]: e.target.value === '' ? '' : Number(e.target.value) }), type: 'number', min: 0, className: 'input' })
  const salvar = async () => {
    setSalvando(true)
    try { const c = await intel.salvarConfig(cid, perm, lim, atr); onSalvo(c); toast('Configuração salva.', 'success'); onClose() } catch (e) { toast(e.message, 'error') } finally { setSalvando(false) }
  }
  const importar = async () => {
    setImportando(true)
    try { const r = await intel.importar(cid); toast(`${r.lidos} avisos lidos, ${r.pagamentos} de pagamento, ${r.novos} novos registrados.`, 'success') } catch (e) { toast(e.message, 'error') } finally { setImportando(false) }
  }
  return (
    <Modal open onClose={onClose} size="lg" title="Configurar o Vórtex Inteligência"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={salvando} onClick={salvar}>Salvar</button></>}>
      <p className="eyebrow-label mb-2">Permissões por papel</p>
      <div className="mb-5 overflow-x-auto">
        <table className="w-full min-w-[420px] text-xs">
          <thead><tr className="border-b border-border"><th className="py-2 text-left font-medium text-text-muted">Permissão</th><th className="w-24 text-center font-medium text-text-muted">Proprietário</th>{PAPEIS.map((p) => <th key={p} className="w-20 text-center font-medium text-text-muted">{p}</th>)}</tr></thead>
          <tbody>
            {PERMS.map(([k, rot]) => (
              <tr key={k} className="border-b border-border-subtle">
                <td className="py-2 text-text-secondary">{rot}</td>
                <td className="text-center"><input type="checkbox" checked disabled /></td>
                {PAPEIS.map((p) => <td key={p} className="text-center"><input type="checkbox" checked={(perm[k] || []).includes(p)} onChange={(e) => marca(k, p, e.target.checked)} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="eyebrow-label mb-2">Limites de consumo (Créditos de IA)</p>
      <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
        <Field label="Por pergunta ao assistente"><input {...num(setLim, lim, 'consultaMaxCreditos')} /></Field>
        <Field label="Por execução do Melhorar agente"><input {...num(setLim, lim, 'melhoriaMaxCreditos')} /></Field>
        <Field label="No mês (módulo inteiro)"><input {...num(setLim, lim, 'mensalMaxCreditos')} /></Field>
        <Field label="Conversas por execução"><input {...num(setLim, lim, 'conversasPorExecucao')} /></Field>
        <Field label="Casos de validação"><input {...num(setLim, lim, 'casosValidacao')} /></Field>
      </div>
      <p className="eyebrow-label mb-2 mt-2">Atribuição da recuperação</p>
      <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
        <Field label="Carência (min)" hint="Pagou antes disso não é oportunidade"><input {...num(setAtr, atr, 'carenciaMinutos')} /></Field>
        <Field label="Janela (h)" hint="Pago até X h após o último contato = recuperado"><input {...num(setAtr, atr, 'janelaHoras')} /></Field>
        <Field label="Conversão (dias)" hint="Até quando uma compra fecha a oportunidade"><input {...num(setAtr, atr, 'conversaoDias')} /></Field>
        <Field label="Pix vence (h)" hint="Quando a plataforma não informa"><input {...num(setAtr, atr, 'pixExpiraHoras')} /></Field>
      </div>
      <div className="mt-2 rounded-xl border border-border p-3 text-xs text-text-secondary">
        <p className="mb-1 font-semibold text-text-primary">Pagamentos que já chegaram</p>
        <p className="mb-2">Os avisos novos das plataformas (Kiwify, Vórtex Pay, Hotmart, Vórtex Call) entram sozinhos pelos Webhooks de entrada. Para trazer os que chegaram antes do módulo:</p>
        <button className="btn-secondary px-3 py-1.5 text-xs" disabled={importando} onClick={importar}>{importando ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Importar histórico de pagamentos</button>
      </div>
    </Modal>
  )
}
