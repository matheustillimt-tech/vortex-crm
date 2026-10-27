// Início manual de um fluxo (gatilho "Início manual"): botão no contato, na conversa ou no card do Kanban.
// Quem chama precisa ser membro da empresa (o fluxo, o contato e a conversa são lidos com o login dele, pelo RLS).
// As regras do bloco Início valem (reentrada, contato já no fluxo, horário). Numa conversa com a automação desligada,
// o início manual liga de novo (sem isso o fluxo não receberia as respostas do cliente).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { companyModules, missing } from '../_shared/access.ts'
import { startFlow } from '../_shared/triggers.ts'
import { enabledTriggers, startOf } from '../_shared/triggers-core.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const MSG: Record<string, string> = {
  started: 'Fluxo iniciado.',
  scheduled: 'Fora do horário permitido: o fluxo começa na próxima janela.',
  duplicate: 'Este fluxo já foi iniciado agora para este contato.',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  let body: { flowId?: string; contactId?: string; chatId?: string; cardId?: string }
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  if (!body.flowId || !body.contactId) return json({ error: 'flowId e contactId são obrigatórios' }, 400)

  const { data: flow } = await userDb.from('flows').select('id, company_id, name, status, nodes, edges').eq('id', body.flowId).maybeSingle()
  if (!flow) return json({ error: 'Fluxo não encontrado.' }, 404)
  const { data: contact } = await userDb.from('contacts').select('*').eq('id', body.contactId).eq('company_id', flow.company_id).maybeSingle()
  if (!contact) return json({ error: 'Contato não encontrado.' }, 404)
  const { data: chat } = body.chatId ? await userDb.from('chats').select('*').eq('id', body.chatId).eq('contact_id', contact.id).maybeSingle() : { data: null }
  if (body.chatId && !chat) return json({ error: 'Conversa não encontrada.' }, 404)
  const mods = await companyModules(admin, flow.company_id)
  const blocked = missing(mods, 'fluxos', 'conexoes')
  if (blocked) return blocked
  if (flow.status !== 'active') return json({ error: 'O fluxo está pausado. Ative o fluxo para iniciar.' }, 409)
  const trig = enabledTriggers(startOf(flow.nodes), 'manual')[0]
  if (!trig) return json({ error: 'Este fluxo não tem o gatilho "Início manual" ligado.' }, 409)
  const where = body.cardId ? 'negócio' : chat ? 'conversa' : 'contato'
  if (trig.config?.where?.length && !trig.config.where.includes(body.cardId ? 'deal' : chat ? 'chat' : 'contact')) return json({ error: `Este fluxo não pode ser iniciado pelo ${where}.` }, 409)

  const { data: member } = await admin.from('company_members').select('name').eq('company_id', flow.company_id).eq('user_id', user.id).maybeSingle()
  if (chat && chat.bot_active === false) {
    await admin.from('chats').update({ bot_active: true }).eq('id', chat.id)
    chat.bot_active = true
  }
  const r = await startFlow({ admin, companyId: flow.company_id, modules: mods }, flow, trig, {
    type: 'manual', key: `manual:${crypto.randomUUID()}`, contactId: contact.id, chatId: chat?.id ?? null,
    connectionId: trig.config?.connectionId || chat?.connection_id || contact.connection_id || null,
    data: { iniciado_por: member?.name || user.email || '', iniciado_no: where },
  }, { contact, ...(chat ? { chat } : {}) })
  if (r.status === 'started' || r.status === 'scheduled' || r.status === 'duplicate') return json({ ok: true, status: r.status, message: MSG[r.status], runId: r.runId })
  return json({ error: r.reason || 'O fluxo não começou.', status: r.status }, r.status === 'error' ? 500 : 409)
})
