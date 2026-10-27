// Webhook de entrada dos fluxos (gatilho "Webhook recebido"). URL exclusiva por webhook:
//   POST /functions/v1/inbound-webhook/<token>   (JSON; formulário x-www-form-urlencoded também é aceito)
// O token da URL identifica o webhook (tabela webhooks) e, quando há segredo, ele precisa vir no cabeçalho escolhido,
// em "Authorization: Bearer" ou em ?secret=. Por isso verify_jwt = false.
// Ordem: segredo → módulos → "aguardando evento de teste" (guarda o payload real para o mapeamento, sem rodar o fluxo)
// → condições → id do evento (o mesmo evento não roda duas vezes) → contato pelo mapeamento → fluxo em segundo plano.
// Todo recebimento fica em webhook_events (histórico com status e erro). O evento não libera envio pelo WhatsApp: o
// fluxo segue as regras da conexão (na API oficial, fora das 24 h só template).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json, phoneVariants } from '../_shared/whatsapp.ts'
import { companyModules } from '../_shared/access.ts'
import { startFlow } from '../_shared/triggers.ts'
import { registrarPagamento } from '../_shared/inteligencia/pagamentos.ts'
import { failedCondition, flattenPaths, getPath, mapPayload, parseBody, startOf } from '../_shared/triggers-core.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const MAX_BODY = 256 * 1024

const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('')
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
const looksLikePhone = (name: string) => !name.trim() || /^\+?[\d\s()-]+$/.test(name.trim())

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const last = url.pathname.split('/').filter(Boolean).pop() || ''
  const token = last && last !== 'inbound-webhook' ? last : url.searchParams.get('token') || ''
  if (!token) return json({ error: 'Token ausente na URL.' }, 400)
  const { data: hook } = await admin.from('webhooks').select('*').eq('token', token).maybeSingle()
  if (!hook) return json({ error: 'Webhook não encontrado.' }, 404)
  // algumas plataformas testam a URL com GET antes de cadastrar
  if (req.method === 'GET' || req.method === 'HEAD') return json({ ok: true, message: 'Webhook do Vórtex CRM ativo. Envie os eventos por POST com JSON.' })
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const x = hook.extra || {}
  const log = async (row: Record<string, unknown>) => {
    const { data, error } = await admin.from('webhook_events').insert({ company_id: hook.company_id, webhook_id: hook.id, flow_id: hook.flow_id, ...row }).select('id').single()
    if (error && error.code !== '23505') console.error('webhook_events', error.message)
    return { data, error }
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY) {
    await log({ status: 'error', reason: 'Corpo do evento maior que 256 KB.' })
    return json({ error: 'Corpo muito grande.' }, 413)
  }

  if (x.secret) {
    const header = String(x.secretHeader || 'x-webhook-secret').toLowerCase()
    const given = req.headers.get(header) || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || ''
    if (!sameSecret(given, String(x.secret))) {
      await log({ status: 'error', reason: `Segredo inválido ou ausente (cabeçalho ${x.secretHeader || 'X-Webhook-Secret'}).` })
      return json({ error: 'não autorizado' }, 401)
    }
  }

  let payload: any
  try {
    payload = parseBody(raw, req.headers.get('content-type') || '')
  } catch {
    await log({ status: 'error', reason: 'O corpo não é um JSON válido.', payload: { _texto: raw.slice(0, 2000) } })
    return json({ error: 'JSON inválido.' }, 400)
  }
  if (payload === null || typeof payload !== 'object') payload = { valor: payload }

  const mods = await companyModules(admin, hook.company_id)
  if (!mods.has('webhooks') || !mods.has('fluxos')) {
    await log({ status: 'error', reason: 'Módulo Webhooks de entrada ou Fluxos não liberado para a empresa.', payload })
    return json({ error: 'Módulo não liberado.' }, 403)
  }

  // "Aguardar evento de teste" no editor: guarda o payload real (para montar o mapeamento) e não roda o fluxo
  if (x.listenUntil && Date.parse(x.listenUntil) > Date.now()) {
    await log({ status: 'test', reason: 'Evento de teste recebido. O fluxo não foi executado.', payload })
    await admin.from('webhooks').update({ extra: { ...x, listenUntil: null, lastTest: { at: new Date().toISOString(), payload } } }).eq('id', hook.id)
    return json({ ok: true, test: true })
  }

  await admin.rpc('webhook_hit', { p_id: hook.id })
  // Vórtex Inteligência: aviso de pagamento (Kiwify, Vórtex Pay, Hotmart, Vórtex Call) vira pedido normalizado, com ou
  // sem fluxo ligado. Nunca lança; repetido não conta duas vezes.
  const pagamento = hook.active ? await registrarPagamento(admin, hook.company_id, payload) : null
  if (!hook.active) {
    await log({ status: 'ignored', reason: 'Webhook desligado.', payload })
    return json({ ok: true, ignored: 'webhook desligado' })
  }
  const { data: flow } = hook.flow_id ? await admin.from('flows').select('id, name, status, nodes, edges').eq('id', hook.flow_id).maybeSingle() : { data: null }
  const trig = flow ? startOf(flow.nodes).triggers.find((t) => t.type === 'webhook' && t.config?.webhookId === hook.id) : null
  if (!flow || !trig) {
    await log({ status: 'ignored', reason: 'Nenhum fluxo usa este webhook.', payload })
    return json({ ok: true, ignored: 'sem fluxo' })
  }
  if (trig.enabled === false || flow.status !== 'active') {
    await log({ status: 'ignored', reason: flow.status !== 'active' ? 'O fluxo está pausado.' : 'O gatilho está desligado no fluxo.', payload })
    return json({ ok: true, ignored: 'desligado' })
  }
  const failed = failedCondition(payload, x.conditions)
  if (failed) {
    const got = getPath(payload, failed.path)
    await log({ status: 'ignored', reason: `Condição não atendida: "${failed.path}" ${failed.op === 'exists' ? 'precisa existir' : failed.op === 'not_exists' ? 'não pode existir' : `${failed.op === 'contains' ? 'contém' : failed.op === 'not_equals' ? 'diferente de' : 'igual a'} "${failed.value ?? ''}"`} (veio "${got ?? ''}").`, payload })
    return json({ ok: true, ignored: 'condição' })
  }

  // Id do evento: o campo escolhido ou, sem ele, o corpo inteiro (o mesmo envio repetido não roda de novo)
  const idValue = x.eventIdPath ? getPath(payload, x.eventIdPath) : null
  const eventKey = idValue != null && idValue !== '' && typeof idValue !== 'object' ? `id:${String(idValue).slice(0, 200)}` : `hash:${await sha256(raw)}`
  const { data: row, error } = await log({ status: 'received', event_key: eventKey, dedupe: eventKey, payload })
  if (error?.code === '23505') {
    await log({ status: 'duplicate', reason: 'Evento repetido: este id já foi recebido e processado.', event_key: eventKey, payload })
    return json({ ok: true, duplicate: true })
  }
  if (!row) return json({ error: 'Não foi possível registrar o evento.' }, 500)
  const fail = async (reason: string) => {
    await admin.from('webhook_events').update({ status: 'error', reason }).eq('id', row.id)
    return json({ ok: false, error: reason })
  }

  // Contato pelo mapeamento (o payload de cada plataforma é diferente: só vale o que foi mapeado)
  const mapped = mapPayload(payload, hook.mapping || [])
  let contact: any = null
  if (mapped.phone) contact = (await admin.from('contacts').select('*').eq('company_id', hook.company_id).in('phone_digits', phoneVariants(mapped.phone)).order('created_at').limit(1).maybeSingle()).data
  if (!contact && mapped.email) contact = (await admin.from('contacts').select('*').eq('company_id', hook.company_id).ilike('email', mapped.email).order('created_at').limit(1).maybeSingle()).data
  if (!contact && !mapped.phone) return fail('Telefone não encontrado no evento. No gatilho, ligue o campo do telefone em "Mapeamento".')
  if (!contact) {
    const { data, error: ce } = await admin.from('contacts').insert({
      company_id: hook.company_id, name: mapped.name || `+${mapped.phone}`, phone: `+${mapped.phone}`, email: mapped.email || '', status: 'lead',
      origin: 'Webhook', connection_id: hook.connection_id, fields: mapped.fields,
    }).select('*').single()
    if (ce) return fail(`Não foi possível criar o contato: ${ce.message}`)
    contact = data
  } else {
    const patch: Record<string, unknown> = {}
    if (mapped.name && looksLikePhone(contact.name || '')) patch.name = mapped.name
    if (mapped.email && mapped.email !== contact.email) patch.email = mapped.email
    if (Object.keys(mapped.fields).length) patch.fields = { ...(contact.fields || {}), ...mapped.fields }
    if (Object.keys(patch).length) {
      await admin.from('contacts').update(patch).eq('id', contact.id)
      Object.assign(contact, patch)
    }
  }
  await admin.from('webhook_events').update({ contact_id: contact.id }).eq('id', row.id)
  if (pagamento?.pedido && !pagamento.contato) await admin.from('intel_orders').update({ contact_id: contact.id }).eq('id', pagamento.pedido).is('contact_id', null)

  // Variáveis: o que foi mapeado e o evento inteiro como {{evento.caminho}}
  const evento = Object.fromEntries(flattenPaths(payload, 150, 4000).map((p) => [`evento.${p.path}`, p.value]))
  const work = (async () => {
    const r = await startFlow({ admin, companyId: hook.company_id, modules: mods }, flow, trig, {
      type: 'webhook', key: `wh:${row.id}`, contactId: contact.id, connectionId: hook.connection_id || null,
      data: { webhook: hook.name, ...evento, ...mapped.fields, ...mapped.vars },
    }, { contact })
    const status = r.status === 'started' || r.status === 'scheduled' ? 'ok' : r.status === 'error' ? 'error' : 'ignored'
    await admin.from('webhook_events').update({ status, reason: r.reason || (r.status === 'started' ? 'Fluxo iniciado.' : null), run_id: r.runId || null }).eq('id', row.id)
  })().catch((e) => console.error('webhook', hook.id, e))
  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(work)
  return json({ ok: true, id: row.id })
})
