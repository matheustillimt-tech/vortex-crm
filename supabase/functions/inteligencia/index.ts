// Vórtex Inteligência. Ações:
//  - tick      (pg_cron a cada minuto): continua as melhorias de agente que estão na fila (intel_agent_jobs).
//  - perguntar (painel): pergunta ao assistente; as consultas rodam com o login de quem pergunta (permissão no banco).
//  - painel    (painel): blocos das abas Visão Geral, Funil e Recuperação e Suporte (sem IA).
//  - registros (painel): registros por trás de um número (pedidos, oportunidades, conversas).
//  - estimar / melhorar / continuar (painel): "Melhorar agente" — estimativa, início e retomada da execução.
//  - importar  (painel, quem configura): lê os webhooks de pagamento já recebidos e registra os pedidos (idempotente).
// verify_jwt padrão: o cron manda a chave anon; o painel, o login.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { loadCreds, pickChatCred, AiError } from '../_shared/ai.ts'
import { custoUsd, precos } from '../_shared/carteira.ts'
import { executar, perguntar } from '../_shared/inteligencia/assistente.ts'
import { blocosRegistros, type Bloco, type Definicao } from '../_shared/inteligencia/blocos.ts'
import { credPara } from '../_shared/inteligencia/chamadas.ts'
import { creditosParaUsd, usdParaCreditos } from '../_shared/inteligencia/limites.ts'
import { rodada } from '../_shared/inteligencia/melhoria.ts'
import { registrarPagamento } from '../_shared/inteligencia/pagamentos.ts'
import { resolverPeriodo } from '../_shared/inteligencia/periodo.ts'
import { VERSAO_ANALISE } from '../_shared/inteligencia/roteiros.ts'
import { agentConfig } from '../_shared/agent-core.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RODADA_MS = 115_000
const admin = createClient(URL_, SERVICE)

const segundoPlano = (p: Promise<unknown>) => {
  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(p.catch((e) => console.error('inteligencia', e)))
}

async function fila(prazo: number) {
  for (let i = 0; i < 5 && Date.now() < prazo - 15_000; i++) {
    const id = await rodada(admin, prazo)
    if (!id) break
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  if (body.action === 'tick') {
    segundoPlano(fila(Date.now() + RODADA_MS))
    return json({ ok: true }, 202)
  }

  const auth = req.headers.get('Authorization') ?? ''
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)
  const companyId = String(body.companyId || '')
  if (!companyId) return json({ error: 'Empresa não informada' }, 400)

  try {
    const { data: me, error: meErr } = await userDb.rpc('intel_me', { p_company: companyId })
    if (meErr) return json({ error: meErr.message }, 404)
    if (!me?.modulo) return json({ error: 'O Vórtex Inteligência não está liberado para esta empresa.', code: 'module_disabled' }, 403)
    const pode = me.pode || {}
    const { data: empresa } = await admin.from('companies').select('timezone').eq('id', companyId).single()
    const tz = empresa?.timezone || 'America/Sao_Paulo'
    const u = { db: userDb, id: user.id, podeConversas: !!pode.conversas }

    switch (body.action) {
      case 'perguntar': {
        if (!pode.consultar) return json({ error: 'Sem permissão para consultar.' }, 403)
        return json(await perguntar({ admin, userDb, companyId, userId: user.id, conversaId: body.conversaId, texto: body.texto }))
      }

      case 'painel': {
        if (!pode.consultar) return json({ error: 'Sem permissão para consultar.' }, 403)
        const args = { ...(body.periodo || {}), ...(body.comparar ? { comparar: body.comparar } : {}), ...(body.filtros?.produto ? { produto: body.filtros.produto } : {}), ...(body.filtros?.agente ? { agente: body.filtros.agente } : {}) }
        const abas: Record<string, [string, string][]> = {
          visao: [['consultar_vendas', 'Vendas'], ['consultar_recuperacao', 'Recuperação'], ['consultar_atendimento', 'Atendimento'], ['consultar_consumo_ia', 'Consumo de IA']],
          funil: [['consultar_funil', 'Funil'], ['consultar_recuperacao', 'Recuperação']],
          suporte: [['consultar_atendimento', 'Atendimento'], ['principais_duvidas', 'Dúvidas dos clientes']],
        }
        const lista = abas[String(body.aba)] || abas.visao
        const resultados = await Promise.all(lista.map(([f, titulo]) => executar(f, args, {}, companyId, tz, u).then((r) => ({ titulo, r })).catch((e) => ({ titulo, erro: (e as Error).message }))))
        const secoes = resultados.map((x: any) => x.erro
          ? { titulo: x.titulo, blocos: [{ tipo: 'aviso', nivel: 'alerta', texto: `Não foi possível carregar: ${x.erro}` }] as Bloco[], definicoes: [] as Definicao[] }
          : { titulo: x.titulo, blocos: body.aba === 'visao' ? resumoVisao(x.r.pacote.blocos) : x.r.pacote.blocos, definicoes: x.r.pacote.definicoes })
        const p = (resultados.find((x: any) => x.r?.periodo) as any)?.r
        return json({ secoes, periodo: p?.periodo, comparacao: p?.comparacao || null, fuso: tz, atualizadoEm: new Date().toISOString() })
      }

      case 'registros': {
        if (!pode.consultar) return json({ error: 'Sem permissão para consultar.' }, 403)
        const p = resolverPeriodo(body.periodo || {}, tz)
        const { data, error } = await userDb.rpc('intel_m_registros', { p_company: companyId, p_tipo: body.tipo, p_de: body.de || p.de, p_ate: body.ate || p.ate, p_filtros: body.filtros || {}, p_pagina: Number(body.pagina) || 0 })
        if (error) return json({ error: error.message }, 403)
        return json({ bloco: blocosRegistros(data, String(body.titulo || 'Registros')), periodo: p })
      }

      case 'estimar': {
        if (!pode.melhorar) return json({ error: 'Sem permissão para melhorar agentes.' }, 403)
        return json(await estimar(companyId, String(body.agentId), me))
      }

      case 'melhorar': {
        if (!pode.melhorar) return json({ error: 'Sem permissão para melhorar agentes.' }, 403)
        if (!me.agentes) return json({ error: 'O módulo Agentes de IA não está liberado para esta empresa.' }, 403)
        const est = await estimar(companyId, String(body.agentId), me)
        if (est.bloqueio) return json({ error: est.bloqueio, estimativa: est }, 400)
        const { data: jobId, error } = await userDb.rpc('intel_job_start', { p_company: companyId, p_agent: body.agentId, p_orcamento_usd: est.orcamento.usd, p_estimativa: est })
        if (error) return json({ error: error.message }, error.code === '23505' ? 409 : 400)
        segundoPlano(fila(Date.now() + RODADA_MS))
        return json({ ok: true, jobId, estimativa: est })
      }

      case 'continuar': {
        if (!pode.melhorar) return json({ error: 'Sem permissão para melhorar agentes.' }, 403)
        const extra = Math.max(0, Number(body.orcamentoExtraCreditos) || Number(me.config?.limites?.melhoriaMaxCreditos) || 0)
        const { error } = await userDb.rpc('intel_job_resume', { p_job: body.jobId, p_orcamento_usd: await creditosParaUsd(admin, companyId, extra) })
        if (error) return json({ error: error.message }, 400)
        segundoPlano(fila(Date.now() + RODADA_MS))
        return json({ ok: true })
      }

      case 'importar': {
        if (!pode.configurar) return json({ error: 'Sem permissão para configurar o módulo.' }, 403)
        let lidos = 0, pagamentos = 0, novos = 0
        for (let pagina = 0; pagina < 50; pagina++) {
          const { data } = await admin.from('webhook_events').select('payload, contact_id, status').eq('company_id', companyId).neq('status', 'test')
            .order('received_at').range(pagina * 500, pagina * 500 + 499)
          if (!data?.length) break
          for (const e of data) {
            lidos++
            const r = await registrarPagamento(admin, companyId, e.payload, e.contact_id)
            if (r) { pagamentos++; if (r.ok && !r.repetido) novos++ }
          }
          if (data.length < 500) break
        }
        return json({ ok: true, lidos, pagamentos, novos })
      }
    }
    return json({ error: 'Ação desconhecida' }, 400)
  } catch (e) {
    console.error('inteligencia', body.action, e)
    return json({ error: e instanceof AiError ? e.message : (e as Error)?.message || 'Erro inesperado' }, 500)
  }
})

// Visão Geral: só os cards e o gráfico principal de cada área (o detalhe fica nas outras abas)
function resumoVisao(blocos: Bloco[]) {
  const out: Bloco[] = []
  const cards = blocos.find((b) => b.tipo === 'cards')
  const serie = blocos.find((b) => b.tipo === 'serie')
  const aviso = blocos.find((b) => b.tipo === 'aviso' && b.nivel === 'alerta')
  if (aviso) out.push(aviso)
  if (cards) out.push(cards)
  if (serie) out.push(serie)
  return out
}

// Estimativa do "Melhorar agente" (identificada como estimativa na tela) e conferência de saldo e orçamento.
async function estimar(companyId: string, agentId: string, me: any) {
  const { data: agente } = await admin.from('agents').select('*').eq('id', agentId).eq('company_id', companyId).maybeSingle()
  if (!agente) throw new Error('Agente não encontrado.')
  const cfg = agentConfig(agente)
  const lim = me.config?.limites || {}
  const [{ data: chats }, { data: feitos }, { data: ativo }] = await Promise.all([
    admin.rpc('intel_chats_do_agente', { p_company: companyId, p_agent: agentId }),
    admin.from('intel_chat_digests').select('chat_id, ate, versao').eq('agent_id', agentId),
    admin.from('intel_agent_jobs').select('id, status').eq('agent_id', agentId).in('status', ['na_fila', 'em_andamento']).maybeSingle(),
  ])
  const vistos = new Map<string, any>((feitos || []).map((d: any) => [d.chat_id, d]))
  const todos = (chats || []) as { chat_id: string; ultima: string; mensagens: number }[]
  const pendentes = todos.filter((c) => { const d = vistos.get(c.chat_id); return !d || Date.parse(d.ate) < Date.parse(c.ultima) || Number(d.versao) < VERSAO_ANALISE })
  const limite = Number(lim.conversasPorExecucao || 1500)
  const nesta = pendentes.sort((a, b) => Date.parse(b.ultima) - Date.parse(a.ultima)).slice(0, limite)
  const creds = await loadCreds(admin, companyId, { origem: 'melhoria', agentId })
  const forte = credPara(creds, 'forte', cfg.settings.aiProvider)
  const leve = credPara(creds, 'leve', cfg.settings.aiProvider)
  const tabela = await precos(admin)
  const base = { conversas: { historico: todos.length, reaproveitadas: todos.length - pendentes.length, pendentes: pendentes.length, nestaExecucao: nesta.length, foraDoLimite: Math.max(0, pendentes.length - nesta.length) } }
  const orcCreditos = Number(lim.melhoriaMaxCreditos || 3000)
  const orcamento = { creditos: orcCreditos, usd: await creditosParaUsd(admin, companyId, orcCreditos) }
  if (!forte || !leve) return { ...base, orcamento, bloqueio: 'Nenhuma chave de IA conectada (Configurações → Integrações) nem Créditos de IA ativos.' }
  if (cfg.engine !== 'padrao') return { ...base, orcamento, bloqueio: 'Este agente usa um motor próprio e não é ajustado por aqui.' }
  if (ativo) return { ...base, orcamento, bloqueio: 'Já existe uma melhoria em andamento para este agente.', jobId: ativo.id }
  // tokens: transcrição comprimida (até 6.000 caracteres por conversa, ~90 por mensagem), texto ÷ 3,2
  const entradaAnalise = nesta.reduce((n, c) => n + Math.min(6000, c.mensagens * 90), 0) / 3.2 + Math.ceil(nesta.length / 6) * 1200
  const instrucoes = (JSON.stringify(cfg.knowledge).length + String(cfg.prompt || '').length + 4000) / 3.2
  const casos = Number(lim.casosValidacao || 10)
  const usd = custoUsd(tabela, leve.model, { entrada: entradaAnalise, saida: nesta.length * 350 }).usd
    + custoUsd(tabela, forte.model, { entrada: 3 * 8000 + instrucoes + 12000, saida: 3 * 2500 + 5000 }).usd
    + 2 * casos * custoUsd(tabela, forte.model === leve.model ? forte.model : (pickChatCred(creds, cfg.settings.aiProvider)?.model || forte.model), { entrada: instrucoes + 600, saida: 400 }).usd
    + casos * custoUsd(tabela, forte.model, { entrada: 2500 + instrucoes / 2, saida: 500 }).usd
  const creditos = await usdParaCreditos(admin, companyId, usd)
  const plataforma = forte.source === 'plataforma'
  let saldo: number | null = null
  let bloqueio: string | null = null
  if (plataforma) {
    const { data: w } = await admin.rpc('ai_wallet_available', { p_company: companyId })
    saldo = w ? Number(w.disponivel) : null
    if (w && w.modo === 'prepago' && Number(w.disponivel) < Math.min(creditos, orcCreditos) * 0.5) bloqueio = `Saldo de Créditos de IA insuficiente para a estimativa (cerca de ${Math.ceil(Math.min(creditos, orcCreditos))} créditos; disponível ${Math.floor(Number(w.disponivel))}). Recarregue em Créditos de IA.`
  }
  const mes = Number((await admin.rpc('intel_gasto_mes', { p_company: companyId })).data?.usd || 0)
  const mesCreditos = await usdParaCreditos(admin, companyId, mes)
  if (!bloqueio && mesCreditos >= Number(lim.mensalMaxCreditos || 30000)) bloqueio = 'O limite mensal do Vórtex Inteligência foi atingido.'
  return {
    ...base, orcamento, fonte: plataforma ? 'plataforma' : 'empresa', modelos: { leve: leve.model, forte: forte.model },
    estimativa: { usd: Math.round(usd * 10000) / 10000, creditos: Math.ceil(creditos), faixa: [Math.ceil(creditos * 0.6), Math.ceil(creditos * 1.6)], estimada: true },
    parcial: base.conversas.foraDoLimite > 0 || creditos > orcCreditos,
    saldo, bloqueio,
  }
}
