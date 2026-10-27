// Chamado a cada 20 s pelo pg_cron: retoma fluxos pausados em "Intervalo Inteligente",
// segue pela saída "Sem resposta" quando o "Aguarda Resposta" estoura o tempo
// e acorda o agente de IA nas conversas com resposta vencida (rede de segurança do agrupamento).
// Gatilhos (triggers.ts), em segundo plano: eventos do banco (contato, etiqueta, campo, negócio, responsável, mensagem
// enviada), agendamentos vencidos (sem resposta da equipe, cliente sem responder, tempo parado na etapa, datas, espera
// pelo horário permitido) e as ocorrências dos gatilhos de data. Também manda os disparos em massa em andamento
// (_shared/disparos.ts).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json } from '../_shared/whatsapp.ts'
import { loadFlow, nextOf, runFrom, runOf, setRun, type Ctx } from '../_shared/flow.ts'
import { cleanup, processEvents, processJobs, queueSchedules } from '../_shared/triggers.ts'
import { processDispatches } from '../_shared/disparos.ts'
import { companyModules } from '../_shared/access.ts'
import { kickAgent } from '../_shared/kick.ts'
import { connectionSecret } from '../_shared/secrets.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// O item já foi "travado" (estado limpo) antes daqui: se a empresa não tem mais Fluxos ou Conexões,
// devolver null cancela a automação em vez de executá-la.
async function buildCtx(chat: any): Promise<Ctx | null> {
  const [{ data: contact }, { data: secret }, { data: company }, modules] = await Promise.all([
    admin.from('contacts').select('*').eq('id', chat.contact_id).single(),
    connectionSecret(admin, chat.connection_id).then((data) => ({ data })),
    admin.from('companies').select('settings').eq('id', chat.company_id).single(),
    companyModules(admin, chat.company_id),
  ])
  if (!contact || !modules.has('fluxos') || !modules.has('conexoes')) return null
  return { admin, companyId: chat.company_id, settings: company?.settings || {}, chat, contact, provider: secret?.provider ?? null, creds: secret?.credentials ?? null, modules }
}

// Retoma uma execução parada; se o fluxo não está mais ativo (ou a empresa perdeu o módulo), ela é cancelada.
async function resume(chat: any, st: any, from: (flow: any) => string | null) {
  const ctx = await buildCtx(chat)
  const flow = ctx && (await loadFlow(ctx, st.flowId))
  if (ctx && flow?.status === 'active') {
    await runFrom(ctx, flow, from(flow), st.vars || {}, runOf(st)).catch((e) => console.error(e))
    return true
  }
  await setRun(admin, st.runId, { status: 'cancelled', reason: 'O fluxo foi pausado ou excluído enquanto esperava.' })
  return false
}

async function automations() {
  const deadline = Date.now() + 50_000
  const cache = new Map()
  await queueSchedules(admin).catch((e) => console.error('datas', e))
  const { data: events, error: ee } = await admin.rpc('flow_events_claim', { p_limit: 100 })
  if (ee) console.error('flow_events_claim', ee.message)
  await processEvents(admin, events ?? [], cache)
  const { data: jobs, error: je } = await admin.rpc('flow_jobs_claim', { p_limit: 40 })
  if (je) console.error('flow_jobs_claim', je.message)
  await processJobs(admin, jobs ?? [], cache, deadline)
  await processDispatches(admin, deadline).catch((e) => console.error('disparos', e))
  const now = new Date()
  if (now.getUTCMinutes() === 7 && now.getUTCSeconds() < 20) await cleanup(admin).catch((e) => console.error('limpeza', e))
}

Deno.serve(async () => {
  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(automations().catch((e) => console.error('gatilhos', e)))

  const now = new Date().toISOString()
  const [{ data: resumes }, { data: timeouts }] = await Promise.all([
    admin.from('chats').select('*').lte('flow_state->>resumeAt', now).limit(50),
    admin.from('chats').select('*').lte('flow_state->waiting->>expiresAt', now).limit(50),
  ])
  let done = 0

  for (const chat of resumes ?? []) {
    const st = chat.flow_state
    // "trava" o item: só segue quem conseguir limpar o estado primeiro (evita rodar duas vezes)
    const { data: claimed } = await admin.from('chats').update({ flow_state: {} }).eq('id', chat.id).eq('flow_state->>resumeAt', st.resumeAt).select('id')
    if (!claimed?.length) continue
    chat.flow_state = {}
    if (await resume(chat, st, () => st.nodeId)) done++
  }

  // Agente de IA: respostas vencidas que nenhuma execução pegou (ou turnos que morreram no meio) são retomadas.
  const { data: overdue, error: oe } = await admin.rpc('ai_overdue', { p_limit: 20 })
  if (oe) console.error('ai_overdue', oe.message)
  await Promise.all((overdue ?? []).map((row: any) => kickAgent(typeof row === 'string' ? row : row.ai_overdue ?? row.id)))

  for (const chat of timeouts ?? []) {
    const st = chat.flow_state
    const { data: claimed } = await admin.from('chats').update({ flow_state: {} }).eq('id', chat.id).eq('flow_state->waiting->>expiresAt', st.waiting.expiresAt).select('id')
    if (!claimed?.length) continue
    chat.flow_state = {}
    if (await resume(chat, st, (flow) => nextOf(flow, st.waiting.nodeId, 1))) done++
  }

  return json({ ok: true, done })
})
