// Foto de perfil dos contatos que já tinham conversa (o recebimento só procura nas mensagens novas).
// O painel manda os contatos da lista do Chat que ainda não foram procurados: { contactIds: [...] } (até 25 por vez).
// Só membros da empresa do contato. Cada contato é procurado no máximo a cada 7 dias (fotos.ts).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { connectionSecret } from '../_shared/secrets.ts'
import { atualizarFoto, procurouHaPouco } from '../_shared/fotos.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const ids = [...new Set((Array.isArray(body.contactIds) ? body.contactIds : []).map(String))].slice(0, 25)
  if (!ids.length) return json({ fotos: {} })

  const admin = createClient(URL_, SERVICE)
  const { data: contatos } = await admin.from('contacts').select('*').in('id', ids)
  const { data: membros } = await admin.from('company_members').select('company_id').eq('user_id', user.id)
  const minhas = new Set((membros || []).map((m: any) => m.company_id))
  const fotos: Record<string, string | null> = {}
  const segredos = new Map<string, any>()

  await Promise.all((contatos || []).filter((c: any) => minhas.has(c.company_id)).map(async (c: any) => {
    if (procurouHaPouco(c.avatar_at)) { fotos[c.id] = c.avatar_url ?? null; return }
    const { data: chats } = await admin.from('chats').select('id, connection_id, external_id').eq('contact_id', c.id).order('last_message_at', { ascending: false }).limit(1)
    const chat = chats?.[0] ?? null
    const connId = chat?.connection_id || c.connection_id
    if (!connId) { fotos[c.id] = c.avatar_url ?? null; return }
    if (!segredos.has(connId)) segredos.set(connId, await connectionSecret(admin, connId).catch(() => null))
    fotos[c.id] = await atualizarFoto(admin, c, chat, segredos.get(connId))
  }))
  return json({ fotos })
})
