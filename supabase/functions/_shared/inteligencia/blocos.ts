// Blocos de resposta do Vórtex Inteligência, montados a partir das métricas do banco (intel_m_*). A tela só desenha
// estes formatos com os componentes de gráfico do app; nada aqui vem do modelo, então gráfico, card e tabela saem do
// mesmo número. Formatos de valor: moeda (centavos), numero, pct (0 a 1), minutos, creditos.
import type { Periodo } from './periodo.ts'

export type Formato = 'moeda' | 'numero' | 'pct' | 'minutos' | 'creditos' | 'texto' | 'data'
export type Acao =
  | { tipo: 'registros'; registro: 'pedidos' | 'oportunidades' | 'conversas' | 'nao_resolvidas' | 'transferidas'; filtros?: Record<string, unknown>; titulo: string }
  | { tipo: 'perguntar'; texto: string }
  | { tipo: 'abrir'; destino: 'conversa' | 'agente'; id: string }
export type Card = { rotulo: string; valor: number | null; formato: Formato; delta?: number | null; inverter?: boolean; ajuda?: string; acao?: Acao }
export type Bloco =
  | { tipo: 'cards'; titulo?: string; itens: Card[] }
  | { tipo: 'serie'; titulo: string; x: 'dia' | 'semana' | 'mes'; series: { chave: string; rotulo: string; formato: Formato; eixo?: 'direita' }[]; dados: Record<string, unknown>[]; acao?: Acao }
  | { tipo: 'comparacao'; titulo: string; periodos: { atual: string; anterior: string }; itens: { rotulo: string; atual: number | null; anterior: number | null; formato: Formato }[] }
  | { tipo: 'distribuicao'; titulo: string; formato: Formato; itens: { rotulo: string; valor: number; acao?: Acao }[] }
  | { tipo: 'funil'; titulo: string; itens: { rotulo: string; valor: number | null }[] }
  | { tipo: 'tabela'; titulo: string; colunas: { chave: string; rotulo: string; formato?: Formato }[]; linhas: Record<string, unknown>[]; abrir?: 'conversa' | 'agente'; vazio?: string }
  | { tipo: 'recomendacoes'; titulo: string; itens: { texto: string; frequencia?: number; natureza?: string; evidencias?: { conversaId?: string; trecho?: string }[] }[] }
  | { tipo: 'acoes'; itens: { rotulo: string; acao: Acao }[] }
  | { tipo: 'aviso'; texto: string; nivel?: 'info' | 'alerta' }
export type Definicao = { termo: string; texto: string }
export type Pacote = { blocos: Bloco[]; definicoes: Definicao[]; resumo: string[] }

/* ---------- formatação (a mesma da tela, para o resumo e a conferência dos números) ---------- */

export const moeda = (c: number | null | undefined) => (c == null ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
export const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`)
export const num = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }))
export function formatar(v: unknown, f: Formato) {
  const n = v == null ? null : Number(v)
  if (f === 'moeda') return moeda(n)
  if (f === 'pct') return pct(n)
  if (f === 'minutos') return n == null ? '—' : `${num(n)} min`
  if (f === 'creditos') return n == null ? '—' : `${num(n)} créditos`
  if (f === 'texto' || f === 'data') return String(v ?? '—')
  return num(n)
}

// variação % contra o anterior; sem base (anterior 0 ou sem dado), null
export const variacao = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || !b ? null : ((a - b) / Math.abs(b)) * 100)
const n0 = (v: unknown) => (v == null ? null : Number(v))

const STATUS: Record<string, string> = {
  pago: 'Pago', pendente: 'Pendente', recusado: 'Recusado', expirado: 'Expirado', cancelado: 'Cancelado', reembolsado: 'Reembolsado',
  chargeback: 'Chargeback', abandonado: 'Carrinho abandonado',
}
const TIPO_OP: Record<string, string> = { carrinho: 'Carrinho abandonado', pix: 'Pix não pago', cartao_recusado: 'Cartão recusado', boleto: 'Boleto não pago', outro: 'Outro' }
const ORIGEM: Record<string, string> = {
  atendimento: 'Atendimento aos leads', vendas: 'Agente de vendas', teste: 'Teste do agente', verificacao: 'Teste da chave',
  inteligencia: 'Consultas no Vórtex Inteligência', melhoria: 'Análises e melhorias dos agentes', validacao: 'Testes de validação',
}
const METODO: Record<string, string> = { pix: 'Pix', cartao: 'Cartão', boleto: 'Boleto', outro: 'Outro' }

/* ---------- Vendas ---------- */

export function blocosVendas(r: any, p: Periodo, comp?: { r: any; p: Periodo } | null): Pacote {
  if (!r?.disponivel) {
    return { blocos: [{ tipo: 'aviso', nivel: 'alerta', texto: 'Dado indisponível: a empresa ainda não recebeu nenhum pagamento das plataformas (webhooks) nem registrou vendas no CRM.' }],
      definicoes: [], resumo: ['vendas: dado indisponível'] }
  }
  const defs: Definicao[] = []
  const blocos: Bloco[] = []
  const resumo: string[] = []
  if (r.fonte === 'pagamentos') {
    const v = r.pagamentos
    const a = comp?.r?.pagamentos
    blocos.push({ tipo: 'cards', itens: [
      { rotulo: 'Vendas aprovadas', valor: v.aprovadas, formato: 'numero', delta: variacao(v.aprovadas, a?.aprovadas), acao: { tipo: 'registros', registro: 'pedidos', filtros: { status: 'pago' }, titulo: 'Pedidos pagos' } },
      { rotulo: 'Receita aprovada', valor: v.receitaCentavos, formato: 'moeda', delta: variacao(v.receitaCentavos, a?.receitaCentavos) },
      { rotulo: 'Ticket médio', valor: n0(v.ticketMedioCentavos), formato: 'moeda', delta: variacao(n0(v.ticketMedioCentavos), n0(a?.ticketMedioCentavos)) },
      { rotulo: 'Reembolsos e chargebacks', valor: v.reembolsadoCentavos, formato: 'moeda', inverter: true, delta: variacao(v.reembolsadoCentavos, a?.reembolsadoCentavos),
        ajuda: `${v.reembolsos} reembolso(s) e ${v.chargebacks} chargeback(s) registrados no período`, acao: { tipo: 'registros', registro: 'pedidos', filtros: { status: 'reembolsado' }, titulo: 'Reembolsos' } },
      { rotulo: 'Receita líquida', valor: v.liquidoCentavos, formato: 'moeda', delta: variacao(v.liquidoCentavos, a?.liquidoCentavos) },
    ] })
    blocos.push({ tipo: 'serie', titulo: 'Receita aprovada por ' + nomeGran(p.gran), x: p.gran, series: [
      { chave: 'receitaCentavos', rotulo: 'Receita', formato: 'moeda' }, { chave: 'vendas', rotulo: 'Vendas', formato: 'numero', eixo: 'direita' }], dados: v.serie })
    if (comp) blocos.push(comparacao('Comparação', p, comp.p, [
      ['Vendas aprovadas', v.aprovadas, a?.aprovadas, 'numero'], ['Receita aprovada', v.receitaCentavos, a?.receitaCentavos, 'moeda'],
      ['Ticket médio', n0(v.ticketMedioCentavos), n0(a?.ticketMedioCentavos), 'moeda'], ['Receita líquida', v.liquidoCentavos, a?.liquidoCentavos, 'moeda']]))
    if (v.porStatus?.length) blocos.push({ tipo: 'distribuicao', titulo: 'Pedidos abertos no período, por status', formato: 'numero',
      itens: v.porStatus.map((s: any) => ({ rotulo: STATUS[s.status] || s.status, valor: s.pedidos, acao: { tipo: 'registros', registro: 'pedidos', filtros: { status: s.status }, titulo: `Pedidos: ${STATUS[s.status] || s.status}` } })) })
    if (v.porProduto?.length) blocos.push({ tipo: 'tabela', titulo: 'Vendas por produto', colunas: [
      { chave: 'produto', rotulo: 'Produto' }, { chave: 'vendas', rotulo: 'Vendas', formato: 'numero' }, { chave: 'receitaCentavos', rotulo: 'Receita', formato: 'moeda' }], linhas: v.porProduto })
    if (v.porMetodo?.length > 1) blocos.push({ tipo: 'distribuicao', titulo: 'Vendas por forma de pagamento', formato: 'numero', itens: v.porMetodo.map((m: any) => ({ rotulo: METODO[m.metodo] || m.metodo, valor: m.vendas })) })
    if (v.semValor) blocos.push({ tipo: 'aviso', texto: `${v.semValor} venda(s) aprovada(s) vieram sem valor da plataforma e não entram na receita.` })
    if (v.outrasMoedas) blocos.push({ tipo: 'aviso', texto: `${v.outrasMoedas} venda(s) em outra moeda ficaram fora da soma em reais.` })
    if (r.crm?.vendas) blocos.push({ tipo: 'aviso', texto: `Há também ${r.crm.vendas} venda(s) registradas no CRM no período (${moeda(r.crm.receitaCentavos)}). Elas não são somadas aos pagamentos porque a mesma venda costuma estar nos dois.` })
    blocos.push({ tipo: 'acoes', itens: [
      { rotulo: 'Ver pedidos pagos', acao: { tipo: 'registros', registro: 'pedidos', filtros: { status: 'pago' }, titulo: 'Pedidos pagos' } },
      ...(comp ? [] : [{ rotulo: 'Comparar com o período anterior', acao: { tipo: 'perguntar', texto: 'Compare com o período anterior.' } as Acao }]),
      { rotulo: 'Ver oportunidades pendentes', acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'pendente' }, titulo: 'Oportunidades pendentes' } }] })
    defs.push(
      { termo: 'Venda aprovada', texto: 'Pedido com pagamento confirmado pela plataforma (data da aprovação no período). Cada pedido conta uma vez, mesmo com várias tentativas de pagamento.' },
      { termo: 'Receita aprovada', texto: 'Soma do valor cobrado dos pedidos aprovados no período, em reais.' },
      { termo: 'Receita líquida', texto: 'Receita aprovada no período menos os reembolsos e chargebacks registrados no período.' })
    resumo.push(`vendas aprovadas ${v.aprovadas}, receita ${moeda(v.receitaCentavos)}, ticket médio ${moeda(n0(v.ticketMedioCentavos))}, reembolsos ${moeda(v.reembolsadoCentavos)}, líquido ${moeda(v.liquidoCentavos)}`)
  } else {
    const v = r.crm
    const a = comp?.r?.crm
    blocos.push({ tipo: 'cards', itens: [
      { rotulo: 'Vendas registradas', valor: v.vendas, formato: 'numero', delta: variacao(v.vendas, a?.vendas) },
      { rotulo: 'Valor registrado', valor: v.receitaCentavos, formato: 'moeda', delta: variacao(v.receitaCentavos, a?.receitaCentavos) }] })
    blocos.push({ tipo: 'serie', titulo: 'Vendas registradas por ' + nomeGran(p.gran), x: p.gran, series: [
      { chave: 'receitaCentavos', rotulo: 'Valor', formato: 'moeda' }, { chave: 'vendas', rotulo: 'Vendas', formato: 'numero', eixo: 'direita' }], dados: v.serie })
    if (comp) blocos.push(comparacao('Comparação', p, comp.p, [['Vendas registradas', v.vendas, a?.vendas, 'numero'], ['Valor registrado', v.receitaCentavos, a?.receitaCentavos, 'moeda']]))
    blocos.push({ tipo: 'aviso', texto: 'Sem plataforma de pagamento conectada: os números são as vendas registradas no CRM (bloco Venda aprovada, habilidade do agente ou lançamento manual), não pagamentos confirmados.' })
    defs.push({ termo: 'Venda registrada', texto: 'Venda lançada no CRM (tabela de vendas do Início), sem confirmação de pagamento pela plataforma.' })
    resumo.push(`vendas registradas no CRM ${v.vendas}, valor ${moeda(v.receitaCentavos)}`)
  }
  return { blocos, definicoes: defs, resumo }
}

/* ---------- Recuperação ---------- */

export function blocosRecuperacao(r: any, p: Periodo, comp?: { r: any; p: Periodo } | null): Pacote {
  if (!r?.disponivel) return { blocos: [{ tipo: 'aviso', nivel: 'alerta', texto: `Dado indisponível: ${r?.motivo || 'sem pedidos das plataformas de pagamento.'} Conecte o webhook da plataforma (Kiwify, Hotmart, Vórtex Pay) em Webhooks de entrada.` }], definicoes: [], resumo: ['recuperação: dado indisponível'] }
  const a = comp?.r
  const g = r.regras || {}
  const blocos: Bloco[] = [
    { tipo: 'cards', itens: [
      { rotulo: 'Oportunidades', valor: r.oportunidades, formato: 'numero', delta: variacao(r.oportunidades, a?.oportunidades), inverter: true, acao: { tipo: 'registros', registro: 'oportunidades', titulo: 'Oportunidades' } },
      { rotulo: 'Vendas recuperadas', valor: r.recuperadas, formato: 'numero', delta: variacao(r.recuperadas, a?.recuperadas), acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'recuperada' }, titulo: 'Vendas recuperadas' } },
      { rotulo: 'Receita recuperada', valor: r.receitaRecuperadaCentavos, formato: 'moeda', delta: variacao(r.receitaRecuperadaCentavos, a?.receitaRecuperadaCentavos) },
      { rotulo: 'Taxa de recuperação', valor: n0(r.taxaRecuperacao), formato: 'pct', delta: variacao(n0(r.taxaRecuperacao), n0(a?.taxaRecuperacao)) },
      { rotulo: 'Compraram após contato', valor: r.compraAposContato, formato: 'numero', ajuda: 'Inclui quem pagou antes da carência ou fora da janela de atribuição' },
      { rotulo: 'Valor potencial não convertido', valor: r.valorPotencialCentavos, formato: 'moeda', inverter: true,
        ajuda: `${r.naoConvertidas} oportunidade(s) sem pagamento. É valor que poderia entrar, não prejuízo confirmado.${r.valorPotencialEstimadoCentavos ? ` Mais ${moeda(r.valorPotencialEstimadoCentavos)} estimados pelo preço médio de ${r.valorPotencialEstimados} carrinho(s) sem valor.` : ''}`,
        acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'pendente' }, titulo: 'Oportunidades pendentes' } },
    ] },
    { tipo: 'serie', titulo: 'Oportunidades e recuperações por ' + nomeGran(p.gran), x: p.gran, series: [
      { chave: 'oportunidades', rotulo: 'Oportunidades', formato: 'numero' }, { chave: 'recuperadas', rotulo: 'Recuperadas', formato: 'numero' }], dados: r.serie },
  ]
  if (comp) blocos.push(comparacao('Comparação', p, comp.p, [
    ['Oportunidades', r.oportunidades, a?.oportunidades, 'numero'], ['Vendas recuperadas', r.recuperadas, a?.recuperadas, 'numero'],
    ['Receita recuperada', r.receitaRecuperadaCentavos, a?.receitaRecuperadaCentavos, 'moeda'], ['Taxa de recuperação', n0(r.taxaRecuperacao), n0(a?.taxaRecuperacao), 'pct']]))
  if (r.porTipo?.length) blocos.push({ tipo: 'tabela', titulo: 'Por tipo de oportunidade', colunas: [
    { chave: 'tipo', rotulo: 'Tipo' }, { chave: 'oportunidades', rotulo: 'Oportunidades', formato: 'numero' }, { chave: 'convertidas', rotulo: 'Pagaram', formato: 'numero' },
    { chave: 'recuperadas', rotulo: 'Recuperadas', formato: 'numero' }], linhas: r.porTipo.map((t: any) => ({ ...t, tipo: TIPO_OP[t.tipo] || t.tipo })) })
  blocos.push({ tipo: 'cards', titulo: 'Pix', itens: [
    { rotulo: 'Pedidos com Pix gerado', valor: r.pix.gerados, formato: 'numero' }, { rotulo: 'Pagos', valor: r.pix.pagos, formato: 'numero' },
    { rotulo: 'Pessoas que geraram Pix e não pagaram', valor: r.pix.pessoasSemPagar, formato: 'numero', inverter: true, acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'pendente', tipo: 'pix' }, titulo: 'Pix não pagos' } },
    { rotulo: 'Pix ainda válidos', valor: r.pix.pendentes, formato: 'numero' }, { rotulo: 'Pix vencidos', valor: r.pix.expirados, formato: 'numero' }] })
  blocos.push({ tipo: 'cards', titulo: 'Carrinhos', itens: [
    { rotulo: 'Carrinhos abandonados', valor: r.carrinhos.abandonados, formato: 'numero', acao: { tipo: 'registros', registro: 'oportunidades', filtros: { tipo: 'carrinho' }, titulo: 'Carrinhos abandonados' } },
    { rotulo: 'Compraram depois', valor: r.carrinhos.convertidos, formato: 'numero' }] })
  blocos.push({ tipo: 'acoes', itens: [
    { rotulo: 'Ver oportunidades pendentes', acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'pendente' }, titulo: 'Oportunidades pendentes' } },
    { rotulo: 'Pendentes sem nenhum contato', acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'sem_contato' }, titulo: 'Sem contato da empresa' } },
    { rotulo: 'Ver vendas recuperadas', acao: { tipo: 'registros', registro: 'oportunidades', filtros: { status: 'recuperada' }, titulo: 'Vendas recuperadas' } }] })
  const defs: Definicao[] = [
    { termo: 'Oportunidade', texto: `Cliente + produto com carrinho abandonado, cartão recusado ou Pix/boleto não pago que não pagou em ${g.carenciaMinutos ?? 30} min. Várias tentativas da mesma pessoa contam uma vez. Pix pago na hora não é oportunidade.` },
    { termo: 'Venda recuperada', texto: `Oportunidade paga depois de uma mensagem da empresa (IA, fluxo ou equipe), mais de ${g.carenciaMinutos ?? 30} min após o início e até ${g.janelaHoras ?? 72} h depois do último contato.` },
    { termo: 'Comprou após contato', texto: 'Pagou depois de receber alguma mensagem da empresa, sem as regras de tempo da atribuição.' },
    { termo: 'Valor potencial não convertido', texto: `Maior valor informado de cada oportunidade sem pagamento até ${g.conversaoDias ?? 30} dias. Não é prejuízo confirmado.` },
  ]
  return { blocos, definicoes: defs, resumo: [`oportunidades ${r.oportunidades}, recuperadas ${r.recuperadas} (${moeda(r.receitaRecuperadaCentavos)}), taxa de recuperação ${pct(n0(r.taxaRecuperacao))}, pagaram depois do contato ${r.compraAposContato}, não convertidas ${r.naoConvertidas} com valor potencial de ${moeda(r.valorPotencialCentavos)}, Pix gerados ${r.pix.gerados} (pagos ${r.pix.pagos}, pessoas sem pagar ${r.pix.pessoasSemPagar}), carrinhos abandonados ${r.carrinhos.abandonados}`] }
}

/* ---------- Atendimento ---------- */

export function blocosSuporte(r: any, p: Periodo, comp?: { r: any; p: Periodo } | null): Pacote {
  const a = comp?.r
  const desde = r.eventosDesde ? new Date(r.eventosDesde) : null
  const parcial = desde && desde > new Date(p.de)
  const blocos: Bloco[] = [
    { tipo: 'cards', itens: [
      { rotulo: 'Conversas com clientes', valor: r.conversas, formato: 'numero', delta: variacao(r.conversas, a?.conversas), acao: { tipo: 'registros', registro: 'conversas', titulo: 'Conversas do período' } },
      { rotulo: 'Atendidas pela IA', valor: r.conversasComIa, formato: 'numero', delta: variacao(r.conversasComIa, a?.conversasComIa) },
      { rotulo: 'Transferências da IA', valor: r.transferenciasIa, formato: 'numero', inverter: true, delta: variacao(r.transferenciasIa, a?.transferenciasIa), acao: { tipo: 'registros', registro: 'transferidas', titulo: 'Conversas transferidas pela IA' } },
      { rotulo: 'A IA não resolveu', valor: r.iaNaoResolveu, formato: 'numero', inverter: true, delta: variacao(r.iaNaoResolveu, a?.iaNaoResolveu), acao: { tipo: 'registros', registro: 'nao_resolvidas', titulo: 'Conversas que a IA não resolveu' } },
      { rotulo: '1ª resposta (mediana)', valor: n0(r.primeiraRespostaMedianaMin), formato: 'minutos', inverter: true, delta: variacao(n0(r.primeiraRespostaMedianaMin), n0(a?.primeiraRespostaMedianaMin)) },
      { rotulo: 'Esperando resposta há +1 h', valor: r.semResposta, formato: 'numero', inverter: true },
      { rotulo: 'Concluídos', valor: parcial && !r.concluidos ? null : r.concluidos, formato: 'numero', ajuda: desde ? `Registrado desde ${desde.toLocaleDateString('pt-BR')}` : undefined },
      { rotulo: 'Reabertos', valor: parcial && !r.reabertos ? null : r.reabertos, formato: 'numero', inverter: true },
    ] },
    { tipo: 'serie', titulo: 'Conversas e transferências por ' + nomeGran(p.gran), x: p.gran, series: [
      { chave: 'conversas', rotulo: 'Conversas', formato: 'numero' }, { chave: 'transferencias', rotulo: 'Transferências da IA', formato: 'numero' }], dados: r.serie },
  ]
  if (comp) blocos.push(comparacao('Comparação', p, comp.p, [
    ['Conversas', r.conversas, a?.conversas, 'numero'], ['Atendidas pela IA', r.conversasComIa, a?.conversasComIa, 'numero'],
    ['Transferências da IA', r.transferenciasIa, a?.transferenciasIa, 'numero'], ['A IA não resolveu', r.iaNaoResolveu, a?.iaNaoResolveu, 'numero'],
    ['1ª resposta (mediana)', n0(r.primeiraRespostaMedianaMin), n0(a?.primeiraRespostaMedianaMin), 'minutos']]))
  if (r.motivosTransferencia?.length) blocos.push({ tipo: 'distribuicao', titulo: 'Por que a IA não resolveu', formato: 'numero', itens: r.motivosTransferencia.map((m: any) => ({ rotulo: m.motivo, valor: m.n })) })
  if (r.porAgente?.length) blocos.push({ tipo: 'tabela', titulo: 'Por agente', abrir: 'agente', colunas: [
    { chave: 'agente', rotulo: 'Agente' }, { chave: 'execucoes', rotulo: 'Execuções', formato: 'numero' }, { chave: 'respondeu', rotulo: 'Respondeu', formato: 'numero' },
    { chave: 'transferiu', rotulo: 'Transferiu', formato: 'numero' }, { chave: 'erros', rotulo: 'Erros', formato: 'numero' }], linhas: r.porAgente.map((x: any) => ({ ...x, id: x.agenteId })) })
  blocos.push({ tipo: 'cards', titulo: 'Mensagens', itens: [
    { rotulo: 'Dos clientes', valor: r.mensagensClientes, formato: 'numero' }, { rotulo: 'Da IA', valor: r.mensagensIa, formato: 'numero' },
    { rotulo: 'Da equipe', valor: r.mensagensEquipe, formato: 'numero' }, { rotulo: 'Tamanho médio da resposta da IA', valor: n0(r.tamanhoMedioRespostaIa), formato: 'numero', ajuda: 'caracteres por mensagem' }] })
  if (parcial) blocos.push({ tipo: 'aviso', texto: `Concluídos, reabertos, "a IA não resolveu" e assumidos pela equipe são registrados desde ${desde!.toLocaleDateString('pt-BR')}; antes disso esses dados não existem (não é zero).` })
  blocos.push({ tipo: 'acoes', itens: [
    { rotulo: 'Abrir conversas que a IA não resolveu', acao: { tipo: 'registros', registro: 'nao_resolvidas', titulo: 'A IA não resolveu' } },
    { rotulo: 'Quais dúvidas os clientes mais tiveram?', acao: { tipo: 'perguntar', texto: 'Quais dúvidas os clientes mais tiveram nesse período?' } }] })
  return {
    blocos,
    definicoes: [
      { termo: 'Conversa', texto: 'Atendimento com pelo menos uma mensagem do cliente no período (com o filtro de agente, só as que o agente respondeu).' },
      { termo: 'Transferência da IA', texto: 'Execução do agente que passou a conversa para a equipe (registro do Uso da IA).' },
      { termo: 'A IA não resolveu', texto: 'Conversa que foi para Aguardando porque a IA transferiu, prometeu um atendente, deu erro ou ficou sem responder.' },
      { termo: '1ª resposta', texto: 'Tempo entre a primeira mensagem do cliente e a primeira resposta (IA ou equipe) nas conversas novas do período.' },
    ],
    resumo: [`conversas ${r.conversas}, atendidas pela IA ${r.conversasComIa}, transferências da IA ${r.transferenciasIa}, a IA não resolveu ${r.iaNaoResolveu}, primeira resposta mediana ${r.primeiraRespostaMedianaMin ?? '—'} min, esperando resposta ${r.semResposta}, concluídos ${r.concluidos}, reabertos ${r.reabertos}`],
  }
}

/* ---------- Funil ---------- */

export function blocosFunil(r: any): Pacote {
  const etapas = (r.etapas || []) as { etapa: string; n: number | null }[]
  const blocos: Bloco[] = [{ tipo: 'funil', titulo: 'Funil do período', itens: etapas.map((e) => ({ rotulo: e.etapa, valor: e.n })) }]
  // maior queda entre etapas consecutivas com dado
  let pior: { de: string; para: string; queda: number } | null = null
  for (let i = 1; i < etapas.length; i++) {
    const a = etapas[i - 1].n, b = etapas[i].n
    if (a && b != null && a > 0) {
      const q = 1 - b / a
      if (!pior || q > pior.queda) pior = { de: etapas[i - 1].etapa, para: etapas[i].etapa, queda: q }
    }
  }
  if (pior) blocos.push({ tipo: 'aviso', texto: `Maior queda: de "${pior.de}" para "${pior.para}" (${pct(pior.queda)} não seguiram).` })
  if (!r.pagamentosDisponiveis) blocos.push({ tipo: 'aviso', texto: 'Compra: dado indisponível sem plataforma de pagamento conectada (webhooks de entrada).' })
  for (const k of r.kanban || []) {
    blocos.push({ tipo: 'tabela', titulo: `Kanban · ${k.quadro}`, colunas: [{ chave: 'coluna', rotulo: 'Etapa' }, { chave: 'negocios', rotulo: 'Negócios agora', formato: 'numero' },
      { chave: 'entradas', rotulo: 'Entraram no período', formato: 'numero' }], linhas: k.colunas })
  }
  if (r.origens?.length) blocos.push({ tipo: 'distribuicao', titulo: 'Leads por origem', formato: 'numero', itens: r.origens.map((o: any) => ({ rotulo: o.origem, valor: o.leads })) })
  return {
    blocos,
    definicoes: [{ termo: 'Funil', texto: 'Volume de cada etapa dentro do período (não acompanha as mesmas pessoas do começo ao fim). "Entraram no período" no Kanban conta desde o início da coleta.' }],
    resumo: [etapas.map((e) => `${e.etapa}: ${e.n ?? 'indisponível'}`).join(', ') + (pior ? `; maior queda de ${pior.de} para ${pior.para} (${pct(pior.queda)})` : '')],
  }
}

/* ---------- Consumo de IA ---------- */

export function blocosConsumo(r: any, p: Periodo, comp?: { r: any; p: Periodo } | null): Pacote {
  const reais = (c: number) => Math.round(Number(c || 0) * Number(r.creditoReais || 0.01) * 100) // centavos
  const blocos: Bloco[] = []
  if (r.carteira) {
    blocos.push({ tipo: 'cards', itens: [
      { rotulo: 'Créditos de IA usados', valor: Number(r.creditos), formato: 'creditos', inverter: true, delta: variacao(Number(r.creditos), comp ? Number(comp.r.creditos) : null) },
      { rotulo: 'Em reais', valor: reais(r.creditos), formato: 'moeda', inverter: true },
      { rotulo: 'Operações', valor: r.operacoes, formato: 'numero' }] })
    blocos.push({ tipo: 'serie', titulo: 'Créditos por ' + nomeGran(p.gran), x: p.gran, series: [{ chave: 'creditos', rotulo: 'Créditos', formato: 'creditos' }], dados: r.serie })
    if (r.porOrigem?.length) blocos.push({ tipo: 'distribuicao', titulo: 'Por uso', formato: 'creditos', itens: r.porOrigem.map((o: any) => ({ rotulo: ORIGEM[o.origem] || o.origem, valor: Number(o.creditos) })) })
    if (r.porAgente?.length) blocos.push({ tipo: 'tabela', titulo: 'Por agente', colunas: [{ chave: 'agente', rotulo: 'Agente' }, { chave: 'creditos', rotulo: 'Créditos', formato: 'creditos' },
      { chave: 'operacoes', rotulo: 'Operações', formato: 'numero' }], linhas: r.porAgente })
  } else {
    blocos.push({ tipo: 'aviso', texto: 'A empresa usa a própria chave de IA (sem Créditos de IA): o custo é pago direto ao provedor. Abaixo, os tokens e o custo estimado pela tabela de preços.' })
  }
  const t = r.tokens || {}
  const mod = (t.modulo || []) as any[]
  blocos.push({ tipo: 'tabela', titulo: 'Tokens por uso (todas as chaves)', colunas: [{ chave: 'uso', rotulo: 'Uso' }, { chave: 'chamadas', rotulo: 'Chamadas', formato: 'numero' },
    { chave: 'entrada', rotulo: 'Tokens de entrada', formato: 'numero' }, { chave: 'saida', rotulo: 'Tokens de saída', formato: 'numero' }, { chave: 'custo', rotulo: 'Custo estimado (US$)', formato: 'texto' }],
    linhas: [
      { uso: ORIGEM.atendimento, chamadas: t.atendimento?.execucoes ?? 0, entrada: t.atendimento?.entrada ?? 0, saida: t.atendimento?.saida ?? 0, custo: usd(t.atendimento?.custoEstimadoUsd) },
      ...mod.map((m) => ({ uso: ORIGEM[m.origem] || m.origem, chamadas: m.chamadas, entrada: m.entrada, saida: m.saida, custo: usd(m.custoEstimadoUsd) }))] })
  return {
    blocos,
    definicoes: [
      { termo: 'Créditos de IA', texto: 'Consumo da IA da plataforma descontado da carteira (1 crédito = R$ ' + Number(r.creditoReais || 0.01).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ').' },
      { termo: 'Custo estimado', texto: 'Tokens × preço de tabela do modelo. Com a chave própria, a cobrança real é a do provedor.' }],
    resumo: [r.carteira ? `créditos usados ${num(Number(r.creditos))} (${moeda(reais(r.creditos))}), operações ${r.operacoes}` : 'empresa sem carteira de créditos; tokens do atendimento ' + (t.atendimento?.entrada ?? 0)],
  }
}
const usd = (v: unknown) => (v == null ? '—' : `US$ ${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}`)

/* ---------- Dúvidas e melhorias ---------- */

export function blocosDuvidas(r: any): Pacote {
  const blocos: Bloco[] = []
  if (r.aprendizados?.length) blocos.push({ tipo: 'recomendacoes', titulo: 'Dúvidas e lacunas encontradas pelas análises dos agentes',
    itens: r.aprendizados.map((l: any) => ({ texto: `${l.titulo}${l.agente ? ` (${l.agente})` : ''}`, frequencia: l.frequencia, natureza: l.natureza })) })
  if (r.perguntas?.length) blocos.push({ tipo: 'tabela', titulo: 'Perguntas dos clientes que mais se repetiram', abrir: 'conversa', colunas: [{ chave: 'pergunta', rotulo: 'Exemplo de pergunta' }, { chave: 'vezes', rotulo: 'Conversas', formato: 'numero' }],
    linhas: r.perguntas.map((x: any) => ({ ...x, id: x.conversas?.[0] })) })
  if (!blocos.length) blocos.push({ tipo: 'aviso', texto: r.podeVerConversas ? 'Nenhuma pergunta se repetiu em duas ou mais conversas no período, e ainda não há análise dos agentes ("Melhorar agente").' : 'Ainda não há análise dos agentes. Ver as perguntas das conversas exige a permissão de visualizar conversas.' })
  return {
    blocos,
    definicoes: [{ termo: 'Pergunta repetida', texto: 'Mensagens de clientes com "?" agrupadas pelo começo do texto, em duas ou mais conversas. As dúvidas dos agentes vêm da base consolidada do "Melhorar agente".' }],
    resumo: [`${(r.aprendizados || []).length} dúvidas consolidadas; ${(r.perguntas || []).length} perguntas repetidas` + ((r.aprendizados || []).slice(0, 5).map((l: any) => `; "${l.titulo}" em ${l.frequencia} conversas`).join(''))],
  }
}

export function blocosRegistros(r: any, titulo: string): Bloco {
  const linhas = r.linhas || []
  if (r.tipo === 'pedidos') return { tipo: 'tabela', titulo, abrir: 'conversa', vazio: 'Nenhum pedido.', colunas: [
    { chave: 'quando', rotulo: 'Quando', formato: 'data' }, { chave: 'cliente', rotulo: 'Cliente' }, { chave: 'produto', rotulo: 'Produto' }, { chave: 'status', rotulo: 'Status' },
    { chave: 'metodo', rotulo: 'Pagamento' }, { chave: 'valorCentavos', rotulo: 'Valor', formato: 'moeda' }],
    linhas: linhas.map((l: any) => ({ ...l, id: l.conversaId, quando: l.pagoEm || l.abertoEm, status: STATUS[l.status] || l.status, metodo: METODO[l.metodo] || l.metodo || '—' })) }
  if (r.tipo === 'oportunidades') return { tipo: 'tabela', titulo, abrir: 'conversa', vazio: 'Nenhuma oportunidade.', colunas: [
    { chave: 'inicio', rotulo: 'Início', formato: 'data' }, { chave: 'cliente', rotulo: 'Cliente' }, { chave: 'tipo', rotulo: 'Tipo' }, { chave: 'produto', rotulo: 'Produto' },
    { chave: 'valorCentavos', rotulo: 'Valor', formato: 'moeda' }, { chave: 'situacao', rotulo: 'Situação' }, { chave: 'contato', rotulo: 'Contato da empresa' }],
    linhas: linhas.map((l: any) => ({ ...l, id: l.conversaId, tipo: TIPO_OP[l.tipo] || l.tipo, cliente: l.cliente || '(sem contato no CRM)',
      situacao: l.situacao === 'recuperada' ? 'Recuperada' : l.situacao === 'convertida' ? 'Pagou' : 'Pendente', contato: l.comContato ? 'Sim' : 'Não',
      valorCentavos: l.valorCentavos, produto: l.produto || '—' })) }
  return { tipo: 'tabela', titulo, abrir: 'conversa', vazio: 'Nenhuma conversa.', colunas: [
    { chave: 'ultimaMensagemEm', rotulo: 'Última mensagem', formato: 'data' }, { chave: 'cliente', rotulo: 'Cliente' }, { chave: 'agente', rotulo: 'Agente' },
    { chave: 'motivo', rotulo: 'Motivo' }, { chave: 'ultimaMensagem', rotulo: 'Mensagem' }],
    linhas: linhas.map((l: any) => ({ ...l, id: l.conversaId, agente: l.agente || '—', motivo: l.motivo || '—' })) }
}

/* ---------- Evolução de um agente (perguntas sobre as melhorias) ---------- */

export function blocosEvolucao(ev: any, agente: { id: string; nome: string }): Pacote {
  const blocos: Bloco[] = []
  const ativa = (ev.versoes || []).find((v: any) => v.publicadaEm)
  const alt = (ev.alteracoes || []) as any[]
  const aplicadas = alt.filter((c) => c.estado === 'aplicada' || c.estado === 'aprovada')
  const pendentes = alt.filter((c) => ['pendente_aprovacao', 'revisao', 'bloqueada'].includes(c.estado))
  blocos.push({ tipo: 'cards', itens: [
    { rotulo: 'Versão ativa', valor: ativa?.numero ?? null, formato: 'numero', ajuda: ativa ? `publicada em ${new Date(ativa.publicadaEm).toLocaleString('pt-BR')}` : 'nenhuma versão publicada pelo Vórtex Inteligência', acao: { tipo: 'abrir', destino: 'agente', id: agente.id } },
    { rotulo: 'Alterações aplicadas', valor: aplicadas.length, formato: 'numero' },
    { rotulo: 'Pendentes de aprovação ou revisão', valor: pendentes.length, formato: 'numero', inverter: true },
    { rotulo: 'Problemas em aberto', valor: (ev.aprendizados || []).filter((l: any) => l.estado === 'aberto' || l.estado === 'pendente').length, formato: 'numero', inverter: true }] })
  if (aplicadas.length) blocos.push({ tipo: 'tabela', titulo: 'O que mudou', colunas: [{ chave: 'campo', rotulo: 'Onde' }, { chave: 'operacao', rotulo: 'Mudança' }, { chave: 'motivo', rotulo: 'Por quê' }, { chave: 'quando', rotulo: 'Quando', formato: 'data' }],
    linhas: aplicadas.slice(0, 15).map((c) => ({ campo: CAMPO[c.campo] || c.campo, operacao: c.operacao, motivo: c.motivo, quando: c.decididoEm || c.criadaEm })) })
  if (pendentes.length) blocos.push({ tipo: 'tabela', titulo: 'Pendentes', colunas: [{ chave: 'campo', rotulo: 'Onde' }, { chave: 'motivo', rotulo: 'Proposta' }, { chave: 'estado', rotulo: 'Situação' }],
    linhas: pendentes.slice(0, 15).map((c) => ({ campo: CAMPO[c.campo] || c.area || c.campo, motivo: c.motivo, estado: c.estado === 'pendente_aprovacao' ? 'Aguarda aprovação' : c.bloqueio || 'Em revisão' })) })
  const d = ev.desempenho
  if (d) {
    const tx = (x: any) => n0(x?.taxaTransferencia)
    blocos.push({ tipo: 'comparacao', titulo: 'Antes e depois da última publicação (até 14 dias de cada lado)', periodos: { atual: 'Depois', anterior: 'Antes' }, itens: [
      { rotulo: 'Execuções', atual: d.depois?.execucoes ?? null, anterior: d.antes?.execucoes ?? null, formato: 'numero' },
      { rotulo: 'Taxa de transferência', atual: tx(d.depois), anterior: tx(d.antes), formato: 'pct' },
      { rotulo: 'A IA não resolveu', atual: d.depois?.iaNaoResolveu ?? null, anterior: d.antes?.iaNaoResolveu ?? null, formato: 'numero' },
      { rotulo: 'Tokens de entrada por execução', atual: n0(d.depois?.tokensEntradaMedia), anterior: n0(d.antes?.tokensEntradaMedia), formato: 'numero' },
      { rotulo: 'Erros', atual: d.depois?.erros ?? null, anterior: d.antes?.erros ?? null, formato: 'numero' }] })
    blocos.push({ tipo: 'aviso', texto: 'Mudanças de tráfego, oferta e perfil dos clientes também mexem nesses números: a comparação mostra tendência, não prova que a versão nova causou a diferença.' })
  }
  blocos.push({ tipo: 'acoes', itens: [{ rotulo: 'Abrir a Evolução dos Agentes', acao: { tipo: 'abrir', destino: 'agente', id: agente.id } }] })
  return {
    blocos,
    definicoes: [{ termo: 'Versão', texto: 'Cópia das instruções e do conhecimento do agente guardada antes e depois de cada mudança; dá para restaurar qualquer uma.' }],
    resumo: [`agente ${agente.nome}: versão ativa ${ativa?.numero ?? 'nenhuma'}, ${aplicadas.length} alterações aplicadas, ${pendentes.length} pendentes; ` +
      aplicadas.slice(0, 6).map((c) => `${CAMPO[c.campo] || c.campo}: ${c.motivo}`).join('; ') + (pendentes.length ? '; pendentes: ' + pendentes.slice(0, 4).map((c) => c.motivo).join('; ') : '')
      + (d ? `; taxa de transferência antes ${pct(tx2(d.antes))} e depois ${pct(tx2(d.depois))}` : '')],
  }
}
const tx2 = (x: any) => n0(x?.taxaTransferencia)
export const CAMPO: Record<string, string> = {
  prompt: 'Instruções', examples: 'Exemplos de respostas', rules: 'Regras do negócio', tone: 'Tom de voz', does: 'Função', audience: 'Público',
  knowledge: 'Conhecimento', settings: 'Configurações', skills: 'Habilidades', files: 'Arquivos', modelo: 'Modelo de IA',
}

/* ---------- utilitários ---------- */

const nomeGran = (g: string) => (g === 'semana' ? 'semana' : g === 'mes' ? 'mês' : 'dia')

function comparacao(titulo: string, p: Periodo, q: Periodo, itens: [string, number | null | undefined, number | null | undefined, Formato][]): Bloco {
  return { tipo: 'comparacao', titulo, periodos: { atual: p.rotulo, anterior: q.rotulo }, itens: itens.map(([rotulo, atual, anterior, formato]) => ({ rotulo, atual: atual ?? null, anterior: anterior ?? null, formato })) }
}

// Todos os números que a resposta pode citar: os valores dos blocos e as formas como aparecem (reais, %, variação).
export function numerosDosBlocos(blocos: Bloco[]): number[] {
  const out: number[] = []
  const add = (v: unknown, f: Formato = 'numero') => {
    if (v == null || v === '' || typeof v === 'boolean') return
    const n = Number(v)
    if (!Number.isFinite(n)) return
    if (f === 'moeda') out.push(n / 100)
    else if (f === 'pct') out.push(n * 100)
    else out.push(n)
  }
  for (const b of blocos) {
    if (b.tipo === 'cards') for (const c of b.itens) { add(c.valor, c.formato); if (c.delta != null) out.push(c.delta, Math.abs(c.delta)); for (const x of textoNumeros(c.ajuda || '')) out.push(x) }
    else if (b.tipo === 'serie') for (const d of b.dados) for (const s of b.series) add(d[s.chave], s.formato)
    else if (b.tipo === 'comparacao') for (const i of b.itens) {
      add(i.atual, i.formato); add(i.anterior, i.formato)
      const dv = variacao(i.atual, i.anterior)
      if (dv != null) out.push(dv, Math.abs(dv))
      if (i.atual != null && i.anterior != null) add(i.atual - i.anterior, i.formato), add(Math.abs(i.atual - i.anterior), i.formato)
    }
    else if (b.tipo === 'distribuicao') { let tot = 0; for (const i of b.itens) { add(i.valor, b.formato); tot += Number(i.valor) || 0 }; add(tot, b.formato); for (const i of b.itens) if (tot) out.push((i.valor / tot) * 100) }
    else if (b.tipo === 'funil') { for (const i of b.itens) add(i.valor); for (let k = 1; k < b.itens.length; k++) { const a = b.itens[k - 1].valor, c = b.itens[k].valor; if (a && c != null) out.push((c / a) * 100, (1 - c / a) * 100) } }
    else if (b.tipo === 'tabela') for (const l of b.linhas) for (const c of b.colunas) if (c.formato && c.formato !== 'data' && c.formato !== 'texto') add(l[c.chave], c.formato); else for (const x of textoNumeros(String(l[c.chave] ?? ''))) out.push(x)
    else if (b.tipo === 'recomendacoes') for (const i of b.itens) { if (i.frequencia != null) out.push(i.frequencia); for (const x of textoNumeros(i.texto)) out.push(x) }
    else if (b.tipo === 'aviso') for (const x of textoNumeros(b.texto)) out.push(x)
  }
  return out
}

// Números escritos num texto em português ("R$ 1.234,56", "12,5%", "1234.5"), sem datas e horários.
export function textoNumeros(texto: string): number[] {
  const limpo = String(texto || '')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}h\d{0,2}\b/gi, ' ')
  const out: number[] = []
  for (const m of limpo.matchAll(/-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?(?:\.\d+)?/g)) {
    let s = m[0]
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
    const n = Number(s)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

// Números do texto da IA que não batem com nenhum valor permitido (tolerância de arredondamento). Inteiros pequenos
// (até 12, como "3 sugestões"), anos e números da pergunta do cliente passam.
export function numerosSemFonte(texto: string, permitidos: number[], extras: string[] = []): number[] {
  const livres = new Set(extras.flatMap(textoNumeros).map((n) => Math.abs(n)))
  return textoNumeros(texto).filter((n) => {
    const a = Math.abs(n)
    if (Number.isInteger(a) && a <= 12) return false
    if (Number.isInteger(a) && a >= 2000 && a <= 2100) return false
    if (livres.has(a)) return false
    return !permitidos.some((p) => {
      const b = Math.abs(p)
      return Math.abs(a - b) <= Math.max(0.051, b * 0.005) || Math.round(b) === a || Math.round(b * 10) / 10 === a
    })
  })
}
