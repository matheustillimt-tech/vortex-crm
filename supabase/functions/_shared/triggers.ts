// Gatilhos de início dos fluxos (servidor). Um evento (mensagem, webhook, etiqueta, negócio, data, início manual...) vira,
// para cada fluxo ativo com um gatilho que combina, uma tentativa de início (startFlow):
//   ciclo? → filtros → reentrada → contato já em fluxo → horário permitido → registra a execução (a chave do evento
//   impede rodar duas vezes) → conversa para falar com o contato → runFrom (flow.ts).
// O que é "depois de um tempo" vira flow_jobs (revalidado antes de executar; o banco cancela quando a condição muda).
// Eventos do banco (contato, etiqueta, campo, negócio, responsável, mensagem enviada) chegam por flow_events (flow-tick).
// Regras puras (palavra-chave, horário, filtros, datas) ficam em triggers-core.ts, compartilhado com o editor.
import { companyModules } from './access.ts'
import { connectionSecret } from './secrets.ts'
import { pickVars, resumeWithReply, runFrom, setRun, type Ctx } from './flow.ts'
import {
  compareValue, connectionOk, dateTarget, enabledTriggers, fieldValue, lastOccurrence, matchMessage, nextWindow, parseDate,
  passesFilters, reentryBlock, sameDay, startOf, toSeconds, withinHours, ymdKey, zonedParts, DEFAULT_TZ, type Start, type Trigger, type Ymd,
} from './triggers-core.ts'

export type FlowEvent = {
  type: string                     // tipo do gatilho (message, webhook, tag, deal, manual...)
  key: string | null               // chave do evento: o mesmo evento não roda o mesmo fluxo duas vezes
  contactId: string
  chatId?: string | null
  connectionId?: string | null     // conexão para falar com o contato quando ele ainda não tem conversa
  data?: Record<string, unknown>   // variáveis que o fluxo recebe
  chain?: string[]                 // fluxos que levaram a este evento (sem ciclos)
  skipHours?: boolean              // já esperou a janela de horário
  [k: string]: unknown
}
export type Started = { status: 'started' | 'scheduled' | 'skipped' | 'duplicate' | 'error'; runId?: string | null; reason?: string }
export type Env = { admin: any; companyId: string; settings?: Record<string, any>; modules?: Set<string> }
type Active = { flow: any; start: Start }

const MAX_CHAIN = 5                                // um fluxo disparando outro, no máximo 5 níveis
const BURST = { ms: 10 * 60_000, max: 20 }         // mesmo fluxo e contato: no máximo 20 entradas em 10 min
const STARTED = ['running', 'waiting', 'done', 'alert', 'error', 'cancelled']
const iso = (t: number | Date) => new Date(t).toISOString()

export async function activeFlows(admin: any, companyId: string): Promise<Active[]> {
  const { data } = await admin.from('flows').select('id, name, status, nodes, edges, created_at').eq('company_id', companyId).eq('status', 'active').order('created_at')
  return (data ?? []).map((flow: any) => ({ flow, start: startOf(flow.nodes) }))
}

async function companyEnv(admin: any, companyId: string, cache?: Map<string, Env>): Promise<Env> {
  const hit = cache?.get(companyId)
  if (hit) return hit
  const [{ data: company }, modules] = await Promise.all([
    admin.from('companies').select('settings').eq('id', companyId).maybeSingle(),
    companyModules(admin, companyId),
  ])
  const env = { admin, companyId, settings: company?.settings || {}, modules }
  cache?.set(companyId, env)
  return env
}

// Execução que não chegou a rodar (ciclo, horário), só para o histórico.
async function record(admin: any, row: Record<string, unknown>) {
  const { error } = await admin.from('flow_runs').insert({ ...row, finished_at: iso(Date.now()) })
  if (error && error.code !== '23505') console.error('flow_runs', error.message)
}

async function pickChat(admin: any, contact: any, connectionId?: string | null) {
  let q = admin.from('chats').select('*').eq('company_id', contact.company_id).eq('contact_id', contact.id)
  if (connectionId) q = q.eq('connection_id', connectionId)
  const { data } = await q.order('last_message_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

async function ensureChat(admin: any, contact: any, connectionId?: string | null) {
  if (!connectionId) return null
  const { data: conn } = await admin.from('connections').select('id').eq('id', connectionId).eq('company_id', contact.company_id).maybeSingle()
  if (!conn) return null
  const { data, error } = await admin.from('chats').insert({
    company_id: contact.company_id, contact_id: contact.id, connection_id: connectionId, status: 'waiting', bot_active: true, last_message_at: iso(Date.now()),
  }).select('*').single()
  if (error) throw error
  return data
}

// Tenta começar um fluxo para o contato do evento. Nunca lança: erros viram execução com erro.
export async function startFlow(env: Env, flow: any, trigger: Trigger | null, ev: FlowEvent, pre: { chat?: any; contact?: any } = {}): Promise<Started> {
  const { admin, companyId } = env
  const { rules } = startOf(flow.nodes)
  const now = new Date()
  const chain = (ev.chain || []).filter(Boolean)
  const base = { company_id: companyId, flow_id: flow.id, trigger_id: trigger?.id || '', trigger_type: ev.type, chain, data: pickVars(ev.data || {}) }
  try {
    const contact = pre.contact || (await admin.from('contacts').select('*').eq('id', ev.contactId).eq('company_id', companyId).maybeSingle()).data
    if (!contact) return { status: 'skipped', reason: 'Contato não encontrado.' }

    // Ciclo: um fluxo que, pelas próprias ações, dispararia a si mesmo (direto ou por outros fluxos)
    if (chain.includes(flow.id) || chain.length >= MAX_CHAIN) {
      const reason = chain.includes(flow.id)
        ? 'Ciclo evitado: este fluxo seria disparado de novo por uma ação dele mesmo (ou de um fluxo que ele disparou).'
        : `Ciclo evitado: mais de ${MAX_CHAIN} fluxos disparando um ao outro em sequência.`
      await record(admin, { ...base, contact_id: contact.id, event_key: ev.key, status: 'alert', reason })
      return { status: 'skipped', reason }
    }

    let chat = pre.chat || (ev.chatId ? (await admin.from('chats').select('*').eq('id', ev.chatId).maybeSingle()).data : null)
    const sendVia = ev.connectionId || trigger?.config?.connectionId || null
    if (!chat) chat = await pickChat(admin, contact, sendVia) || (sendVia ? null : await pickChat(admin, contact))

    // Filtros do bloco Início
    const cards = rules.filters?.kanbanId ? (await admin.from('kanban_cards').select('kanban_id, column_id').eq('contact_id', contact.id)).data || [] : []
    const why = passesFilters(rules.filters, { contact, chat, connectionId: chat?.connection_id ?? sendVia ?? contact.connection_id, cards })
    if (why) return { status: 'skipped', reason: `Filtro: ${why}.` }

    // Reentrada e repetição rápida
    const { data: prev } = await admin.from('flow_runs').select('started_at').eq('flow_id', flow.id).eq('contact_id', contact.id)
      .in('status', STARTED).order('started_at', { ascending: false }).limit(BURST.max)
    const block = reentryBlock(rules, prev || [], now)
    if (block) return { status: 'skipped', reason: block }
    if ((prev || []).length >= BURST.max && now.getTime() - Date.parse(prev![BURST.max - 1].started_at) < BURST.ms) {
      const reason = `Proteção contra repetição: ${BURST.max} entradas deste contato em menos de 10 minutos.`
      await record(admin, { ...base, contact_id: contact.id, chat_id: chat?.id ?? null, event_key: ev.key, status: 'alert', reason })
      return { status: 'skipped', reason }
    }

    // Contato já está num fluxo (esperando resposta ou num intervalo)
    const st = chat?.flow_state || {}
    const busy = !!st.flowId && !!(st.waiting || st.resumeAt)
    if (busy && st.flowId === flow.id && rules.ifInFlow !== 'restart') return { status: 'skipped', reason: 'O contato já está neste fluxo.' }
    if (busy && st.flowId !== flow.id && rules.ifOtherFlow === 'skip') return { status: 'skipped', reason: 'O contato está em outro fluxo.' }

    // Dias e horários permitidos
    if (!ev.skipHours && !withinHours(rules.hours, now)) {
      const at = rules.hours?.outside === 'ignore' ? null : nextWindow(rules.hours, now)
      if (!at) {
        await record(admin, { ...base, contact_id: contact.id, chat_id: chat?.id ?? null, event_key: ev.key, status: 'skipped', reason: 'Fora dos dias e horários permitidos (configurado para ignorar).' })
        return { status: 'skipped', reason: 'Fora do horário permitido.' }
      }
      await admin.from('flow_jobs').upsert({
        company_id: companyId, flow_id: flow.id, trigger_id: trigger?.id || '', kind: 'window', contact_id: contact.id, chat_id: chat?.id ?? null,
        key: `janela:${flow.id}:${ev.key || crypto.randomUUID()}`, run_at: iso(at), event: { ...ev, chain, skipHours: true },
      }, { onConflict: 'key', ignoreDuplicates: true })
      return { status: 'scheduled', reason: `Fora do horário permitido: começa em ${iso(at)}.` }
    }

    if (chat && chat.bot_active === false) {
      await record(admin, { ...base, contact_id: contact.id, chat_id: chat.id, event_key: ev.key, status: 'skipped', reason: 'As automações estão desligadas nesta conversa.' })
      return { status: 'skipped', reason: 'Automações desligadas na conversa.' }
    }

    // Registra a execução: a chave do evento faz o mesmo evento não rodar este fluxo duas vezes
    const { data: run, error } = await admin.from('flow_runs').insert({ ...base, contact_id: contact.id, chat_id: chat?.id ?? null, event_key: ev.key, status: 'running' }).select('id').single()
    if (error) {
      if (error.code === '23505') return { status: 'duplicate', reason: 'Este evento já iniciou este fluxo.' }
      throw error
    }

    if (!chat) chat = await ensureChat(admin, contact, sendVia || contact.connection_id)
    if (!chat) {
      const reason = 'O contato não tem conversa e o gatilho não tem uma conexão para falar com ele. Escolha a conexão no gatilho.'
      await setRun(admin, run.id, { status: 'error', reason })
      return { status: 'error', runId: run.id, reason }
    }
    if (!pre.chat) await admin.from('flow_runs').update({ chat_id: chat.id }).eq('id', run.id)

    // Sai do fluxo em que estava (ou recomeça este)
    if (busy) {
      await setRun(admin, st.runId, { status: 'cancelled', reason: st.flowId === flow.id ? 'Recomeçou do início por um novo evento.' : `Substituído pelo fluxo "${flow.name}".` })
      await admin.from('chats').update({ flow_state: {} }).eq('id', chat.id)
      chat.flow_state = {}
    }

    const modules = env.modules || await companyModules(admin, companyId)
    if (!modules.has('fluxos') || !modules.has('conexoes')) {
      const reason = 'Módulo Fluxos ou Conexões não liberado para a empresa.'
      await setRun(admin, run.id, { status: 'error', reason })
      return { status: 'error', runId: run.id, reason }
    }
    const secret = await connectionSecret(admin, chat.connection_id)
    const ctx: Ctx = { admin, companyId, settings: env.settings || {}, chat, contact, provider: secret?.provider ?? null, creds: secret?.credentials ?? null, modules }
    try {
      await runFrom(ctx, flow, 'start', { gatilho: ev.type, ...(ev.data || {}) }, { id: run.id, chain: [...chain, flow.id], alerts: 0 })
    } catch (e) {
      console.error('fluxo', flow.id, e)
      return { status: 'error', runId: run.id, reason: String((e as Error)?.message || e) }
    }
    return { status: 'started', runId: run.id }
  } catch (e) {
    console.error('startFlow', flow.id, e)
    return { status: 'error', reason: String((e as Error)?.message || e) }
  }
}

/* ---------- Interrupção ---------- */

// Encerra a execução deste fluxo para o contato (parada num intervalo ou esperando resposta) e o que estava agendado.
export async function stopForContact(admin: any, contactId: string, flowId: string, reason: string) {
  const { data: chats } = await admin.from('chats').select('id, flow_state').eq('contact_id', contactId).eq('flow_state->>flowId', flowId)
  for (const c of chats ?? []) {
    const { data: ok } = await admin.from('chats').update({ flow_state: {} }).eq('id', c.id).eq('flow_state->>flowId', flowId).select('id')
    if (ok?.length) await setRun(admin, c.flow_state?.runId, { status: 'cancelled', reason })
  }
  await admin.from('flow_jobs').update({ status: 'cancelled', reason }).eq('contact_id', contactId).eq('flow_id', flowId).eq('status', 'pending')
}

/* ---------- Mensagem do cliente (whatsapp-webhook) ---------- */

export type Incoming = { messageId: string; text: string; replyId?: string | null; connectionId: string; newChat: boolean; newContact: boolean; reopened: boolean }

// Devolve true quando um fluxo cuidou da mensagem (o agente de IA não responde).
export async function onContactMessage(env: Env, ctx: Ctx, m: Incoming): Promise<boolean> {
  const { admin } = env
  const { chat, contact } = ctx
  const flows = await activeFlows(admin, env.companyId)

  // Condição de interrupção "o cliente respondeu": fluxo parado num intervalo e esperas pelo horário permitido
  const stopOnReply = flows.filter((f) => f.start.rules.stopOn?.reply)
  for (const f of stopOnReply) {
    if (chat.flow_state?.flowId === f.flow.id && chat.flow_state?.resumeAt) {
      await stopForContact(admin, contact.id, f.flow.id, 'O cliente respondeu (condição de interrupção).')
      chat.flow_state = {}
    } else await admin.from('flow_jobs').update({ status: 'cancelled', reason: 'O cliente respondeu (condição de interrupção).' })
      .eq('contact_id', contact.id).eq('flow_id', f.flow.id).eq('status', 'pending').in('kind', ['window', 'schedule', 'date_field', 'stage_idle'])
  }

  // "Conversa sem resposta da equipe": a primeira mensagem sem resposta abre a espera
  for (const { flow, start } of flows) {
    for (const t of enabledTriggers(start, 'no_team_reply')) {
      if (connectionOk(t.config, m.connectionId)) await scheduleNoTeamReply(admin, flow, t, chat, contact, m).catch((e) => console.error('sem resposta da equipe', e))
    }
  }

  if (chat.flow_state?.waiting) { await resumeWithReply(ctx, m.text, m.replyId); return true }
  if (chat.flow_state?.resumeAt) return true // fluxo pausado num intervalo; o agendador retoma

  // Quem começa: palavra-chave > primeiro contato > conversa reaberta > qualquer mensagem (empate: o fluxo mais antigo)
  const cands: { flow: any; t: Trigger; rank: number }[] = []
  for (const { flow, start } of flows) {
    for (const t of enabledTriggers(start)) {
      const c = t.config || {}
      if (!connectionOk(c, m.connectionId)) continue
      if (t.type === 'message' && matchMessage(m.text, c)) cands.push({ flow, t, rank: c.mode === 'keyword' && (c.keywords || []).some((k: string) => String(k).trim()) ? 0 : 3 })
      else if (t.type === 'first_contact' && m.newChat && (!c.onlyNewContacts || m.newContact)) cands.push({ flow, t, rank: 1 })
      else if (t.type === 'reopened' && m.reopened) cands.push({ flow, t, rank: 2 })
    }
  }
  // Fluxos Padrões das Configurações (boas-vindas e reabertura de cada conexão) continuam valendo
  const cfg = env.settings?.connectionFlowConfigs?.[m.connectionId] || {}
  const legacyId = m.newChat ? cfg.welcome : m.reopened ? cfg.reopen : null
  const legacy = legacyId && flows.find((f) => f.flow.id === legacyId)
  if (legacy) cands.push({ flow: legacy.flow, t: { id: m.newChat ? 'boas-vindas' : 'reabertura', type: m.newChat ? 'first_contact' : 'reopened' }, rank: m.newChat ? 1 : 2 })
  cands.sort((a, b) => a.rank - b.rank)

  const tried = new Set<string>()
  for (const c of cands) {
    if (tried.has(c.flow.id)) continue
    tried.add(c.flow.id)
    const r = await startFlow(env, c.flow, c.t, {
      type: c.t.type, key: `msg:${m.messageId}`, contactId: contact.id, chatId: chat.id, connectionId: m.connectionId, data: { mensagem: m.text },
    }, { chat, contact })
    if (r.status !== 'skipped') return true
  }
  return false
}

async function scheduleNoTeamReply(admin: any, flow: any, t: Trigger, chat: any, contact: any, m: Incoming) {
  const c = t.config || {}
  const { data: pend } = await admin.from('flow_jobs').select('id').eq('flow_id', flow.id).eq('trigger_id', t.id).eq('chat_id', chat.id).eq('status', 'pending').limit(1)
  if (pend?.length) return
  // uma vez por espera: só abre outra depois que a equipe responder
  const senders = c.countBot ? ['agent', 'bot'] : ['agent']
  const { data: last } = await admin.from('messages').select('at').eq('chat_id', chat.id).in('sender', senders).order('at', { ascending: false }).limit(1).maybeSingle()
  const { data: fired } = await admin.from('flow_jobs').select('id').eq('flow_id', flow.id).eq('trigger_id', t.id).eq('chat_id', chat.id)
    .in('status', ['done', 'running']).gte('created_at', last?.at || '1970-01-01').limit(1)
  if (fired?.length) return
  await admin.from('flow_jobs').upsert({
    company_id: chat.company_id, flow_id: flow.id, trigger_id: t.id, kind: 'no_team_reply', contact_id: contact.id, chat_id: chat.id,
    key: `ntr:${flow.id}:${t.id}:${m.messageId}`, run_at: iso(Date.now() + toSeconds(c.amount ?? 15, c.unit ?? 'minutos') * 1000),
    event: { type: 'no_team_reply', key: `ntr:${m.messageId}`, contactId: contact.id, chatId: chat.id, connectionId: m.connectionId, data: { mensagem: m.text }, countBot: !!c.countBot },
  }, { onConflict: 'key', ignoreDuplicates: true })
}

/* ---------- Eventos do banco (flow_events) ---------- */

const overlap = (a: unknown[] = [], b: unknown[] = []) => a.some((x) => b.includes(x))
const anyOf = (list: unknown[] | undefined, v: unknown) => !list?.length || list.includes(v)

export async function processEvents(admin: any, events: any[], cache = new Map<string, Env>()) {
  const flowsBy = new Map<string, Active[]>()
  const kanbans = new Map<string, any>()
  for (const e of events) {
    try {
      const env = await companyEnv(admin, e.company_id, cache)
      if (!env.modules?.has('fluxos')) continue
      if (!flowsBy.has(e.company_id)) flowsBy.set(e.company_id, await activeFlows(admin, e.company_id))
      await handleEvent(env, flowsBy.get(e.company_id)!, e, kanbans)
    } catch (err) {
      console.error('evento', e.id, e.kind, err)
    }
  }
}

async function handleEvent(env: Env, flows: Active[], e: any, kanbans: Map<string, any>) {
  const { admin } = env
  const d = e.data || {}
  const chain: string[] = e.origin?.chain || []
  const ev = (type: string, extra: Partial<FlowEvent> = {}): FlowEvent => ({ type, key: `ev:${e.id}`, contactId: e.contact_id, chatId: e.chat_id, chain, ...extra })
  const each = async (type: string, ok: (c: Record<string, any>) => boolean, make: (t: Trigger) => FlowEvent) => {
    for (const { flow, start } of flows) {
      const t = enabledTriggers(start, type).find((x) => ok(x.config || {}))
      if (t && e.contact_id) await startFlow(env, flow, t, make(t))
    }
  }

  switch (e.kind) {
    case 'contact_created':
      return each('contact_created', (c) => anyOf(c.origins, d.origin) && anyOf(c.connections, d.connectionId),
        () => ev('contact_created', { connectionId: d.connectionId, data: { origem: d.origin } }))

    case 'tag': {
      const labels: string[] = d.labels || []
      if (d.action === 'added') {
        for (const f of flows) {
          if (overlap(f.start.rules.stopOn?.labels, labels)) await stopForContact(admin, e.contact_id, f.flow.id, 'Etiqueta adicionada (condição de interrupção).')
        }
      }
      return each('tag', (c) => (c.action || 'added') === d.action && (!c.labels?.length || overlap(c.labels, labels)),
        () => ev('tag', { data: { etiqueta_acao: d.action === 'added' ? 'adicionada' : 'removida' } }))
    }

    case 'field_updated': {
      const changed: string[] = d.fields || []
      const want = flows.some((f) => enabledTriggers(f.start, 'field_updated').some((t) => changed.includes(t.config?.field)))
      if (!want) return
      const { data: contact } = await admin.from('contacts').select('*').eq('id', e.contact_id).maybeSingle()
      if (!contact) return
      return each('field_updated', (c) => changed.includes(c.field) && compareValue(fieldValue(contact, c.field), c.op || 'any', c.value),
        (t) => ev('field_updated', { data: { campo: t.config?.field, valor: String(fieldValue(contact, t.config?.field) ?? '') } }))
    }

    case 'deal': {
      let k = kanbans.get(d.kanbanId)
      if (!k) {
        k = (await admin.from('kanbans').select('id, name, columns').eq('id', d.kanbanId).maybeSingle()).data
        kanbans.set(d.kanbanId, k)
      }
      const cols: any[] = k?.columns || []
      const to = cols.find((c) => c.id === d.to)
      const from = cols.find((c) => c.id === d.from)
      const vars = { funil: k?.name || '', etapa: to?.name || '', etapa_anterior: from?.name || '' }
      // Interrupção: negócio chegou na etapa (sem etapas escolhidas = etapa de conversão, "ganho")
      for (const f of flows) {
        const s = f.start.rules.stopOn || {}
        if (e.contact_id && s.kanbanId === d.kanbanId && (s.columns?.length ? s.columns.includes(d.to) : !!to?.conversion)) {
          await stopForContact(admin, e.contact_id, f.flow.id, `Negócio chegou em "${to?.name || 'etapa'}" (condição de interrupção).`)
        }
      }
      await each('deal', (c) => anyOf(c.kanbanId ? [c.kanbanId] : [], d.kanbanId) && (!c.event || c.event === 'any' || c.event === d.event)
        && anyOf(c.toColumns, d.to) && (!c.fromColumns?.length || (d.event === 'moved' && c.fromColumns.includes(d.from))),
        () => ev('deal', { data: vars }))
      const result = to?.conversion ? 'won' : to?.lost ? 'lost' : null
      if (result) await each('deal_result', (c) => (c.result || 'won') === result && anyOf(c.kanbanId ? [c.kanbanId] : [], d.kanbanId), () => ev('deal_result', { data: { ...vars, resultado: result === 'won' ? 'ganho' : 'perdido' } }))
      // Tempo parado na etapa: agenda a partir de quando o card entrou; o tick confere se ele continua lá
      for (const { flow, start } of flows) {
        for (const t of enabledTriggers(start, 'stage_idle')) {
          const c = t.config || {}
          if (!e.contact_id || c.kanbanId !== d.kanbanId || c.columnId !== d.to) continue
          const since = d.since ? Date.parse(d.since) : Date.now()
          await admin.from('flow_jobs').upsert({
            company_id: e.company_id, flow_id: flow.id, trigger_id: t.id, kind: 'stage_idle', contact_id: e.contact_id, chat_id: null,
            key: `idle:${flow.id}:${t.id}:${d.cardId}:${since}`, run_at: iso(since + toSeconds(c.amount ?? 1, c.unit ?? 'dias') * 1000),
            event: { type: 'stage_idle', key: `idle:${d.cardId}:${since}`, contactId: e.contact_id, chain, data: vars, cardId: d.cardId, columnId: d.to, since: d.since },
          }, { onConflict: 'key', ignoreDuplicates: true })
        }
      }
      return
    }

    case 'assignee':
      return each('assignee', (c) => (!c.scope || c.scope === 'any' || c.scope === d.scope) && (!c.to || c.to === d.to),
        () => ev('assignee', { data: { responsavel_mudou: d.scope === 'deal' ? 'negócio' : 'conversa' } }))

    case 'outbound':
      return scheduleNoClientReply(env, flows, e)
  }
}

// "Cliente sem responder": a última mensagem enviada ao cliente (pela equipe, IA ou fluxo) abre ou estica a espera.
async function scheduleNoClientReply(env: Env, flows: Active[], e: any) {
  const { admin } = env
  const d = e.data || {}
  const list = flows.flatMap(({ flow, start }) => enabledTriggers(start, 'no_client_reply').map((t) => ({ flow, t })))
  if (!list.length) return
  const { data: chat } = await admin.from('chats').select('id, company_id, contact_id, connection_id').eq('id', e.chat_id).maybeSingle()
  if (!chat) return
  const { data: lastIn } = await admin.from('messages').select('at').eq('chat_id', chat.id).eq('sender', 'contact').order('at', { ascending: false }).limit(1).maybeSingle()
  for (const { flow, t } of list) {
    const c = t.config || {}
    if (!connectionOk(c, chat.connection_id) || (c.onlyTeam && d.sender !== 'agent')) continue
    const runAt = iso(Date.parse(d.at || iso(Date.now())) + toSeconds(c.amount ?? 1, c.unit ?? 'horas') * 1000)
    const { data: pend } = await admin.from('flow_jobs').select('id, event').eq('flow_id', flow.id).eq('trigger_id', t.id).eq('chat_id', chat.id).eq('status', 'pending').limit(1).maybeSingle()
    if (pend) {
      await admin.from('flow_jobs').update({ run_at: runAt, event: { ...pend.event, data: { ...(pend.event?.data || {}), desde: d.at } } }).eq('id', pend.id)
      continue
    }
    // uma vez por silêncio: depois de disparar, só volta a contar quando o cliente responder
    const { data: fired } = await admin.from('flow_runs').select('id').eq('flow_id', flow.id).eq('chat_id', chat.id).eq('trigger_type', 'no_client_reply')
      .gte('started_at', lastIn?.at || '1970-01-01').limit(1)
    if (fired?.length) continue
    await admin.from('flow_jobs').upsert({
      company_id: chat.company_id, flow_id: flow.id, trigger_id: t.id, kind: 'no_client_reply', contact_id: chat.contact_id, chat_id: chat.id,
      key: `ncr:${flow.id}:${t.id}:${d.messageId}`, run_at: runAt,
      event: { type: 'no_client_reply', key: `ncr:${d.messageId}`, contactId: chat.contact_id, chatId: chat.id, connectionId: chat.connection_id, data: { desde: d.at } },
    }, { onConflict: 'key', ignoreDuplicates: true })
  }
}

/* ---------- Agendamentos (flow_jobs) ---------- */

export async function processJobs(admin: any, jobs: any[], cache = new Map<string, Env>(), deadline = Date.now() + 60_000) {
  for (const job of jobs) {
    if (Date.now() > deadline) {
      await admin.from('flow_jobs').update({ status: 'pending' }).eq('id', job.id).eq('status', 'running')
      continue
    }
    let out: { status: string; reason?: string | null; run_id?: string | null }
    try {
      out = await runJob(admin, job, cache)
    } catch (e) {
      console.error('agendamento', job.id, e)
      out = { status: 'error', reason: String((e as Error)?.message || e).slice(0, 300) }
    }
    await admin.from('flow_jobs').update(out).eq('id', job.id)
  }
}

async function runJob(admin: any, job: any, cache: Map<string, Env>) {
  const cancel = (reason: string) => ({ status: 'cancelled', reason })
  const ev = job.event || {}
  const env = await companyEnv(admin, job.company_id, cache)
  if (!env.modules?.has('fluxos')) return cancel('Módulo Fluxos não liberado para a empresa.')
  const { data: flow } = await admin.from('flows').select('id, name, status, nodes, edges').eq('id', job.flow_id).maybeSingle()
  if (!flow || flow.status !== 'active') return cancel('O fluxo foi pausado ou excluído.')
  const start = startOf(flow.nodes)
  const trig = start.triggers.find((t) => t.id === job.trigger_id) || null
  if (job.kind !== 'window' && (!trig || trig.enabled === false)) return cancel('O gatilho foi removido ou desligado.')

  // Revalida: a condição ainda vale agora?
  switch (job.kind) {
    case 'no_team_reply': {
      const { data } = await admin.from('messages').select('id').eq('chat_id', job.chat_id).in('sender', ev.countBot ? ['agent', 'bot'] : ['agent']).gt('at', job.created_at).limit(1)
      if (data?.length) return cancel('A equipe respondeu antes do prazo.')
      break
    }
    case 'no_client_reply': {
      const { data } = await admin.from('messages').select('id').eq('chat_id', job.chat_id).eq('sender', 'contact').gt('at', ev.data?.desde || job.created_at).limit(1)
      if (data?.length) return cancel('O cliente respondeu antes do prazo.')
      break
    }
    case 'stage_idle': {
      const { data: card } = await admin.from('kanban_cards').select('column_id, extra').eq('id', ev.cardId).maybeSingle()
      if (!card || card.column_id !== ev.columnId || (ev.since && card.extra?.columnSince && Date.parse(card.extra.columnSince) !== Date.parse(ev.since))) {
        return cancel('O negócio saiu da etapa antes do prazo.')
      }
      break
    }
    case 'date_field': {
      const ok = await dateStillMatches(admin, trig!, job.contact_id, ev.target)
      if (!ok) return cancel('A data do contato mudou.')
      break
    }
    case 'fanout':
      return fanOut(admin, flow, trig!, job)
  }

  const r = await startFlow(env, flow, trig || { id: job.trigger_id, type: ev.type || job.kind }, { ...ev, type: ev.type || trig?.type || job.kind, contactId: ev.contactId || job.contact_id })
  return { status: r.status === 'skipped' ? 'cancelled' : r.status === 'error' ? 'error' : 'done', reason: r.reason || null, run_id: r.runId || null }
}

/* ---------- Datas ---------- */

// A cada rodada: gatilhos de data e de horário programado com ocorrência na última hora viram uma distribuição (fanout).
export async function queueSchedules(admin: any, now = new Date()) {
  const { data: flows } = await admin.from('flows').select('id, company_id, nodes').eq('status', 'active').overlaps('trigger_types', ['schedule', 'date_field'])
  for (const flow of flows ?? []) {
    const start = startOf(flow.nodes)
    for (const t of [...enabledTriggers(start, 'schedule'), ...enabledTriggers(start, 'date_field')]) {
      const c = t.config || {}
      const occ = t.type === 'schedule' ? lastOccurrence(c, now) : lastOccurrence({ mode: 'daily', time: c.time, tz: c.tz, createdAt: c.createdAt }, now)
      if (!occ || now.getTime() - occ.getTime() > 3600_000) continue
      const p = zonedParts(occ, c.tz || DEFAULT_TZ)
      const label = t.type === 'schedule' ? occ.toISOString() : ymdKey(p)
      await admin.from('flow_jobs').upsert({
        company_id: flow.company_id, flow_id: flow.id, trigger_id: t.id, kind: 'fanout', key: `occ:${flow.id}:${t.id}:${label}`, run_at: iso(now),
        event: { type: t.type, occurrence: label, today: { y: p.y, m: p.m, d: p.d } },
      }, { onConflict: 'key', ignoreDuplicates: true })
    }
  }
}

const AUDIENCE_MAX = 5000

async function pages(q: () => any, max = 20000) {
  const out: any[] = []
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await q().range(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return out
}

// Um agendamento por contato do público (o tick executa aos poucos).
async function fanOut(admin: any, flow: any, t: Trigger, job: any) {
  const c = t.config || {}
  const ev = job.event || {}
  const rows: any[] = []
  if (t.type === 'schedule') {
    const a = c.audience || {}
    const contacts = await pages(() => admin.from('contacts').select('id, labels, connection_id').eq('company_id', job.company_id).order('created_at'))
    for (const k of contacts) {
      if (rows.length >= AUDIENCE_MAX) break
      const labels: string[] = k.labels || []
      if (a.labelsAny?.length && !overlap(a.labelsAny, labels)) continue
      if (a.labelsNone?.length && overlap(a.labelsNone, labels)) continue
      if (a.connections?.length && !a.connections.includes(k.connection_id)) continue
      rows.push({ contact_id: k.id, key: `sch:${flow.id}:${t.id}:${ev.occurrence}:${k.id}`,
        event: { type: 'schedule', key: `sch:${t.id}:${ev.occurrence}:${k.id}`, contactId: k.id, connectionId: c.connectionId || null, data: {} } })
    }
  } else {
    const target = dateTarget(ev.today, c.when || 'on', c.days)
    for (const id of await contactsOnDate(admin, job.company_id, c, target)) {
      if (rows.length >= AUDIENCE_MAX) break
      rows.push({ contact_id: id, key: `date:${flow.id}:${t.id}:${id}:${ymdKey(target)}`,
        event: { type: 'date_field', key: `date:${t.id}:${ymdKey(target)}:${id}`, contactId: id, connectionId: c.connectionId || null, target, data: { data_alvo: ymdKey(target) } } })
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await admin.from('flow_jobs').upsert(rows.slice(i, i + 500).map((r) => ({
      company_id: job.company_id, flow_id: flow.id, trigger_id: t.id, kind: t.type, chat_id: null, run_at: iso(Date.now()), ...r,
    })), { onConflict: 'key', ignoreDuplicates: true })
  }
  return { status: 'done', reason: `${rows.length} contato(s) na fila.` }
}

async function contactsOnDate(admin: any, companyId: string, c: Record<string, any>, target: Ymd): Promise<string[]> {
  const tz = c.tz || DEFAULT_TZ
  const hit = (v: unknown) => { const d = parseDate(v, tz); return !!d && sameDay(d, target, !!c.yearly) }
  if (c.source === 'created_at') {
    const list = await pages(() => admin.from('contacts').select('id, created_at').eq('company_id', companyId).order('created_at'))
    return list.filter((k) => hit(k.created_at)).map((k) => k.id)
  }
  if (!c.field) return []
  const list = await pages(() => admin.from('contacts').select('id, fields').eq('company_id', companyId).not(`fields->>${c.field}`, 'is', null).order('created_at'))
  return list.filter((k) => hit(k.fields?.[c.field])).map((k) => k.id)
}

async function dateStillMatches(admin: any, t: Trigger, contactId: string, target: Ymd | undefined) {
  if (!target) return true
  const c = t.config || {}
  const tz = c.tz || DEFAULT_TZ
  const { data } = await admin.from('contacts').select('created_at, fields').eq('id', contactId).maybeSingle()
  const v: unknown = c.source === 'created_at' ? data?.created_at : data?.fields?.[c.field]
  const d = parseDate(v, tz)
  return !!d && sameDay(d, target, !!c.yearly)
}

/* ---------- Limpeza ---------- */

export async function cleanup(admin: any) {
  const ago = (days: number) => iso(Date.now() - days * 86400_000)
  await admin.from('flow_events').delete().lt('processed_at', ago(2))
  await admin.from('flow_jobs').delete().in('status', ['done', 'cancelled', 'error']).lt('updated_at', ago(30))
  await admin.from('webhook_events').delete().lt('received_at', ago(30))
  await admin.from('flow_runs').delete().not('finished_at', 'is', null).lt('finished_at', ago(180))
}
