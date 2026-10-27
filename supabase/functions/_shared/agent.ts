// Agente de IA no atendimento (servidor). Caminho de uma mensagem:
//   whatsapp-webhook grava a mensagem → scheduleReply marca "responder em N s" (agrupamento) e acorda ai-agent →
//   runChat espera o prazo (mensagem nova reinicia), trava a conversa e chama processTurn →
//   processTurn confere se a IA continua ativa, monta o contexto (instruções, conhecimento, histórico, dados do contato),
//   conversa com o provedor executando as ferramentas (ações reais) e, conferindo de novo, envia a resposta.
// Toda execução fica registrada em public.ai_runs (Configurações → Uso da IA).
import { AiError, audioSupport, chat, imageType, loadCreds, pickChatCred, synthesize, toBase64, transcribe, type AiCred, type ChatMsg, type ChatPart, type Creds, type ParsedCall, type ToolDef } from './ai.ts'
import { mediaKind, recipientOf, sendMedia, sendText, sendTyping, type Creds as WaCreds, type Provider } from './whatsapp.ts'
import { companyModules } from './access.ts'
import { connectionSecret } from './secrets.ts'
import { loadFlow, type Ctx as FlowCtx } from './flow.ts'
import { startFlow } from './triggers.ts'
import { startOf } from './triggers-core.ts'
import { agentConfig, blockReason, fieldKey, motivoFalha, note, prometeuHumano, resolveAgent, toWaiting, type AgentCfg, colunaPausada } from './agent-core.ts'
import { exigirSaldo, SemCreditos } from './carteira.ts'

export { agentConfig, blockReason, fieldKey, numberAllowed, resolveAgent } from './agent-core.ts'

export const LOCK_SECONDS = 150
const MAX_ROUNDS = 6 // voltas com o provedor num turno (cada volta pode executar ferramentas)
const HISTORY = 40 // mensagens recentes que vão para a IA
const MAX_IMAGES = 3 // imagens do cliente por turno
const MAX_IMAGE_BYTES = 3_750_000
const DAILY_CAP = 80 // respostas da IA por conversa por dia (proteção contra loop com outro robô)
const KNOWLEDGE_INLINE = 30_000 // até isso o conhecimento vai inteiro; acima, a IA consulta por busca
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------- Execução (função ai-agent) ---------- */

// Espera o agrupamento vencer, trava a conversa e responde. Mensagens que chegam durante a resposta
// reagendam a conversa; o laço pega de novo até não sobrar nada (ou o prazo da função acabar: o flow-tick continua).
export async function runChat(admin: any, chatId: string, deadline: number, lockSeconds = LOCK_SECONDS) {
  for (let i = 0; i < 20 && Date.now() < deadline - 2000; i++) {
    const { data: c, error } = await admin.rpc('ai_claim', { p_chat: chatId, p_lock_seconds: lockSeconds })
    if (error) { console.error('ai_claim', error.message); return }
    if (c.state === 'none' || c.state === 'locked') return // nada pendente, ou outra execução cuida (ela repete o laço)
    if (c.state === 'wait') { await sleep(Math.min(+c.ms + 150, Math.max(0, deadline - Date.now() - 2000))); continue }
    if (c.state === 'retry') { await sleep(300); continue }
    try {
      await processTurn(admin, chatId, deadline)
    } catch (e) {
      console.error('turno da IA', chatId, e)
    } finally {
      await admin.rpc('ai_release', { p_chat: chatId })
    }
  }
}

type Turn = {
  admin: any
  chat: any
  contact: any
  company: any
  agent: AgentCfg
  mods: Set<string>
  provider: Provider | null
  creds: WaCreds | null
  ai: Creds
  dryRun: boolean
  refs: Refs
  actions: { tool: string; ok: boolean; detail: string }[]
  transferred: boolean
  flowStarted: boolean
  audioText: string | null
  seenAt: string // horário da última mensagem que a IA leu neste turno
}

type Run = { status: string; reason: string; provider: string; model: string; input: number; output: number; error: string | null }

export async function processTurn(admin: any, chatId: string, deadline = Date.now() + 125_000) {
  const t0 = Date.now()
  const run: Run = { status: 'pulou', reason: '', provider: '', model: '', input: 0, output: 0, error: null }
  let turn: Turn | null = null
  let chat: any = null
  let pendentes = 0 // mensagens do cliente esperando resposta neste turno
  try {
    const { data } = await admin.from('chats').select('*').eq('id', chatId).maybeSingle()
    chat = data
    if (!chat) return
    const [{ data: contact }, { data: secret }, { data: company }, mods, agent] = await Promise.all([
      admin.from('contacts').select('*').eq('id', chat.contact_id).single(),
      connectionSecret(admin, chat.connection_id).then((data) => ({ data })),
      admin.from('companies').select('id, name, timezone, settings').eq('id', chat.company_id).single(),
      companyModules(admin, chat.company_id),
      resolveAgent(admin, chat),
    ])
    const why = blockReason(chat, agent, mods, contact)
    if (why) { run.reason = why; return }
    const pausa = await colunaPausada(admin, chat.company_id, chat.contact_id)
    if (pausa) { run.reason = `negócio em "${pausa}" no Kanban`; return }

    const history = await loadHistory(admin, chat)
    const pending = trailingFromContact(history)
    pendentes = pending.length
    const st = chat.ai_state || {}
    if (!pending.length && !st.handoff) { run.reason = 'nenhuma mensagem do cliente para responder'; return }

    turn = {
      admin, chat, contact, company, agent: agent!, mods, provider: secret?.provider ?? null, creds: secret?.credentials ?? null,
      ai: {}, dryRun: false, refs: emptyRefs(), actions: [], transferred: false, flowStarted: false, audioText: null,
      seenAt: history[history.length - 1]?.at ?? new Date(0).toISOString(),
    }
    const tz = company?.timezone || 'America/Sao_Paulo'

    // Horário comercial: fora dele avisa (uma vez a cada 6 h) e deixa na fila.
    if (turn.agent.settings.businessHours && !isOpen(company?.settings?.businessHours, tz, new Date())) {
      const last = st.offHoursAt ? Date.parse(st.offHoursAt) : 0
      if (Date.now() - last > 6 * 3600_000) {
        await sendParts(turn, [offHoursText(company?.settings?.businessHours, tz, new Date())])
        await saveState(turn, { offHoursAt: new Date().toISOString() })
      }
      await admin.from('chats').update({ status: 'waiting' }).eq('id', chat.id)
      run.reason = 'fora do horário comercial'
      return
    }

    // Limites: respostas por dia e conversa sem avanço → passa para um humano.
    const today = dayKey(tz)
    const count = st.day === today ? +st.count || 0 : 0
    if (count >= DAILY_CAP) {
      await transfer(turn, `limite de ${DAILY_CAP} respostas da IA no dia nesta conversa`)
      run.status = 'transferiu'; run.reason = 'limite diário'
      return
    }
    if (turn.agent.settings.stopNoProgress && noProgress(history)) {
      await transfer(turn, 'a conversa parou de avançar (mensagens repetidas)')
      run.status = 'transferiu'; run.reason = 'sem avanço'
      return
    }

    turn.ai = await loadCreds(admin, chat.company_id, { origem: 'atendimento', agentId: turn.agent.id, chatId: chat.id })
    const cred = pickChatCred(turn.ai, turn.agent.settings.aiProvider)
    if (!cred) {
      await warnOnce(turn, 'nokey', '⚠️ A IA não respondeu: nenhuma chave de IA conectada. Conecte em Configurações → Integrações.')
      if (pending.length) await toWaiting(admin, chat, 'a IA não respondeu: nenhuma chave de IA conectada')
      run.status = 'erro'; run.reason = 'sem chave de IA'
      return
    }
    run.provider = cred.provider; run.model = cred.model
    // IA da plataforma: sem Créditos de IA, nem começa (lança SemCreditos; a conversa vai para a equipe)
    if (cred.medidor) await exigirSaldo(cred.medidor)

    await prepareMedia(turn, pending)
    turn.refs = await loadRefs(admin, turn.agent)
    const tools = buildTools(turn)
    const messages: ChatMsg[] = [{ role: 'system', content: buildSystem(turn, tools.defs.map((t) => t.function.name)) }, ...toChat(turn, history, pending)]
    if (!pending.length && st.handoff) messages.push({ role: 'user', content: '[registro do sistema — não é mensagem do cliente] A conversa acabou de ser entregue a você por um fluxo. Continue o atendimento a partir do histórico.' })

    const reply = await converse(turn, cred, messages, tools, run)

    // Antes de enviar: a IA continua ativa nesta conversa? (pausa, transferência por humano, bot desligado...)
    // E ninguém da equipe respondeu enquanto ela pensava (a pausa por mensagem humana pode chegar um instante depois).
    const { data: fresh } = await admin.from('chats').select('*').eq('id', chat.id).single()
    if (await humanReplied(turn)) { run.reason = 'não enviada: um atendente respondeu enquanto a IA preparava a resposta'; return }
    if (!turn.transferred) {
      const agentNow = await resolveAgent(admin, fresh)
      const why2 = blockReason(fresh, agentNow, mods, contact)
      if (why2 && !(turn.flowStarted && why2.startsWith('um fluxo'))) { run.reason = `não enviada: ${why2}`; return }
    } else if (!fresh.bot_active) { run.reason = 'não enviada: bot desligado'; return }

    let sent = 0
    if (turn.audioText) sent += await sendVoice(turn, turn.audioText, reply)
    else if (reply) sent += await sendParts(turn, splitReply(reply, turn.agent.settings.split, turn.agent.settings.sign ? turn.agent.name : ''))

    // A IA não resolveu e não transferiu: prometeu uma pessoa da equipe, ou o cliente ficou sem resposta.
    const agiu = turn.flowStarted || turn.actions.some((x) => x.ok && (x.tool === 'enviar_arquivo' || x.tool === 'executar_habilidade'))
    if (!turn.transferred && sent && prometeuHumano(reply || turn.audioText || '')) {
      await transfer(turn, 'a IA disse ao cliente que alguém da equipe ia continuar')
    } else if (!turn.transferred && !sent && pending.length && !agiu) {
      await toWaiting(admin, chat, 'a IA não respondeu à última mensagem do cliente', { textOnce: '⚠️ A IA não respondeu à última mensagem do cliente. A conversa foi para Aguardando.' })
    }

    const patch: Record<string, unknown> = { answered: true }
    // a IA está atendendo (menos quando a conversa espera alguém da equipe)
    if (!turn.transferred && fresh.status === 'waiting' && sent && !fresh.ai_state?.precisaHumano) patch.status = 'attending'
    if (!sent && !turn.transferred && !agiu) delete patch.answered
    await admin.from('chats').update(patch).eq('id', chat.id)
    const said = norm(reply || turn.audioText || '')
    await saveState(turn, { day: today, count: count + (sent ? 1 : 0), handoff: null, lastReplies: [...(st.lastReplies || []), ...(said ? [said] : [])].slice(-3) })
    run.status = turn.transferred ? 'transferiu' : sent ? 'respondeu' : 'sem_resposta'
  } catch (e) {
    if (e instanceof SemCreditos && chat) {
      // Sem saldo: nenhuma chamada nova à IA. O atendimento manual continua; a conversa vai para Aguardando.
      run.status = 'sem_credito'; run.reason = e.motivo === 'carteira_inativa' ? 'IA da plataforma não liberada' : 'sem Créditos de IA'
      const aviso = e.motivo === 'carteira_inativa'
        ? '⚠️ A IA não respondeu: a IA da plataforma não está liberada para esta empresa.'
        : '⚠️ A IA não respondeu: acabaram os Créditos de IA da empresa. Recarregue em Créditos de IA; enquanto isso, a equipe atende por aqui.'
      if (turn) await warnOnce(turn, 'semcredito', aviso).catch(() => undefined)
      if (pendentes) await toWaiting(admin, chat, `a IA não respondeu: ${run.reason}`).catch((x) => console.error('toWaiting', x))
      return
    }
    run.status = 'erro'
    run.error = (e as Error)?.message || String(e)
    console.error('processTurn', chatId, e)
    const avisou = !!turn && e instanceof AiError && ['auth', 'config', 'modelo', 'limite'].includes(e.kind)
    if (avisou) await warnOnce(turn!, `err_${(e as AiError).kind}`, `⚠️ A IA não respondeu: ${(e as AiError).message} Confira em Configurações → Integrações.`).catch(() => undefined)
    // O cliente ficou sem resposta: a conversa vai para Aguardando com o motivo.
    if (chat && pendentes) {
      const motivo = e instanceof AiError ? e.message : motivoFalha(run.error)
      await toWaiting(admin, chat, `a IA não respondeu: ${motivo}`, avisou ? {} : { textOnce: `⚠️ A IA não conseguiu responder (${motivo}). A conversa foi para Aguardando.` })
        .catch((x) => console.error('toWaiting', x))
    }
  } finally {
    if (chat) {
      await admin.from('ai_runs').insert({
        company_id: chat.company_id, chat_id: chat.id, agent_id: turn?.agent.id ?? null, status: run.status, reason: run.reason.slice(0, 300),
        provider: run.provider, model: run.model, input_tokens: run.input, output_tokens: run.output,
        actions: turn?.actions ?? [], error: run.error?.slice(0, 1000) ?? null, ms: Date.now() - t0,
      }).then(({ error }: any) => error && console.error('ai_runs', error.message))
    }
  }
}

// Conversa com o provedor executando as ferramentas pedidas. Devolve o texto final para o cliente.
async function converse(turn: Turn, cred: AiCred, messages: ChatMsg[], tools: Tools, run: Run) {
  let text = ''
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await chat(cred, { messages, tools: tools.defs })
    run.input += r.usage.input
    run.output += r.usage.output
    if (r.model) run.model = r.model
    if (!r.calls.length) { text = r.text; break }
    messages.push(r.message)
    for (const call of r.calls) {
      const out = await execTool(turn, tools, call)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) })
    }
    if (round === MAX_ROUNDS - 1) text = r.text
  }
  return text.trim()
}

/* ---------- Histórico ---------- */

async function loadHistory(admin: any, chat: any) {
  const { data } = await admin.from('messages').select('id, sender, text, type, media_url, at, extra')
    .eq('chat_id', chat.id).eq('company_id', chat.company_id).order('at', { ascending: false }).limit(HISTORY)
  return (data ?? []).reverse()
}

// Mensagens do cliente depois da última fala da empresa (IA, fluxo ou atendente): o que ainda não teve resposta.
function trailingFromContact(history: any[]) {
  const out: any[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.sender === 'sys') continue
    if (m.sender !== 'contact') break
    out.unshift(m)
  }
  return out
}

const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

// Cliente repetindo a mesma coisa 3 vezes, ou a IA dando a mesma resposta 3 vezes: a conversa não está andando.
// Áudio, foto e documento não contam pelo texto de exibição ("🎤 Áudio" é igual em todos): áudio vale pela
// transcrição; mídia sem texto próprio nunca é "repetida".
export function noProgress(history: any[]) {
  const said = (m: any) => m.extra?.transcript || (m.type && m.type !== 'text' ? '' : m.text)
  const last3 = (sender: string, onlyAi = false) =>
    history.filter((m) => m.sender === sender && (!onlyAi || m.extra?.agentId)).slice(-3).map((m) => norm(said(m)))
  const same = (a: string[]) => a.length === 3 && a[0].length > 3 && a.every((x) => x === a[0])
  return same(last3('contact')) || same(last3('bot', true))
}

// Áudios do cliente viram texto (se o agente ouve áudio) e imagens vão para a IA (se ela vê imagem).
async function prepareMedia(turn: Turn, pending: any[]) {
  const s = turn.agent.settings
  const audios = pending.filter((m) => m.type === 'audio' && m.media_url && !m.extra?.transcript)
  if (s.hearAudio && audios.length && audioSupport(turn.ai).hear) {
    for (const m of audios) {
      try {
        const file = await download(turn.admin, 'whatsapp-media', m.media_url)
        const t = file && (await transcribe(turn.ai, file.bytes, file.mime))
        if (t?.text) {
          m.extra = { ...(m.extra || {}), transcript: t.text }
          await turn.admin.from('messages').update({ extra: m.extra }).eq('id', m.id)
        }
      } catch (e) {
        if (e instanceof SemCreditos) throw e
        console.error('transcrição', e)
      }
    }
  }
  if (s.seeImage) {
    let n = 0
    for (const m of [...pending].reverse()) {
      if (n >= MAX_IMAGES) break
      if (!['image', 'sticker'].includes(m.type) || !m.media_url) continue
      try {
        const file = await download(turn.admin, 'whatsapp-media', m.media_url)
        const mime = file && imageType(file.bytes)
        if (!file || !mime || file.bytes.byteLength > MAX_IMAGE_BYTES) continue
        m._image = `data:${mime};base64,${toBase64(file.bytes)}`
        n++
      } catch (e) { console.error('imagem', e) }
    }
  }
}

async function download(admin: any, bucket: string, path: string) {
  const { data, error } = await admin.storage.from(bucket).download(path)
  if (error || !data) return null
  return { bytes: new Uint8Array(await data.arrayBuffer()), mime: (data.type || '').split(';')[0] }
}

function describeContact(m: any, s: AgentCfg['settings']) {
  const caption = m.text && !/^(📷 Imagem|🎤 Áudio|🎥 Vídeo|🔖 Figurinha)$/.test(m.text) ? m.text : ''
  switch (m.type) {
    case 'audio':
      if (m.extra?.transcript) return `[áudio transcrito] ${m.extra.transcript}`
      return s.hearAudio ? '[o cliente mandou um áudio que não deu para transcrever; peça com gentileza para escrever]' : '[o cliente mandou um áudio; você não ouve áudios, peça com gentileza para escrever]'
    case 'image':
    case 'sticker':
      if (m._image) return `[${m.type === 'sticker' ? 'figurinha' : 'imagem'} enviada]${caption ? ` ${caption}` : ''}`
      return `[o cliente mandou uma ${m.type === 'sticker' ? 'figurinha' : 'imagem'}${s.seeImage ? ' que não deu para abrir' : '; você não vê imagens'}]${caption ? ` Legenda: ${caption}` : ''}`
    case 'video': return `[o cliente mandou um vídeo; você não assiste vídeos]${caption ? ` Legenda: ${caption}` : ''}`
    case 'document': return `[o cliente mandou um documento: ${m.text}]`
    default: return m.text || ''
  }
}

// Histórico no formato do provedor. Mensagens seguidas do mesmo lado viram uma só e a primeira é sempre do cliente.
function toChat(turn: Turn, history: any[], pending: any[]): ChatMsg[] {
  const pendingIds = new Set(pending.map((m) => m.id))
  const raw: { role: 'user' | 'assistant'; parts: ChatPart[] }[] = []
  for (const m of history) {
    let role: 'user' | 'assistant'
    let text: string
    if (m.sender === 'contact') { role = 'user'; text = describeContact(m, turn.agent.settings) }
    else if (m.sender === 'bot') { role = 'assistant'; text = m.text }
    else if (m.sender === 'agent') { role = 'assistant'; text = `[atendente humano] ${m.text}` }
    else { role = 'user'; text = `[registro do sistema — não é mensagem do cliente] ${m.text}` }
    if (!text) continue
    const parts: ChatPart[] = [{ type: 'text', text }]
    if (m._image && pendingIds.has(m.id)) parts.push({ type: 'image_url', image_url: { url: m._image } })
    const prev = raw[raw.length - 1]
    if (prev && prev.role === role) prev.parts.push(...parts)
    else raw.push({ role, parts })
  }
  while (raw.length && raw[0].role === 'assistant') raw.shift()
  return raw.map((r) => {
    const onlyText = r.parts.every((p) => p.type === 'text')
    const content = onlyText ? r.parts.map((p) => (p as any).text).join('\n') : r.parts
    return r.role === 'assistant' ? { role: 'assistant', content: content as string } : { role: 'user', content }
  })
}

/* ---------- Referências (nomes de fluxos, etiquetas, quadros...) ---------- */

type Refs = { flows: any[]; labels: any[]; kanbans: any[]; products: any[]; departments: any[]; members: any[] }
const emptyRefs = (): Refs => ({ flows: [], labels: [], kanbans: [], products: [], departments: [], members: [] })

async function loadRefs(admin: any, agent: AgentCfg): Promise<Refs> {
  if (!agent.skills.length) return emptyRefs()
  const cid = agent.companyId
  const [flows, labels, kanbans, products, departments, members] = await Promise.all([
    admin.from('flows').select('id, name, status').eq('company_id', cid),
    admin.from('labels').select('id, name').eq('company_id', cid),
    admin.from('kanbans').select('id, name, columns').eq('company_id', cid),
    admin.from('products').select('id, name, price, currency').eq('company_id', cid),
    admin.from('departments').select('id, name').eq('company_id', cid),
    admin.from('company_members').select('id, name').eq('company_id', cid),
  ])
  return { flows: flows.data ?? [], labels: labels.data ?? [], kanbans: kanbans.data ?? [], products: products.data ?? [], departments: departments.data ?? [], members: members.data ?? [] }
}

// Fluxo da habilidade: pelo id escolhido na tela ou, nas habilidades antigas, pelo nome ("Disparar fluxo "Nome"").
function skillFlow(turn: Turn, s: any) {
  if (s.flowId) return turn.refs.flows.find((f) => f.id === s.flowId) || null
  const m = /^Disparar fluxo "(.+)"$/.exec(s.action || '')
  return m ? turn.refs.flows.find((f) => f.name === m[1]) || null : null
}
const skillKind = (s: any) => (/^Disparar fluxo/.test(s.action || '') ? 'Disparar fluxo' : s.action)

// Habilidade "Agendar no Vórtex Call": vira as ferramentas ver_horarios e agendar_horario (API pública de agendamento do Call)
const AGENDA_CALL = 'Agendar no Vórtex Call'
// Endereço do Vórtex Call: o da habilidade (callUrl, preenchido na tela) ou o padrão da plataforma (VORTEX_CALL_URL)
const CALL_URL = Deno.env.get('VORTEX_CALL_URL') || ''
const callSkillOf = (a: AgentCfg) => a.skills.find((s) => skillKind(s) === AGENDA_CALL && String(s.agenda || '').trim() && /^https:\/\//.test(String(s.callUrl || CALL_URL)))
const callBase = (s: any) => String(s.callUrl || CALL_URL).replace(/\/+$/, '') + '/api/agendamento/' + encodeURIComponent(String(s.agenda).trim())

function describeSkill(turn: Turn, s: any) {
  const r = turn.refs
  switch (skillKind(s)) {
    case 'Disparar fluxo': return `dispara o fluxo "${skillFlow(turn, s)?.name || '(fluxo não escolhido)'}", que envia as mensagens dele ao cliente`
    case 'Transferir pra humano': {
      const d = r.departments.find((x) => x.id === s.departmentId)?.name
      const u = r.members.find((x) => x.id === s.memberId)?.name
      return `transfere para atendimento humano${d ? ` (departamento ${d})` : ''}${u ? ` (atendente ${u})` : ''}`
    }
    case 'Adicionar etiqueta': return `adiciona a etiqueta "${r.labels.find((x) => x.id === s.labelId)?.name || '(etiqueta não escolhida)'}" no contato`
    case 'Mover no Kanban': return `coloca o contato no quadro "${r.kanbans.find((x) => x.id === s.kanbanId)?.name || '(quadro não escolhido)'}"${s.column ? `, etapa "${s.column}"` : ''}`
    case AGENDA_CALL: return `consulta os horários e agenda na agenda "${s.agenda || '(agenda não informada)'}" do Vórtex Call`
    case 'Enviar arquivo': return `envia o arquivo "${turn.agent.files.find((f) => f.id === s.fileId)?.name || '(arquivo não escolhido)'}"`
    case 'Registrar venda': {
      const p = r.products.find((x) => x.id === s.productId)
      return `registra uma venda${p ? ` do produto "${p.name}" (R$ ${p.price})` : ''} no painel (informe o valor em "valor" se o cliente combinou outro)`
    }
    default: return s.action || 'ação'
  }
}

/* ---------- Instruções ---------- */

function identity(a: AgentCfg) {
  if (a.prompt.trim()) return a.prompt.trim()
  return [
    `Você é ${a.name}${a.role ? `, ${a.role}` : ''}.`,
    a.does && `Sua função: ${a.does}.`,
    a.objective && `Objetivo principal: ${a.objective}.`,
    a.audience && `Quem é o cliente: ${a.audience}.`,
    a.tone && `Tom de voz: ${a.tone}.`,
    a.examples && `Escreva no mesmo jeito destes exemplos:\n${a.examples}`,
    a.rules && `Regras do negócio: ${a.rules}`,
    a.forbidden && `Nunca fale sobre: ${a.forbidden}.`,
    `Emojis: ${a.emojis === 'nenhum' ? 'não use' : a.emojis === 'livre' ? 'use à vontade' : 'com moderação, no máximo um por mensagem'}.`,
  ].filter(Boolean).join('\n')
}

const sendableFiles = (a: AgentCfg) => a.files.filter((f) => f?.path && f?.name)

export function buildSystem(turn: Turn, toolNames: string[]) {
  const a = turn.agent
  const s = a.settings
  const has = (t: string) => toolNames.includes(t)
  const out: string[] = [identity(a)]

  out.push([
    '\n# Como atender',
    `- Você atende clientes pelo WhatsApp da empresa "${turn.company?.name || ''}". Escreva em português do Brasil, como uma pessoa no WhatsApp: frases curtas e diretas.`,
    s.split
      ? '- Separe a resposta em até 3 balões curtos, deixando uma linha em branco entre um balão e outro.'
      : '- Responda em uma única mensagem.',
    '- Formatação do WhatsApp: *negrito* com um asterisco de cada lado. Nada de títulos, tabelas ou markdown.',
    '- Use só as informações destas instruções, do conhecimento e do histórico. Nunca invente preços, prazos, links, chaves Pix, políticas ou promessas.' + (has('transferir_para_humano') ? ' Se não souber a resposta ou não conseguir resolver o que o cliente pediu, use transferir_para_humano (não diga que vai verificar sem transferir).' : ' Se não souber, diga que vai verificar.'),
    '- Se o cliente perguntar se está falando com um robô, diga com honestidade que é um assistente virtual da empresa.',
    '- Linhas "[atendente humano]" foram escritas por alguém da equipe: mantenha coerência com elas.',
    '- Linhas "[registro do sistema]" são anotações internas: não responda a elas nem as mencione ao cliente.',
    toolNames.length ? '- Você pode agir no sistema com as ferramentas. Só diga ao cliente que fez algo (enviou arquivo, transferiu, registrou, marcou) depois que a ferramenta responder "ok": true. Se responder "ok": false, não confirme: explique que não conseguiu e ofereça outra saída.' : '',
    has('transferir_para_humano') ? '- Use transferir_para_humano quando o cliente pedir para falar com uma pessoa, quando a resposta não estiver nas instruções nem no conhecimento, ou quando você não puder resolver o problema dele' + (s.stopNoProgress ? ', ou quando a conversa andar em círculo (o cliente repete a mesma dúvida e suas respostas não resolvem)' : '') + '. No motivo, diga o que ficou sem resposta. Depois, avise em uma frase que um atendente vai continuar.' : '',
    has('agendar_horario') ? '- Para marcar a reunião, consulte ver_horarios e ofereça um ou dois horários próximos (ex.: "tenho amanhã às 10h ou às 15h, qual fica melhor?"). Quando o cliente escolher, use agendar_horario com o id daquele horário. Não mande link de agendamento: você mesmo agenda. Só diga que agendou depois do "ok": true; a confirmação com o link da sala chega sozinha no WhatsApp logo depois.' : '',
    has('salvar_dados') ? '- Quando o cliente informar um dos dados da lista "Dados para anotar", salve com salvar_dados (sem avisar o cliente). Não pergunte de novo o que já está salvo.' : '',
  ].filter(Boolean).join('\n'))

  const kb = a.knowledge
  if (kb.length) {
    const size = kb.reduce((n, k) => n + (k.title || '').length + (k.content || '').length, 0)
    if (size <= KNOWLEDGE_INLINE) {
      out.push('\n# Conhecimento (consulte para responder; o que não estiver aqui, não invente)\n' + kb.map((k) => `## ${k.title || 'Informação'}\n${(k.content || '').trim()}`).join('\n\n'))
    } else {
      out.push('\n# Conhecimento\nHá uma base de conhecimento grande. Antes de responder dúvidas sobre os assuntos abaixo, use consultar_conhecimento:\n' + kb.map((k) => `- ${k.title || 'Informação'}`).join('\n'))
    }
  }

  const files = sendableFiles(a)
  if (files.length && has('enviar_arquivo')) {
    out.push('\n# Arquivos que você pode enviar (ferramenta enviar_arquivo)\n' + files.map((f, i) => `- arquivo_${i + 1}: ${f.name} — enviar quando: ${f.when || 'o cliente pedir isso'}`).join('\n'))
  }

  if (a.fields.length && has('salvar_dados')) {
    out.push('\n# Dados para anotar (tarefa secundária: sem virar formulário)\n' + a.fields.map((f) => `- ${fieldKey(f.field)}: ${f.desc || f.field}`).join('\n'))
  }

  if (has('responder_em_audio')) {
    out.push(`\n# Áudio\nVocê pode responder com uma mensagem de voz usando responder_em_audio. Quando usar: ${s.audioRule?.trim() || 'quando o cliente mandar áudio'}. Preço, Pix, link, lista, endereço e dados continuam em texto (responda por texto nesses casos).`)
  }

  // Parte que muda a cada turno (no fim, para o começo do prompt continuar igual entre as mensagens)
  const tz = turn.company?.timezone || 'America/Sao_Paulo'
  const c = turn.contact || {}
  const labels = (c.labels || []).map((id: string) => turn.refs.labels.find((l) => l.id === id)?.name).filter(Boolean)
  const saved = a.fields.map((f) => fieldKey(f.field)).map((k) => [k, k === 'nome' ? c.fields?.nome || '' : k === 'email' ? c.fields?.email || c.email || '' : c.fields?.[k]]).filter(([, v]) => v)
  const missing = a.fields.map((f) => fieldKey(f.field)).filter((k) => !saved.some(([x]) => x === k))
  out.push([
    '\n# Contexto desta conversa (atualizado agora)',
    `- Agora: ${new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date())}`,
    `- Cliente: ${c.name || 'sem nome'} (WhatsApp ${c.phone || '—'})`,
    labels.length ? `- Etiquetas do contato: ${labels.join(', ')}` : '',
    saved.length ? `- Dados já salvos (não pergunte de novo): ${saved.map(([k, v]) => `${k} = ${v}`).join('; ')}` : '',
    missing.length && has('salvar_dados') ? `- Dados que ainda faltam: ${missing.join(', ')}` : '',
  ].filter(Boolean).join('\n'))
  return out.join('\n')
}

/* ---------- Ferramentas (ações reais) ---------- */

type Tools = { defs: ToolDef[]; skillIds: Record<string, any>; fileIds: Record<string, any>; call?: any }

function buildTools(turn: Turn): Tools {
  const a = turn.agent
  const defs: ToolDef[] = []
  const skillIds: Record<string, any> = {}
  const fileIds: Record<string, any> = {}
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
    defs.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } })

  fn('transferir_para_humano', 'Passa a conversa para um atendente humano da equipe (ela vai para a fila do Chat ao Vivo) e pausa a IA nesta conversa.', {
    motivo: { type: 'string', description: 'Por que está transferindo, em uma frase (aparece para a equipe).' },
  }, ['motivo'])

  if (a.fields.length) {
    const props: Record<string, unknown> = {}
    for (const f of a.fields) props[fieldKey(f.field)] = { type: 'string', description: f.desc || f.field }
    fn('salvar_dados', 'Salva no cadastro do contato os dados que o cliente informou na conversa. Mande só os campos que você descobriu.', {
      dados: { type: 'object', properties: props, additionalProperties: false },
    }, ['dados'])
  }

  const call = callSkillOf(a)
  if (call) {
    fn('ver_horarios', 'Lista os próximos horários livres da reunião, com o id de cada um.', {})
    fn('agendar_horario', 'Agenda o cliente no horário escolhido. Use o nome, o WhatsApp e o e-mail do cadastro.', {
      horario: { type: 'string', description: 'O id do horário, como veio de ver_horarios.' },
    }, ['horario'])
  }

  const skills = a.skills.filter((s) => s?.action && String(s.when || '').trim() && skillKind(s) !== AGENDA_CALL)
  if (skills.length) {
    skills.forEach((s, i) => { skillIds[`habilidade_${i + 1}`] = s })
    fn('executar_habilidade', 'Executa uma ação configurada pela empresa. Use a habilidade cuja situação combina com o momento da conversa:\n'
      + skills.map((s, i) => `- habilidade_${i + 1}: quando ${String(s.when).trim()} → ${describeSkill(turn, s)}`).join('\n'), {
      habilidade: { type: 'string', enum: Object.keys(skillIds) },
      motivo: { type: 'string', description: 'O que na conversa fez você usar esta habilidade.' },
      valor: { type: 'number', description: 'Só para registrar venda: valor combinado com o cliente, se for diferente do padrão.' },
    }, ['habilidade', 'motivo'])
  }

  const files = sendableFiles(a)
  if (files.length) {
    files.forEach((f, i) => { fileIds[`arquivo_${i + 1}`] = f })
    fn('enviar_arquivo', 'Envia ao cliente um dos arquivos cadastrados (lista em "Arquivos que você pode enviar").', {
      arquivo: { type: 'string', enum: Object.keys(fileIds) },
      legenda: { type: 'string', description: 'Texto curto que acompanha o arquivo (opcional).' },
    }, ['arquivo'])
  }

  if (a.settings.audio && (turn.dryRun || audioSupport(turn.ai).speak)) {
    fn('responder_em_audio', 'Responde ao cliente com uma mensagem de voz em vez de texto. O texto vira áudio com a voz do agente.', {
      texto: { type: 'string', description: 'O que falar, do jeito que se fala (sem emojis, links ou listas).' },
    }, ['texto'])
  }

  const kbSize = a.knowledge.reduce((n, k) => n + (k.title || '').length + (k.content || '').length, 0)
  if (kbSize > KNOWLEDGE_INLINE) {
    fn('consultar_conhecimento', 'Busca na base de conhecimento da empresa os trechos sobre um assunto.', {
      busca: { type: 'string', description: 'Palavras do assunto (ex.: "prazo de entrega", "troca").' },
    }, ['busca'])
  }
  return { defs, skillIds, fileIds, call }
}

type ToolOut = { ok: boolean; resultado?: string; erro?: string }

async function execTool(turn: Turn, tools: Tools, call: ParsedCall): Promise<ToolOut> {
  const done = (ok: boolean, detail: string): ToolOut => {
    turn.actions.push({ tool: call.name, ok, detail: detail.slice(0, 300) })
    return ok ? { ok, resultado: detail } : { ok, erro: detail }
  }
  if (call.parseError) return done(false, `Não entendi os parâmetros (${call.parseError}).`)
  const args = call.args as Record<string, any>
  const dry = turn.dryRun
  try {
    switch (call.name) {
      case 'transferir_para_humano':
        if (dry) { turn.transferred = true; return done(true, '(teste) Conversa seria transferida para um humano.') }
        await transfer(turn, String(args.motivo || 'pedido do cliente'))
        return done(true, 'Conversa transferida. Um atendente humano vai continuar.')

      case 'salvar_dados': {
        const allowed = new Set(turn.agent.fields.map((f) => fieldKey(f.field)))
        const data = Object.fromEntries(Object.entries(args.dados || {}).map(([k, v]) => [fieldKey(k), String(v ?? '').trim().slice(0, 500)]).filter(([k, v]) => allowed.has(k) && v))
        if (!Object.keys(data).length) return done(false, 'Nenhum dado válido para salvar.')
        if (dry) return done(true, `(teste) Seria salvo: ${JSON.stringify(data)}`)
        await saveFields(turn, data)
        return done(true, `Salvo: ${Object.keys(data).join(', ')}.`)
      }

      case 'executar_habilidade': {
        const s = tools.skillIds[String(args.habilidade)]
        if (!s) return done(false, 'Habilidade inexistente.')
        if (dry) {
          if (skillKind(s) === 'Transferir pra humano') turn.transferred = true
          return done(true, `(teste) Executaria: ${describeSkill(turn, s)}.`)
        }
        return done(...(await runSkill(turn, s, args)))
      }

      case 'enviar_arquivo': {
        const f = tools.fileIds[String(args.arquivo)]
        if (!f) return done(false, 'Arquivo inexistente.')
        if (dry) return done(true, `(teste) Seria enviado o arquivo "${f.name}".`)
        return done(...(await sendFile(turn, f, args.legenda)))
      }

      case 'responder_em_audio': {
        const texto = String(args.texto || '').trim()
        if (!texto) return done(false, 'Texto vazio.')
        turn.audioText = texto.slice(0, 1500)
        return done(true, 'O áudio será enviado no lugar da resposta em texto. Não escreva mais nada.')
      }

      case 'consultar_conhecimento':
        return done(true, searchKnowledge(turn.agent, String(args.busca || '')))

      case 'ver_horarios':
        if (!tools.call) return done(false, 'Agenda não configurada.')
        return done(...(await verHorarios(turn, tools.call)))

      case 'agendar_horario': {
        if (!tools.call) return done(false, 'Agenda não configurada.')
        const sessao = String(args.horario || '').trim()
        if (dry) return done(true, `(teste) Seria agendado no horário ${sessao}.`)
        return done(...(await agendarHorario(turn, tools.call, sessao)))
      }

      default:
        return done(false, `Ferramenta desconhecida: ${call.name}`)
    }
  } catch (e) {
    console.error('ferramenta', call.name, e)
    return done(false, `Falhou: ${(e as Error)?.message || 'erro inesperado'}`)
  }
}

const quando = (turn: Turn, iso: string) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: turn.company?.timezone || 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(iso))

async function verHorarios(turn: Turn, s: any): Promise<[boolean, string]> {
  const r = await fetch(callBase(s), { signal: AbortSignal.timeout(10000) })
  if (!r.ok) return [false, 'Não consegui consultar a agenda agora.']
  const j = await r.json()
  const livres = (j.sessoes || []).filter((x: any) => !x.lotada).slice(0, 15)
  if (!livres.length) return [true, 'Nenhum horário livre no momento. Transfira para a equipe.']
  return [true, 'Horários livres:\n' + livres.map((x: any) => `- ${x.id}: ${quando(turn, x.inicio)}`).join('\n')]
}

async function agendarHorario(turn: Turn, s: any, sessao: string): Promise<[boolean, string]> {
  const { contact, chat, agent, admin } = turn
  const f = contact.fields || {}
  const email = [contact.email, f.email].find((e) => /^\S+@\S+\.\S+$/.test(String(e || '')))
  const resposta = /^[0-9a-f-]{36}$/i.test(String(f.type_resposta || '')) ? f.type_resposta : undefined
  const r = await fetch(callBase(s) + '/inscrever', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ sessao, nome: f.nome || contact.name || 'Cliente', whatsapp: contact.phone, email, resposta }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return [false, `${j.erro || 'Não deu para agendar.'} Consulte ver_horarios de novo e ofereça outro.`]
  const hora = quando(turn, j.inicio)
  await note(admin, chat, `📅 ${agent.name} agendou a reunião: ${hora}`)
  if (j.resultado === 'mesma') return [true, `O cliente já estava agendado nesse horário (${hora}).`]
  return [true, `Agendado: ${hora}. A confirmação com o link da sala chega sozinha no WhatsApp; só confirme o dia e o horário.`]
}

async function runSkill(turn: Turn, s: any, args: Record<string, any>): Promise<[boolean, string]> {
  const { admin, chat, contact, agent } = turn
  switch (skillKind(s)) {
    case 'Disparar fluxo': {
      if (!turn.mods.has('fluxos')) return [false, 'Módulo de Fluxos não liberado para a empresa.']
      const ref = skillFlow(turn, s)
      const flow = ref && (await loadFlow({ admin, companyId: chat.company_id } as FlowCtx, ref.id))
      if (!flow) return [false, 'Fluxo não encontrado (confira a habilidade).']
      if (flow.status !== 'active') return [false, `O fluxo "${flow.name}" está pausado.`]
      // gatilho "Evento de agente de IA" do fluxo: desligado ou limitado a outros agentes recusa; sem ele, vale como sempre valeu
      const trig = startOf(flow.nodes).triggers.find((t) => t.type === 'ai_agent')
      if (trig?.enabled === false) return [false, `O fluxo "${flow.name}" está com o gatilho de agente de IA desligado.`]
      if (trig?.config?.agents?.length && !trig.config.agents.includes(agent.id)) return [false, `O fluxo "${flow.name}" não aceita ser iniciado por este agente.`]
      await note(admin, chat, `🤖 ${agent.name} disparou o fluxo "${flow.name}"`)
      const r = await startFlow({ admin, companyId: chat.company_id, settings: turn.company?.settings || {}, modules: turn.mods }, flow, trig || { id: '', type: 'ai_agent' }, {
        type: 'ai_agent', key: `ai:${chat.id}:${Date.now()}`, contactId: contact.id, chatId: chat.id, data: { agente: agent.name, motivo: String(args.motivo || '').slice(0, 300) },
      }, { chat: { ...chat }, contact })
      if (r.status === 'skipped' || r.status === 'error') return [false, `O fluxo "${flow.name}" não começou: ${r.reason || 'erro inesperado'}`]
      turn.flowStarted = true
      return [true, `Fluxo "${flow.name}" executado: ele mesmo já enviou as mensagens dele ao cliente. Não repita o conteúdo; se não precisar dizer mais nada, responda vazio.`]
    }
    case 'Transferir pra humano':
      await transfer(turn, String(args.motivo || s.when || 'habilidade'), { departmentId: s.departmentId, memberId: s.memberId })
      return [true, 'Conversa transferida. Um atendente humano vai continuar.']
    case 'Adicionar etiqueta': {
      const label = turn.refs.labels.find((l) => l.id === s.labelId)
      if (!label) return [false, 'Etiqueta não encontrada (confira a habilidade).']
      const labels = [...new Set([...(contact.labels || []), label.id])]
      const { error } = await admin.from('contacts').update({ labels }).eq('id', contact.id)
      if (error) return [false, error.message]
      contact.labels = labels
      await note(admin, chat, `🏷️ ${agent.name} adicionou a etiqueta "${label.name}"`)
      return [true, `Etiqueta "${label.name}" adicionada.`]
    }
    case 'Mover no Kanban': {
      if (!turn.mods.has('kanban')) return [false, 'Módulo Kanban não liberado para a empresa.']
      const k = turn.refs.kanbans.find((x) => x.id === s.kanbanId)
      if (!k) return [false, 'Quadro não encontrado (confira a habilidade).']
      const cols = k.columns || []
      const col = cols.find((x: any) => x.name?.toLowerCase() === String(s.column || '').toLowerCase()) || cols[0]
      if (!col) return [false, 'O quadro não tem etapas.']
      const { data: card } = await admin.from('kanban_cards').select('id').eq('kanban_id', k.id).eq('contact_id', contact.id).maybeSingle()
      const r = card
        ? await admin.from('kanban_cards').update({ column_id: col.id }).eq('id', card.id)
        : await admin.from('kanban_cards').insert({ company_id: chat.company_id, kanban_id: k.id, column_id: col.id, contact_id: contact.id, title: contact.name })
      if (r.error) return [false, r.error.message]
      await note(admin, chat, `📋 ${agent.name} colocou o contato em "${k.name}" → ${col.name}`)
      return [true, `Contato no quadro "${k.name}", etapa "${col.name}".`]
    }
    case 'Enviar arquivo': {
      const f = agent.files.find((x) => x.id === s.fileId)
      if (!f?.path) return [false, 'Arquivo da habilidade não encontrado ou sem upload.']
      return sendFile(turn, f, '')
    }
    case 'Registrar venda': {
      const p = turn.refs.products.find((x) => x.id === s.productId)
      const value = +args.valor > 0 ? +args.valor : +(p?.price || 0)
      const { error } = await admin.from('sales').insert({
        company_id: chat.company_id, connection_id: chat.connection_id, contact_id: contact.id, product_id: p?.id || null,
        value, currency: p?.currency || 'BRL', state: contact.state || '', extra: { by: 'ia', agentId: agent.id },
      })
      if (error) return [false, error.message]
      await note(admin, chat, `✅ ${agent.name} registrou uma venda${p ? ` de "${p.name}"` : ''}: R$ ${value}`)
      return [true, `Venda registrada (R$ ${value}).`]
    }
    default:
      return [false, `Ação "${s.action}" não suportada.`]
  }
}

async function saveFields(turn: Turn, data: Record<string, string>) {
  const { admin, contact, chat, agent } = turn
  const fields = { ...(contact.fields || {}), ...data }
  const patch: Record<string, unknown> = { fields }
  if (data.email && /^\S+@\S+\.\S+$/.test(data.email)) patch.email = data.email
  // nome digitado pelo cliente substitui o nome do WhatsApp (ou o número) no cadastro
  if (data.nome && data.nome.length <= 80) patch.name = data.nome
  const { error } = await admin.from('contacts').update(patch).eq('id', contact.id)
  if (error) throw new Error(error.message)
  Object.assign(contact, patch)
  await note(admin, chat, `📝 ${agent.name} salvou: ${Object.entries(data).map(([k, v]) => `${k} = ${v}`).join('; ')}`)
}

// Passa para a equipe e pausa a IA: para um atendente (habilidade com responsável) ou para Aguardando, com o motivo.
async function transfer(turn: Turn, motivo: string, opts: { departmentId?: string; memberId?: string } = {}) {
  const { admin, chat, agent, refs } = turn
  const member = opts.memberId ? refs.members.find((m) => m.id === opts.memberId) : null
  const dept = opts.departmentId ? refs.departments.find((d) => d.id === opts.departmentId) : null
  const text = `🤖→👤 ${agent.name} transferiu para atendimento humano${dept ? ` (${dept.name})` : ''}${member ? ` → ${member.name}` : ''}. Motivo: ${motivo}`
  turn.transferred = true
  if (!member) return toWaiting(admin, chat, motivo, { pause: true, departmentId: dept?.id, text })
  const patch: Record<string, unknown> = {
    ai_paused: true, ai_pause_reason: 'transferido', ai_due_at: null, answered: false, status: 'attending', assigned_to: member.id,
  }
  if (dept) patch.department_id = dept.id
  await admin.from('chats').update(patch).eq('id', chat.id)
  Object.assign(chat, patch)
  await note(admin, chat, text)
}

function searchKnowledge(agent: AgentCfg, q: string) {
  const words = norm(q).split(' ').filter((w) => w.length >= 3)
  const scored = agent.knowledge.map((k) => {
    const t = norm(k.title || ''), c = norm(k.content || '')
    const score = words.reduce((n, w) => n + (t.includes(w) ? 3 : 0) + (c.split(w).length - 1), 0)
    return { k, score }
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
  if (!scored.length) return 'Nada encontrado sobre isso na base de conhecimento.'
  return scored.map(({ k }) => `## ${k.title}\n${String(k.content || '').slice(0, 4000)}`).join('\n\n')
}

/* ---------- Envio ---------- */

export function splitReply(text: string, split: boolean, sign: string) {
  let parts = split ? text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [text.trim()]
  if (parts.length > 4) parts = [...parts.slice(0, 3), parts.slice(3).join('\n\n')]
  if (sign && parts.length) parts[parts.length - 1] += `\n— ${sign}`
  return parts.filter(Boolean)
}

// Alguém da equipe (painel ou celular da empresa) escreveu depois da última mensagem que a IA leu?
async function humanReplied(turn: Turn) {
  const { data } = await turn.admin.from('messages').select('id').eq('chat_id', turn.chat.id).eq('sender', 'agent').gt('at', turn.seenAt).limit(1)
  return !!data?.length
}

async function stillActive(turn: Turn) {
  const { data } = await turn.admin.from('chats').select('ai_paused, ai_pause_reason, bot_active').eq('id', turn.chat.id).single()
  if (!data?.bot_active || (await humanReplied(turn))) return false
  return !data.ai_paused || (turn.transferred && data.ai_pause_reason === 'transferido')
}

async function insertBot(turn: Turn, m: { text: string; type?: string; media_url?: string | null; wa_id: string | null; delivery: string; extra?: Record<string, unknown> }) {
  await turn.admin.from('messages').insert({
    company_id: turn.chat.company_id, chat_id: turn.chat.id, sender: 'bot', text: m.text, type: m.type || 'text', media_url: m.media_url ?? null,
    wa_id: m.wa_id, delivery: m.delivery, at: new Date().toISOString(), extra: { agentId: turn.agent.id, agentName: turn.agent.name, ...(m.extra || {}) },
  })
  await turn.admin.from('chats').update({ last_message_at: new Date().toISOString(), answered: true }).eq('id', turn.chat.id)
}

// Envia os balões com "digitando..." antes de cada um. Logo antes de cada envio (depois do "digitando...") confere de novo
// se a IA continua ativa e se ninguém da equipe escreveu: um atendente que responde nesse meio-tempo não leva a IA por cima.
async function sendParts(turn: Turn, parts: string[]) {
  let sent = 0
  for (const text of parts) {
    let waId: string | null = null
    let delivery = 'local'
    if (turn.provider && turn.creds) {
      const typing = Math.min(4000, 700 + text.length * 35)
      await sendTyping(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), typing)
      if (turn.provider !== 'sandbox') await sleep(typing * (0.6 + Math.random() * 0.4))
    }
    if (!(await stillActive(turn))) break
    if (turn.provider && turn.creds) {
      try { waId = await sendText(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), text); delivery = 'sent' } catch (e) { delivery = 'failed'; console.error('envio IA', e) }
    }
    await insertBot(turn, { text, wa_id: waId, delivery })
    sent++
  }
  return sent
}

async function voiceFor(turn: Turn) {
  const v = turn.agent.settings.voice
  if (!v || v === 'padrao') return {}
  const { data } = await turn.admin.from('voices').select('extra').eq('id', v).eq('company_id', turn.chat.company_id).maybeSingle()
  return { elevenVoiceId: data?.extra?.elevenVoiceId || undefined }
}

// Resposta em áudio (mensagem de voz). Sem provedor de voz ou se falhar, vai em texto.
async function sendVoice(turn: Turn, text: string, fallback: string) {
  try {
    const audio = await synthesize(turn.ai, text, await voiceFor(turn))
    if (audio && turn.provider && turn.creds) {
      const path = `${turn.chat.company_id}/${turn.chat.id}/ia-${Date.now()}.mp3`
      const up = await turn.admin.storage.from('whatsapp-media').upload(path, audio.bytes, { contentType: audio.mime, upsert: true })
      if (up.error) throw up.error
      const { data: link } = await turn.admin.storage.from('whatsapp-media').createSignedUrl(path, 3600)
      const waId = await sendMedia(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), { kind: 'audio', url: link.signedUrl, mime: audio.mime })
      await insertBot(turn, { text: `🎤 ${text}`, type: 'audio', media_url: path, wa_id: waId, delivery: 'sent', extra: { tts: audio.provider } })
      return 1
    }
  } catch (e) {
    // sem créditos para a voz: a resposta (já paga) vai em texto
    if (!(e instanceof SemCreditos)) console.error('áudio da IA', e)
  }
  return sendParts(turn, splitReply(fallback || text, turn.agent.settings.split, turn.agent.settings.sign ? turn.agent.name : ''))
}

// Arquivo do agente: link temporário do bucket privado agent-files. Documento que o provedor recusar vai como link.
async function sendFile(turn: Turn, f: any, caption?: string): Promise<[boolean, string]> {
  if (!turn.provider || !turn.creds) return [false, 'Esta conexão não tem provedor de WhatsApp configurado.']
  const { data: link, error } = await turn.admin.storage.from('agent-files').createSignedUrl(f.path, 3600)
  if (error || !link?.signedUrl) return [false, 'Arquivo não encontrado no armazenamento.']
  const kind = mediaKind(f.mime || '')
  const legenda = String(caption || '').trim().slice(0, 500)
  await sendTyping(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), 1500)
  try {
    const waId = await sendMedia(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), { kind, url: link.signedUrl, mime: f.mime, fileName: f.fileName || f.name, caption: legenda || undefined })
    await insertBot(turn, { text: legenda || `📎 ${f.name}`, type: kind, media_url: `agent-files:${f.path}`, wa_id: waId, delivery: 'sent', extra: { file: f.name } })
    await note(turn.admin, turn.chat, `📎 ${turn.agent.name} enviou o arquivo "${f.name}"`)
    return [true, `Arquivo "${f.name}" enviado.`]
  } catch (e) {
    if (kind !== 'document') return [false, `O WhatsApp não aceitou o arquivo: ${(e as Error).message}`]
    // provedor sem envio de documento: manda o link (vale 7 dias)
    const { data: long } = await turn.admin.storage.from('agent-files').createSignedUrl(f.path, 7 * 86400)
    const text = `${legenda ? legenda + '\n' : ''}📎 ${f.name}: ${long?.signedUrl}`
    const waId = await sendText(turn.provider, turn.creds, recipientOf(turn.provider, turn.contact, turn.chat), text)
    await insertBot(turn, { text, wa_id: waId, delivery: 'sent', extra: { file: f.name } })
    await note(turn.admin, turn.chat, `📎 ${turn.agent.name} enviou o link do arquivo "${f.name}"`)
    return [true, `Arquivo "${f.name}" enviado como link.`]
  }
}

/* ---------- Estado, avisos e horário ---------- */

async function saveState(turn: Turn, patch: Record<string, unknown>) {
  const { data } = await turn.admin.from('chats').select('ai_state').eq('id', turn.chat.id).single()
  const next: Record<string, unknown> = { ...(data?.ai_state || {}), ...patch }
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k]
  await turn.admin.from('chats').update({ ai_state: next }).eq('id', turn.chat.id)
}

// Aviso no painel (uma vez a cada 12 h por conversa e tipo), para não encher a conversa de alertas.
async function warnOnce(turn: Turn, key: string, text: string) {
  const st = turn.chat.ai_state || {}
  const last = st.warned?.[key] ? Date.parse(st.warned[key]) : 0
  if (Date.now() - last < 12 * 3600_000) return
  await note(turn.admin, turn.chat, text)
  await saveState(turn, { warned: { ...(st.warned || {}), [key]: new Date().toISOString() } })
}

const dayKey = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())

const WEEK = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
function localNow(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { wd, min: (+p.hour % 24) * 60 + +p.minute }
}
const toMin = (s: string) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
const dayOf = (hours: any[], wd: number) => hours.find((h) => String(h.day || '').toLowerCase().startsWith(WEEK[wd]))

export function isOpen(hours: any[] | undefined, tz: string, d: Date) {
  if (!Array.isArray(hours) || !hours.length) return true
  const { wd, min } = localNow(tz, d)
  const h = dayOf(hours, wd)
  return !!h?.open && min >= toMin(h.from) && min < toMin(h.to)
}

export function offHoursText(hours: any[] | undefined, tz: string, d: Date) {
  const { wd, min } = localNow(tz, d)
  for (let i = 0; i < 8 && Array.isArray(hours); i++) {
    const h = dayOf(hours, (wd + i) % 7)
    if (!h?.open || (i === 0 && min >= toMin(h.from))) continue
    const when = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : `${WEEK[(wd + i) % 7]}${(wd + i) % 7 >= 1 && (wd + i) % 7 <= 5 ? '-feira' : ''}`
    return `Oi! Nosso atendimento está fechado agora. Voltamos ${when} às ${h.from}. Sua mensagem ficou registrada e respondemos assim que abrirmos 🙂`
  }
  return 'Oi! Nosso atendimento está fechado agora. Sua mensagem ficou registrada e respondemos assim que abrirmos 🙂'
}

/* ---------- Teste ao vivo (editor do agente) ---------- */
// Roda o agente com o rascunho da tela e as mensagens digitadas, sem WhatsApp e sem executar ações.
// Também valida as versões candidatas do Vórtex Inteligência (origem "validacao", com a execução em ref).
export async function previewReply(admin: any, companyId: string, draft: any, msgs: { from: string; text: string }[], opts: { origem?: 'teste' | 'validacao'; ref?: string } = {}) {
  const [{ data: company }, mods] = await Promise.all([
    admin.from('companies').select('id, name, timezone, settings').eq('id', companyId).single(),
    companyModules(admin, companyId),
  ])
  const agent = agentConfig({ ...draft, company_id: companyId, extra: draft })
  // o teste ao vivo também gasta créditos quando usa a IA da plataforma
  const ai = await loadCreds(admin, companyId, { origem: opts.origem || 'teste', agentId: draft?.id || null, ref: opts.ref })
  const cred = pickChatCred(ai, agent.settings.aiProvider)
  if (!cred) throw new AiError('Nenhuma chave de IA conectada. Conecte em Configurações → Integrações.', 'config')
  const turn: Turn = {
    admin, chat: { id: null, company_id: companyId, ai_state: {} }, contact: { name: 'Cliente de teste', phone: '', labels: [], fields: {} }, company, agent, mods,
    provider: null, creds: null, ai, dryRun: true, refs: await loadRefs(admin, agent), actions: [], transferred: false, flowStarted: false, audioText: null,
    seenAt: new Date().toISOString(),
  }
  const tools = buildTools(turn)
  const history = msgs.filter((m) => m.text?.trim()).slice(-HISTORY).map((m, i) => ({ id: `t${i}`, sender: m.from === 'user' ? 'contact' : 'bot', type: 'text', text: m.text }))
  const messages: ChatMsg[] = [{ role: 'system', content: buildSystem(turn, tools.defs.map((t) => t.function.name)) }, ...toChat(turn, history, [])]
  const run: Run = { status: '', reason: '', provider: cred.provider, model: cred.model, input: 0, output: 0, error: null }
  const t0 = Date.now()
  const reply = await converse(turn, cred, messages, tools, run)
  const parts = turn.audioText ? [`🎤 (áudio) ${turn.audioText}`] : splitReply(reply, agent.settings.split, agent.settings.sign ? agent.name : '')
  return { parts, actions: turn.actions, provider: cred.provider, model: run.model, transferred: turn.transferred, source: cred.source,
    usage: { input: run.input, output: run.output }, ms: Date.now() - t0, systemChars: String(messages[0]?.content || '').length }
}
