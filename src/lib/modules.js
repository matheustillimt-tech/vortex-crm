import { Bot, Columns3, Facebook, Instagram, MessageCircle, Plug, Send, Sparkles, Users, Webhook, Workflow } from 'lucide-react'

// Catálogo de módulos e dependências — espelha supabase/migrations/0003_superadmin_modulos.sql.
// O banco é quem decide o acesso; aqui é só para montar menus, rotas e o painel do superadmin.
export const MODULES = [
  { key: 'conexoes', name: 'Conexões', desc: 'Números de WhatsApp (API Web e API Oficial) e templates', icon: Plug },
  { key: 'contatos', name: 'Contatos', desc: 'Base de contatos e campos personalizados', icon: Users },
  { key: 'chat', name: 'Chat ao vivo', desc: 'Atendimento das conversas e respostas rápidas', icon: MessageCircle },
  { key: 'kanban', name: 'Kanban', desc: 'Quadros de CRM e negócios', icon: Columns3 },
  { key: 'fluxos', name: 'Fluxos de automação', desc: 'Chatbot, fluxos padrões e variáveis globais', icon: Workflow },
  { key: 'agentes', name: 'Agentes de IA', desc: 'Atendentes de IA e vozes', icon: Bot },
  { key: 'webhooks', name: 'Webhooks de entrada', desc: 'Recebe leads de outros sistemas', icon: Webhook },
  { key: 'disparos', name: 'Disparos em massa', desc: 'Envia um fluxo para muitos contatos', icon: Send },
  { key: 'facebook', name: 'Facebook', desc: 'Meta Ads, pixels e perfis', icon: Facebook },
  { key: 'instagram', name: 'Instagram', desc: 'Direct do Instagram pela API oficial (via Zernio)', icon: Instagram },
  { key: 'inteligencia', name: 'Vórtex Inteligência', desc: 'Assistente de gestão com dados reais e evolução dos agentes de IA', icon: Sparkles },
]
export const ALL_MODULES = MODULES.map((m) => m.key)
export const moduleName = (k) => MODULES.find((m) => m.key === k)?.name || k

// módulo -> [módulo de que ele precisa, motivo]
export const DEPS = {
  chat: [['conexoes', 'as conversas chegam e saem por um número conectado'], ['contatos', 'toda conversa pertence a um contato']],
  agentes: [['chat', 'o agente responde dentro das conversas'], ['conexoes', 'o agente fala com o cliente pelo WhatsApp']],
  fluxos: [['conexoes', 'os fluxos começam com mensagens recebidas e respondem pelo WhatsApp'], ['contatos', 'os fluxos leem e alteram dados do contato']],
  disparos: [['fluxos', 'cada disparo envia um fluxo'], ['conexoes', 'o disparo sai por um número conectado'], ['contatos', 'o público do disparo são os contatos']],
  instagram: [['conexoes', 'a conta do Instagram é uma conexão'], ['chat', 'as conversas do Direct são atendidas no Chat ao vivo']],
  inteligencia: [['chat', 'as análises de atendimento leem as conversas'], ['contatos', 'pedidos e oportunidades são ligados aos contatos']],
  webhooks: [['contatos', 'cada chamada cria ou atualiza um contato'], ['conexoes', 'o webhook usa uma conexão para falar com o contato']],
}

// selecionados + tudo de que eles precisam, em cadeia
export function closure(selected) {
  const out = new Set()
  const visit = (k) => {
    if (out.has(k)) return
    out.add(k)
    for (const [req] of DEPS[k] || []) visit(req)
  }
  for (const k of selected || []) if (ALL_MODULES.includes(k)) visit(k)
  return ALL_MODULES.filter((k) => out.has(k))
}

// Quais módulos selecionados (diretamente ou em cadeia) precisam de `key`
export function requiredBy(key, selected) {
  return (selected || []).filter((s) => s !== key && closure([s]).includes(key))
}

// Explicação curta: "Conexões é necessário para utilizar Chat ao vivo e Agentes de IA"
export function why(key, selected) {
  const by = requiredBy(key, selected)
  if (!by.length) return ''
  const names = by.map(moduleName)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0]
  return `${moduleName(key)} é necessário para utilizar ${list}`
}

// Rotas do app -> módulo (o que não está aqui é base da plataforma: Dashboard, Configurações gerais, Cobrança, Perfil)
export const ROUTE_MODULE = [
  ['/chats', 'chat'],
  ['/crms', 'kanban'],
  ['/customers', 'contatos'],
  ['/flows', 'fluxos'],
  ['/agentes', 'agentes'],
  ['/creditos-ia', 'agentes'],
  ['/inteligencia', 'inteligencia'],
  ['/connections', 'conexoes'],
  ['/settings/inbound-webhooks', 'webhooks'],
  ['/mass-dispatches', 'disparos'],
  ['/facebook', 'facebook'],
]
export const moduleForPath = (path) => ROUTE_MODULE.find(([p]) => path === p || path.startsWith(p + '/'))?.[1] || null

// Abas de Configurações que pertencem a um módulo
export const SETTINGS_TAB_MODULE = {
  ai_usage_history: 'agentes',
  flow_translator_history: 'fluxos',
  connection_flow_configs: 'fluxos',
  mass_dispatches: 'disparos',
  quick_replies: 'chat',
  whatsapp_templates: 'conexoes',
  global_variables: 'fluxos',
  custom_fields: 'contatos',
}

// Blocos do editor de fluxos que dependem de outro módulo (o servidor também pula esses blocos)
export const BLOCK_MODULE = { kanban: 'kanban', possible_sale: 'kanban', ai_agent: 'agentes' }

// Situação da assinatura
export const SUB_STATUS = {
  trial: { label: 'Em teste', badge: 'badge-info' },
  active: { label: 'Ativa', badge: 'badge-success' },
  past_due: { label: 'Vencida', badge: 'badge-warning' },
  canceled: { label: 'Cancelada', badge: 'badge-danger' },
}
