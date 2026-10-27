// Agente de IA. Ações:
//  - run   (servidor: webhook, fluxos e flow-tick, com a chave de serviço): espera o agrupamento e responde a conversa.
//  - kick  (painel, ao retomar a IA numa conversa): responde o que o cliente deixou sem resposta.
//  - check (painel, Configurações → Integrações): testa a chave de IA salva da empresa.
//  - test  (painel, "Teste ao vivo" do agente): roda o rascunho do agente sem WhatsApp e sem executar ações.
// verify_jwt = false: "run" confere a chave de serviço; as outras conferem o usuário logado e a empresa.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { companyModules, missing } from '../_shared/access.ts'
import { AiError, checkChat, checkEleven, loadCreds, pickChatCred } from '../_shared/ai.ts'
import { previewReply, runChat } from '../_shared/agent.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALL_MS = 125_000 // abaixo do limite de tempo das Edge Functions

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const friendly = (e: unknown) => (e instanceof AiError ? e.message : (e as Error)?.message || 'Erro inesperado')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const admin = createClient(URL_, SERVICE)
  const auth = req.headers.get('Authorization') ?? ''

  if (body.action === 'run') {
    if (!same(auth, `Bearer ${SERVICE}`)) return json({ error: 'não autorizado' }, 401)
    if (!body.chatId) return json({ error: 'chatId obrigatório' }, 400)
    // @ts-ignore EdgeRuntime existe no runtime da Supabase
    EdgeRuntime.waitUntil(runChat(admin, body.chatId, Date.now() + WALL_MS).catch((e) => console.error('runChat', e)))
    return json({ ok: true }, 202)
  }

  // Ações do painel: usuário logado, membro da empresa, com o módulo Agentes de IA.
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  let companyId: string | null = body.companyId ?? null
  let chat: any = null
  if (body.action === 'kick') {
    const { data } = await admin.from('chats').select('*').eq('id', body.chatId).maybeSingle()
    chat = data
    companyId = chat?.company_id ?? null
  }
  if (!companyId) return json({ error: 'Empresa não informada' }, 400)
  const { data: member } = await admin.from('company_members').select('id, role').eq('company_id', companyId).eq('user_id', user.id).maybeSingle()
  if (!member) return json({ error: 'Empresa não encontrada' }, 404)
  const mods = await companyModules(admin, companyId)

  try {
    if (body.action === 'check') {
      // testar a chave da plataforma também gasta (pouco) crédito
      const creds = await loadCreds(admin, companyId, { origem: 'verificacao' })
      const p = String(body.provider || '')
      if (p === 'elevenlabs') {
        if (!creds.elevenlabs) return json({ error: 'Salve a chave da ElevenLabs antes de testar.' }, 400)
        return json(await checkEleven(creds.elevenlabs.apiKey))
      }
      const cred = creds[p] || (p ? null : pickChatCred(creds))
      if (!cred) return json({ error: 'Salve a chave antes de testar.' }, 400)
      return json(await checkChat(cred))
    }

    const blocked = missing(mods, 'agentes')
    if (blocked) return blocked

    if (body.action === 'test') {
      const msgs = Array.isArray(body.messages) ? body.messages.slice(-40) : []
      if (!body.agent || !msgs.length) return json({ error: 'Agente e mensagens são obrigatórios' }, 400)
      return json(await previewReply(admin, companyId, body.agent, msgs))
    }

    if (body.action === 'kick') {
      // o cliente estava esperando resposta? (última mensagem da conversa é dele)
      const { data: last } = await admin.from('messages').select('sender').eq('chat_id', chat.id).neq('sender', 'sys').order('at', { ascending: false }).limit(1).maybeSingle()
      if (last?.sender !== 'contact') return json({ ok: true, pending: false })
      await admin.rpc('ai_schedule', { p_chat: chat.id, p_seconds: 1 })
      // @ts-ignore EdgeRuntime existe no runtime da Supabase
      EdgeRuntime.waitUntil(runChat(admin, chat.id, Date.now() + WALL_MS).catch((e) => console.error('runChat', e)))
      return json({ ok: true, pending: true })
    }
    return json({ error: 'Ação desconhecida' }, 400)
  } catch (e) {
    console.error('ai-agent', body.action, e)
    return json({ error: friendly(e), code: e instanceof AiError ? e.kind : undefined }, e instanceof AiError && e.kind !== 'provedor' ? 400 : 500)
  }
})
