// Regras puras dos gatilhos de início dos fluxos (sem banco): formato do bloco Início, palavra-chave, horários com fuso,
// filtros, reentrada, datas e o mapeamento do payload dos webhooks. O servidor (triggers.ts) e o editor
// (src/lib/triggers.js, importado pelo Vite) usam este mesmo arquivo, então ele não importa nada.

export type Trigger = { id: string; type: string; enabled?: boolean; config?: Record<string, any> }
export type Hours = { enabled?: boolean; days?: number[]; from?: string; to?: string; tz?: string; outside?: 'wait' | 'ignore' }
export type FieldRule = { key: string; op?: string; value?: string }
export type Filters = {
  connections?: string[]; labelsAny?: string[]; labelsNone?: string[]; origins?: string[]; assignees?: string[]
  kanbanId?: string; columns?: string[]; fields?: FieldRule[]
}
export type Rules = {
  reentry?: 'always' | 'once' | 'interval'; interval?: { amount?: number; unit?: string }
  ifInFlow?: 'ignore' | 'restart'; ifOtherFlow?: 'replace' | 'skip'
  hours?: Hours; filters?: Filters
  stopOn?: { reply?: boolean; labels?: string[]; kanbanId?: string; columns?: string[] }
}
export type Start = { triggers: Trigger[]; rules: Rules; legacy: boolean }

export const DEFAULT_TZ = 'America/Sao_Paulo'
export const UNIT_SECONDS: Record<string, number> = { segundos: 1, minutos: 60, horas: 3600, dias: 86400 }
export const toSeconds = (amount: unknown, unit: unknown) => Math.max(0, +(amount as number) || 0) * (UNIT_SECONDS[String(unit)] || 60)

export const DEFAULT_RULES: Required<Pick<Rules, 'reentry' | 'ifInFlow' | 'ifOtherFlow'>> & Rules = {
  reentry: 'always', interval: { amount: 1, unit: 'dias' }, ifInFlow: 'ignore', ifOtherFlow: 'replace',
  hours: { enabled: false, days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00', tz: DEFAULT_TZ, outside: 'wait' },
  filters: {}, stopOn: {},
}

// Gatilho que o formato antigo (data.keywords) vira: "Mensagem recebida", contém a palavra inteira, sem diferenciar
// maiúsculas e com acentos como eram (a mesma regra do pickFlow antigo).
export const LEGACY_TRIGGER_ID = 'palavras-chave'
export function legacyTrigger(keywords: string[]): Trigger {
  return {
    id: LEGACY_TRIGGER_ID, type: 'message', enabled: true,
    config: { connections: [], mode: 'keyword', keywords, match: 'contains', wholeWord: true, ignoreCase: true, ignoreAccents: false },
  }
}

// Bloco Início de um fluxo → gatilhos e regras (formato antigo convertido na leitura; nada muda no banco).
export function startOf(nodes: any[] | null | undefined): Start {
  const d = (nodes || []).find((n: any) => n?.type === 'start')?.data || {}
  const rules = { ...DEFAULT_RULES, ...(d.rules || {}) }
  if (Array.isArray(d.triggers)) return { triggers: d.triggers.filter((t: any) => t?.type), rules, legacy: false }
  const kws: string[] = (Array.isArray(d.keywords) ? d.keywords : []).map((k: unknown) => String(k ?? '').trim()).filter(Boolean)
  return { triggers: kws.length ? [legacyTrigger(kws)] : [], rules, legacy: true }
}

export const enabledTriggers = (s: Start, type?: string) => s.triggers.filter((t) => t.enabled !== false && (!type || t.type === type))

/* ---------- Texto e palavra-chave ---------- */

export function normalizeText(s: unknown, o: { ignoreCase?: boolean; ignoreAccents?: boolean } = {}) {
  let t = String(s ?? '').trim().replace(/\s+/g, ' ')
  if (o.ignoreAccents) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (o.ignoreCase !== false) t = t.toLowerCase()
  return t
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Palavras e frases do gatilho "Mensagem recebida". Sem palavras (ou modo "qualquer mensagem") = qualquer mensagem.
export function matchMessage(text: unknown, cfg: Record<string, any> = {}): boolean {
  const kws: string[] = (cfg.keywords || []).map((k: unknown) => String(k ?? '').trim()).filter(Boolean)
  if (cfg.mode !== 'keyword' || !kws.length) return true
  const o = { ignoreCase: cfg.ignoreCase !== false, ignoreAccents: !!cfg.ignoreAccents }
  const t = normalizeText(text, o)
  if (!t) return false
  return kws.some((raw) => {
    const k = normalizeText(raw, o)
    if (!k) return false
    switch (cfg.match) {
      case 'exact': return t === k
      case 'starts': return cfg.wholeWord ? new RegExp(`^${escapeRe(k)}($|[^\\p{L}\\p{N}_])`, 'u').test(t) : t.startsWith(k)
      case 'ends': return cfg.wholeWord ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}$`, 'u').test(t) : t.endsWith(k)
      default: return cfg.wholeWord ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}($|[^\\p{L}\\p{N}_])`, 'u').test(t) : t.includes(k)
    }
  })
}

// Conexões: lista vazia = todas.
export const connectionOk = (cfg: Record<string, any> = {}, connectionId?: string | null) =>
  !(cfg.connections || []).length || (!!connectionId && cfg.connections.includes(connectionId))

/* ---------- Fuso e horários ---------- */

export type Parts = { y: number; m: number; d: number; h: number; min: number; wd: number }

export function zonedParts(date: Date, tz = DEFAULT_TZ): Parts {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz || DEFAULT_TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, wd }
}

// Hora local (no fuso) → instante. Acerta o deslocamento duas vezes (horário de verão).
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz = DEFAULT_TZ): Date {
  const want = Date.UTC(y, m - 1, d, h, min)
  let t = want
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz)
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
  }
  return new Date(t)
}

const hm = (s: unknown, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  return m ? Math.min(+m[1], 23) * 60 + Math.min(+m[2], 59) : fallback
}

// Dentro dos dias e horários permitidos? Janela que passa da meia-noite (22:00 às 06:00) também vale.
export function withinHours(h: Hours | undefined, now: Date): boolean {
  if (!h?.enabled) return true
  const p = zonedParts(now, h.tz)
  const days = h.days?.length ? h.days : [0, 1, 2, 3, 4, 5, 6]
  const from = hm(h.from, 0), to = hm(h.to, 24 * 60), cur = p.h * 60 + p.min
  if (from === to) return days.includes(p.wd)
  if (from < to) return days.includes(p.wd) && cur >= from && cur < to
  // passa da meia-noite: depois do início conta para o dia de hoje; antes do fim, para o dia anterior
  return (cur >= from && days.includes(p.wd)) || (cur < to && days.includes((p.wd + 6) % 7))
}

// Próximo início de janela permitida (para "aguardar a próxima janela").
export function nextWindow(h: Hours | undefined, now: Date): Date | null {
  if (!h?.enabled) return now
  const tz = h.tz || DEFAULT_TZ
  const days = h.days?.length ? h.days : [0, 1, 2, 3, 4, 5, 6]
  const from = hm(h.from, 0)
  const p = zonedParts(now, tz)
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i))
    const wd = day.getUTCDay()
    if (!days.includes(wd)) continue
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(from / 60), from % 60, tz)
    if (at.getTime() > now.getTime()) return at
  }
  return null
}

/* ---------- Filtros e reentrada ---------- */

export type Subject = { contact: any; chat?: any; connectionId?: string | null; cards?: any[] }

// Campos fixos do contato (os outros ficam em contacts.fields)
export const CONTACT_COLUMN: Record<string, string> = { nome: 'name', telefone: 'phone', email: 'email', status: 'status', estado: 'state', origem: 'origin' }
export const fieldValue = (contact: any, key: string) => (CONTACT_COLUMN[key] ? contact?.[CONTACT_COLUMN[key]] : contact?.fields?.[key])

export function compareValue(actual: unknown, op = 'equals', expected: unknown = ''): boolean {
  const a = normalizeText(actual, { ignoreAccents: true }), e = normalizeText(expected, { ignoreAccents: true })
  switch (op) {
    case 'filled': return a !== ''
    case 'empty': return a === ''
    case 'contains': return a.includes(e)
    case 'not_equals': return a !== e
    case 'any': return true
    default: return a === e
  }
}

// Filtros comuns do bloco Início. Devolve o motivo quando o contato não passa.
export function passesFilters(f: Filters | undefined, s: Subject): string | null {
  if (!f) return null
  const c = s.contact || {}
  const labels: string[] = c.labels || []
  if (f.connections?.length && !f.connections.includes(s.connectionId || s.chat?.connection_id || c.connection_id)) return 'conexão fora do filtro'
  if (f.labelsAny?.length && !f.labelsAny.some((l) => labels.includes(l))) return 'contato sem a etiqueta do filtro'
  if (f.labelsNone?.length && f.labelsNone.some((l) => labels.includes(l))) return 'contato com etiqueta excluída pelo filtro'
  if (f.origins?.length && !f.origins.some((o) => normalizeText(o, { ignoreAccents: true }) === normalizeText(c.origin, { ignoreAccents: true }))) return 'origem fora do filtro'
  if (f.assignees?.length && !f.assignees.includes(s.chat?.assigned_to)) return 'responsável fora do filtro'
  if (f.kanbanId) {
    const card = (s.cards || []).find((k: any) => k.kanban_id === f.kanbanId)
    if (!card) return 'contato fora do funil do filtro'
    if (f.columns?.length && !f.columns.includes(card.column_id)) return 'contato fora da etapa do filtro'
  }
  for (const r of f.fields || []) {
    if (r?.key && !compareValue(fieldValue(c, r.key), r.op, r.value)) return `campo "${r.key}" fora do filtro`
  }
  return null
}

// Reentrada: runs = execuções anteriores deste fluxo para o contato (as que começaram de fato).
export function reentryBlock(rules: Rules, runs: { started_at: string }[], now: Date): string | null {
  if (!runs.length || !rules.reentry || rules.reentry === 'always') return null
  if (rules.reentry === 'once') return 'o contato já passou por este fluxo (executar uma vez por contato)'
  const secs = toSeconds(rules.interval?.amount ?? 1, rules.interval?.unit ?? 'dias')
  const last = Math.max(...runs.map((r) => Date.parse(r.started_at)))
  return now.getTime() - last < secs * 1000 ? 'intervalo mínimo entre entradas ainda não passou' : null
}

/* ---------- Datas (gatilhos de data) ---------- */

export type Ymd = { y: number; m: number; d: number }
export const ymdKey = (x: Ymd) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`
export function addDays(x: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

// Datas como aparecem nos campos: 2026-10-21, 21/10/2026, 21-10-2026, 2026-10-21T09:00:00Z (no fuso informado).
export function parseDate(v: unknown, tz = DEFAULT_TZ): Ymd | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (m) return valid(+m[3], +m[2], +m[1])
  m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s) // dia/mês (aniversário sem ano)
  if (m) return valid(2000, +m[2], +m[1])
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) { const p = zonedParts(new Date(t), tz); return { y: p.y, m: p.m, d: p.d } }
  }
  return null
}
function valid(y: number, m: number, d: number): Ymd | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null
}

// Data do contato bate com o dia-alvo? yearly: só dia e mês (29/02 cai em 28/02 nos anos sem 29).
export function sameDay(date: Ymd, target: Ymd, yearly = false): boolean {
  if (!yearly) return date.y === target.y && date.m === target.m && date.d === target.d
  if (date.m === 2 && date.d === 29 && !valid(target.y, 2, 29)) return target.m === 2 && target.d === 28
  return date.m === target.m && date.d === target.d
}

// Dia que o campo precisa ter para disparar hoje: "3 dias antes" → hoje + 3; "2 dias depois" → hoje − 2.
export function dateTarget(today: Ymd, when: string, days: number): Ymd {
  const n = Math.max(0, Math.round(+days || 0))
  return when === 'before' ? addDays(today, n) : when === 'after' ? addDays(today, -n) : today
}

// Gatilho "Data ou horário programado": a ocorrência mais recente que já chegou (ou null). Uma vez: date + time.
// Recorrente: todo dia, dias da semana ou dia do mês, no horário e fuso. Ocorrências antes de createdAt não contam.
export function lastOccurrence(cfg: Record<string, any>, now: Date): Date | null {
  const tz = cfg.tz || DEFAULT_TZ
  const t = hm(cfg.time, 9 * 60)
  const created = cfg.createdAt ? Date.parse(cfg.createdAt) : 0
  const ok = (at: Date | null) => (at && at.getTime() <= now.getTime() && at.getTime() >= created ? at : null)
  if (cfg.mode === 'once') {
    const d = parseDate(cfg.date)
    return d ? ok(zonedToUtc(d.y, d.m, d.d, Math.floor(t / 60), t % 60, tz)) : null
  }
  const p = zonedParts(now, tz)
  for (let i = 0; i <= 31; i++) {
    const day = addDays({ y: p.y, m: p.m, d: p.d }, -i)
    const wd = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
    if (cfg.mode === 'weekly' && !(cfg.weekdays?.length ? cfg.weekdays : [1]).includes(wd)) continue
    if (cfg.mode === 'monthly' && day.d !== Math.min(+cfg.monthDay || 1, daysIn(day.y, day.m))) continue
    const at = zonedToUtc(day.y, day.m, day.d, Math.floor(t / 60), t % 60, tz)
    if (at.getTime() <= now.getTime()) return ok(at)
  }
  return null
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/* ---------- Webhook: payload real ---------- */

// Caminho no JSON: buyer.phone, data.items.0.name ou data.items[0].name
export function getPath(obj: any, path: string): unknown {
  if (!path) return undefined
  let cur = obj
  for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

// Todos os caminhos com valor simples do payload (para montar o mapeamento a partir de um evento de teste real).
// `maxValor` corta cada valor: 200 basta pra prévia da tela; as variáveis {{evento.*}} do fluxo usam mais (um texto
// pronto de WhatsApp, como o `mensagem` do Vórtex Call, passa de 200 e chegava cortado no meio do link).
export function flattenPaths(obj: any, max = 300, maxValor = 200): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  const walk = (v: any, path: string, depth: number) => {
    if (out.length >= max || depth > 8) return
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Array.isArray(v) ? v.slice(0, 20).entries() : Object.entries(v)) walk(x, path ? `${path}.${k}` : String(k), depth + 1)
    } else out.push({ path, value: v == null ? '' : String(v).slice(0, maxValor) })
  }
  walk(obj, '', 0)
  return out
}

// Telefone em dígitos com DDI. Número brasileiro sem DDI (10 ou 11 dígitos) ganha o 55.
export function normalizePhone(raw: unknown, ddi = '55'): string {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 10 || d.length === 11) d = ddi + d.replace(/^0+/, '')
  return d.length >= 10 && d.length <= 15 ? d : ''
}

// Mapeamento (from: caminho no payload; to: nome | telefone | email | var:<variável> | <campo do contato>)
export type MapRow = { from: string; to: string }
export function mapPayload(payload: any, mapping: MapRow[] = []) {
  const out = { name: '', phone: '', email: '', fields: {} as Record<string, string>, vars: {} as Record<string, string> }
  for (const r of mapping) {
    if (!r?.from || !r?.to) continue
    const raw = getPath(payload, r.from)
    if (raw == null || raw === '' || typeof raw === 'object') continue
    const v = String(raw).trim().slice(0, 1000)
    if (r.to === 'nome') out.name = v
    else if (r.to === 'telefone') out.phone = normalizePhone(v)
    else if (r.to === 'email') out.email = v.toLowerCase()
    else if (r.to.startsWith('var:')) out.vars[r.to.slice(4)] = v
    else out.fields[r.to] = v
  }
  return out
}

// Condições por evento ou valor (todas precisam valer). Devolve a primeira que falhou.
export type Condition = { path: string; op?: string; value?: string }
export function failedCondition(payload: any, conds: Condition[] = []): Condition | null {
  for (const c of conds) {
    if (!c?.path) continue
    const v = getPath(payload, c.path)
    const ok = c.op === 'exists' ? v != null && v !== ''
      : c.op === 'not_exists' ? v == null || v === ''
      : compareValue(typeof v === 'object' ? JSON.stringify(v) : v, c.op || 'equals', c.value)
    if (!ok) return c
  }
  return null
}

// Corpo recebido: JSON ou formulário (application/x-www-form-urlencoded, usado por algumas plataformas).
export function parseBody(raw: string, contentType = ''): any {
  const t = raw.trim()
  if (!t) return {}
  if (/x-www-form-urlencoded/i.test(contentType) || (!/^[[{]/.test(t) && t.includes('='))) {
    const o: Record<string, any> = {}
    for (const [k, v] of new URLSearchParams(t)) {
      // a[b][c]=1 vira { a: { b: { c: '1' } } }
      const parts = k.replace(/\]/g, '').split('[')
      let cur = o
      parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = v; else cur = cur[p] = (typeof cur[p] === 'object' && cur[p]) || {} })
    }
    return o
  }
  return JSON.parse(t)
}
