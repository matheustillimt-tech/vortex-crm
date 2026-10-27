// Vórtex Inteligência (migration 0035, função inteligencia). Banco real: funções intel_* (o banco confere empresa e
// permissão) e a função inteligencia (assistente, painéis, registros, "Melhorar agente").
// Modo demonstração: os mesmos formatos com números de exemplo, para ver a tela sem o servidor.
import { BACKEND, supabase } from './supabase'
import { callFn, fromRow } from './backend'
import { useDB } from './store'

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

// O servidor mudou o agente (melhoria publicada, aprovação, restauração): atualiza a cópia da tela sem salvar de novo
export function agenteAtualizado(row) {
  if (!row?.id) return
  const a = fromRow(row)
  useDB.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }))
}
export async function recarregarAgente(id) {
  if (!BACKEND) return
  const { data } = await supabase.from('agents').select('*').eq('id', id).maybeSingle()
  if (data) agenteAtualizado(data)
}

export const PERIODOS = [
  { id: 'hoje', label: 'Hoje' }, { id: 'ontem', label: 'Ontem' }, { id: 'ultimos_7_dias', label: '7 dias' }, { id: 'esta_semana', label: 'Esta semana' },
  { id: 'semana_passada', label: 'Semana passada' }, { id: 'ultimos_30_dias', label: '30 dias' }, { id: 'este_mes', label: 'Este mês' }, { id: 'mes_passado', label: 'Mês passado' },
  { id: 'ultimos_90_dias', label: '90 dias' },
]

export const ESTADO_JOB = {
  na_fila: ['badge-info', 'Na fila'], em_andamento: ['badge-info', 'Em andamento'], concluido: ['badge-success', 'Concluída'], sem_melhoria: ['badge-muted', 'Sem melhoria confiável'],
  pendente_revisao: ['badge-warning', 'Aguardando revisão'], pausado: ['badge-warning', 'Pausada'], falhou: ['badge-danger', 'Falhou'], cancelado: ['badge-muted', 'Cancelada'],
}
export const ETAPAS = [['preparar', 'Preparar'], ['analisar', 'Analisar conversas'], ['consolidar', 'Consolidar aprendizados'], ['propor', 'Montar versão candidata'], ['validar', 'Validar'], ['aplicar', 'Publicar']]
export const ESTADO_ALTERACAO = {
  aplicada: ['badge-success', 'Aplicada'], aprovada: ['badge-success', 'Aprovada'], pendente_aprovacao: ['badge-warning', 'Aguarda aprovação'],
  revisao: ['badge-warning', 'Em revisão'], bloqueada: ['badge-danger', 'Bloqueada'], rejeitada: ['badge-muted', 'Rejeitada'],
}
export const CAMPO = {
  prompt: 'Instruções', examples: 'Exemplos de respostas', rules: 'Regras do negócio', tone: 'Tom de voz', does: 'Função', audience: 'Público', knowledge: 'Conhecimento',
  settings: 'Configurações', skills: 'Habilidades', files: 'Arquivos', modelo: 'Modelo de IA', configuracao: 'Configuração',
}
export const TIPO_APRENDIZADO = {
  duvida_recorrente: 'Dúvida recorrente', resposta_incorreta: 'Resposta incorreta', resposta_incompleta: 'Resposta incompleta', correcao_humana: 'Correção da equipe',
  objecao: 'Objeção comercial', info_ausente: 'Informação ausente', resposta_longa: 'Resposta longa', repetitiva: 'Repetitiva', pergunta_desnecessaria: 'Pergunta desnecessária',
  transferencia_evitavel: 'Transferência evitável', transferencia_necessaria: 'Devia ter transferido', instrucao_conflitante: 'Instrução conflitante', uso_de_contexto: 'Contexto demais', tom: 'Tom',
}
export const NATUREZA = { confirmado: ['badge-success', 'Confirmado pela equipe'], hipotese: ['badge-muted', 'Hipótese'], excecao: ['badge-warning', 'Exceção pontual'] }

/* ---------- API ---------- */

export const intel = BACKEND ? {
  me: (cid) => rpc('intel_me', { p_company: cid }),
  opcoes: (cid) => rpc('intel_opcoes', { p_company: cid }),
  painel: (cid, aba, periodo, comparar, filtros) => callFn('inteligencia', { action: 'painel', companyId: cid, aba, periodo, comparar, filtros }),
  perguntar: (cid, conversaId, texto) => callFn('inteligencia', { action: 'perguntar', companyId: cid, conversaId, texto }),
  registros: (cid, r) => callFn('inteligencia', { action: 'registros', companyId: cid, ...r }),
  conversas: async (cid) => {
    const { data, error } = await supabase.from('intel_conversations').select('id, title, updated_at').eq('company_id', cid).order('updated_at', { ascending: false }).limit(30)
    if (error) throw new Error(error.message)
    return data
  },
  mensagens: async (id) => {
    const { data, error } = await supabase.from('intel_messages').select('id, role, text, blocks, context, created_at').eq('conversation_id', id).order('created_at')
    if (error) throw new Error(error.message)
    return data.map((m) => ({ id: m.id, role: m.role, text: m.text, blocks: m.blocks, meta: m.context?.meta, createdAt: m.created_at }))
  },
  apagarConversa: async (id) => { const { error } = await supabase.from('intel_conversations').delete().eq('id', id); if (error) throw new Error(error.message) },
  evolucao: (cid, agentId) => rpc('intel_evolucao', { p_company: cid, p_agent: agentId }),
  estimar: (cid, agentId) => callFn('inteligencia', { action: 'estimar', companyId: cid, agentId }),
  melhorar: (cid, agentId) => callFn('inteligencia', { action: 'melhorar', companyId: cid, agentId }),
  continuar: (cid, jobId) => callFn('inteligencia', { action: 'continuar', companyId: cid, jobId }),
  cancelar: (jobId) => rpc('intel_job_cancel', { p_job: jobId }),
  decidir: async (changeId, aprovar) => { const r = await rpc('intel_change_decide', { p_change: changeId, p_aprovar: aprovar }); agenteAtualizado(r?.agente); return r },
  restaurar: async (versionId) => { const r = await rpc('intel_version_restore', { p_version: versionId }); agenteAtualizado(r?.agente); return r },
  salvarConfig: (cid, permissoes, limites, atribuicao) => rpc('intel_settings_save', { p_company: cid, p_permissoes: permissoes, p_limites: limites, p_atribuicao: atribuicao }),
  importar: (cid) => callFn('inteligencia', { action: 'importar', companyId: cid }),
} : demo()

/* ---------- Modo demonstração ---------- */

function demo() {
  const espera = (ms = 500) => new Promise((r) => setTimeout(r, ms))
  const dias = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 86400e3).toISOString().slice(0, 10))
  const serie = (n, f) => dias(n).map((x, i) => ({ x, ...f(i) }))
  const periodo = { rotulo: 'Últimos 7 dias (exemplo)', de: dias(7)[0], ate: new Date().toISOString() }
  const vendas = () => [
    { tipo: 'cards', itens: [
      { rotulo: 'Vendas aprovadas', valor: 38, formato: 'numero', delta: 12.5, acao: { tipo: 'registros', registro: 'pedidos', filtros: { status: 'pago' }, titulo: 'Pedidos pagos' } },
      { rotulo: 'Receita aprovada', valor: 748600, formato: 'moeda', delta: 9.1 }, { rotulo: 'Ticket médio', valor: 19700, formato: 'moeda', delta: -3 },
      { rotulo: 'Reembolsos e chargebacks', valor: 39400, formato: 'moeda', inverter: true, delta: 0 }, { rotulo: 'Receita líquida', valor: 709200, formato: 'moeda', delta: 8 }] },
    { tipo: 'serie', titulo: 'Receita aprovada por dia', x: 'dia', series: [{ chave: 'receitaCentavos', rotulo: 'Receita', formato: 'moeda' }, { chave: 'vendas', rotulo: 'Vendas', formato: 'numero', eixo: 'direita' }],
      dados: serie(7, (i) => ({ vendas: [4, 6, 3, 7, 5, 8, 5][i], receitaCentavos: [4, 6, 3, 7, 5, 8, 5][i] * 19700 })) },
    { tipo: 'distribuicao', titulo: 'Pedidos abertos no período, por status', formato: 'numero', itens: [{ rotulo: 'Pago', valor: 38 }, { rotulo: 'Pendente', valor: 14 }, { rotulo: 'Recusado', valor: 6 }, { rotulo: 'Carrinho abandonado', valor: 21 }] },
  ]
  const recuperacao = () => [
    { tipo: 'cards', itens: [
      { rotulo: 'Oportunidades', valor: 41, formato: 'numero', inverter: true, acao: { tipo: 'registros', registro: 'oportunidades', titulo: 'Oportunidades' } },
      { rotulo: 'Vendas recuperadas', valor: 9, formato: 'numero', delta: 28 }, { rotulo: 'Receita recuperada', valor: 177300, formato: 'moeda' },
      { rotulo: 'Taxa de recuperação', valor: 0.2195, formato: 'pct' }, { rotulo: 'Compraram após contato', valor: 12, formato: 'numero' },
      { rotulo: 'Valor potencial não convertido', valor: 472800, formato: 'moeda', inverter: true, ajuda: 'É valor que poderia entrar, não prejuízo confirmado.' }] },
    { tipo: 'serie', titulo: 'Oportunidades e recuperações por dia', x: 'dia', series: [{ chave: 'oportunidades', rotulo: 'Oportunidades', formato: 'numero' }, { chave: 'recuperadas', rotulo: 'Recuperadas', formato: 'numero' }],
      dados: serie(7, (i) => ({ oportunidades: [5, 7, 4, 8, 6, 7, 4][i], recuperadas: [1, 2, 0, 2, 1, 2, 1][i] })) },
  ]
  const suporte = () => [
    { tipo: 'cards', itens: [{ rotulo: 'Conversas com clientes', valor: 214, formato: 'numero', delta: 6 }, { rotulo: 'Atendidas pela IA', valor: 188, formato: 'numero' },
      { rotulo: 'Transferências da IA', valor: 23, formato: 'numero', inverter: true, delta: -15, acao: { tipo: 'registros', registro: 'transferidas', titulo: 'Conversas transferidas pela IA' } },
      { rotulo: 'A IA não resolveu', valor: 31, formato: 'numero', inverter: true }, { rotulo: '1ª resposta (mediana)', valor: 0.4, formato: 'minutos' }] },
    { tipo: 'distribuicao', titulo: 'Por que a IA não resolveu', formato: 'numero', itens: [{ rotulo: 'pediu prazo de entrega internacional', valor: 9 }, { rotulo: 'quer falar com atendente', valor: 8 }, { rotulo: 'dúvida sobre nota fiscal', valor: 6 }] },
  ]
  const conversas = []
  const agentesEvolucao = {}
  return {
    me: async () => ({ modulo: true, agentes: true, papel: 'Proprietário', pode: { consultar: true, conversas: true, melhorar: true, aprovar: true, restaurar: true, configurar: true },
      config: { permissoes: { consultar: ['Proprietário', 'Admin', 'Membro'], conversas: ['Proprietário', 'Admin'], melhorar: ['Proprietário', 'Admin'], aprovar: ['Proprietário'], restaurar: ['Proprietário', 'Admin'], configurar: ['Proprietário', 'Admin'] },
        limites: { consultaMaxCreditos: 60, melhoriaMaxCreditos: 3000, mensalMaxCreditos: 30000, conversasPorExecucao: 1500, casosValidacao: 10 }, atribuicao: { carenciaMinutos: 30, janelaHoras: 72, conversaoDias: 30, pixExpiraHoras: 48 } },
      coletaDesde: new Date().toISOString() }),
    opcoes: async () => ({ produtos: [{ id: 'p1', nome: 'Curso exemplo' }], agentes: useDB.getState().agents.map((a) => ({ id: a.id, nome: a.name, ativo: a.active, motor: a.engine || 'padrao' })), conexoes: [] }),
    painel: async (_c, aba) => {
      await espera()
      const secoes = aba === 'funil'
        ? [{ titulo: 'Funil', blocos: [{ tipo: 'funil', titulo: 'Funil do período', itens: [{ rotulo: 'Leads novos', valor: 320 }, { rotulo: 'Conversas iniciadas', valor: 214 }, { rotulo: 'Atendidas pela IA', valor: 188 }, { rotulo: 'Iniciaram compra', valor: 79 }, { rotulo: 'Compraram', valor: 38 }] }] },
          { titulo: 'Recuperação', blocos: recuperacao() }]
        : aba === 'suporte' ? [{ titulo: 'Atendimento', blocos: suporte() }]
          : [{ titulo: 'Vendas', blocos: vendas().slice(0, 2) }, { titulo: 'Recuperação', blocos: recuperacao().slice(0, 1) }, { titulo: 'Atendimento', blocos: suporte().slice(0, 1) }]
      return { secoes: secoes.map((s) => ({ definicoes: [], ...s })), periodo, atualizadoEm: new Date().toISOString(), fuso: 'America/Sao_Paulo' }
    },
    perguntar: async (_c, conversaId, texto) => {
      await espera(900)
      let c = conversas.find((x) => x.id === conversaId)
      if (!c) { c = { id: `c${conversas.length + 1}`, title: texto.slice(0, 60), updated_at: new Date().toISOString(), msgs: [] }; conversas.unshift(c) }
      const t = texto.toLowerCase()
      const [txt, blocks] = /recuper|pix|carrinho|abandon/.test(t) ? ['Exemplo: nos últimos 7 dias houve 41 oportunidades e 9 vendas recuperadas (R$ 1.773,00). No modo demonstração os números são fictícios.', recuperacao()]
        : /suporte|atendimento|resolv|transfer/.test(t) ? ['Exemplo: 214 conversas, 188 atendidas pela IA e 23 transferências. No modo demonstração os números são fictícios.', suporte()]
          : ['Exemplo: 38 vendas aprovadas e R$ 7.486,00 de receita nos últimos 7 dias. No modo demonstração os números são fictícios.', vendas()]
      const msg = { id: `m${Date.now()}`, role: 'assistant', text: txt, blocks, meta: { periodos: [{ rotulo: periodo.rotulo }], filtros: {}, atualizadoEm: new Date().toISOString(), definicoes: [{ termo: 'Demonstração', texto: 'Sem servidor conectado: dados de exemplo.' }] }, createdAt: new Date().toISOString() }
      c.msgs.push({ id: `u${Date.now()}`, role: 'user', text: texto, createdAt: new Date().toISOString() }, msg)
      return { conversaId: c.id, mensagem: msg }
    },
    registros: async (_c, r) => {
      await espera(300)
      return { bloco: { tipo: 'tabela', titulo: r.titulo, abrir: 'conversa', colunas: [{ chave: 'quando', rotulo: 'Quando', formato: 'data' }, { chave: 'cliente', rotulo: 'Cliente' }, { chave: 'valorCentavos', rotulo: 'Valor', formato: 'moeda' }],
        linhas: [{ quando: new Date().toISOString(), cliente: 'Cliente exemplo', valorCentavos: 19700 }] } }
    },
    conversas: async () => conversas,
    mensagens: async (id) => conversas.find((c) => c.id === id)?.msgs || [],
    apagarConversa: async (id) => { const i = conversas.findIndex((c) => c.id === id); if (i >= 0) conversas.splice(i, 1) },
    evolucao: async (_c, agentId) => JSON.parse(JSON.stringify(agentesEvolucao[agentId] || { jobs: [], versoes: [], alteracoes: [], aprendizados: [], validacao: [], desempenho: null })),
    estimar: async () => ({ conversas: { historico: 120, reaproveitadas: 0, pendentes: 120, nestaExecucao: 120, foraDoLimite: 0 }, estimativa: { creditos: 420, faixa: [252, 672], estimada: true }, orcamento: { creditos: 3000 }, fonte: 'plataforma', saldo: 18000 }),
    melhorar: async (_c, agentId) => {
      const job = { id: `j${Date.now()}`, status: 'em_andamento', etapa: 'analisar', progresso: { mensagem: 'Analisando conversas (exemplo)', feitos: 0, total: 120 }, cobertura: { historico: 120, nestaExecucao: 120 }, created_at: new Date().toISOString(), relatorio: {} }
      agentesEvolucao[agentId] = { jobs: [job], versoes: [], alteracoes: [], aprendizados: [], validacao: [], desempenho: null }
      let n = 0
      const passo = setInterval(() => {
        n += 30
        job.progresso = { mensagem: n < 120 ? `Analisando conversas (${n} de 120)` : 'Concluída (exemplo)', feitos: Math.min(n, 120), total: 120 }
        if (n >= 120) {
          clearInterval(passo)
          Object.assign(job, { status: 'concluido', etapa: 'fim', finished_at: new Date().toISOString(), relatorio: { conclusao: 'Exemplo: respostas mais curtas e prazo de entrega no conhecimento.', aplicadas: 2, pendentes: 1, conversas: { historico: 120, analisadas: 120 }, custo: { creditos: 380 }, versaoAtiva: 2,
            validacao: { aprovada: true, casos: 8, melhor: 4, igual: 4, pior: 0, regrasRespeitadas: true, pontosAtual: 17.5, pontosCandidata: 19.25, tokensEntradaAtual: 3100, tokensEntradaCandidata: 2950, msAtual: 2100, msCandidata: 1900 } } })
          agentesEvolucao[agentId].alteracoes = [
            { id: 'a1', campo: 'prompt', operacao: 'editar', motivo: 'Respostas longas em 14 conversas', estado: 'aplicada', aprendizados: ['respostas-longas'], antes: 'Seja simpático.', depois: 'Seja simpático e responda em até 3 frases.', evidencias: [] },
            { id: 'a2', campo: 'knowledge', operacao: 'adicionar', motivo: 'Equipe informou o prazo em 6 conversas', estado: 'aplicada', aprendizados: ['prazo'], depois: '{"title":"Prazo de entrega","content":"10 dias úteis"}', evidencias: [] },
            { id: 'a3', campo: 'garantia', operacao: 'proposta', motivo: 'Clientes perguntam sobre garantia; não há política nas instruções', estado: 'pendente_aprovacao', protegida: true, area: 'garantia', aprendizados: ['garantia'], evidencias: [] }]
          agentesEvolucao[agentId].versoes = [{ id: 'v2', numero: 2, origem: 'melhoria', resumo: 'Respostas mais curtas', publicadaEm: new Date().toISOString(), conteudo: {} }, { id: 'v1', numero: 1, origem: 'copia', resumo: 'Antes da melhoria', conteudo: {} }]
          agentesEvolucao[agentId].aprendizados = [{ id: 'l1', chave: 'respostas-longas', tipo: 'resposta_longa', titulo: 'Respostas longas demais', frequencia: 14, natureza: 'hipotese', estado: 'aplicado', evidencias: [] },
            { id: 'l2', chave: 'garantia', tipo: 'info_ausente', titulo: 'Clientes perguntam sobre garantia', frequencia: 5, natureza: 'hipotese', estado: 'pendente', area: 'garantia', evidencias: [] }]
        }
      }, 1500)
      return { ok: true, jobId: job.id }
    },
    continuar: async () => ({ ok: true }),
    cancelar: async () => {},
    decidir: async () => ({ ok: true }),
    restaurar: async () => ({ ok: true }),
    salvarConfig: async () => ({}),
    importar: async () => { await espera(); return { lidos: 0, pagamentos: 0, novos: 0 } },
  }
}

/* ---------- Formatação (a mesma do servidor) ---------- */

export function formatar(v, f) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (f === 'moeda') return (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  if (f === 'pct') return `${(n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
  if (f === 'minutos') return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} min`
  if (f === 'creditos') return `${n.toLocaleString('pt-BR', { maximumFractionDigits: n < 10 ? 2 : 0 })} créditos`
  if (f === 'data') { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  if (f === 'texto') return String(v)
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : String(v)
}
