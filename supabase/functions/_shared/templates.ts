// Modelos de mensagem (templates) da API Oficial: confere o que o painel manda antes de ir para a Meta e converte o
// que a Meta devolve na linha de whatsapp_templates. Sem rede nem banco (testado em supabase/tests/meta.test.ts).
// Partes do modelo: cabeçalho (texto, imagem, vídeo ou documento), corpo com variáveis, rodapé e botões.
import { templateStatus } from './meta-webhook.ts'

// Autenticação fica de fora: o texto desses modelos é fixo da Meta (código de verificação), não dá para escrever.
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY']
export const TEMPLATE_LANGUAGES = ['pt_BR', 'en_US', 'es_ES']
export const MEDIA_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT']
const BODY_MAX = 1024
const HEADER_MAX = 60
const FOOTER_MAX = 60
const BUTTON_TEXT_MAX = 25

export type TemplateHeader = { format: string; text?: string; mediaUrl?: string }
export type TemplateButton = { type: string; text: string; url?: string; phone?: string }

// Variáveis {{1}}, {{2}}… do corpo, sem repetir, em ordem
export function templateVars(body: string): number[] {
  const nums = [...String(body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  return [...new Set(nums)].sort((a, b) => a - b)
}

export type TemplateInput = {
  name?: unknown; category?: unknown; language?: unknown; body?: unknown; examples?: unknown
  header?: unknown; footer?: unknown; buttons?: unknown
}
export type TemplateDraft = {
  name: string; category: string; language: string; body: string; examples: string[]
  header: TemplateHeader | null; footer: string; buttons: TemplateButton[]; components: any[]
}

const hasVar = (s: string) => /\{\{.*\}\}/.test(s)

// Cabeçalho: nenhum, texto (sem variável) ou mídia (o arquivo já enviado para o armazenamento do painel)
function checkHeader(raw: any): { header: TemplateHeader | null } | { error: string } {
  const format = String(raw?.format || 'NONE').toUpperCase()
  if (format === 'NONE') return { header: null }
  if (format === 'TEXT') {
    const text = String(raw?.text ?? '').trim()
    if (!text) return { error: 'Escreva o texto do cabeçalho ou escolha "Nenhum".' }
    if (text.length > HEADER_MAX) return { error: `O cabeçalho tem no máximo ${HEADER_MAX} caracteres.` }
    if (hasVar(text)) return { error: 'O cabeçalho de texto não aceita variáveis. Use as variáveis no corpo.' }
    return { header: { format, text } }
  }
  if (!MEDIA_FORMATS.includes(format)) return { error: 'Escolha o tipo do cabeçalho.' }
  const mediaUrl = String(raw?.mediaUrl ?? '').trim()
  if (!/^https:\/\/\S+$/i.test(mediaUrl)) return { error: 'Envie o arquivo do cabeçalho (imagem, vídeo ou documento).' }
  return { header: { format, mediaUrl } }
}

// Botões: respostas rápidas, links (até 2) e ligação (até 1), no máximo 10. As respostas rápidas vão juntas na frente,
// como a Meta exige quando os tipos se misturam.
function checkButtons(raw: unknown): { buttons: TemplateButton[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : []
  if (list.length > 10) return { error: 'O modelo tem no máximo 10 botões.' }
  const out: TemplateButton[] = []
  for (const b of list as any[]) {
    const type = String(b?.type || '').toUpperCase()
    const text = String(b?.text ?? '').trim()
    if (!text) return { error: 'Escreva o texto de cada botão.' }
    if (text.length > BUTTON_TEXT_MAX) return { error: `O texto do botão tem no máximo ${BUTTON_TEXT_MAX} caracteres ("${text}").` }
    if (type === 'QUICK_REPLY') out.push({ type, text })
    else if (type === 'URL') {
      const url = String(b?.url ?? '').trim()
      if (!/^https?:\/\/\S+\.\S+$/i.test(url) || hasVar(url)) return { error: `Informe o link completo do botão "${text}" (ex.: https://seusite.com.br).` }
      out.push({ type, text, url })
    } else if (type === 'PHONE_NUMBER') {
      const digits = String(b?.phone ?? '').replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) return { error: `Informe o telefone do botão "${text}" com DDI e DDD (ex.: +55 11 9XXXX-XXXX).` }
      out.push({ type, text, phone: `+${digits}` })
    } else return { error: 'Escolha o tipo de cada botão.' }
  }
  if (out.filter((b) => b.type === 'URL').length > 2) return { error: 'O modelo aceita no máximo 2 botões de link.' }
  if (out.filter((b) => b.type === 'PHONE_NUMBER').length > 1) return { error: 'O modelo aceita no máximo 1 botão de ligação.' }
  return { buttons: [...out.filter((b) => b.type === 'QUICK_REPLY'), ...out.filter((b) => b.type !== 'QUICK_REPLY')] }
}

// Componentes do pedido da Meta. Cabeçalho de mídia leva o `headerHandle` do upload (meta.uploadForTemplate).
export function templateComponents(d: Pick<TemplateDraft, 'body' | 'examples' | 'header' | 'footer' | 'buttons'>, headerHandle = '') {
  const out: any[] = []
  if (d.header?.format === 'TEXT') out.push({ type: 'HEADER', format: 'TEXT', text: d.header.text })
  else if (d.header) out.push({ type: 'HEADER', format: d.header.format, ...(headerHandle ? { example: { header_handle: [headerHandle] } } : {}) })
  const body: Record<string, unknown> = { type: 'BODY', text: d.body }
  if (d.examples.length) body.example = { body_text: [d.examples] }
  out.push(body)
  if (d.footer) out.push({ type: 'FOOTER', text: d.footer })
  if (d.buttons.length) {
    out.push({
      type: 'BUTTONS',
      buttons: d.buttons.map((b) => b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url }
        : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone }
        : { type: 'QUICK_REPLY', text: b.text }),
    })
  }
  return out
}

// Confere o modelo e monta o pedido da Meta. Devolve o erro em português quando algo não passa.
export function templateDraft(input: TemplateInput): { draft: TemplateDraft } | { error: string } {
  const name = String(input.name ?? '').trim()
  const category = String(input.category ?? '').toUpperCase()
  const language = String(input.language ?? '')
  const body = String(input.body ?? '').trim()
  const examples = (Array.isArray(input.examples) ? input.examples : []).map((e) => String(e ?? '').trim())
  const footer = String(input.footer ?? '').trim()

  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { error: 'O nome do modelo usa só letras minúsculas, números e _ (ex.: confirmacao_pedido).' }
  if (!TEMPLATE_CATEGORIES.includes(category)) return { error: 'Escolha a categoria Marketing ou Utilidade.' }
  if (!TEMPLATE_LANGUAGES.includes(language)) return { error: 'Escolha o idioma do modelo.' }
  if (!body) return { error: 'Escreva o texto do modelo.' }
  if (body.length > BODY_MAX) return { error: `O texto do modelo tem no máximo ${BODY_MAX} caracteres.` }

  const vars = templateVars(body)
  if (vars.some((n, i) => n !== i + 1)) return { error: 'Numere as variáveis em sequência, começando em {{1}}.' }
  // a Meta recusa modelo que começa ou termina com variável
  if (/^\{\{\s*\d+\s*\}\}/.test(body) || /\{\{\s*\d+\s*\}\}[.!?…]*$/.test(body)) return { error: 'O texto não pode começar nem terminar com uma variável. Escreva algo antes e depois dela.' }
  const filled = examples.slice(0, vars.length)
  if (filled.length < vars.length || filled.some((e) => !e)) return { error: 'Dê um exemplo para cada variável. A Meta usa os exemplos para analisar o modelo.' }

  if (footer.length > FOOTER_MAX) return { error: `O rodapé tem no máximo ${FOOTER_MAX} caracteres.` }
  if (hasVar(footer)) return { error: 'O rodapé não aceita variáveis.' }
  const h = checkHeader(input.header)
  if ('error' in h) return h
  const b = checkButtons(input.buttons)
  if ('error' in b) return b

  const draft = { name, category, language, body, examples: filled, header: h.header, footer, buttons: b.buttons, components: [] as any[] }
  draft.components = templateComponents(draft)
  return { draft }
}

// Modelo como a Meta devolve (GET /<WABA>/message_templates) → campos de whatsapp_templates
export function templateRow(t: any) {
  const comps: any[] = t?.components || []
  const h = comps.find((c) => c?.type === 'HEADER')
  const header = h ? { format: String(h.format || 'TEXT'), ...(h.format === 'TEXT' || !h.format ? { text: String(h.text || '') } : {}) } : null
  const footer = String(comps.find((c) => c?.type === 'FOOTER')?.text || '')
  const buttons = (comps.find((c) => c?.type === 'BUTTONS')?.buttons || []).map((b: any) => ({
    type: String(b.type), text: String(b.text || ''), ...(b.url ? { url: String(b.url) } : {}), ...(b.phone_number ? { phone: String(b.phone_number) } : {}),
  }))
  return {
    name: String(t?.name || ''),
    language: String(t?.language || ''),
    category: String(t?.category || ''),
    status: templateStatus(String(t?.status || '')),
    body: comps.find((c) => c?.type === 'BODY')?.text || '',
    extra: {
      metaId: String(t?.id || ''),
      rejectedReason: t?.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : '',
      ...(header ? { header } : {}), ...(footer ? { footer } : {}), ...(buttons.length ? { buttons } : {}),
    },
  }
}

// Ao sincronizar: cabeçalho, rodapé e botões vêm da Meta; o arquivo de mídia que o painel enviou (a Meta só devolve um
// link temporário) continua guardado enquanto o cabeçalho for do mesmo tipo.
export function mergeTemplateExtra(prev: any, next: any) {
  const { header: ph, footer: _f, buttons: _b, ...rest } = prev || {}
  const out: any = { ...rest, ...next }
  if (out.header && ph?.mediaUrl && ph.format === out.header.format) out.header = { ...out.header, mediaUrl: ph.mediaUrl }
  return out
}
