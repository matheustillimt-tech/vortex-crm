// Parte leve do agente de IA, usada no recebimento (whatsapp-webhook) e no envio pelo painel (send-message):
// qual agente atende a conversa, se ele pode responder agora, agendar a resposta e pausar quando um humano assume.
// O motor (conversa com o provedor, ações, envio) fica em agent.ts e roda na função ai-agent.
import { onlyDigits, phoneVariants } from './whatsapp.ts'
import { kickAgent } from './kick.ts'

export type AgentCfg = ReturnType<typeof agentConfig>

export const fieldKey = (s: unknown) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

export function agentConfig(row: any) {
  const x = row?.extra || {}
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    name: (row.name || 'Agente') as string,
    active: !!row.active,
    // 'padrao' (este motor). Campo reservado para motores próprios no futuro.
    engine: (x.engine || 'padrao') as string,
    connectionId: (row.connection_id || null) as string | null,
    role: x.role || '', does: x.does || '', objective: x.objective || '', audience: x.audience || '', tone: x.tone || '',
    examples: x.examples || '', rules: x.rules || '', forbidden: x.forbidden || '', emojis: x.emojis || 'moderado', prompt: x.prompt || '',
    skills: (Array.isArray(x.skills) ? x.skills : []) as any[],
    fields: (Array.isArray(x.fields) ? x.fields : []).filter((f: any) => fieldKey(f?.field)) as any[],
    files: (Array.isArray(x.files) ? x.files : []) as any[],
    knowledge: (Array.isArray(x.knowledge) ? x.knowledge : []).filter((k: any) => (k?.title || k?.content || '').trim()) as any[],
    settings: {
      buffer: 5, split: true, audio: false, voice: 'padrao', audioRule: '', hearAudio: true, seeImage: true, businessHours: false,
      stopOnHuman: true, stopNoProgress: true, sign: false, testNumbers: '', aiProvider: '', ...(x.settings || {}),
    },
  }
}

// Agente desta conversa: o definido por um fluxo (bloco "Agente de IA"), o agente ativo da conexão ou, se a conexão
// não tem agente ativo e está num rotacionador ativo, o agente escolhido no rotacionador.
export async function resolveAgent(admin: any, chat: any): Promise<AgentCfg | null> {
  const q = () => admin.from('agents').select('*').eq('company_id', chat.company_id)
  if (chat.ai_agent_id) {
    const { data } = await q().eq('id', chat.ai_agent_id).maybeSingle()
    return data ? agentConfig(data) : null
  }
  if (!chat.connection_id) return null
  const { data } = await q().eq('connection_id', chat.connection_id).eq('active', true).limit(1).maybeSingle()
  if (data) return agentConfig(data)
  const { data: rot } = await admin.from('rotators').select('agent_id').eq('company_id', chat.company_id).eq('active', true)
    .not('agent_id', 'is', null).contains('connection_ids', [chat.connection_id]).order('created_at').limit(1).maybeSingle()
  if (!rot) return null
  const { data: viaRot } = await q().eq('id', rot.agent_id).maybeSingle()
  return viaRot ? agentConfig(viaRot) : null
}

const testList = (agent: AgentCfg) => String(agent.settings.testNumbers || '').split(/[,;\n]+/).map(onlyDigits).filter((d) => d.length >= 8)

// Modo de teste: com números na lista, o agente só responde a eles.
export function numberAllowed(agent: AgentCfg, phone: string) {
  const list = testList(agent)
  if (!list.length) return true
  const mine = new Set(phoneVariants(onlyDigits(phone)))
  return list.some((t) => phoneVariants(t).some((v) => mine.has(v)))
}

// Motivo para a IA NÃO responder nesta conversa agora (null = pode responder).
export function blockReason(chat: any, agent: AgentCfg | null, mods: Set<string>, contact: any): string | null {
  if (!mods.has('agentes') || !mods.has('chat') || !mods.has('conexoes')) return 'módulo de Agentes de IA não liberado'
  if (!agent) return 'nenhum agente ativo nesta conexão'
  if (!agent.active) return `agente ${agent.name} pausado`
  if (!chat.bot_active) return 'bot desligado nesta conversa'
  if (chat.ai_paused) return `IA pausada nesta conversa (${chat.ai_pause_reason || 'manual'})`
  if (chat.status === 'resolved') return 'conversa resolvida'
  if (!numberAllowed(agent, contact?.phone || '')) return 'modo de teste: número fora da lista'
  if (chat.flow_state?.waiting || chat.flow_state?.resumeAt) return 'um fluxo está em andamento'
  return null
}

// Negócio do contato numa coluna do Kanban marcada "Pausar IA e disparos" (ex.: Em negociação): nada automático fala
// com ele (IA, mensagens de fluxo, disparos). Devolve o nome da coluna, ou null. O vendedor segue falando pelo chat.
export async function colunaPausada(admin: any, companyId: string, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null
  const { data: cards } = await admin.from('kanban_cards').select('kanban_id, column_id').eq('company_id', companyId).eq('contact_id', contactId)
  if (!cards?.length) return null
  const { data: ks } = await admin.from('kanbans').select('id, columns').eq('company_id', companyId).in('id', [...new Set(cards.map((c: any) => c.kanban_id))])
  for (const card of cards) {
    const col = (ks || []).find((k: any) => k.id === card.kanban_id)?.columns?.find((x: any) => x.id === card.column_id)
    if (col?.pausa) return col.name || 'coluna pausada'
  }
  return null
}

// Mensagem do cliente chegou: marca "responder em N s" (tempo de agrupamento do agente) e acorda a função ai-agent.
export async function scheduleReply(admin: any, chat: any, contact: any, mods: Set<string>, opts: { seconds?: number } = {}) {
  const agent = await resolveAgent(admin, chat)
  const why = blockReason(chat, agent, mods, contact)
  if (why) return { scheduled: false, why }
  const pausa = await colunaPausada(admin, chat.company_id, contact?.id ?? chat.contact_id)
  if (pausa) return { scheduled: false, why: `negócio em "${pausa}" no Kanban` }
  const secs = opts.seconds ?? Math.max(0, Math.min(120, Math.round(+agent!.settings.buffer || 0)))
  const waiting = chat.ai_due_at && new Date(chat.ai_due_at).getTime() > Date.now() - 5000 && !chat.ai_lock_until
  await admin.rpc('ai_schedule', { p_chat: chat.id, p_seconds: secs })
  // já tem uma execução esperando esta conversa: ela relê o novo prazo sozinha
  if (!waiting) await kickAgent(chat.id)
  return { scheduled: true, seconds: secs }
}

export async function note(admin: any, chat: any, text: string) {
  await admin.from('messages').insert({ company_id: chat.company_id, chat_id: chat.id, sender: 'sys', text, delivery: 'local', at: new Date().toISOString() })
}

// A IA não resolveu (transferiu, prometeu um atendente, deu erro, ficou sem resposta, anotou um problema): a conversa vai
// para Aguardando com o motivo em ai_state.precisaHumano e fica lá até alguém da equipe assumir. O banco apaga a marca
// quando a conversa sai de Aguardando (0016_ia_nao_resolveu.sql). pause: a IA para nesta conversa (transferência); sem
// pausar, ela segue respondendo o resto, mas não tira a conversa de Aguardando. textOnce: nota só se ainda não estava marcada.
export async function toWaiting(admin: any, chat: any, motivo: string, opts: { pause?: boolean; departmentId?: string | null; text?: string; textOnce?: string } = {}) {
  const { data: atual } = await admin.from('chats').select('status, ai_state').eq('id', chat.id).single()
  const jaMarcada = atual?.status === 'waiting' && !!atual?.ai_state?.precisaHumano
  const patch: Record<string, unknown> = {
    status: 'waiting', answered: false, assigned_to: null,
    ai_state: { ...(atual?.ai_state || chat.ai_state || {}), precisaHumano: { motivo: motivo.slice(0, 300), em: new Date().toISOString() } },
  }
  if (opts.pause) Object.assign(patch, { ai_paused: true, ai_pause_reason: 'transferido', ai_due_at: null })
  if (opts.departmentId) patch.department_id = opts.departmentId
  await admin.from('chats').update(patch).eq('id', chat.id)
  Object.assign(chat, patch)
  if (opts.text) await note(admin, chat, opts.text)
  else if (opts.textOnce && !jaMarcada) await note(admin, chat, opts.textOnce)
}

// A resposta promete uma pessoa da equipe ("vou te passar para um atendente", "nossa equipe vai te responder",
// "vou verificar com o responsável"). Se a IA escreveu isso sem transferir, o cliente ficaria esperando ninguém.
const PROMESSA_HUMANO = [
  /\b(vou|irei|vamos|j[aá] vou)\s+(te\s+|lhe\s+|o\s+|a\s+)?(passar|transferir|encaminhar|direcionar)\b/,
  /\b(atendente|consultora?|especialista|vendedora?|respons[aá]vel|colaboradora?|gerente|equipe|time|setor)\b[^.!?\n]{0,30}\b(vai|ir[aá]|v[aã]o|ir[aã]o)\s+(te\s+|lhe\s+)?(responder|retornar|continuar|ajudar|chamar|falar|entrar em contato|verificar|confirmar|resolver|analisar|dar (um )?retorno|assumir)/,
  /\b(vou|irei|vamos)\s+(verificar|confirmar|checar|consultar|ver)\b[^.!?\n]{0,30}\b(atendente|equipe|time|setor|respons[aá]vel|gerente|pessoal)\b/,
]
export const prometeuHumano = (texto: string) => {
  const t = String(texto || '').toLowerCase()
  return PROMESSA_HUMANO.some((re) => re.test(t))
}

// Falha da IA em uma frase para a equipe (o texto técnico fica em ai_runs.error).
export function motivoFalha(texto: string): string {
  const t = String(texto || '')
  if (/credit balance is too low|insufficient_quota|billing|quota/i.test(t)) return 'sem crédito na conta da IA'
  if (/authentication_error|invalid.{0,10}api.?key|unauthorized|\b401\b/i.test(t)) return 'a chave da IA foi recusada'
  if (/rate.?limit|\b429\b/i.test(t)) return 'limite de uso da IA atingido'
  if (/overloaded|\b5(00|02|03|04|29)\b|unavailable/i.test(t)) return 'o provedor da IA está instável'
  if (/timeout|timed out|abort|prazo/i.test(t)) return 'a resposta demorou demais'
  return t.slice(0, 160) || 'erro inesperado'
}

// Humano escreveu pelo painel ou pelo celular da empresa: pausa a IA nesta conversa (se o agente estiver configurado assim).
export async function pauseForHuman(admin: any, chat: any, text: string) {
  if (chat.ai_paused) return false
  const agent = await resolveAgent(admin, chat)
  if (!agent?.active || agent.settings.stopOnHuman === false) return false
  const { data } = await admin.from('chats').update({ ai_paused: true, ai_pause_reason: 'humano', ai_due_at: null })
    .eq('id', chat.id).eq('ai_paused', false).select('id')
  if (!data?.length) return false
  await note(admin, chat, text)
  return true
}
