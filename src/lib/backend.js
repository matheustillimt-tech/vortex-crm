import { supabase } from './supabase'

// Coleção do store -> tabela. "cols" são os campos que viram colunas de verdade;
// o resto do objeto vai para a coluna jsonb "extra", então o front pode ganhar campos sem migração.
export const TABLES = {
  departments: { table: 'departments', cols: ['name', 'color'] },
  labels: { table: 'labels', cols: ['name', 'color'] },
  // meta: dados da conta Meta da API Oficial (número, conta, qualidade, pagamento). Só o servidor grava.
  connections: { table: 'connections', cols: ['name', 'number', 'provider', 'plan', 'status'], readonly: ['meta'] },
  // instagram*: contato do Direct (id, @ e perfil), gravados só pelo servidor
  contacts: { table: 'contacts', cols: ['name', 'phone', 'email', 'status', 'origin', 'state', 'labels', 'connectionId', 'fields'], readonly: ['phoneDigits', 'instagramId', 'instagramUsername', 'instagramProfile', 'avatarUrl', 'avatarAt'] },
  // ai*: estado da IA na conversa. Só o servidor e as funções do banco mudam (pausar/retomar passa por chatAiSet).
  chats: { table: 'chats', cols: ['contactId', 'connectionId', 'status', 'unread', 'answered', 'assignedTo', 'departmentId', 'lastMessageAt', 'botActive', 'flowState'], readonly: ['externalId', 'lastMessageText', 'lastMessageFrom', 'aiAgentId', 'aiPaused', 'aiPauseReason', 'aiDueAt', 'aiLockUntil', 'aiState'] },
  kanbans: { table: 'kanbans', cols: ['name', 'color', 'columns'], skip: ['cards'] },
  // triggerTypes: tipos de gatilho do bloco Início, calculados pelo banco
  flows: { table: 'flows', cols: ['name', 'folder', 'status', 'nodes', 'edges'], nullable: ['folder'], readonly: ['triggerTypes'] },
  agents: { table: 'agents', cols: ['name', 'avatar', 'active', 'connectionId'] },
  // turn, clicks, counts, misses, lastClickAt: a roda e a contagem dos cliques, só o servidor grava (rotator_hit)
  rotators: { table: 'rotators', cols: ['name', 'slug', 'connectionIds', 'mode', 'message', 'agentId', 'active'], readonly: ['turn', 'clicks', 'counts', 'misses', 'lastClickAt'] },
  voices: { table: 'voices', cols: ['name'] },
  // calls: o servidor conta a cada recebimento; o resto da configuração (segredo, condições, teste) vai em extra
  webhooks: { table: 'webhooks', cols: ['name', 'connectionId', 'flowId', 'token', 'active', 'mapping'], readonly: ['calls'] },
  dispatches: { table: 'dispatches', cols: ['name', 'flowId', 'connectionId', 'interval', 'total', 'sent', 'status', 'contacts'] },
  pixels: { table: 'pixels', cols: ['name', 'platform', 'pixelId', 'events'] },
  metaProfiles: { table: 'meta_profiles', cols: ['name', 'accounts'] },
  products: { table: 'products', cols: ['name', 'price', 'min', 'max', 'currency'] },
  sales: { table: 'sales', cols: ['connectionId', 'contactId', 'productId', 'value', 'currency', 'state', 'sourceId', 'at'] },
  quickReplies: { table: 'quick_replies', cols: ['shortcut', 'type', 'content'] },
  globalVars: { table: 'global_vars', cols: ['name', 'value', 'description'] },
  customFields: { table: 'custom_fields', cols: ['key', 'label', 'type'] },
  whatsappTemplates: { table: 'whatsapp_templates', cols: ['connectionId', 'name', 'category', 'language', 'body', 'status'] },
  mcpCredentials: { table: 'mcp_credentials', cols: ['name', 'token'] },
  invitations: { table: 'invitations', cols: ['email', 'role', 'departmentId'], readonly: ['code'] },
  platformInvites: { table: 'platform_invites', cols: ['email', 'status'] },
  invoices: { table: 'invoices', cols: ['number', 'amount', 'status', 'date'] },
  team: { table: 'company_members', cols: ['name', 'email', 'role', 'departmentId', 'userId'] },
}
const CARDS = { table: 'kanban_cards', cols: ['kanbanId', 'columnId', 'contactId', 'title', 'value', 'labels', 'assignee', 'notes'] }

// Chaves do store que ficam em companies.settings (jsonb)
export const SETTINGS_KEYS = ['tokens', 'billing', 'expenses', 'webhookQuota', 'dispatchQuota', 'flowFolders', 'integrations', 'connectionFlowConfigs', 'savedFilters', 'businessHours', 'systemFields', 'aiUsage', 'translations']

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const isRef = (k) => /Id$/.test(k) || k === 'assignedTo' || k === 'assignee'

export function toRow(cfg, obj, companyId) {
  const row = { company_id: companyId, extra: {} }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id') row.id = v
    else if (cfg.skip?.includes(k) || cfg.readonly?.includes(k) || k === 'companyId') continue
    else if (cfg.cols.includes(k) || k === 'createdAt' || k === 'updatedAt') row[snake(k)] = isRef(k) && (v === '' || v === undefined) ? null : v ?? null
    else row.extra[k] = v
  }
  // null em coluna obrigatória: deixa o default do banco agir (refs e colunas "nullable" aceitam null)
  for (const k of Object.keys(row)) if (row[k] === null && !isRef(camel(k)) && !cfg.nullable?.includes(camel(k))) delete row[k]
  return row
}

export function fromRow(row) {
  const { extra = {}, company_id, ...rest } = row
  const out = { ...extra }
  for (const [k, v] of Object.entries(rest)) out[camel(k)] = v
  return out
}

const msgToRow = (m, chatId, companyId) => ({ id: m.id, company_id: companyId, chat_id: chatId, sender: m.from, text: m.text, type: m.type || 'text', media_url: m.mediaUrl || null, at: m.at })
export const msgFromRow = (r) => ({
  id: r.id, from: r.sender, text: r.text, type: r.type, mediaUrl: r.media_url, at: r.at, delivery: r.delivery,
  ...(r.extra?.agentName && { agentName: r.extra.agentName }), ...(r.extra?.transcript && { transcript: r.extra.transcript }),
  // motivo da Meta quando a entrega falhou (whatsapp-webhook)
  ...(r.extra?.deliveryError && { deliveryError: r.extra.deliveryError }),
  // vídeo que a IA mandou por link (aula, "como o cliente agenda"): toca no chat
  ...(typeof r.extra?.url === 'string' && /^https?:/.test(r.extra.url) && { mediaLink: r.extra.url }),
})

// Inserções em andamento: quem referencia um id recém-criado espera ele chegar no banco (evita erro de FK).
const pending = new Map()
const waitRefs = async (obj) => {
  const ps = Object.entries(obj).filter(([k, v]) => isRef(k) && pending.has(v)).map(([, v]) => pending.get(v))
  if (ps.length) await Promise.allSettled(ps)
}
const track = (id, p) => {
  pending.set(id, p)
  p.finally(() => pending.get(id) === p && pending.delete(id))
  return p
}
export const waitFor = (id) => pending.get(id) || Promise.resolve()

const check = ({ error }) => {
  if (error) throw new Error(error.message)
}

export function insert(key, obj, companyId) {
  const cfg = TABLES[key]
  return track(obj.id, (async () => {
    await waitRefs(obj)
    check(await supabase.from(cfg.table).insert(toRow(cfg, obj, companyId)))
    if (key === 'kanbans' && obj.cards?.length) await syncCards(obj.id, [], obj.cards, companyId)
  })())
}

export async function update(key, prev, next, companyId) {
  const cfg = TABLES[key]
  await waitFor(next.id)
  await waitRefs(next)
  const row = toRow(cfg, next, companyId)
  delete row.id
  delete row.created_at
  check(await supabase.from(cfg.table).update(row).eq('id', next.id))
  if (key === 'kanbans') await syncCards(next.id, prev.cards || [], next.cards || [], companyId)
}

export async function remove(key, id) {
  await waitFor(id)
  check(await supabase.from(TABLES[key].table).delete().eq('id', id))
}

async function syncCards(kanbanId, prevCards, nextCards, companyId) {
  const nextIds = new Set(nextCards.map((c) => c.id))
  const removed = prevCards.filter((c) => !nextIds.has(c.id)).map((c) => c.id)
  const prevById = new Map(prevCards.map((c) => [c.id, JSON.stringify(c)]))
  const changed = nextCards.filter((c) => prevById.get(c.id) !== JSON.stringify(c))
  if (removed.length) check(await supabase.from(CARDS.table).delete().in('id', removed))
  if (changed.length) {
    await Promise.allSettled(changed.map(waitRefs))
    check(await supabase.from(CARDS.table).upsert(changed.map((c) => ({ ...toRow(CARDS, { ...c, kanbanId }, companyId) }))))
  }
}

export async function saveSetting(state) {
  const settings = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, state[k]]))
  settings.corporate = state.company.corporate || {}
  check(await supabase.from('companies').update({ settings }).eq('id', state.company.id))
}

export async function saveCompany(company, state) {
  check(await supabase.from('companies').update({
    name: company.name, description: company.description || '', slug: company.slug || '', timezone: company.timezone,
    email_notifications: !!company.emailNotifications,
  }).eq('id', company.id))
  if (company.corporate) await saveSetting({ ...state, company })
}

export async function saveProfile(user) {
  check(await supabase.from('profiles').update({ name: user.name, phone: user.phone || '', locale: user.locale || 'pt-BR', timezone: user.timezone || 'America/Sao_Paulo', notif: user.notif || {} }).eq('id', user.id))
}

// Chama uma Edge Function e devolve o JSON (ou lança o erro com a mensagem que o servidor mandou;
// `code` e `hint` vêm junto quando o servidor manda, ex.: configuração faltando).
export async function callFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let j = {}
    try { j = await error.context.json() } catch {}
    const err = new Error(j.error || error.message)
    err.code = j.code
    err.hint = j.hint
    throw err
  }
  return data
}

export async function sendMessage(chatId, msg) {
  await waitFor(chatId)
  return callFn('send-message', { chatId, id: msg.id, text: msg.text, ...(msg.media && { media: msg.media }) })
}

// Foto, vídeo, áudio ou documento do Chat ao Vivo: o servidor dá um link de envio para a pasta do chat no bucket
// privado whatsapp-media e o arquivo sobe direto do navegador. Depois vai em sendMessage como `media`.
export async function uploadChatMedia(chatId, file) {
  await waitFor(chatId)
  const { path, token } = await callFn('send-message', { action: 'upload', chatId, fileName: file.name, size: file.size })
  check(await supabase.storage.from('whatsapp-media').uploadToSignedUrl(path, token, file, { contentType: file.type || 'application/octet-stream' }))
  return { path, fileName: file.name }
}

// Cliques dos rotacionadores (o carregamento do painel já traz, isto só atualiza a contagem com a tela aberta)
export async function rotatorStats(companyId) {
  const { data, error } = await supabase.from('rotators').select('id, turn, clicks, counts, misses, last_click_at').eq('company_id', companyId)
  if (error) throw new Error(error.message)
  return data.map(fromRow)
}

/* ---------- Agentes de IA ---------- */

// Pausar/retomar a IA numa conversa (só nela). Ao retomar, a IA responde o que o cliente deixou sem resposta.
export async function chatAiSet(chatId, active) {
  check(await supabase.rpc('chat_ai_set', { p_chat: chatId, p_active: active }))
  if (active) await callFn('ai-agent', { action: 'kick', chatId }).catch(() => {})
}

// Chaves de IA da empresa: ficam só no servidor; o painel vê se existe e os 4 últimos caracteres.
export const aiCredentialList = async (companyId) => (await rpc('ai_credential_list', { p_company: companyId })).map((r) => ({ provider: r.provider, model: r.model, baseUrl: r.base_url, keyHint: r.key_hint, updatedAt: r.updated_at }))
export const aiCredentialSave = (companyId, provider, { apiKey, model, baseUrl }) =>
  rpc('ai_credential_save', { p_company: companyId, p_provider: provider, p_api_key: apiKey || '', p_model: model || '', p_base_url: baseUrl || '' })
export const aiCredentialRemove = (companyId, provider) => rpc('ai_credential_remove', { p_company: companyId, p_provider: provider })
export const aiCheck = (companyId, provider) => callFn('ai-agent', { action: 'check', companyId, provider })
// Teste ao vivo: o rascunho do agente responde de verdade (sem WhatsApp e sem executar ações)
export const agentTest = (companyId, agent, messages) => callFn('ai-agent', { action: 'test', companyId, agent, messages })

export async function aiRuns(companyId, limit = 200) {
  const { data, error } = await supabase.from('ai_runs').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return data.map(fromRow)
}

const safeName = (n) => (n || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80)

// Arquivo que o agente envia: bucket privado agent-files/<empresa>/<agente>/... (o servidor manda por link temporário)
export async function uploadAgentFile(companyId, agentId, file) {
  const path = `${companyId}/${agentId}/${Date.now()}-${safeName(file.name)}`
  check(await supabase.storage.from('agent-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false }))
  return { path, mime: file.type || 'application/octet-stream', size: file.size, fileName: file.name }
}
export const removeAgentFile = (path) => supabase.storage.from('agent-files').remove([path]).catch(() => {})
export const agentFileLink = async (path) => (await supabase.storage.from('agent-files').createSignedUrl(path, 600)).data?.signedUrl || null

// Foto do agente (só aparece no painel): bucket público agent-avatars/<empresa>/...
export async function uploadAgentAvatar(companyId, file) {
  const path = `${companyId}/agente-${Date.now()}-${safeName(file.name)}`
  check(await supabase.storage.from('agent-avatars').upload(path, file, { contentType: file.type, upsert: false }))
  return supabase.storage.from('agent-avatars').getPublicUrl(path).data.publicUrl
}

export const accessFromRow = (r) => ({ selected: r?.selected || [], effective: r?.effective || [], packageId: r?.package_id || null, customized: !!r?.customized })

// A tela de cobrança mostra o que o superadmin registrou (não o que ficou salvo nas configurações da empresa)
export const withSubscription = (billing, sub) => ({
  ...(billing || {}),
  plan: sub.plan,
  status: sub.status,
  source: sub.source,
  nextDue: sub.renewsAt || sub.trialEndsAt || billing?.nextDue,
})

/* ---------- Várias empresas ---------- */
// As funções do banco conferem o usuário logado: ele só lista, abre e cria empresas como membro (o RLS separa os dados).
const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}
const companyFromRpc = (c) => ({ id: c.id, publicId: c.public_id, name: c.name, role: c.role, plan: c.plan, status: c.status, current: !!c.is_current, logoUrl: c.logo_url || null })
export const listCompanies = async () => (await rpc('my_companies')).map(companyFromRpc)
export const switchCompany = (id) => rpc('switch_company', { p_company: id })
export const createCompany = (f) => rpc('create_company', { p_name: f.name, p_description: f.description || '', p_phone: f.phone || '', p_timezone: f.timezone || 'America/Sao_Paulo' })
export const listInvitations = async () =>
  (await rpc('my_invitations')).map((i) => ({ id: i.id, companyId: i.company_id, companyName: i.company_name, role: i.role, department: i.department, createdAt: i.created_at }))
export const acceptInvitation = ({ id, code }) => rpc('accept_invitation', { p_id: id || null, p_code: code || null })
// Logo/foto da empresa: arquivo no bucket público company-logos/<empresa>/ (só admins da empresa enviam) e link em companies.logo_url
const LOGOS = 'company-logos'
const logoPath = (url) => (url || '').split('/' + LOGOS + '/')[1]?.split('?')[0]
// Arquivo do cabeçalho de um template (imagem, vídeo ou documento): fica público na pasta da empresa, porque a Meta
// baixa pelo link ao criar o template e a cada envio. Devolve o link público.
export const TEMPLATE_MEDIA = {
  IMAGE: { accept: 'image/jpeg,image/png', types: ['image/jpeg', 'image/png'], max: 5, label: 'imagem JPG ou PNG de até 5 MB' },
  VIDEO: { accept: 'video/mp4,video/3gpp', types: ['video/mp4', 'video/3gpp'], max: 16, label: 'vídeo MP4 de até 16 MB' },
  DOCUMENT: { accept: 'application/pdf', types: ['application/pdf'], max: 16, label: 'PDF de até 16 MB' },
}
export async function uploadTemplateMedia(companyId, format, file) {
  const rule = TEMPLATE_MEDIA[format]
  if (!rule || !rule.types.includes(file.type) || file.size > rule.max * 1024 * 1024) throw new Error(`Envie ${rule?.label || 'um arquivo válido'}.`)
  const name = file.name.normalize('NFD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80)
  const path = `${companyId}/${Date.now()}-${name}`
  check(await supabase.storage.from('template-media').upload(path, file, { contentType: file.type, upsert: false }))
  return supabase.storage.from('template-media').getPublicUrl(path).data.publicUrl
}

export async function setCompanyLogo(companyId, image, previousUrl) {
  let url = null
  if (image) {
    const path = `${companyId}/logo-${Date.now()}.${image.ext}`
    check(await supabase.storage.from(LOGOS).upload(path, image.blob, { contentType: image.blob.type, upsert: false }))
    url = supabase.storage.from(LOGOS).getPublicUrl(path).data.publicUrl
  }
  check(await supabase.from('companies').update({ logo_url: url }).eq('id', companyId))
  // apaga o arquivo anterior (se falhar, só sobra um arquivo pequeno sem uso)
  const old = logoPath(previousUrl)
  if (old) await supabase.storage.from(LOGOS).remove([old]).catch(() => {})
  return url
}

// O código do convite é gerado pelo banco: busca depois que a inserção termina
export async function invitationCode(id) {
  await waitFor(id)
  const { data } = await supabase.from('invitations').select('code').eq('id', id).maybeSingle()
  return data?.code || null
}

/* ---------- Leitura paginada ---------- */
// A API devolve no máximo 1000 linhas por consulta: lê em páginas (a 1ª conta o total, as demais vão em paralelo).
// newest: as mais recentes primeiro (e devolve em ordem crescente, como o resto do app espera). cap: teto de linhas.
const PAGE = 1000
const RECENT_MESSAGES = 3000
// Tabelas que crescem com o uso: as mais recentes até o teto. As demais (configurações) vêm inteiras até 10 mil.
const LOAD = {
  chats: { order: 'last_message_at', newest: true, cap: 5000 },
  contacts: { newest: true, cap: 20000 },
  sales: { newest: true, cap: 10000 },
  dispatches: { newest: true, cap: 2000 },
}
export async function fetchRows(table, cid, { order = 'created_at', newest = false, cap = 10000 } = {}) {
  const q = (count) => supabase.from(table).select('*', count ? { count: 'exact' } : undefined).eq('company_id', cid).order(order, { ascending: !newest }).order('id')
  const first = await q(true).range(0, Math.min(PAGE, cap) - 1)
  if (first.error) throw new Error(`${table}: ${first.error.message}`)
  const total = first.count ?? first.data.length
  const upto = Math.min(total, cap)
  const pages = []
  for (let from = PAGE; from < upto; from += PAGE) pages.push(q(false).range(from, Math.min(from + PAGE, upto) - 1))
  const rest = await Promise.all(pages)
  const seen = new Set()
  const rows = []
  for (const r of [first, ...rest]) {
    if (r.error) throw new Error(`${table}: ${r.error.message}`)
    for (const row of r.data) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row) }
  }
  return { rows: newest ? rows.reverse() : rows, total, truncated: total > cap }
}

// Mensagens de uma conversa, das mais novas para trás (before: só as anteriores a essa data)
export const CHAT_PAGE = 100
export async function loadChatMessages(chatId, companyId, before) {
  let q = supabase.from('messages').select('*').eq('chat_id', chatId).eq('company_id', companyId).order('at', { ascending: false }).limit(CHAT_PAGE)
  if (before) q = q.lt('at', before)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data.reverse().map(msgFromRow)
}

// Carrega tudo da empresa atual do usuário logado.
export async function loadAll(userId) {
  const { data: profile, error: pe } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (pe) throw new Error(pe.message)
  const user = { id: profile.id, name: profile.name, email: profile.email, phone: profile.phone, locale: profile.locale, timezone: profile.timezone, notif: profile.notif }
  // Abre a empresa do perfil; se a pessoa não é mais membro dela, abre a primeira que tiver. Sem nenhuma: tela de empresas.
  const companies = await listCompanies()
  if (!companies.length) {
    const { data: isSuperadmin } = await supabase.rpc('am_i_superadmin')
    return { noCompany: true, companies, user, isSuperadmin: !!isSuperadmin }
  }
  let cid = profile.current_company_id
  if (!companies.some((c) => c.id === cid)) {
    cid = companies[0].id
    await switchCompany(cid)
  }
  companies.forEach((c) => { c.current = c.id === cid })
  const { data: company, error: ce } = await supabase.from('companies').select('*').eq('id', cid).single()
  if (ce) throw new Error(ce.message)

  // Tudo em páginas de 1000 (o máximo por consulta da API). Tabelas grandes vêm das mais recentes, até um teto.
  const keys = Object.keys(TABLES)
  const results = await Promise.all(keys.map((k) => fetchRows(TABLES[k].table, cid, LOAD[k])))
  const out = {}
  const truncated = {}
  results.forEach((r, i) => {
    out[keys[i]] = r.rows.map(fromRow)
    if (r.truncated) truncated[keys[i]] = r.total
  })

  const cards = await fetchRows('kanban_cards', cid, { cap: 20000 })
  out.kanbans = out.kanbans.map((k) => ({ ...k, cards: cards.rows.filter((c) => c.kanban_id === k.id).map(fromRow) }))

  // Mensagens: só as mais recentes da empresa; cada conversa busca as dela ao ser aberta (loadChatMessages)
  const msgs = await fetchRows('messages', cid, { order: 'at', newest: true, cap: RECENT_MESSAGES })
  const messages = {}
  for (const m of msgs.rows) (messages[m.chat_id] ||= []).push(msgFromRow(m))

  // Módulos liberados e assinatura vêm de tabelas que só o superadmin altera
  const [{ data: access, error: ae }, { data: sub, error: se }, { data: isSuperadmin }] = await Promise.all([
    supabase.from('company_access').select('*').eq('company_id', cid).maybeSingle(),
    supabase.from('company_subscriptions').select('*').eq('company_id', cid).maybeSingle(),
    supabase.rpc('am_i_superadmin'),
  ])
  if (ae) throw new Error(ae.message)
  if (se) throw new Error(se.message)

  const s = company.settings || {}
  const me2 = out.team.find((m) => m.userId === userId)
  const subscription = sub ? fromRow(sub) : null
  return {
    ...out,
    messages,
    ...Object.fromEntries(SETTINGS_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
    ...(subscription && { billing: withSubscription(s.billing, subscription) }),
    access: accessFromRow(access),
    subscription,
    isSuperadmin: !!isSuperadmin,
    company: { id: company.id, publicId: company.public_id, name: company.name, logoUrl: company.logo_url || null, description: company.description, slug: company.slug, timezone: company.timezone, emailNotifications: company.email_notifications, active: company.active, corporate: s.corporate || {} },
    user: { ...user, role: me2?.role },
    memberId: me2?.id || null,
    truncated,
    companies,
    noCompany: false,
  }
}

// Tempo real: mensagens, chats, contatos e cards chegam sozinhos (e módulos/assinatura quando o superadmin muda).
export function subscribe(companyId, onChange) {
  const ch = supabase.channel('empresa-' + companyId)
  for (const table of ['messages', 'chats', 'contacts', 'kanban_cards', 'connections', 'company_access', 'company_subscriptions']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `company_id=eq.${companyId}` }, (p) => onChange(table, p))
  }
  ch.subscribe()
  return () => supabase.removeChannel(ch)
}

/* ---------- Gatilhos dos fluxos ---------- */
// Contadores do bloco Início (por gatilho e situação), histórico das execuções e o que está agendado.
export const flowRunStats = (flowId) => rpc('flow_run_stats', { p_flow: flowId })
// por bloco: node_id, status (ok | alert | error), total, last_reason, last_at (flow_runs.steps)
export const flowNodeStats = (flowId) => rpc('flow_node_stats', { p_flow: flowId })
export async function flowRuns(flowId, limit = 50) {
  const { data, error } = await supabase.from('flow_runs').select('*').eq('flow_id', flowId).order('started_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return data
}
export async function flowJobsPending(flowId, limit = 30) {
  const { data, error } = await supabase.from('flow_jobs').select('id, kind, trigger_id, contact_id, run_at, status, created_at').eq('flow_id', flowId).eq('status', 'pending').order('run_at').limit(limit)
  if (error) throw new Error(error.message)
  return data
}
// Recebimentos de um webhook de entrada (com o payload real) e o último evento de teste
export async function webhookEvents(webhookId, limit = 20) {
  const { data, error } = await supabase.from('webhook_events').select('*').eq('webhook_id', webhookId).order('received_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return data
}
export async function webhookExtra(webhookId) {
  const { data, error } = await supabase.from('webhooks').select('extra, calls').eq('id', webhookId).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}
// Início manual (gatilho "Início manual")
export const startFlowManual = (body) => callFn('flow-start', body)

// Fotos de perfil dos contatos ainda não procurados (o servidor guarda e devolve o link; até 25 por vez)
export const buscarFotos = (contactIds) => callFn('contato-foto', { contactIds })
