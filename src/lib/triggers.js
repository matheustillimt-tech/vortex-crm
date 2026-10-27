import {
  MessageSquare, UserPlus, RotateCcw, Clock, Hourglass, Webhook, CreditCard, ClipboardList, UserRoundPlus, Tag, PenLine, Columns3, Trophy,
  UserCheck, Timer, CalendarClock, CalendarDays, CalendarCheck, Hand, Workflow, Bot,
} from 'lucide-react'
import { DEFAULT_RULES, DEFAULT_TZ, startOf } from '../../supabase/functions/_shared/triggers-core.ts'
import { uid } from './utils'

// Catálogo dos gatilhos do bloco "Início do fluxo". As regras (palavra-chave, horários, datas, mapeamento) estão em
// supabase/functions/_shared/triggers-core.ts, o mesmo arquivo que o servidor usa.
export { DEFAULT_RULES, DEFAULT_TZ, startOf }

export const ORIGINS = ['WhatsApp', 'Instagram', 'Anúncio Meta', 'Webhook', 'Importação', 'Manual']
export const UNITS = ['minutos', 'horas', 'dias']
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
export const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Noronha', 'America/Rio_Branco', 'Europe/Lisbon', 'America/New_York', 'UTC']

export const TRIGGER_GROUPS = [
  { id: 'messages', label: 'Mensagens e atendimento' },
  { id: 'integrations', label: 'Integrações' },
  { id: 'crm', label: 'CRM e contatos' },
  { id: 'dates', label: 'Datas e agendamentos' },
  { id: 'internal', label: 'Internos' },
]

const now = () => new Date().toISOString()

// module: módulo que precisa estar liberado. unavailable: depende de algo que o Vórtex CRM ainda não tem (aparece marcado).
export const TRIGGERS = [
  { type: 'message', group: 'messages', label: 'Mensagem recebida', icon: MessageSquare, desc: 'Quando o cliente manda uma mensagem: qualquer uma ou com palavra-chave.',
    defaults: () => ({ connections: [], mode: 'keyword', keywords: [], match: 'contains', wholeWord: false, ignoreCase: true, ignoreAccents: true, chatType: 'individual' }) },
  { type: 'first_contact', group: 'messages', label: 'Primeiro contato', icon: UserPlus, desc: 'Primeira mensagem de alguém que nunca conversou com você neste número.',
    defaults: () => ({ connections: [], onlyNewContacts: false }) },
  { type: 'reopened', group: 'messages', label: 'Conversa reaberta', icon: RotateCcw, desc: 'O cliente volta a escrever depois que a conversa foi encerrada (resolvida).',
    defaults: () => ({ connections: [] }) },
  { type: 'no_team_reply', group: 'messages', label: 'Conversa sem resposta da equipe', icon: Clock, desc: 'O cliente escreveu e ninguém da equipe respondeu dentro do tempo.',
    defaults: () => ({ connections: [], amount: 15, unit: 'minutos', countBot: false }) },
  { type: 'no_client_reply', group: 'messages', label: 'Cliente sem responder', icon: Hourglass, desc: 'Você mandou mensagem e o cliente não respondeu dentro do tempo.',
    defaults: () => ({ connections: [], amount: 1, unit: 'horas', onlyTeam: false }) },

  { type: 'webhook', group: 'integrations', label: 'Webhook recebido', icon: Webhook, module: 'webhooks', desc: 'Outro sistema (checkout, site, CRM) avisa o Vórtex CRM por uma URL exclusiva.',
    defaults: () => ({ webhookId: null }) },
  { type: 'integration_event', group: 'integrations', label: 'Evento de integração', icon: CreditCard, desc: 'Compra aprovada, Pix gerado, carrinho abandonado, assinatura, reembolso…',
    unavailable: 'Nenhuma plataforma de pagamento está integrada ao Vórtex CRM. Use "Webhook recebido": cole a URL na sua plataforma (Hotmart, Kiwify, Eduzz…) e filtre o evento nas condições.' },
  { type: 'form', group: 'integrations', label: 'Formulário enviado', icon: ClipboardList, desc: 'Quando alguém envia um formulário.',
    unavailable: 'O Vórtex CRM ainda não tem formulários. Se o seu formulário (site, Typeform, Google Forms via automação) puder enviar um webhook, use "Webhook recebido".' },

  { type: 'contact_created', group: 'crm', label: 'Contato criado', icon: UserRoundPlus, module: 'contatos', desc: 'Um contato novo entra na base (pelo WhatsApp, webhook, importação ou à mão).',
    defaults: () => ({ origins: [], connections: [] }) },
  { type: 'tag', group: 'crm', label: 'Etiqueta adicionada ou removida', icon: Tag, module: 'contatos', desc: 'Quando uma etiqueta entra ou sai do contato.',
    defaults: () => ({ action: 'added', labels: [] }) },
  { type: 'field_updated', group: 'crm', label: 'Campo do contato atualizado', icon: PenLine, module: 'contatos', desc: 'Quando um campo do contato muda (e, se quiser, para um valor específico).',
    defaults: () => ({ field: '', op: 'any', value: '' }) },
  { type: 'deal', group: 'crm', label: 'Negócio criado ou mudou de etapa', icon: Columns3, module: 'kanban', desc: 'Negócio do Kanban criado ou movido para uma etapa.',
    defaults: () => ({ event: 'any', kanbanId: '', toColumns: [], fromColumns: [] }) },
  { type: 'deal_result', group: 'crm', label: 'Negócio ganho ou perdido', icon: Trophy, module: 'kanban', desc: 'Negócio chega numa etapa de conversão (ganho) ou de perda.',
    defaults: () => ({ result: 'won', kanbanId: '' }) },
  { type: 'assignee', group: 'crm', label: 'Responsável alterado', icon: UserCheck, desc: 'Quando muda o responsável da conversa ou do negócio.',
    defaults: () => ({ scope: 'chat', to: '' }) },
  { type: 'stage_idle', group: 'crm', label: 'Tempo parado numa etapa', icon: Timer, module: 'kanban', desc: 'O negócio ficou parado na mesma etapa por um tempo.',
    defaults: () => ({ kanbanId: '', columnId: '', amount: 3, unit: 'dias' }) },

  { type: 'schedule', group: 'dates', label: 'Data ou horário programado', icon: CalendarClock, desc: 'Numa data e hora, uma vez ou repetindo, para um público.',
    defaults: () => ({ mode: 'once', date: '', time: '09:00', weekdays: [1], monthDay: 1, tz: DEFAULT_TZ, audience: { labelsAny: [], labelsNone: [], connections: [] }, connectionId: '', createdAt: now() }) },
  { type: 'date_field', group: 'dates', label: 'Data de um campo', icon: CalendarDays, desc: 'Antes, no dia ou depois de uma data do contato: vencimento, aniversário, renovação.',
    defaults: () => ({ source: 'field', field: '', when: 'on', days: 0, time: '09:00', tz: DEFAULT_TZ, yearly: false, connectionId: '', createdAt: now() }) },
  { type: 'appointment', group: 'dates', label: 'Evento de agendamento', icon: CalendarCheck, desc: 'Agendamento criado, confirmado, cancelado, concluído ou ausência.',
    unavailable: 'O Vórtex CRM ainda não tem agenda. Quando o seu sistema de agendamento enviar webhooks, use "Webhook recebido" com uma condição por tipo de evento.' },

  { type: 'manual', group: 'internal', label: 'Início manual', icon: Hand, desc: 'Alguém da equipe inicia pelo contato, pela conversa ou pelo negócio.',
    defaults: () => ({ where: ['contact', 'chat', 'deal'], connectionId: '' }) },
  { type: 'flow', group: 'internal', label: 'Iniciado por outro fluxo', icon: Workflow, desc: 'Outro fluxo chega neste pelo bloco "Conexão de Fluxo", passando as variáveis.',
    defaults: () => ({ vars: [] }) },
  { type: 'ai_agent', group: 'internal', label: 'Evento de agente de IA', icon: Bot, module: 'agentes', desc: 'Uma habilidade do agente de IA inicia o fluxo com o contato e os dados coletados.',
    defaults: () => ({ agents: [] }) },
]

export const triggerDef = (type) => TRIGGERS.find((t) => t.type === type) || { type, label: type, icon: Workflow, desc: '', group: 'internal' }

// { ok } ou { ok: false, reason } para o painel mostrar o gatilho como indisponível
export function availability(def, modules) {
  if (def.unavailable) return { ok: false, reason: def.unavailable }
  if (def.module && !modules.includes(def.module)) return { ok: false, reason: 'O plano da sua empresa não inclui este módulo. Fale com o suporte para liberar.' }
  return { ok: true }
}

export const newTrigger = (type) => ({ id: uid(), type, enabled: true, config: triggerDef(type).defaults?.() || {} })

// Bloco Início de um fluxo novo
export const newStartData = () => ({ label: 'Início do fluxo', triggers: [], rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) })

// Dados do bloco Início no formato novo (o antigo, só com palavras-chave, é convertido mantendo a regra)
export function startData(data) {
  const s = startOf([{ type: 'start', data }])
  const { keywords, ...rest } = data || {}
  return { ...rest, label: rest.label === 'Início' || !rest.label ? 'Início do fluxo' : rest.label, triggers: s.triggers, rules: s.rules }
}

/* ---------- Resumos ("Mensagem recebida → contém 'quero comprar' → WhatsApp Comercial") ---------- */

const MATCH = { exact: 'é exatamente', contains: 'contém', starts: 'começa com', ends: 'termina com' }
const names = (ids, list, key = 'name') => (ids || []).map((id) => list?.find((x) => x.id === id)?.[key]).filter(Boolean)
const quoted = (arr) => arr.map((k) => `"${k}"`).join(', ')
const conns = (c, db) => {
  const n = names(c.connections, db?.connections)
  return n.length ? n.join(', ') : ''
}
const span = (amount, unit) => `${amount || 0} ${+amount === 1 ? String(unit || 'minutos').replace(/s$/, '') : unit || 'minutos'}`
const col = (db, kanbanId, id) => db?.kanbans?.find((k) => k.id === kanbanId)?.columns?.find((x) => x.id === id)?.name
const fmtDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').reverse().join('/') : s || '—')

export const DATE_SOURCES = [
  { value: 'field', label: 'Campo personalizado do contato' },
  { value: 'created_at', label: 'Data de cadastro do contato' },
]

export function triggerSummary(t, db) {
  const c = t?.config || {}
  const conn = conns(c, db)
  const via = conn ? ` → ${conn}` : ''
  switch (t?.type) {
    case 'message': {
      const kws = (c.keywords || []).map((k) => String(k).trim()).filter(Boolean)
      if (c.mode !== 'keyword' || !kws.length) return `Inicia com qualquer mensagem recebida${via}`
      return `Mensagem recebida → ${MATCH[c.match] || 'contém'} ${quoted(kws.slice(0, 3))}${kws.length > 3 ? ` +${kws.length - 3}` : ''}${via}`
    }
    case 'first_contact': return `Primeiro contato${c.onlyNewContacts ? ' (só contatos novos)' : ''}${via}`
    case 'reopened': return `Conversa reaberta${via}`
    case 'no_team_reply': return `Sem resposta da equipe por ${span(c.amount, c.unit)}${via}`
    case 'no_client_reply': return `Cliente sem responder por ${span(c.amount, c.unit)}${via}`
    case 'webhook': {
      const w = db?.webhooks?.find((x) => x.id === c.webhookId)
      return w ? `Webhook recebido → ${w.name}` : 'Webhook recebido → crie a URL'
    }
    case 'contact_created': return `Contato criado${c.origins?.length ? ` → origem: ${c.origins.join(', ')}` : ''}${via}`
    case 'tag': {
      const l = names(c.labels, db?.labels)
      return `Etiqueta ${l.length ? quoted(l) : '(qualquer)'} ${c.action === 'removed' ? 'removida' : 'adicionada'}`
    }
    case 'field_updated': {
      const v = c.op === 'equals' ? ` → igual a "${c.value}"` : c.op === 'contains' ? ` → contém "${c.value}"` : c.op === 'filled' ? ' → preenchido' : c.op === 'empty' ? ' → vazio' : ''
      return c.field ? `Campo "${c.field}" atualizado${v}` : 'Campo do contato atualizado: escolha o campo'
    }
    case 'deal': {
      const k = db?.kanbans?.find((x) => x.id === c.kanbanId)
      const to = (c.toColumns || []).map((id) => col(db, c.kanbanId, id)).filter(Boolean)
      const what = c.event === 'created' ? 'Negócio criado' : to.length ? `Negócio foi para ${quoted(to)}` : 'Negócio mudou de etapa'
      return `${what}${k ? ` → ${k.name}` : ''}`
    }
    case 'deal_result': {
      const k = db?.kanbans?.find((x) => x.id === c.kanbanId)
      return `Negócio ${c.result === 'lost' ? 'perdido' : 'ganho'}${k ? ` → ${k.name}` : ''}`
    }
    case 'assignee': {
      const who = db?.team?.find((m) => m.id === c.to)?.name
      return `Responsável ${c.scope === 'deal' ? 'do negócio' : c.scope === 'any' ? '' : 'da conversa'} alterado${who ? ` → para ${who}` : ''}`.replace('  ', ' ')
    }
    case 'stage_idle': return c.columnId ? `Parado em "${col(db, c.kanbanId, c.columnId) || 'etapa'}" por ${span(c.amount, c.unit)}` : 'Tempo parado na etapa: escolha a etapa'
    case 'schedule': {
      const when = c.mode === 'once' ? `Em ${fmtDay(c.date)}` : c.mode === 'weekly' ? `Toda ${(c.weekdays || []).map((d) => WEEKDAYS[d]).join(', ') || '—'}` : c.mode === 'monthly' ? `Todo dia ${c.monthDay || 1} do mês` : 'Todo dia'
      const aud = names(c.audience?.labelsAny, db?.labels)
      return `${when} às ${c.time || '09:00'}${aud.length ? ` → público: ${aud.join(', ')}` : ' → todos os contatos'}`
    }
    case 'date_field': {
      const d = +c.days || 0
      const tail = `${c.yearly ? ' (todo ano)' : ''} → às ${String(c.time || '09:00').replace(/:00$/, 'h')}`
      const ref = c.source === 'created_at' ? 'do cadastro' : c.field ? `de "${c.field}"` : 'da data (escolha o campo)'
      return `${c.when === 'before' ? `${d} dia(s) antes ${ref}` : c.when === 'after' ? `${d} dia(s) depois ${ref}` : `No dia ${ref}`}${tail}`
    }
    case 'manual': return 'Início manual pela equipe'
    case 'flow': return 'Iniciado por outro fluxo'
    case 'ai_agent': {
      const a = names(c.agents, db?.agents)
      return `Habilidade de agente de IA${a.length ? ` → ${a.join(', ')}` : ''}`
    }
    default: return triggerDef(t?.type).label
  }
}

// Agentes com a habilidade "Disparar fluxo" apontando para este fluxo
export const agentSkillsFor = (db, flowId) =>
  (db?.agents || []).flatMap((a) => (a.skills || []).filter((s) => s.flowId === flowId).map((s) => ({ agent: a, skill: s })))
