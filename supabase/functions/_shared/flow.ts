// Motor de fluxos (servidor). Mesma lógica do simulador do editor (src/pages/FlowEditor.jsx),
// mas enviando pelo WhatsApp e guardando o estado do chat em chats.flow_state:
//   { flowId, runId, chain, vars, waiting: { type: 'menu'|'input', nodeId, options?, variable?, expiresAt? } }
//   { flowId, runId, chain, vars, resumeAt, nodeId }   (pausado em Intervalo Inteligente)
// Cada execução fica em flow_runs (runId): começa em triggers.ts (startFlow) e termina aqui (concluída, com alerta ou erro).
// chain: fluxos que levaram a esta execução; vai junto nas mudanças de contato e card (extra._flow) para o banco avisar
// os gatilhos sem deixar um fluxo disparar a si mesmo em ciclo.
import { colunaPausada } from './agent-core.ts'
import { numberedMenu, recipientOf, sendMenu, sendTemplate, sendText, templateText, type Creds, type Provider } from './whatsapp.ts'
import { kickAgent } from './kick.ts'

export type Ctx = {
  admin: any
  companyId: string
  settings: Record<string, any>
  chat: any
  contact: any
  provider: Provider | null
  creds: Creds | null
  globals?: Record<string, string>
  modules?: Set<string> // módulos liberados para a empresa (blocos de Kanban e Agente de IA dependem deles)
  run?: Run | null
  windowOpen?: boolean // API oficial: o cliente escreveu nas últimas 24 h (calculado no primeiro envio)
  trail?: Trail // resultado de cada bloco desta execução (flow_runs.steps)
}

export type Run = { id: string | null; chain: string[]; alerts: number; blockedNoted?: boolean; humanNoted?: boolean }
export const runOf = (st: any): Run | null => (st?.runId ? { id: st.runId, chain: st.chain || [], alerts: 0 } : null)

const off = (ctx: Ctx, m: string) => !!ctx.modules && !ctx.modules.has(m)

const UNIT: Record<string, number> = { segundos: 1, minutos: 60, horas: 3600, dias: 86400 }
const INLINE_MAX = 20 // esperas até 20s acontecem na própria requisição; maiores vão para o agendador (flow-tick)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const fill = (t: unknown, vars: Record<string, unknown>) =>
  String(t ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))

export const nextOf = (flow: any, id: string, idx = 0): string | null =>
  flow.edges?.find((e: any) => e.source === id && (e.sourceHandle || 'out-0') === `out-${idx}`)?.target ?? null

async function vars(ctx: Ctx, extra: Record<string, unknown>) {
  if (!ctx.globals) {
    const { data } = await ctx.admin.from('global_vars').select('name, value').eq('company_id', ctx.companyId)
    ctx.globals = Object.fromEntries((data ?? []).map((g: any) => [g.name, g.value]))
  }
  const c = ctx.contact
  return { ...ctx.globals, nome: c.name, primeiro_nome: (c.name || '').split(' ')[0], telefone: c.phone, email: c.email, ...(c.fields || {}), ...extra }
}

async function insertMsg(ctx: Ctx, m: { sender: string; text: string; wa_id?: string | null; delivery?: string }) {
  const now = new Date().toISOString()
  await ctx.admin.from('messages').insert({ company_id: ctx.companyId, chat_id: ctx.chat.id, sender: m.sender, text: m.text, wa_id: m.wa_id ?? null, delivery: m.delivery ?? 'local', at: now })
  if (m.sender === 'bot') await ctx.admin.from('chats').update({ last_message_at: now, answered: true }).eq('id', ctx.chat.id)
}

// O evento que iniciou o fluxo não libera envio: valem as regras da conexão. Na API oficial da Meta, texto livre só
// dentro de 24 h desde a última mensagem do cliente (fora disso, só template aprovado).
// No Instagram vale a mesma janela, e fora dela robô nenhum fala (não existe template; só humano até 7 dias, em send-message).
export const META_WINDOW_MS = 24 * 3600 * 1000
const hasWindow = (provider: Provider | null) => provider === 'meta' || provider === 'instagram'
export const windowOpen = (provider: Provider | null, lastContactAt: string | null | undefined, now = Date.now()) =>
  !hasWindow(provider) || (!!lastContactAt && now - Date.parse(lastContactAt) < META_WINDOW_MS)

async function sendBlocked(ctx: Ctx): Promise<boolean> {
  if (!hasWindow(ctx.provider) || !ctx.creds) return false
  if (ctx.windowOpen === undefined) {
    const { data } = await ctx.admin.from('messages').select('at').eq('chat_id', ctx.chat.id).eq('sender', 'contact').order('at', { ascending: false }).limit(1).maybeSingle()
    ctx.windowOpen = windowOpen(ctx.provider, data?.at)
  }
  if (ctx.windowOpen) return false
  if (ctx.run) ctx.run.alerts++
  ctx.trail?.alert(ctx.provider === 'instagram' ? 'Mensagem não enviada: fora das 24 h do Instagram' : 'Mensagem não enviada: fora da janela de 24 h da API oficial')
  if (!ctx.run?.blockedNoted) {
    if (ctx.run) ctx.run.blockedNoted = true
    await note(ctx, ctx.provider === 'instagram'
      ? '⚠️ Mensagem do fluxo não enviada: no Instagram, robô só responde até 24 h depois da última mensagem do cliente.'
      : '⚠️ Mensagem do fluxo não enviada: na API oficial só dá para mandar texto até 24 h depois da última mensagem do cliente. Para falar primeiro, use o bloco Template WhatsApp.')
  }
  return true
}

// Conversa em atendimento humano (tem responsável da equipe) ou negócio numa coluna do Kanban com "Pausar IA e
// disparos" (ex.: Em negociação): fluxo automático (e disparo, que roda por fluxo) não fala nem entrega à IA.
// Kanban, etiquetas e campos continuam. Fluxo disparado à mão pela equipe (gatilho manual) fala normalmente.
async function humanBlocked(ctx: Ctx, gatilho: unknown): Promise<boolean> {
  if (gatilho === 'manual') return false
  const humano = !!ctx.chat?.assigned_to && ctx.chat.status !== 'resolved'
  const coluna = humano ? null : await colunaPausada(ctx.admin, ctx.companyId, ctx.contact?.id)
  if (!humano && !coluna) return false
  ctx.trail?.alert(humano ? 'Não enviado: conversa em atendimento humano' : `Não enviado: negócio em "${coluna}" no Kanban`)
  if (!ctx.run?.humanNoted) {
    if (ctx.run) ctx.run.humanNoted = true
    await note(ctx, humano ? '🙋 Mensagem do fluxo não enviada: a conversa está em atendimento humano.' : `⏸️ Mensagem do fluxo não enviada: o negócio está em "${coluna}" no Kanban.`)
  }
  return true
}

export async function say(ctx: Ctx, text: string, gatilho?: unknown) {
  if (await humanBlocked(ctx, gatilho)) return
  if (await sendBlocked(ctx)) return
  let waId: string | null = null
  let delivery = 'local'
  if (ctx.provider && ctx.creds) {
    try { waId = await sendText(ctx.provider, ctx.creds, recipientOf(ctx.provider, ctx.contact, ctx.chat), text); delivery = 'sent' } catch (e) { delivery = 'failed'; console.error('envio falhou', e); ctx.trail?.error(`Mensagem não enviada: ${errMsg(e)}`) }
  }
  await insertMsg(ctx, { sender: 'bot', text, wa_id: waId, delivery })
}

const note = (ctx: Ctx, text: string) => insertMsg(ctx, { sender: 'sys', text })
// bloco pulado ou incompleto: a nota vai para a conversa e o bloco conta como alerta no editor
const skip = (ctx: Ctx, text: string) => { ctx.trail?.alert(text.replace(/^▸\s*/, '')); return note(ctx, text) }
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 200)

/* ---------- Resultado de cada bloco (flow_runs.steps) ---------- */

// Cada bloco por onde a execução passa vira um passo: ok, alert (pulado, fora da janela de 24 h, saída de falha) ou
// error (envio recusado, gravação que falhou, bloco que quebrou), com o motivo. Os passos de um trecho (até o fim ou
// uma espera) vão de uma vez para flow_runs.steps; o editor soma por bloco (flow_node_stats).
export type Step = { n: string; s: 'ok' | 'alert' | 'error'; r?: string; at: string }
export type Trail = ReturnType<typeof newTrail>

export function newTrail(ctx: Ctx) {
  let steps: Step[] = []
  let runId = ctx.run?.id ?? null
  let node: string | null = null
  let base = 0
  let mark: { s: 'alert' | 'error'; r: string } | null = null
  const close = () => {
    if (!node) return
    const s = mark?.s ?? ((ctx.run?.alerts ?? 0) > base ? 'alert' : 'ok')
    steps.push({ n: node, s, ...(mark?.r ? { r: mark.r.slice(0, 200) } : {}), at: new Date().toISOString() })
    node = null
    mark = null
  }
  const flush = async () => {
    close()
    const out = steps
    steps = []
    // a estatística nunca derruba o fluxo
    if (!runId || !out.length) return
    try {
      const { error } = await ctx.admin.rpc('flow_run_steps_add', { p_run: runId, p_steps: out })
      if (error) console.error('steps', error.message)
    } catch (e) { console.error('steps', e) }
  }
  return {
    get steps() { return steps },
    // começa um bloco e fecha o anterior; numa Conexão de Fluxo a execução muda e os passos de antes vão para a anterior
    async begin(id: string) {
      close()
      if ((ctx.run?.id ?? null) !== runId) { await flush(); runId = ctx.run?.id ?? null }
      node = id
      base = ctx.run?.alerts ?? 0
    },
    alert(r: string) { if (node && mark?.s !== 'error') mark = { s: 'alert', r } },
    error(r: string) { if (node) mark = { s: 'error', r } },
    flush,
  }
}

export async function saveState(ctx: Ctx, state: Record<string, unknown>) {
  // fluxo parado (menu, resposta, intervalo): a execução vai junto para continuar contando nela
  if (Object.keys(state).length && ctx.run?.id) state = { ...state, runId: ctx.run.id, chain: ctx.run.chain }
  ctx.chat.flow_state = state
  await ctx.admin.from('chats').update({ flow_state: state }).eq('id', ctx.chat.id)
}

/* ---------- Execuções (flow_runs) ---------- */

export async function setRun(admin: any, id: string | null | undefined, patch: Record<string, unknown>) {
  if (!id) return
  const done = ['done', 'alert', 'error', 'cancelled', 'skipped'].includes(String(patch.status))
  await admin.from('flow_runs').update({ ...patch, ...(done ? { finished_at: new Date().toISOString() } : {}) }).eq('id', id)
}

// Marca extra._flow numa gravação de contato/card feita pelo fluxo (o banco tira a marca e a passa ao evento).
export const flowMark = (ctx: Ctx, extra: any) => (ctx.run?.id ? { extra: { ...(extra || {}), _flow: { run: ctx.run.id, chain: ctx.run.chain } } } : {})

// Produto e valor no negócio do contato no Kanban escolhido (extra.venda mostra o produto no card). Valor vazio = preço
// do produto; moeda do bloco ou do produto. Devolve a nota da conversa.
// - 'possivel' (bloco Possível venda: carrinho abandonado, Pix gerado…): sem negócio lá, cria na primeira coluna.
// - 'aprovada' (bloco Venda aprovada, com o Kanban escolhido): só atualiza o negócio que já existe (a coluna fica com o bloco Kanban).
export async function vendaNoNegocio(ctx: Ctx, c: any, status: 'possivel' | 'aprovada'): Promise<string> {
  const nome = status === 'possivel' ? 'Possível venda' : 'Venda aprovada'
  const { data: k } = c.crmId ? await ctx.admin.from('kanbans').select('id, columns').eq('id', c.crmId).eq('company_id', ctx.companyId).maybeSingle() : { data: null }
  if (!k) return `▸ ${nome}: escolha o Kanban do negócio no bloco`
  const { data: p } = c.productId ? await ctx.admin.from('products').select('id, name, price, currency').eq('id', c.productId).eq('company_id', ctx.companyId).maybeSingle() : { data: null }
  const value = +c.amount || +(p?.price ?? 0) || 0
  const venda = { produtoId: p?.id ?? null, produto: p?.name ?? '', moeda: c.currency || p?.currency || 'BRL', status, em: new Date().toISOString() }
  const { data: card } = await ctx.admin.from('kanban_cards').select('id, extra').eq('kanban_id', k.id).eq('contact_id', ctx.contact.id).maybeSingle()
  if (card) {
    const extra = { ...(card.extra || {}), venda }
    await ctx.admin.from('kanban_cards').update({ value, extra, ...flowMark(ctx, extra) }).eq('id', card.id)
  } else if (status === 'aprovada') {
    return `▸ ${nome}: o contato não tem negócio nesse Kanban (coloque o bloco Kanban antes)`
  } else {
    const col = (k.columns || [])[0]
    if (!col) return `▸ ${nome} pulada: o Kanban não tem colunas`
    await ctx.admin.from('kanban_cards').insert({
      company_id: ctx.companyId, kanban_id: k.id, column_id: col.id, contact_id: ctx.contact.id, title: ctx.contact.name, value, labels: ctx.contact.labels || [],
      extra: { venda }, ...flowMark(ctx, { venda }),
    })
  }
  const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: venda.moeda }).format(value)
  return `${status === 'possivel' ? '🛒' : '✅'} ${nome} no Kanban: ${venda.produto || 'sem produto'} (${fmt})`
}

// Bloco Etiquetas: as mesmas etiquetas entram (ou saem) também dos negócios do contato no Kanban; as outras etiquetas
// de cada negócio ficam como estão.
export async function etiquetarNegocios(ctx: Ctx, ids: string[], remover: boolean) {
  if (!ids.length) return
  const { data: cards } = await ctx.admin.from('kanban_cards').select('id, labels').eq('company_id', ctx.companyId).eq('contact_id', ctx.contact.id)
  for (const card of cards || []) {
    const cur: string[] = card.labels || []
    const labels = remover ? cur.filter((l) => !ids.includes(l)) : [...new Set([...cur, ...ids])]
    if (labels.length !== cur.length) await ctx.admin.from('kanban_cards').update({ labels }).eq('id', card.id)
  }
}

export async function loadFlow(ctx: Ctx, flowId: string | null | undefined) {
  if (!flowId) return null
  const { data } = await ctx.admin.from('flows').select('id, name, status, nodes, edges').eq('id', flowId).eq('company_id', ctx.companyId).maybeSingle()
  return data
}

export function matchOption(options: string[], text: string, replyId?: string | null) {
  if (replyId?.startsWith('opt-')) return +replyId.slice(4)
  const t = (text || '').trim().toLowerCase()
  const n = parseInt(t, 10)
  if (String(n) === t && n >= 1 && n <= options.length) return n - 1
  let i = options.findIndex((o) => o.trim().toLowerCase() === t)
  if (i < 0) i = options.findIndex((o) => t && (t.includes(o.trim().toLowerCase()) || o.trim().toLowerCase().includes(t)))
  return i
}

const CHAT_STATUS: Record<string, string> = { Aguardando: 'waiting', Atendendo: 'attending', Resolvido: 'resolved' }

export async function runFrom(ctx: Ctx, flowIn: any, startId: string | null, v0: Record<string, unknown> = {}, run?: Run | null) {
  if (run !== undefined) ctx.run = run
  const trail = ctx.trail = newTrail(ctx)
  try {
    const r = await walk(ctx, flowIn, startId, v0)
    await trail.flush()
    if (r === 'waiting') await setRun(ctx.admin, ctx.run?.id, { status: 'waiting' })
    else await setRun(ctx.admin, ctx.run?.id, ctx.run?.alerts ? { status: 'alert', reason: r || 'Concluído com alertas (veja as notas na conversa).' } : { status: 'done', reason: null })
  } catch (e) {
    trail.error(errMsg(e))
    await trail.flush()
    await setRun(ctx.admin, ctx.run?.id, { status: 'error', reason: String((e as Error)?.message || e).slice(0, 300) }).catch(() => {})
    throw e
  } finally {
    if (ctx.trail === trail) ctx.trail = undefined
  }
}

// Percorre os blocos. 'waiting' = parou esperando (menu, resposta, intervalo); texto = terminou com aviso.
async function walk(ctx: Ctx, flowIn: any, startId: string | null, v0: Record<string, unknown>): Promise<'waiting' | string | null> {
  let flow = flowIn
  let cur = startId
  let steps = 0
  const v = { ...v0 }
  while (cur && steps++ < 60) {
    const n = flow.nodes?.find((x: any) => x.id === cur)
    if (!n) break
    if (n.type === 'start') { cur = nextOf(flow, n.id); continue }
    await ctx.trail?.begin(n.id)
    const kind = n.data?.kind
    const c = n.data?.config || {}
    const V = await vars(ctx, v)
    switch (kind) {
      case 'message': {
        const secs = Math.min(+c.typing || 0, 5)
        if (secs) await sleep(secs * 1000)
        await say(ctx, fill(c.text, V), v.gatilho)
        cur = nextOf(flow, n.id)
        break
      }
      case 'pix':
        await say(ctx, `${fill(c.text || 'Segue o Pix para pagamento', V)}\n\nChave Pix: ${c.key || '—'}${c.amount ? `\nValor: R$ ${c.amount}` : ''}`, v.gatilho)
        cur = nextOf(flow, n.id)
        break
      case 'whatsapp_template': {
        if (await humanBlocked(ctx, v.gatilho)) { cur = nextOf(flow, n.id); break }
        const language = c.language || 'pt_BR'
        // valores das variáveis do template ({{1}}, {{2}}…), com {{nome}} etc. preenchidos; a Meta não aceita valor vazio
        const params = (Array.isArray(c.params) ? c.params : []).map((p: unknown) => fill(p, V).trim() || '-')
        const { data: tpl } = await ctx.admin.from('whatsapp_templates').select('body, extra').eq('company_id', ctx.companyId)
          .eq('name', c.template || '').eq('language', language).limit(1).maybeSingle()
        const text = tpl?.body ? templateText(tpl.body, params) : ''
        // cabeçalho de mídia: o arquivo escolhido no bloco ou, sem ele, o que foi enviado ao criar o template
        const h = tpl?.extra?.header
        const media = h && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(h.format) ? (c.headerUrl || h.mediaUrl || '') : ''
        const header = media ? { format: h.format, link: media, filename: c.headerName || undefined } : null
        let waId = null, delivery = 'local'
        if (ctx.provider && ctx.creds) {
          try { waId = await sendTemplate(ctx.provider, ctx.creds, recipientOf(ctx.provider, ctx.contact, ctx.chat), c.template, language, { params, header, text }); delivery = 'sent' } catch (e) { delivery = 'failed'; console.error(e); ctx.trail?.error(`Template não enviado: ${errMsg(e)}`) }
        }
        await insertMsg(ctx, { sender: 'bot', text: text || `[template] ${c.template || ''}`, wa_id: waId, delivery })
        cur = nextOf(flow, n.id)
        break
      }
      case 'notification':
        if (c.phone && ctx.provider && ctx.creds) {
          try { await sendText(ctx.provider, ctx.creds, c.phone, fill(c.text, V)) } catch (e) { console.error(e); ctx.trail?.error(`Notificação não enviada: ${errMsg(e)}`) }
        } else if (!c.phone) ctx.trail?.alert('Notificação sem o número que recebe')
        await note(ctx, `🔔 Notificação enviada para ${c.phone || '—'}`)
        cur = nextOf(flow, n.id)
        break
      case 'interactive_menu':
      case 'menu':
      case 'carousel': {
        const options: string[] = (c.options || []).filter(Boolean)
        const text = fill(c.text || 'Escolha uma opção:', V)
        // menu que não pode sair não fica esperando resposta
        if (await humanBlocked(ctx, v.gatilho)) { await saveState(ctx, {}); return 'Menu não enviado: conversa em atendimento humano ou negócio pausado no Kanban.' }
        if (await sendBlocked(ctx)) { await saveState(ctx, {}); return 'Menu não enviado: fora da janela de 24 h da API oficial.' }
        let shown = numberedMenu(text, options), waId: string | null = null, delivery = 'local'
        if (ctx.provider && ctx.creds) {
          try { const r = await sendMenu(ctx.provider, ctx.creds, recipientOf(ctx.provider, ctx.contact, ctx.chat), text, options); shown = r.shown; waId = r.id; delivery = 'sent' } catch (e) { delivery = 'failed'; console.error(e); ctx.trail?.error(`Menu não enviado: ${errMsg(e)}`) }
        }
        await insertMsg(ctx, { sender: 'bot', text: shown, wa_id: waId, delivery })
        await saveState(ctx, { flowId: flow.id, vars: v, waiting: { type: 'menu', nodeId: n.id, options } })
        return 'waiting'
      }
      case 'wait_response': {
        const mins = +c.timeout || 0
        await saveState(ctx, { flowId: flow.id, vars: v, waiting: { type: 'input', nodeId: n.id, variable: c.variable || 'resposta', expiresAt: mins ? new Date(Date.now() + mins * 60000).toISOString() : null } })
        return 'waiting'
      }
      case 'condition': {
        const val = String(V[c.variable] ?? '').toLowerCase()
        const target = String(c.value ?? '').toLowerCase()
        const ok = c.operator === 'é igual a' ? val === target : c.operator === 'não contém' ? !val.includes(target) : c.operator === 'existe' ? !!val : val.includes(target)
        cur = nextOf(flow, n.id, ok ? 0 : 1)
        break
      }
      case 'distributor':
        cur = nextOf(flow, n.id, Math.floor(Math.random() * Math.max(2, +c.count || 2)))
        break
      case 'smart_interval': {
        const secs = (+c.amount || 0) * (UNIT[c.unit] || 1)
        const next = nextOf(flow, n.id)
        if (secs <= INLINE_MAX) { if (secs) await sleep(secs * 1000); cur = next; break }
        await saveState(ctx, { flowId: flow.id, vars: v, nodeId: next, resumeAt: new Date(Date.now() + secs * 1000).toISOString() })
        return 'waiting'
      }
      case 'chat_controller': {
        const status = CHAT_STATUS[c.status] || 'attending'
        await ctx.admin.from('chats').update({ status }).eq('id', ctx.chat.id)
        ctx.chat.status = status
        cur = nextOf(flow, n.id)
        break
      }
      case 'department':
        if (c.departmentId) await ctx.admin.from('chats').update({ department_id: c.departmentId }).eq('id', ctx.chat.id)
        cur = nextOf(flow, n.id)
        break
      case 'tags': {
        const cur0: string[] = ctx.contact.labels || []
        const ids: string[] = c.labels || []
        const labels = c.action === 'Remover' ? cur0.filter((l) => !ids.includes(l)) : [...new Set([...cur0, ...ids])]
        await ctx.admin.from('contacts').update({ labels, ...flowMark(ctx, ctx.contact.extra) }).eq('id', ctx.contact.id)
        ctx.contact.labels = labels
        if (!off(ctx, 'kanban')) await etiquetarNegocios(ctx, ids, c.action === 'Remover')
        cur = nextOf(flow, n.id)
        break
      }
      case 'manipulator': {
        if (c.field) {
          const value = fill(c.value, V)
          const fields = { ...(ctx.contact.fields || {}), [c.field]: value }
          await ctx.admin.from('contacts').update({ fields, ...flowMark(ctx, ctx.contact.extra) }).eq('id', ctx.contact.id)
          ctx.contact.fields = fields
          v[c.field] = value
        }
        cur = nextOf(flow, n.id)
        break
      }
      case 'kanban': {
        await blocoKanban(ctx, c, V)
        cur = nextOf(flow, n.id)
        break
      }
      case 'approved_sale': {
        const { data: p } = c.productId ? await ctx.admin.from('products').select('price, currency').eq('id', c.productId).eq('company_id', ctx.companyId).maybeSingle() : { data: null }
        const { error: se } = await ctx.admin.from('sales').insert({
          company_id: ctx.companyId, connection_id: ctx.chat.connection_id, contact_id: ctx.contact.id, product_id: c.productId || null,
          value: +fill(c.amount, V) || p?.price || 0, currency: c.currency || p?.currency || 'BRL', state: ctx.contact.state || '',
        })
        if (se) ctx.trail?.error(`Venda não registrada: ${se.message}`)
        else await note(ctx, '✅ Venda registrada no painel')
        // "Pôr o valor no negócio do Kanban" (opcional): valor e produto no negócio que o bloco Kanban criou/moveu
        if (c.crmId && !off(ctx, 'kanban')) { const t = await vendaNoNegocio(ctx, { ...c, amount: fill(c.amount, V) }, 'aprovada'); await (t.startsWith('▸') ? skip : note)(ctx, t) }
        cur = nextOf(flow, n.id)
        break
      }
      case 'possible_sale': {
        const t = off(ctx, 'kanban') ? '▸ Bloco Possível venda pulado: módulo Kanban não liberado' : await vendaNoNegocio(ctx, { ...c, amount: fill(c.amount, V) }, 'possivel')
        await (t.startsWith('▸') ? skip : note)(ctx, t)
        cur = nextOf(flow, n.id)
        break
      }
      case 'integration': {
        let ok = false
        let why = ''
        try {
          const r = await fetch(fill(c.url, V), {
            method: c.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: ['GET', 'DELETE'].includes(c.method) ? undefined : fill(c.body || '{}', V),
            signal: AbortSignal.timeout(10000),
          })
          v.resposta_integracao = (await r.text()).slice(0, 2000)
          ok = r.ok
          why = `HTTP ${r.status}`
        } catch (e) { console.error('integração', e); why = errMsg(e) }
        // saiu pela "Falha": o bloco conta como alerta, com o motivo
        if (!ok) ctx.trail?.alert(`Integração falhou: ${why}`)
        cur = nextOf(flow, n.id, ok ? 0 : 1)
        break
      }
      case 'ai_agent':
        if (off(ctx, 'agentes')) {
          await skip(ctx, '▸ Bloco Agente de IA pulado: módulo Agentes de IA não liberado')
          cur = nextOf(flow, n.id)
          break
        }
        if (c.mode === 'Remover agente do chat') {
          const patch = { ai_agent_id: null, ai_paused: true, ai_pause_reason: 'fluxo', ai_due_at: null }
          await ctx.admin.from('chats').update(patch).eq('id', ctx.chat.id)
          Object.assign(ctx.chat, patch)
          await note(ctx, '🤖 Agente de IA removido do chat')
        } else if (await humanBlocked(ctx, v.gatilho)) {
          // atendimento humano: a IA não entra
        } else {
          // entrega a conversa ao agente: ele responde (agrupamento curto) assim que o fluxo terminar
          const { data: ag } = c.agentId ? await ctx.admin.from('agents').select('id, name').eq('id', c.agentId).eq('company_id', ctx.companyId).maybeSingle() : { data: null }
          const patch = { ai_agent_id: ag?.id ?? null, ai_paused: false, ai_pause_reason: null, ai_state: { ...(ctx.chat.ai_state || {}), handoff: true } }
          await ctx.admin.from('chats').update(patch).eq('id', ctx.chat.id)
          Object.assign(ctx.chat, patch)
          await note(ctx, `🤖 Conversa entregue ao agente de IA${ag ? ` ${ag.name}` : ''}`)
          await ctx.admin.rpc('ai_schedule', { p_chat: ctx.chat.id, p_seconds: 3 })
          await kickAgent(ctx.chat.id)
        }
        cur = nextOf(flow, n.id)
        break
      case 'connection_flow': {
        const f2 = await loadFlow(ctx, c.flowId)
        if (f2 && f2.status === 'active') {
          // o fluxo de destino conta como "iniciado por outro fluxo", com as variáveis desta execução
          if (ctx.run?.id) ctx.run = await handOff(ctx, flow, f2, v)
          flow = f2
          cur = 'start'
        } else cur = null
        break
      }
      default:
        await skip(ctx, `▸ Bloco "${kind}" ainda não executa no servidor`)
        cur = nextOf(flow, n.id, 0)
    }
  }
  await saveState(ctx, {})
  if (cur && steps > 60) {
    if (ctx.run) ctx.run.alerts++
    await note(ctx, '⚠️ Fluxo interrompido: mais de 60 blocos seguidos sem pausa (verifique se não há um caminho em círculo).')
    return 'Interrompido: mais de 60 blocos seguidos sem pausa.'
  }
  return null
}

// Conexão de Fluxo: fecha a execução atual e abre outra no fluxo de destino (gatilho "Iniciado por outro fluxo").
async function handOff(ctx: Ctx, from: any, to: any, v: Record<string, unknown>): Promise<Run> {
  const reason = `Seguiu para o fluxo "${to.name}".`
  await setRun(ctx.admin, ctx.run!.id, ctx.run!.alerts ? { status: 'alert', reason } : { status: 'done', reason })
  const chain = [...new Set([...(ctx.run!.chain || []), from.id])]
  const trig = (to.nodes?.find((n: any) => n.type === 'start')?.data?.triggers || []).find((t: any) => t?.type === 'flow')
  const { data } = await ctx.admin.from('flow_runs').insert({
    company_id: ctx.companyId, flow_id: to.id, contact_id: ctx.contact.id, chat_id: ctx.chat.id, trigger_id: trig?.id || '', trigger_type: 'flow',
    status: 'running', chain, data: { fluxo_origem: from.name, ...pickVars(v) },
  }).select('id').single()
  return { id: data?.id ?? null, chain, alerts: 0 }
}

// Variáveis do evento guardadas na execução (só valores simples e curtos)
export const pickVars = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v || {}).filter(([, x]) => x == null || ['string', 'number', 'boolean'].includes(typeof x)).slice(0, 40)
    .map(([k, x]) => [k, typeof x === 'string' ? x.slice(0, 300) : x]))

// Cliente respondeu enquanto o fluxo esperava (menu ou "Aguarda Resposta").
export async function resumeWithReply(ctx: Ctx, text: string, replyId?: string | null) {
  const st = ctx.chat.flow_state || {}
  const w = st.waiting
  const flow = await loadFlow(ctx, st.flowId)
  ctx.run = runOf(st)
  if (!w || !flow || flow.status !== 'active') {
    await saveState(ctx, {})
    await setRun(ctx.admin, ctx.run?.id, { status: 'cancelled', reason: 'O fluxo foi pausado ou excluído enquanto esperava a resposta.' })
    return
  }
  if (w.type === 'menu') {
    const idx = matchOption(w.options || [], text, replyId)
    if (idx < 0) { await say(ctx, 'Não entendi 🤔 Responda com o número de uma das opções.'); return }
    await saveState(ctx, {})
    await runFrom(ctx, flow, nextOf(flow, w.nodeId, idx), st.vars || {})
    return
  }
  await saveState(ctx, {})
  await runFrom(ctx, flow, nextOf(flow, w.nodeId, 0), { ...(st.vars || {}), [w.variable || 'resposta']: text })
}

/** Anotação do card: "trocar" (padrão, como sempre foi) ou "acrescentar" no fim, com uma linha em branco antes.
 *  Nunca passa de 8.000 caracteres: no "acrescentar", sai o começo do texto antigo (o novo fica inteiro). */
export function notasDoCard(atual: unknown, novo: string, modo: unknown): string {
  const texto = novo.slice(0, 8000)
  const antes = String(atual ?? '').trimEnd()
  if (modo !== 'acrescentar' || !antes) return texto
  return `${antes}\n\n${texto}`.slice(-8000)
}

/** Bloco Kanban. Ações: "Criar/mover card" (cria ou move pra coluna; sem coluna, a primeira), "Criar card" (só se
 *  ainda não existir), "Remover card" e "Anotar no negócio" (só a anotação e o responsável do negócio que já existe,
 *  sem mudar de coluna; sem negócio, pula com aviso). "Anotação do card" (opcional) usa as variáveis do fluxo
 *  ({{evento.…}}) e troca ou acrescenta (`notesMode`). */
export async function blocoKanban(ctx: Ctx, c: any, V: Record<string, unknown>): Promise<void> {
  if (off(ctx, 'kanban')) {
    await skip(ctx, '▸ Bloco Kanban pulado: módulo Kanban não liberado')
    return
  }
  const { data: k } = await ctx.admin.from('kanbans').select('id, columns').eq('id', c.crmId).eq('company_id', ctx.companyId).maybeSingle()
  if (!k) {
    await skip(ctx, '▸ Bloco Kanban pulado: o Kanban escolhido não existe mais (escolha outro no bloco)')
    return
  }
  const { data: card } = await ctx.admin.from('kanban_cards').select('id, extra, assignee, notes').eq('kanban_id', k.id).eq('contact_id', ctx.contact.id).maybeSingle()
  if (c.action === 'Remover card') {
    if (card) await ctx.admin.from('kanban_cards').delete().eq('id', card.id)
    return
  }
  // "Criar negócio (se ainda não existir)": quem já tem negócio no quadro fica onde está (um aviso atrasado não puxa para trás)
  if (c.action === 'Criar card' && card) return
  const anotar = c.action === 'Anotar no negócio'
  if (anotar && !card) {
    await skip(ctx, '▸ Anotação pulada: o contato não tem negócio nesse Kanban')
    return
  }
  const texto = String(c.notes || '').trim() ? fill(c.notes, V) : ''
  const notas = texto ? { notes: notasDoCard(card?.notes, texto, c.notesMode) } : {}
  // "Responsável" (opcional): membro da própria empresa; só preenche card sem responsável (não troca quem já cuida)
  let resp: Record<string, string> = {}
  if (c.assignee && !card?.assignee) {
    const { data: m } = await ctx.admin.from('company_members').select('id').eq('id', c.assignee).eq('company_id', ctx.companyId).maybeSingle()
    if (m) resp = { assignee: m.id }
  }
  if (anotar) {
    if (texto || resp.assignee) await ctx.admin.from('kanban_cards').update({ ...notas, ...resp, ...flowMark(ctx, card.extra) }).eq('id', card.id)
    return
  }
  const cols = k.columns || []
  const col = cols.find((x: any) => x.name?.toLowerCase() === String(c.column || '').toLowerCase()) || cols[0]
  if (!col) return
  if (card) await ctx.admin.from('kanban_cards').update({ column_id: col.id, ...notas, ...resp, ...flowMark(ctx, card.extra) }).eq('id', card.id)
  // negócio novo nasce com as etiquetas do contato (as do bloco Etiquetas que veio antes inclusive)
  else await ctx.admin.from('kanban_cards').insert({ company_id: ctx.companyId, kanban_id: k.id, column_id: col.id, contact_id: ctx.contact.id, title: ctx.contact.name, labels: ctx.contact.labels || [], ...notas, ...resp, ...flowMark(ctx, {}) })
}

