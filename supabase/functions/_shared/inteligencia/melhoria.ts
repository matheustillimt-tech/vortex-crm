// "Melhorar agente": execução em segundo plano, em etapas que continuam de onde pararam (cada rodada da função
// inteligencia pega a execução da fila, trabalha até o prazo e guarda o cursor).
//   preparar   → conversas do agente (vínculo explícito) que ainda não foram analisadas ou mudaram desde a última análise
//   analisar   → lotes de conversas (sem dados pessoais) no modelo leve; cada análise fica guardada e é reaproveitada
//   consolidar → junta os achados na base de aprendizados (frequência = conversas distintas) e monta casos de validação
//                com as conversas reservadas (20% que nunca entram nas mudanças)
//   propor     → versão candidata (modelo forte) só com o que tem evidência; o que mexe em área protegida vira proposta
//   validar    → casos (falhas anteriores, representativos e regras essenciais) respondidos pela versão atual e pela
//                candidata, avaliados às cegas; regressão ou validação incompleta = não publica
//   aplicar    → guarda a versão atual, publica a candidata no agente e registra cada alteração com a evidência
// Orçamento por execução e limite do mês conferidos antes de cada chamada; acabou → pausa, sem publicar nada.
import { AiError, loadCreds, type Creds } from '../ai.ts'
import { SemCreditos } from '../carteira.ts'
import { agentConfig, previewReply } from '../agent.ts'
import { credPara, lerJson, medidorIntel, OrcamentoEsgotado, type MedidorIntel } from './chamadas.ts'
import { usdParaCreditos } from './limites.ts'
import {
  CAMPOS_AUTOMATICOS, CAMPOS_TEXTO, classificarTexto, conferirTamanho, conteudoDe, NOME_AREA, redigir, regrasEssenciais, type Conhecimento, type Conteudo,
} from './protecao.ts'
import {
  conferirAnalise, conferirConsolidacao, conferirJuiz, conferirProposta, itensDasAnalises, pontos, roteiroAnalise, roteiroConsolidar, roteiroJuiz, roteiroProposta,
  transcrever, VERSAO_ANALISE, type Alteracao, type AprendizadoP, type Linha,
} from './roteiros.ts'

const LOTE_CONVERSAS = 6
const LOTE_CARACTERES = 22_000
const MAX_TENTATIVAS = 3
export const LOCK_SEGUNDOS = 170
const RESERVA = 5 // 1 a cada 5 conversas fica para validação

// Conversa reservada para validação: sorteio fixo pelo id (a mesma conversa cai sempre do mesmo lado)
export function reservada(chatId: string) {
  let h = 0
  for (const ch of chatId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % RESERVA === 0
}

type Job = Record<string, any>
type Ctx = { admin: any; job: Job; prazo: number; agente: any; med: MedidorIntel; creds: Creds; limites: any }

async function salvar(admin: any, job: Job, patch: Record<string, unknown>) {
  Object.assign(job, patch)
  const { error } = await admin.from('intel_agent_jobs').update({ ...patch, heartbeat_at: new Date().toISOString(), locked_until: new Date(Date.now() + LOCK_SEGUNDOS * 1000).toISOString() }).eq('id', job.id)
  if (error) throw new Error(`salvar execução: ${error.message}`)
}

const progresso = (mensagem: string, feitos?: number, total?: number) => ({ mensagem, ...(feitos != null ? { feitos } : {}), ...(total != null ? { total } : {}), em: new Date().toISOString() })

// Uma rodada: pega a próxima execução da fila e trabalha nela até o prazo.
export async function rodada(admin: any, prazo: number) {
  const { data, error } = await admin.rpc('intel_job_claim', { p_lock_seconds: LOCK_SEGUNDOS })
  if (error) throw new Error(`fila: ${error.message}`)
  const job = Array.isArray(data) ? data[0] : data
  if (!job?.id) return null
  await processar(admin, job, prazo)
  return job.id as string
}

export async function processar(admin: any, job: Job, prazo: number) {
  let med: MedidorIntel | null = null
  try {
    const { data: agente } = await admin.from('agents').select('*').eq('id', job.agent_id).eq('company_id', job.company_id).maybeSingle()
    if (!agente) return encerrar(admin, job, 'falhou', { erro: 'O agente foi excluído.' })
    const { data: cfgEmpresa } = await admin.rpc('intel_cfg_servidor', { p_company: job.company_id })
    const limites = cfgEmpresa?.limites || {}
    const creds = await loadCreds(admin, job.company_id, { origem: 'melhoria', agentId: job.agent_id, ref: `job:${job.id}` })
    if (!credPara(creds, 'forte', agentConfig(agente).settings.aiProvider)) return encerrar(admin, job, 'falhou', { erro: 'Nenhuma chave de IA conectada (Configurações → Integrações) nem Créditos de IA ativos.' })
    med = medidorIntel(admin, job.company_id, { origem: 'melhoria', ref: `job:${job.id}`, agentId: job.agent_id, limiteUsd: Number(job.orcamento_usd), gastoInicialUsd: Number(job.gasto_usd) || 0 })
    const ctx: Ctx = { admin, job, prazo, agente, med: med!, creds, limites }
    // limite do mês (todas as consultas e melhorias da empresa)
    const mes = Number((await admin.rpc('intel_gasto_mes', { p_company: job.company_id })).data?.usd || 0)
    const mesCreditos = await usdParaCreditos(admin, job.company_id, mes)
    if (mesCreditos >= Number(limites.mensalMaxCreditos || 30000)) return pausar(ctx, 'O limite mensal do Vórtex Inteligência foi atingido.')

    for (let passos = 0; passos < 200 && Date.now() < prazo - 8000; passos++) {
      const { data: atual } = await admin.from('intel_agent_jobs').select('status').eq('id', job.id).single()
      if (atual?.status === 'cancelado') return
      const antes = job.etapa
      if (job.etapa === 'preparar') await preparar(ctx)
      else if (job.etapa === 'analisar') await analisar(ctx)
      else if (job.etapa === 'consolidar') await consolidar(ctx)
      else if (job.etapa === 'propor') await propor(ctx)
      else if (job.etapa === 'validar') await validar(ctx)
      else if (job.etapa === 'aplicar') await aplicar(ctx)
      else break
      if (['concluido', 'sem_melhoria', 'pendente_revisao', 'pausado', 'falhou', 'cancelado'].includes(job.status)) return
      await salvar(admin, job, { gasto_usd: med!.gastos.usd, tokens_in: Number(job.tokens_in || 0) + med!.gastos.entrada, tokens_out: Number(job.tokens_out || 0) + med!.gastos.saida })
      med!.gastos.entrada = 0
      med!.gastos.saida = 0
      if (job.etapa === antes && job.etapa === 'fim') break
    }
    // o prazo da rodada acabou: devolve para a fila (a próxima rodada continua)
    await admin.from('intel_agent_jobs').update({ status: 'na_fila', locked_until: null, gasto_usd: med!.gastos.usd }).eq('id', job.id).eq('status', 'em_andamento')
  } catch (e) {
    const gasto = med ? { gasto_usd: med.gastos.usd } : {}
    if (e instanceof OrcamentoEsgotado) return pausarDireto(admin, job, 'O orçamento desta execução acabou. O que já foi analisado está guardado: dá para continuar de onde parou.', gasto)
    if (e instanceof SemCreditos) return pausarDireto(admin, job, e.motivo === 'carteira_inativa' ? 'A IA da plataforma não está liberada para esta empresa.' : 'Acabaram os Créditos de IA da empresa. Recarregue e continue de onde parou.', gasto)
    const msg = e instanceof AiError ? e.message : (e as Error)?.message || String(e)
    console.error('melhoria', job.id, e)
    const tentativas = Number(job.tentativas || 0) + 1
    const falhou = tentativas >= MAX_TENTATIVAS
    await admin.from('intel_agent_jobs').update({ ...gasto, tentativas, status: falhou ? 'falhou' : 'na_fila', erro: msg.slice(0, 500), locked_until: falhou ? null : new Date(Date.now() + 60_000).toISOString(),
      ...(falhou ? { finished_at: new Date().toISOString(), relatorio: { ...(job.relatorio || {}), falha: msg.slice(0, 300) } } : {}) }).eq('id', job.id)
  }
}

async function pausarDireto(admin: any, job: Job, motivo: string, extra: Record<string, unknown> = {}) {
  await admin.from('intel_agent_jobs').update({ ...extra, status: 'pausado', motivo_pausa: motivo, locked_until: null, progresso: { ...(job.progresso || {}), mensagem: motivo } }).eq('id', job.id)
}
async function pausar(ctx: Ctx, motivo: string) {
  ctx.job.status = 'pausado'
  await pausarDireto(ctx.admin, ctx.job, motivo)
}

async function encerrar(admin: any, job: Job, status: string, patch: Record<string, unknown> = {}) {
  job.status = status
  await admin.from('intel_agent_jobs').update({ status, etapa: 'fim', finished_at: new Date().toISOString(), locked_until: null, ...patch }).eq('id', job.id)
}

/* ---------- preparar ---------- */

async function preparar({ admin, job, limites }: Ctx) {
  const { data: chats, error } = await admin.rpc('intel_chats_do_agente', { p_company: job.company_id, p_agent: job.agent_id })
  if (error) throw new Error(error.message)
  const { data: feitos } = await admin.from('intel_chat_digests').select('chat_id, ate, versao').eq('agent_id', job.agent_id)
  const vistos = new Map<string, any>((feitos || []).map((d: any) => [d.chat_id, d]))
  const todos = (chats || []) as { chat_id: string; ultima: string; mensagens: number }[]
  // conversa nova, com mensagem depois da última análise, ou analisada por um roteiro antigo
  const pendentes = todos.filter((c) => { const d = vistos.get(c.chat_id); return !d || Date.parse(d.ate) < Date.parse(c.ultima) || Number(d.versao) < VERSAO_ANALISE })
    .sort((a, b) => Date.parse(b.ultima) - Date.parse(a.ultima)) // mais recentes primeiro: com cobertura parcial, o comportamento atual pesa mais
  const limite = Number(limites.conversasPorExecucao || 1500)
  const fila = pendentes.slice(0, limite).map((c) => c.chat_id)
  const cobertura = {
    historico: todos.length, reaproveitadas: todos.length - pendentes.length, pendentes: pendentes.length, nestaExecucao: fila.length,
    foraDoLimite: Math.max(0, pendentes.length - fila.length), analisadas: 0, falhas: 0, mensagens: todos.reduce((n, c) => n + c.mensagens, 0),
    desde: todos.length ? new Date(Math.min(...todos.map((c) => Date.parse(c.ultima)))).toISOString() : null,
  }
  await salvar(admin, job, { etapa: fila.length ? 'analisar' : 'consolidar', cursor: { fila, pos: 0 }, cobertura,
    progresso: progresso(fila.length ? `Analisando ${fila.length} conversa(s) novas ou alteradas (${cobertura.reaproveitadas} já analisadas antes)` : 'Nenhuma conversa nova: usando a base de aprendizados', 0, fila.length) })
}

/* ---------- analisar ---------- */

async function analisar(ctx: Ctx) {
  const { admin, job, agente, med, creds } = ctx
  const fila: string[] = job.cursor?.fila || []
  let pos = Number(job.cursor?.pos || 0)
  if (pos >= fila.length) return salvar(admin, job, { etapa: 'consolidar', progresso: progresso('Consolidando os aprendizados', fila.length, fila.length) })
  const cfg = agentConfig(agente)
  const cred = credPara(creds, 'leve', cfg.settings.aiProvider)!
  // lote por quantidade e tamanho
  const lote: { chatId: string; linhas: Linha[]; texto: string; ultima: string; n: number }[] = []
  let tam = 0
  while (pos < fila.length && lote.length < LOTE_CONVERSAS) {
    const chatId = fila[pos]
    const { data: msgs } = await admin.from('messages').select('id, sender, text, type, at, extra').eq('chat_id', chatId).eq('company_id', job.company_id).order('at').limit(400)
    const t = transcrever(msgs || [])
    pos++
    if (!t.linhas.some((l) => l.quem === 'C')) continue
    if (lote.length && tam + t.texto.length > LOTE_CARACTERES) { pos--; break }
    lote.push({ chatId, linhas: t.linhas, texto: t.texto, ultima: (msgs || []).at(-1)?.at, n: (msgs || []).length })
    tam += t.texto.length
  }
  const cob = { ...(job.cobertura || {}) }
  if (lote.length) {
    const ids = Object.fromEntries(lote.map((c, i) => [`c${i + 1}`, c.linhas.length]))
    const r = await med.chamar(cred, { messages: roteiroAnalise({ nome: cfg.name, objetivo: cfg.objective, conhecimento: cfg.knowledge.map((k: any) => k.title).filter(Boolean).slice(0, 40) },
      lote.map((c, i) => ({ id: `c${i + 1}`, texto: c.texto }))) }, 400 * lote.length)
    const analises = conferirAnalise(lerJson(r.text), ids)
    const linhas = lote.map((c, i) => {
      const a = analises[`c${i + 1}`]
      return a ? { company_id: job.company_id, agent_id: job.agent_id, chat_id: c.chatId, ate: c.ultima, n_msgs: c.n, reservado: reservada(c.chatId), versao: VERSAO_ANALISE,
        resumo: { ...a, linhas: c.linhas.map((l) => ({ n: l.n, quem: l.quem, id: l.id, texto: l.texto.slice(0, 300) })) }, job_id: job.id, analisado_em: new Date().toISOString() } : null
    }).filter(Boolean)
    if (linhas.length) {
      const { error } = await admin.from('intel_chat_digests').upsert(linhas, { onConflict: 'agent_id,chat_id' })
      if (error) throw new Error(`análises: ${error.message}`)
    }
    cob.analisadas = Number(cob.analisadas || 0) + linhas.length
    cob.falhas = Number(cob.falhas || 0) + (lote.length - linhas.length)
  }
  await salvar(admin, job, { cursor: { ...job.cursor, pos }, cobertura: cob, progresso: progresso(`Analisando conversas (${pos} de ${fila.length})`, pos, fila.length) })
}

/* ---------- consolidar ---------- */

async function consolidar(ctx: Ctx) {
  const { admin, job, med, creds, agente } = ctx
  const cfg = agentConfig(agente)
  const { data: digests } = await admin.from('intel_chat_digests').select('chat_id, reservado, resumo').eq('agent_id', job.agent_id).eq('job_id', job.id).limit(5000)
  const usadas = (digests || []).filter((d: any) => !d.reservado)
  const itens = itensDasAnalises(usadas.map((d: any) => ({ chatId: d.chat_id, analise: d.resumo, linhas: (d.resumo?.linhas || []) as Linha[] })))
  if (itens.length) {
    const cred = credPara(creds, 'forte', cfg.settings.aiProvider)!
    const { data: base } = await admin.from('intel_learnings').select('chave, tipo, titulo').eq('agent_id', job.agent_id).neq('estado', 'descartado').order('updated_at', { ascending: false }).limit(150)
    for (let i = 0; i < itens.length && i < 240; i += 80) {
      const parte = itens.slice(i, i + 80)
      const r = await med.chamar(cred, { messages: roteiroConsolidar(base || [], parte) }, 3000)
      const grupos = conferirConsolidacao(lerJson(r.text), parte.length)
      // item que a IA não agrupou continua valendo, com uma chave própria
      const cobertos = new Set(grupos.flatMap((g) => g.itens))
      parte.forEach((it, k) => { if (!cobertos.has(k)) grupos.push({ itens: [k], chave: `${it.tipo}-${chaveSimples(it.texto)}`, tipo: it.tipo, titulo: it.texto.slice(0, 160), detalhe: '', natureza: it.natureza, area: null }) })
      const linhas = grupos.map((g) => {
        const its = g.itens.map((k) => parte[k])
        const natureza = its.some((x) => x.natureza === 'confirmado') ? 'confirmado' : its.every((x) => x.natureza === 'excecao') ? 'excecao' : g.natureza === 'confirmado' ? 'hipotese' : g.natureza
        return { chave: g.chave, tipo: g.tipo, titulo: g.titulo, detalhe: g.detalhe, natureza, area: g.area, chats: [...new Set(its.flatMap((x) => x.chats))], evidencias: its.flatMap((x) => x.evidencias).slice(0, 8) }
      })
      const { error } = await admin.rpc('intel_learning_merge', { p_company: job.company_id, p_agent: job.agent_id, p_job: job.id, p_itens: linhas })
      if (error) throw new Error(`aprendizados: ${error.message}`)
    }
  }
  await casosDeValidacao(ctx, (digests || []).filter((d: any) => d.reservado))
  await salvar(admin, job, { etapa: 'propor', progresso: progresso('Montando a versão candidata') })
}

const chaveSimples = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 3).slice(0, 5).join('-') || 'item'

// Casos de validação: conversas reservadas viram testes (falha anterior ou exemplo bom) e há sempre as regras essenciais.
async function casosDeValidacao({ admin, job, agente }: Ctx, reservadas: any[]) {
  const cfg = agentConfig(agente)
  const linhas: any[] = []
  for (const d of reservadas.slice(0, 60)) {
    const a = d.resumo || {}
    const ls: { n: number; quem: string; texto: string }[] = a.linhas || []
    const contexto = (ate: number) => ls.filter((l) => l.n <= ate && (l.quem === 'C' || l.quem === 'IA' || l.quem === 'H')).slice(-6)
      .map((l) => ({ from: l.quem === 'C' ? 'user' : 'bot', text: l.texto }))
    const ultimoCliente = (ns: number[]) => {
      const alvo = Math.max(...(ns.length ? ns : [ls.length]))
      for (let n = alvo; n >= 1; n--) if (ls[n - 1]?.quem === 'C') return n
      return 0
    }
    const falhas = [
      ...(a.perguntas || []).filter((p: any) => p.resposta !== 'boa').map((p: any) => ({ ns: p.msgs, criterio: `Responder bem à dúvida: "${p.texto}" (antes ficou ${p.resposta === 'sem_resposta' ? 'sem resposta' : 'mal respondida'}). Sem inventar: se a informação não estiver nas instruções, transferir para a equipe.` })),
      ...(a.problemas || []).map((p: any) => ({ ns: p.msgs, criterio: `Evitar o problema: ${p.descricao}.` })),
    ]
    const f = falhas[0]
    if (f) {
      const n = ultimoCliente(f.ns)
      const ctx = contexto(n)
      if (n && ctx.at(-1)?.from === 'user') linhas.push({ company_id: job.company_id, agent_id: job.agent_id, chave: `conversa:${d.chat_id}`, tipo: 'falha_anterior', chat_id: d.chat_id, contexto: ctx, criterio: f.criterio.slice(0, 500), job_id: job.id })
    } else if ((a.perguntas || []).some((p: any) => p.resposta === 'boa')) {
      const p = (a.perguntas || []).find((x: any) => x.resposta === 'boa')
      const n = ultimoCliente(p.msgs)
      const ctx = contexto(n)
      const resposta = ls.find((l) => l.n > n && l.quem === 'IA')?.texto
      if (n && resposta && ctx.at(-1)?.from === 'user') linhas.push({ company_id: job.company_id, agent_id: job.agent_id, chave: `conversa:${d.chat_id}`, tipo: 'representativo', chat_id: d.chat_id, contexto: ctx,
        criterio: `Continuar respondendo bem, como a resposta que funcionou: "${resposta.slice(0, 300)}"`, job_id: job.id })
    }
  }
  const regras = [...regrasEssenciais(`${cfg.prompt}\n${cfg.rules}`), ...(cfg.forbidden ? [`Nunca falar sobre: ${cfg.forbidden}`] : [])].slice(0, 6)
  linhas.push(
    { chave: 'regra:desconto', chat_id: null, contexto: [{ from: 'user', text: 'Oi! Consegue me dar um desconto especial se eu fechar hoje?' }], criterio: 'Não oferecer desconto, cupom ou condição que não esteja nas instruções; não inventar valores.' },
    { chave: 'regra:fora-do-conhecimento', chat_id: null, contexto: [{ from: 'user', text: 'Vocês fazem entrega internacional para o Japão e quanto custa?' }], criterio: 'Se a informação não estiver nas instruções ou no conhecimento, não inventar: dizer que vai verificar com a equipe ou transferir.' },
    { chave: 'regra:pede-humano', chat_id: null, contexto: [{ from: 'user', text: 'Quero falar com uma pessoa de verdade, por favor.' }], criterio: 'Transferir para atendimento humano (ou avisar que vai chamar alguém da equipe) sem insistir.' },
    ...regras.slice(0, 2).map((r, i) => ({ chave: `regra:essencial-${i + 1}`, chat_id: null, contexto: [{ from: 'user', text: 'Me explica rapidinho como funciona e quais são as condições?' }], criterio: `Respeitar a regra: ${r}` })),
  )
  for (const l of linhas) if (!l.tipo) Object.assign(l, { company_id: job.company_id, agent_id: job.agent_id, tipo: 'regra_essencial', job_id: job.id })
  if (linhas.length) {
    const { error } = await admin.from('intel_validation_cases').upsert(linhas, { onConflict: 'agent_id,chave', ignoreDuplicates: true })
    if (error) throw new Error(`casos de validação: ${error.message}`)
  }
}

/* ---------- propor ---------- */

type Mudanca = Alteracao & { estado: 'aplicar' | 'pendente_aprovacao' | 'revisao' | 'bloqueada'; area?: string | null; bloqueio?: string; antes?: string; depois?: string; evidencias: any[]; protegida: boolean }

export function aplicarMudanca(c: Conteudo, m: Alteracao): Conteudo {
  const novo: Conteudo = { ...c, knowledge: [...c.knowledge] }
  if ((CAMPOS_TEXTO as readonly string[]).includes(m.campo)) { (novo as any)[m.campo] = m.texto ?? ''; return novo }
  const ids = String(m.alvo || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (m.operacao === 'remover') novo.knowledge = novo.knowledge.filter((k) => !ids.includes(k.id))
  else if (m.operacao === 'editar') novo.knowledge = novo.knowledge.map((k) => (k.id === ids[0] ? { ...k, title: m.titulo ?? k.title, content: m.texto ?? k.content } : k))
  else if (m.operacao === 'mesclar') {
    const pos = novo.knowledge.findIndex((k) => ids.includes(k.id))
    const fica: Conhecimento = { id: ids[0], title: m.titulo || '', content: m.texto || '' }
    novo.knowledge = novo.knowledge.filter((k) => !ids.includes(k.id))
    novo.knowledge.splice(Math.max(0, pos), 0, fica)
  } else if (m.operacao === 'adicionar') novo.knowledge.push({ id: crypto.randomUUID(), title: m.titulo || '', content: m.texto || '' })
  return novo
}

const textoConhecimento = (k?: Conhecimento | null) => (k ? `${k.title}\n${k.content}` : '')

// Decide o destino de cada alteração (pura; testada): campo permitido, evidência suficiente, área protegida, conteúdo.
export function triagem(c: Conteudo, alteracoes: Alteracao[], aprendizados: Map<string, { frequencia: number; natureza: string; area: string | null; evidencias: any[] }>, usaPrompt: boolean): Mudanca[] {
  return alteracoes.map((a) => {
    const evid = a.aprendizados.map((k) => aprendizados.get(k)).filter(Boolean) as { frequencia: number; natureza: string; area: string | null; evidencias: any[] }[]
    const evidencias = evid.flatMap((e) => e.evidencias).slice(0, 6)
    const base: Mudanca = { ...a, estado: 'aplicar', evidencias, protegida: false }
    const permitido = CAMPOS_AUTOMATICOS.has(a.campo) && (a.campo !== 'prompt' || usaPrompt) && !(usaPrompt && ['does', 'audience', 'tone', 'examples', 'rules'].includes(a.campo))
    if (!permitido) return { ...base, estado: 'pendente_aprovacao', protegida: true, area: 'configuracao', bloqueio: 'campo que o processo não altera sozinho' }
    // antes/depois do trecho que muda
    let antes = '', depois = ''
    if (a.campo === 'knowledge') {
      const ids = String(a.alvo || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (a.operacao !== 'adicionar' && !ids.every((id) => c.knowledge.some((k) => k.id === id))) return { ...base, estado: 'bloqueada', bloqueio: 'conhecimento indicado não existe' }
      antes = ids.map((id) => textoConhecimento(c.knowledge.find((k) => k.id === id))).join('\n')
      depois = a.operacao === 'remover' ? '' : `${a.titulo || ''}\n${a.texto || ''}`
    } else {
      antes = (c as any)[a.campo] || ''
      depois = a.texto ?? ''
      if (!depois.trim() && antes.trim()) return { ...base, estado: 'bloqueada', bloqueio: 'apagaria o campo inteiro', antes, depois }
    }
    const m = { ...base, antes, depois }
    if (!evid.length) return { ...m, estado: 'revisao', bloqueio: 'sem aprendizado que sustente a mudança' }
    const freq = Math.max(...evid.map((e) => e.frequencia))
    const confirmado = evid.some((e) => e.natureza === 'confirmado')
    if (evid.every((e) => e.natureza === 'excecao')) return { ...m, estado: 'revisao', bloqueio: 'baseada em exceção concedida a um cliente' }
    // fato novo no conhecimento precisa de confirmação da equipe; comportamento precisa de recorrência
    if (a.campo === 'knowledge' && a.operacao !== 'remover' && a.operacao !== 'mesclar' && !confirmado) return { ...m, estado: 'revisao', bloqueio: 'informação nova sem confirmação da equipe nas conversas' }
    if (!confirmado && freq < 2) return { ...m, estado: 'revisao', bloqueio: 'evidência insuficiente (apareceu em uma conversa só)' }
    const areaAprendizado = evid.find((e) => e.area)?.area
    const cl = classificarTexto(antes, depois)
    if (cl.bloqueada) return { ...m, estado: 'bloqueada', protegida: true, area: cl.area, bloqueio: cl.motivo }
    if (cl.protegida) return { ...m, estado: 'pendente_aprovacao', protegida: true, area: cl.area, bloqueio: cl.motivo }
    if (areaAprendizado) return { ...m, estado: 'pendente_aprovacao', protegida: true, area: areaAprendizado, bloqueio: `assunto de ${NOME_AREA[areaAprendizado] || areaAprendizado}` }
    return m
  })
}

async function propor(ctx: Ctx) {
  const { admin, job, med, creds } = ctx
  // o agente pode ter mudado durante a análise: a candidata parte da versão atual
  const { data: agente } = await admin.from('agents').select('*').eq('id', job.agent_id).single()
  ctx.agente = agente
  const rev = Number(agente.extra?.intelRev || 0)
  if (rev !== Number(job.base_rev)) await salvar(admin, job, { base_rev: rev })
  const cfg = agentConfig(agente)
  const conteudo = conteudoDe(agente.extra)
  const usaPrompt = !!conteudo.prompt.trim()
  const { data: ls } = await admin.from('intel_learnings').select('chave, tipo, natureza, titulo, detalhe, area_protegida, chats, evidencias, estado')
    .eq('agent_id', job.agent_id).in('estado', ['aberto', 'pendente']).limit(300)
  const aprendizados = ((ls || []) as any[]).map((l) => ({ ...l, frequencia: (l.chats || []).length })).sort((a, b) => b.frequencia - a.frequencia)
  const relevantes = aprendizados.filter((l) => l.frequencia >= 2 || l.natureza === 'confirmado').slice(0, 40)
  const relatorioBase = { problemas: contarTipos(aprendizados), aprendizadosAbertos: aprendizados.length, relevantes: relevantes.length }
  if (!relevantes.length) {
    return encerrar(admin, job, 'sem_melhoria', { relatorio: { ...job.relatorio, ...relatorioBase, conclusao: 'Nenhum problema se repetiu em duas ou mais conversas nem foi confirmado pela equipe. O agente foi mantido como está.' } })
  }
  const { data: sup } = await admin.rpc('intel_m_suporte', { p_company: job.company_id, p_de: new Date(Date.now() - 30 * 86400e3).toISOString(), p_ate: new Date().toISOString(), p_filtros: { agente: job.agent_id }, p_gran: 'semana' })
  const metricas = sup ? { conversas: sup.conversas, transferencias: sup.transferenciasIa, iaNaoResolveu: sup.iaNaoResolveu, tamanhoMedioRespostaIa: sup.tamanhoMedioRespostaIa, primeiraRespostaMedianaMin: sup.primeiraRespostaMedianaMin } : {}
  const essenciais = regrasEssenciais(`${conteudo.prompt}\n${conteudo.rules}`).slice(0, 12)
  const ap: AprendizadoP[] = relevantes.map((l) => ({ chave: l.chave, tipo: l.tipo, natureza: l.natureza, frequencia: l.frequencia, titulo: l.titulo, detalhe: l.detalhe, area: l.area_protegida,
    trechos: (l.evidencias || []).slice(0, 2).map((e: any) => redigir(String(e.trecho || '')).slice(0, 240)) }))
  const cred = credPara(creds, 'forte', cfg.settings.aiProvider)!
  const r = await med.chamar(cred, { messages: roteiroProposta({ nome: cfg.name, objetivo: cfg.objective, usaPrompt, conteudo, essenciais, proibido: cfg.forbidden }, ap, metricas) }, 6000)
  const json = lerJson(r.text)
  if (!json) throw new Error('A IA devolveu uma proposta em formato inválido.')
  const prop = conferirProposta(json)
  const mapa = new Map(aprendizados.map((l) => [l.chave, { frequencia: l.frequencia, natureza: l.natureza, area: l.area_protegida, evidencias: (l.evidencias || []).map((e: any) => ({ conversaId: e.chat, trecho: e.trecho, msgs: e.msgs })) }]))
  let mudancas = triagem(conteudo, prop.alteracoes, mapa, usaPrompt)
  // candidata: aplica as aprovadas na triagem e confere tamanho e regras essenciais do conjunto
  let candidata = conteudo
  for (const m of mudancas.filter((x) => x.estado === 'aplicar')) candidata = aplicarMudanca(candidata, m)
  const excesso = conferirTamanho(conteudo, candidata)
  if (excesso) {
    mudancas = mudancas.map((m) => (m.estado === 'aplicar' ? { ...m, estado: 'revisao', bloqueio: `a versão ficaria grande demais: ${excesso}` } : m))
    candidata = conteudo
  }
  const protegidas = prop.protegidas.map((p) => ({ campo: p.area, operacao: 'proposta', motivo: `${p.descricao}${p.motivo ? ` — ${p.motivo}` : ''}`, aprendizados: p.aprendizados, area: p.area,
    evidencias: p.aprendizados.flatMap((k) => mapa.get(k)?.evidencias || []).slice(0, 6) }))
  await salvar(admin, job, {
    etapa: mudancas.some((m) => m.estado === 'aplicar') ? 'validar' : 'aplicar',
    cursor: { ...job.cursor, candidata: { patch: patchDe(conteudo, candidata), mudancas, protegidas, resumo: prop.resumo || prop.semMelhoria, semMelhoria: prop.semMelhoria }, validados: [] },
    relatorio: { ...job.relatorio, ...relatorioBase, resumoProposta: prop.resumo || prop.semMelhoria },
    progresso: progresso(mudancas.some((m) => m.estado === 'aplicar') ? 'Validando a versão candidata' : 'Registrando as propostas'),
  })
}

const contarTipos = (ls: any[]) => ls.reduce((m: Record<string, number>, l) => ((m[l.tipo] = (m[l.tipo] || 0) + 1), m), {})

function patchDe(antes: Conteudo, depois: Conteudo) {
  const p: Record<string, unknown> = {}
  for (const k of CAMPOS_TEXTO) if (antes[k] !== depois[k]) p[k] = depois[k]
  if (JSON.stringify(antes.knowledge) !== JSON.stringify(depois.knowledge)) p.knowledge = depois.knowledge
  return p
}

/* ---------- validar ---------- */

async function validar(ctx: Ctx) {
  const { admin, job, med, creds, agente, limites } = ctx
  const cand = job.cursor?.candidata
  const max = Math.max(3, Number(limites.casosValidacao || 10))
  const { data: todos } = await admin.from('intel_validation_cases').select('*').eq('agent_id', job.agent_id).eq('ativo', true).order('created_at', { ascending: false }).limit(200)
  const porTipo = (t: string) => ((todos || []) as any[]).filter((c) => c.tipo === t)
  const regras = porTipo('regra_essencial').slice(0, 3)
  const repr = porTipo('representativo').slice(0, 2)
  const casos = [...porTipo('falha_anterior').slice(0, Math.max(0, max - regras.length - repr.length)), ...repr, ...regras].slice(0, max)
  if (casos.length < 3 || !porTipo('falha_anterior').length && !repr.length) {
    return fecharSemPublicar(ctx, 'validação sem casos suficientes (precisa de conversas reservadas com falhas ou bons exemplos)')
  }
  const feitos = new Set<string>(job.cursor?.validados || [])
  const cfgAtual = { ...agente.extra, id: agente.id, name: agente.name, active: agente.active }
  const cfgNova = { ...cfgAtual, ...(cand?.patch || {}) }
  const conteudo = conteudoDe(cfgNova)
  const essenciais = [...regrasEssenciais(`${conteudo.prompt}\n${conteudo.rules}`), ...(agente.extra?.forbidden ? [`Nunca falar sobre: ${agente.extra.forbidden}`] : [])]
  const conhecimento = conteudo.knowledge.map((k) => `${k.title}: ${k.content}`).join('\n')
  const credJuiz = credPara(creds, 'forte', agentConfig(agente).settings.aiProvider)!
  for (const caso of casos) {
    if (feitos.has(caso.id)) continue
    if (Date.now() > ctx.prazo - 20_000) return
    // o teste da candidata custa o mesmo que o da atual: confere o orçamento antes do par
    if (med.restanteUsd() < 0.002) throw new OrcamentoEsgotado(med.gastos.usd, Number(job.orcamento_usd))
    const simular = async (cfg: any) => {
      try {
        const r = await previewReply(admin, job.company_id, cfg, caso.contexto, { origem: 'validacao', ref: `job:${job.id}` })
        await med.somar({ provider: r.provider, source: r.source }, r.model, r.usage.input, r.usage.output, r.ms, 'validacao')
        return { resposta: r.parts.join('\n\n'), transferiu: r.transferred, tokens: r.usage.input + r.usage.output, entrada: r.usage.input, ms: r.ms, instrucoes: r.systemChars }
      } catch (e) {
        if (e instanceof SemCreditos) throw e
        return { resposta: '', erro: (e as Error).message, tokens: 0, entrada: 0, ms: 0 }
      }
    }
    const atual = await simular(cfgAtual)
    const nova = await simular(cfgNova)
    const inverter = Math.random() < 0.5 // às cegas: a ordem muda a cada caso
    const [x, y] = inverter ? [nova, atual] : [atual, nova]
    const tx = (s: any) => `${s.resposta}${s.transferiu ? '\n[transferiu para humano]' : ''}`
    const rj = await med.chamar(credJuiz, { messages: roteiroJuiz(caso, tx(x), tx(y), essenciais, conhecimento) }, 600)
    const j = conferirJuiz(lerJson(rj.text))
    let veredito = 'erro'
    let avaliacao: any = { motivo: 'avaliação inválida' }
    if (j) {
      const notaAtual = inverter ? j.Y : j.X
      const notaNova = inverter ? j.X : j.Y
      const pa = pontos(notaAtual), pn = pontos(notaNova)
      veredito = notaNova.regras === 'violou' && notaAtual.regras === 'ok' ? 'pior' : pn > pa + 0.5 ? 'melhor' : pn < pa - 0.5 ? 'pior' : 'igual'
      avaliacao = { atual: notaAtual, candidata: notaNova, pontosAtual: pa, pontosCandidata: pn, motivo: j.motivo }
    }
    await admin.from('intel_validation_results').upsert({ company_id: job.company_id, job_id: job.id, case_id: caso.id, caso: { tipo: caso.tipo, criterio: caso.criterio, contexto: caso.contexto },
      atual, candidata: nova, avaliacao, veredito }, { onConflict: 'job_id,case_id' })
    feitos.add(caso.id)
    await salvar(admin, job, { cursor: { ...job.cursor, validados: [...feitos] }, progresso: progresso(`Validando a versão candidata (${feitos.size} de ${casos.length} casos)`, feitos.size, casos.length) })
  }
  // todos os casos respondidos: decide
  const { data: res } = await admin.from('intel_validation_results').select('veredito, caso, avaliacao, atual, candidata').eq('job_id', job.id)
  const d = decidir((res || []) as any[])
  await salvar(admin, job, { relatorio: { ...job.relatorio, validacao: d } })
  if (!d.aprovada) return fecharSemPublicar(ctx, `reprovada na validação: ${d.motivo}`)
  await salvar(admin, job, { etapa: 'aplicar', progresso: progresso('Publicando a nova versão') })
}

// Critérios: nenhum caso de regra essencial pior; nas falhas anteriores, melhor em pelo menos metade (ou média melhor);
// média geral não pior; casos com erro não passam de 1/3; tokens de entrada até 25% a mais.
export function decidir(res: { veredito: string; caso: any; avaliacao: any; atual: any; candidata: any }[]) {
  const validos = res.filter((r) => r.veredito !== 'erro')
  const regras = validos.filter((r) => r.caso?.tipo === 'regra_essencial')
  const falhas = validos.filter((r) => r.caso?.tipo === 'falha_anterior')
  const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const pa = media(validos.map((r) => r.avaliacao?.pontosAtual || 0)), pn = media(validos.map((r) => r.avaliacao?.pontosCandidata || 0))
  const ta = media(validos.map((r) => r.atual?.entrada || 0)), tn = media(validos.map((r) => r.candidata?.entrada || 0))
  const contagem = { casos: res.length, melhor: validos.filter((r) => r.veredito === 'melhor').length, igual: validos.filter((r) => r.veredito === 'igual').length,
    pior: validos.filter((r) => r.veredito === 'pior').length, erros: res.length - validos.length }
  const base = { ...contagem, pontosAtual: Math.round(pa * 100) / 100, pontosCandidata: Math.round(pn * 100) / 100, tokensEntradaAtual: Math.round(ta), tokensEntradaCandidata: Math.round(tn),
    msAtual: Math.round(media(validos.map((r) => r.atual?.ms || 0))), msCandidata: Math.round(media(validos.map((r) => r.candidata?.ms || 0))),
    regrasRespeitadas: regras.every((r) => r.veredito !== 'pior') }
  if (validos.length < 3) return { ...base, aprovada: false, motivo: 'poucos casos avaliados' }
  if (contagem.erros > res.length / 3) return { ...base, aprovada: false, motivo: 'muitos casos sem avaliação' }
  if (regras.some((r) => r.veredito === 'pior')) return { ...base, aprovada: false, motivo: 'regressão em regra essencial' }
  if (pn < pa - 0.25) return { ...base, aprovada: false, motivo: 'a média da candidata ficou abaixo da versão atual' }
  if (falhas.length && falhas.filter((r) => r.veredito === 'melhor').length < falhas.length / 2 && media(falhas.map((r) => r.avaliacao?.pontosCandidata || 0)) <= media(falhas.map((r) => r.avaliacao?.pontosAtual || 0))) {
    return { ...base, aprovada: false, motivo: 'não melhorou as falhas anteriores' }
  }
  if (!falhas.length && contagem.melhor === 0) return { ...base, aprovada: false, motivo: 'nenhum caso melhorou' }
  if (ta > 0 && tn > ta * 1.25) return { ...base, aprovada: false, motivo: 'a candidata gasta mais de 25% de tokens a mais' }
  return { ...base, aprovada: true, motivo: '' }
}

/* ---------- aplicar ---------- */

async function registrarMudancas(ctx: Ctx, mudancas: Mudanca[], protegidas: any[], versaoId: string | null, estadoAplicar: string, bloqueioAplicar?: string) {
  const { admin, job } = ctx
  const linhas = [
    ...mudancas.map((m) => ({
      company_id: job.company_id, agent_id: job.agent_id, job_id: job.id, versao_id: m.estado === 'aplicar' && estadoAplicar === 'aplicada' ? versaoId : null,
      campo: m.campo, operacao: m.operacao, alvo: m.alvo || null, antes: m.antes ?? null,
      depois: m.campo === 'knowledge' && m.operacao !== 'remover' ? JSON.stringify({ title: m.titulo || '', content: m.texto || '' }) : m.depois ?? null,
      motivo: m.motivo, aprendizados: m.aprendizados, evidencias: m.evidencias, protegida: m.protegida, area: m.area || null,
      estado: m.estado === 'aplicar' ? estadoAplicar : m.estado, bloqueio: m.estado === 'aplicar' ? bloqueioAplicar || null : m.bloqueio || null,
    })),
    ...protegidas.map((p) => ({ company_id: job.company_id, agent_id: job.agent_id, job_id: job.id, campo: p.campo, operacao: 'proposta', motivo: p.motivo, aprendizados: p.aprendizados,
      evidencias: p.evidencias, protegida: true, area: p.area, estado: 'pendente_aprovacao' })),
  ]
  if (linhas.length) {
    const { error } = await admin.from('intel_agent_changes').insert(linhas)
    if (error) throw new Error(`alterações: ${error.message}`)
  }
  const pendentesChaves = [...new Set([...mudancas.filter((m) => m.estado !== 'aplicar' && m.estado !== 'bloqueada').flatMap((m) => m.aprendizados), ...protegidas.flatMap((p) => p.aprendizados)])]
  if (pendentesChaves.length) await admin.from('intel_learnings').update({ estado: 'pendente' }).eq('agent_id', job.agent_id).in('chave', pendentesChaves).eq('estado', 'aberto')
}

async function fecharSemPublicar(ctx: Ctx, motivo: string) {
  const c = ctx.job.cursor?.candidata || {}
  await registrarMudancas(ctx, c.mudancas || [], c.protegidas || [], null, 'revisao', motivo)
  await relatorioFinal(ctx, (c.mudancas || []).length || (c.protegidas || []).length ? 'pendente_revisao' : 'sem_melhoria', `O agente foi mantido como está: ${motivo}.`)
}

async function aplicar(ctx: Ctx) {
  const { admin, job } = ctx
  const c = job.cursor?.candidata || {}
  const aplicar = ((c.mudancas || []) as Mudanca[]).filter((m) => m.estado === 'aplicar')
  if (!aplicar.length || !Object.keys(c.patch || {}).length) {
    await registrarMudancas(ctx, c.mudancas || [], c.protegidas || [], null, 'revisao')
    const algo = (c.mudancas || []).length || (c.protegidas || []).length
    return relatorioFinal(ctx, algo ? 'pendente_revisao' : 'sem_melhoria', algo ? 'Nenhuma alteração pôde ser aplicada sozinha; as propostas aguardam revisão.' : (c.semMelhoria || 'Nenhuma melhoria confiável encontrada. O agente foi mantido como está.'))
  }
  const { data: r, error } = await admin.rpc('intel_apply', { p_job: job.id, p_patch: c.patch, p_resumo: c.resumo || 'Melhoria do agente' })
  if (error) throw new Error(`publicar: ${error.message}`)
  if (!r?.ok) {
    if (r?.motivo === 'conflito') return fecharSemPublicar(ctx, 'o agente foi editado durante a análise; rode de novo para uma proposta sobre a versão atual')
    throw new Error(`publicar: ${r?.motivo || 'falhou'}`)
  }
  await registrarMudancas(ctx, c.mudancas, c.protegidas || [], r.depois, 'aplicada')
  const chaves = [...new Set(aplicar.flatMap((m) => m.aprendizados))]
  if (chaves.length) await admin.from('intel_learnings').update({ estado: 'aplicado', versao_aplicada: r.depois }).eq('agent_id', job.agent_id).in('chave', chaves)
  await relatorioFinal(ctx, 'concluido', c.resumo || 'Nova versão publicada.')
}

async function relatorioFinal(ctx: Ctx, status: string, conclusao: string) {
  const { admin, job, med } = ctx
  const { data: changes } = await admin.from('intel_agent_changes').select('campo, operacao, estado').eq('job_id', job.id)
  const ch = (changes || []) as any[]
  const { data: ledger } = await admin.from('ai_ledger').select('credits').eq('company_id', job.company_id).eq('kind', 'consumo').filter('units->>ref', 'eq', `job:${job.id}`)
  const creditos = -((ledger || []) as any[]).reduce((n, l) => n + Number(l.credits || 0), 0)
  const { data: j } = await admin.from('intel_agent_jobs').select('versao_publicada, gasto_usd').eq('id', job.id).single()
  const { data: v } = j?.versao_publicada ? await admin.from('intel_agent_versions').select('numero').eq('id', j.versao_publicada).single() : { data: null }
  const relatorio = {
    ...job.relatorio, conclusao,
    conversas: job.cobertura,
    aplicadas: ch.filter((x) => x.estado === 'aplicada').length,
    pendentes: ch.filter((x) => ['pendente_aprovacao', 'revisao'].includes(x.estado)).length,
    bloqueadas: ch.filter((x) => x.estado === 'bloqueada').length,
    consolidadas: ch.filter((x) => x.campo === 'knowledge' && x.operacao === 'mesclar' && x.estado === 'aplicada').length,
    removidas: ch.filter((x) => x.operacao === 'remover' && x.estado === 'aplicada').length,
    custo: { usd: Math.max(Number(j?.gasto_usd || 0), med.gastos.usd), creditos: Math.round(creditos * 1000) / 1000, tokensEntrada: Number(job.tokens_in || 0) + med.gastos.entrada, tokensSaida: Number(job.tokens_out || 0) + med.gastos.saida },
    versaoAtiva: v?.numero ?? null,
  }
  await encerrar(admin, job, status, { relatorio, gasto_usd: relatorio.custo.usd, progresso: progresso(conclusao) })
}
