// Webhook do app do Vórtex CRM na Meta: uma URL só recebe os eventos de todas as contas conectadas pelo Embedded Signup.
// Cada entry é uma conta do WhatsApp Business (entry.id = WABA ID); as mensagens indicam o número em
// value.metadata.phone_number_id. Aqui só separa o corpo; quem processa é o whatsapp-webhook.

export type AccountChange = { wabaId: string; field: string; value: any }

// Campos de conta que ficam registrados em meta_account_events (os demais, como histórico da coexistência, são ignorados)
export const ACCOUNT_FIELDS = new Set([
  'account_update', 'account_review_update', 'phone_number_quality_update', 'phone_number_name_update',
  'message_template_status_update', 'message_template_quality_update', 'template_category_update', 'business_capability_update',
])

// Mensagens e recibos agrupados por número, no mesmo formato do webhook da Meta (o parseMeta lê direto)
export function splitByPhone(body: any): Map<string, any> {
  const out = new Map<string, any>()
  for (const e of body?.entry ?? []) {
    for (const ch of e.changes ?? []) {
      const phoneId = ch?.field === 'messages' ? String(ch.value?.metadata?.phone_number_id || '') : ''
      if (!phoneId) continue
      const part = out.get(phoneId) ?? { object: body.object, entry: [] }
      let entry = part.entry.find((x: any) => x.id === e.id)
      if (!entry) part.entry.push((entry = { id: e.id, changes: [] }))
      entry.changes.push(ch)
      out.set(phoneId, part)
    }
  }
  return out
}

export function accountChanges(body: any): AccountChange[] {
  const out: AccountChange[] = []
  for (const e of body?.entry ?? []) {
    for (const ch of e.changes ?? []) {
      if (ACCOUNT_FIELDS.has(ch?.field)) out.push({ wabaId: String(ch.value?.waba_info?.waba_id || e.id || ''), field: ch.field, value: ch.value || {} })
    }
  }
  return out
}

// Entrega que falhou (statuses[].errors da Meta) → motivo em português para o chat, com o código para o suporte
const DELIVERY_ERRORS: Record<number, string> = {
  131042: 'falta forma de pagamento na conta do WhatsApp Business (cadastre no Gerenciador do WhatsApp)',
  131049: 'a Meta segurou a mensagem de marketing para não cansar o cliente (limite de marketing por pessoa)',
  131050: 'o cliente parou de receber mensagens de marketing desta empresa',
  130472: 'o número do cliente está num teste da Meta que limita mensagens de marketing',
  131047: 'passaram mais de 24 h desde a última mensagem do cliente: só template pode iniciar a conversa',
  131026: 'o número não pode receber esta mensagem (sem WhatsApp, versão antiga ou não aceitou os termos)',
  131056: 'muitas mensagens seguidas para o mesmo número: aguarde e tente de novo',
  132000: 'a quantidade de variáveis enviadas não bate com o template',
  132001: 'o template não existe neste idioma ou ainda não foi aprovado',
  132012: 'o formato de uma variável ou do cabeçalho não bate com o template',
  132015: 'o template está pausado pela Meta por baixa qualidade',
  132016: 'o template foi desativado pela Meta',
  131053: 'a Meta não conseguiu baixar ou usar o arquivo de mídia',
  368: 'a conta foi restringida temporariamente pela Meta',
}
export function deliveryErrorText(e: { code: number; title?: string; details?: string }) {
  const why = DELIVERY_ERRORS[e.code] || e.details || e.title || 'a Meta não informou o motivo'
  return `Não entregue: ${why} (erro ${e.code || '?'})`
}

// Status de template da Meta → texto da tela de Templates
const TEMPLATE_STATUS: Record<string, string> = {
  APPROVED: 'APROVADO', REINSTATED: 'APROVADO', REJECTED: 'REJEITADO', PENDING: 'EM ANÁLISE', IN_APPEAL: 'EM RECURSO',
  PAUSED: 'PAUSADO', DISABLED: 'DESATIVADO', FLAGGED: 'SINALIZADO', PENDING_DELETION: 'EXCLUÍDO', DELETED: 'EXCLUÍDO',
}
export const templateStatus = (event: string) => TEMPLATE_STATUS[event] || event
