// Atendente envia mensagem pelo painel: texto, ou foto, vídeo, áudio e documento (com legenda opcional).
// 1) confere que o usuário é da empresa do chat e que ela tem Chat ao vivo e Conexões; 2) entrega pelo provedor, se a conexão tiver credenciais;
// 3) grava a mensagem e atualiza o chat. O front recebe a mensagem gravada pelo Realtime.
// Arquivo: o painel pede um link de envio (action "upload"), sobe o arquivo direto para o bucket privado whatsapp-media
// (<empresa>/<chat>/...) e depois manda a mensagem com `media`; o provedor baixa por um link temporário.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json, MEDIA_MAX_MB, outgoingKind, sendMedia, sendText, type Provider } from '../_shared/whatsapp.ts'
import { companyModules, missing } from '../_shared/access.ts'
import { pauseForHuman } from '../_shared/agent-core.ts'
import { connectionSecret } from '../_shared/secrets.ts'
import { igKind, igSend, igWindow, type IgCreds } from '../_shared/zernio.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BUCKET = 'whatsapp-media'
const MAX_BYTES = MEDIA_MAX_MB.document * 1024 * 1024
const LABEL: Record<string, string> = { image: '📷 Imagem', video: '🎥 Vídeo', audio: '🎤 Áudio' }
const safeName = (n: string) => (n || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80)

type Body = { action?: string; chatId?: string; id?: string; text?: string; fileName?: string; size?: number; media?: { path?: string; fileName?: string } }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const auth = req.headers.get('Authorization') ?? ''
  const userDb = createClient(URL, ANON, { global: { headers: { Authorization: auth } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  let body: Body
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const text = (body.text ?? '').trim()
  const upload = body.action === 'upload'
  if (!body.chatId || (!upload && !text && !body.media)) return json({ error: 'chatId e text (ou um arquivo) são obrigatórios' }, 400)
  if (text.length > (body.media ? 1024 : 4096)) return json({ error: body.media ? 'Legenda muito longa (máx. 1024)' : 'Mensagem muito longa (máx. 4096)' }, 400)

  // De quem é o chat, se o usuário é membro dessa empresa e se ela tem os módulos liberados.
  // (as gravações abaixo ainda passam pelo RLS, que confere tudo de novo)
  const admin = createClient(URL, SERVICE)
  const { data: chat } = await admin.from('chats').select('id, company_id, contact_id, connection_id, external_id, status, assigned_to').eq('id', body.chatId).maybeSingle()
  const { data: member } = chat
    ? await admin.from('company_members').select('id, name').eq('company_id', chat.company_id).eq('user_id', user.id).maybeSingle()
    : { data: null }
  if (!chat || !member) return json({ error: 'Chat não encontrado' }, 404)
  const mods = await companyModules(admin, chat.company_id)
  const blocked = missing(mods, 'chat', 'conexoes')
  if (blocked) return blocked

  // Link de envio: só para a pasta deste chat, com nome gerado aqui (quem envia não escolhe o caminho).
  const folder = `${chat.company_id}/${chat.id}`
  if (upload) {
    if (Number(body.size) > MAX_BYTES) return json({ error: `Arquivo grande demais: o limite é ${MEDIA_MAX_MB.document} MB.` }, 413)
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(`${folder}/enviado-${Date.now()}-${safeName(body.fileName || '')}`)
    if (error || !data) return json({ error: 'Não foi possível preparar o envio do arquivo.' }, 500)
    return json({ path: data.path, token: data.token })
  }

  // Arquivo já enviado: tipo e tamanho vêm do armazenamento, não do navegador.
  let file: { path: string; name: string; mime: string; size: number } | null = null
  if (body.media) {
    const path = String(body.media.path || '')
    const name = path.slice(folder.length + 1)
    if (!path.startsWith(`${folder}/`) || !name || name.includes('/')) return json({ error: 'Arquivo inválido' }, 400)
    const { data: found } = await admin.storage.from(BUCKET).list(folder, { search: name, limit: 5 })
    const obj = found?.find((o) => o.name === name)
    if (!obj) return json({ error: 'O arquivo não chegou ao servidor. Anexe de novo.' }, 400)
    file = { path, name: String(body.media.fileName || name).slice(0, 120), mime: obj.metadata?.mimetype || 'application/octet-stream', size: Number(obj.metadata?.size) || 0 }
  }

  const [{ data: contact }, { data: secret }] = await Promise.all([
    admin.from('contacts').select('phone').eq('id', chat.contact_id).single(),
    connectionSecret(admin, chat.connection_id).then((data) => ({ data })),
  ])
  const provider = (secret?.provider ?? null) as Provider | null
  const kind = file ? outgoingKind(provider, file.mime, file.size) : null

  let delivery = 'local' // sem provedor configurado: fica só no painel
  let waId: string | null = null
  let asLink = false
  // O WhatsApp achou o contato na outra forma do número (com ou sem o 9): os próximos envios já vão nela.
  let numeroCerto = null as string | null
  const certo = (n: string) => { numeroCerto = n }

  // Instagram: a Meta só deixa responder dentro da janela. Até 24 h desde a última mensagem do cliente, normal;
  // de 24 h a 7 dias, só pessoa da equipe e com a tag HUMAN_AGENT (é o caso aqui: quem envia é um atendente);
  // depois de 7 dias, nada até o cliente escrever de novo.
  let humanAgent = false
  if (secret && provider === 'instagram') {
    const off = missing(mods, 'instagram')
    if (off) return off
    const { data: last } = await admin.from('messages').select('at').eq('chat_id', chat.id).eq('sender', 'contact').order('at', { ascending: false }).limit(1).maybeSingle()
    const w = igWindow(last?.at)
    if (w === 'closed') return json({ error: 'O Instagram só deixa responder até 7 dias depois da última mensagem do cliente. Espere ele escrever de novo.', code: 'ig_window_closed' }, 409)
    humanAgent = w === 'human'
    const creds = secret.credentials as unknown as IgCreds
    const to = String(chat.external_id || '')
    const key = body.id || crypto.randomUUID() // mesma chave = a Zernio não manda duas vezes se o painel tentar de novo
    try {
      if (file && kind) {
        const type = kind === 'document' ? (igKind(file.mime, file.size) === 'file' ? 'file' : null) : kind
        if (type) {
          const { data: link } = await admin.storage.from(BUCKET).createSignedUrl(file.path, 3600)
          if (!link?.signedUrl) throw new Error('link do arquivo')
          waId = await igSend(creds, to, { attachment: { url: link.signedUrl, type }, humanAgent }, `${key}-a`)
          if (text) await igSend(creds, to, { text, humanAgent }, `${key}-t`) // anexo no Instagram não tem legenda
        } else {
          // formato que o Instagram não aceita: vai o link do arquivo (vale 7 dias)
          const { data: long } = await admin.storage.from(BUCKET).createSignedUrl(file.path, 7 * 86400)
          waId = await igSend(creds, to, { text: `${text ? text + '\n' : ''}📎 ${file.name}: ${long?.signedUrl}`, humanAgent }, key)
          asLink = true
        }
      } else {
        waId = await igSend(creds, to, { text, humanAgent }, key)
      }
      delivery = 'sent'
    } catch (e) {
      delivery = 'failed'
      console.error('falha na Zernio', e)
    }
  }

  if (secret && provider !== 'instagram') {
    let phone = contact?.phone ?? ''
    try {
      if (file && kind) {
        const { data: link } = await admin.storage.from(BUCKET).createSignedUrl(file.path, 3600)
        if (!link?.signedUrl) throw new Error('link do arquivo')
        // áudio não tem legenda no WhatsApp: o texto vai logo depois, numa mensagem própria
        const caption = kind !== 'audio' && text ? text : undefined
        try {
          waId = await sendMedia(provider!, secret.credentials, phone, { kind, url: link.signedUrl, mime: file.mime, fileName: file.name, caption }, certo)
        } catch (e) {
          if (kind !== 'document') throw e
          // provedor sem envio de documento: manda o link (vale 7 dias), como o agente de IA faz
          const { data: long } = await admin.storage.from(BUCKET).createSignedUrl(file.path, 7 * 86400)
          waId = await sendText(provider!, secret.credentials, phone, `${text ? text + '\n' : ''}📎 ${file.name}: ${long?.signedUrl}`, certo)
          asLink = true
        }
        if (numeroCerto) phone = numeroCerto
        if (kind === 'audio' && text) await sendText(provider!, secret.credentials, phone, text)
      } else {
        waId = await sendText(provider!, secret.credentials, phone, text, certo)
      }
      delivery = 'sent'
      if (numeroCerto) {
        const { error } = await admin.from('contacts').update({ phone: `+${numeroCerto}` }).eq('id', chat.contact_id)
        if (error) console.error('telefone do contato', error.message)
      }
    } catch (e) {
      delivery = 'failed'
      console.error('falha no provedor', e)
    }
  }

  const now = new Date().toISOString()
  const { error: insErr } = await userDb.from('messages').insert({
    ...(body.id ? { id: body.id } : {}), company_id: chat.company_id, chat_id: chat.id, sender: 'agent', wa_id: waId, delivery, at: now,
    text: file && kind ? text || LABEL[kind] || `📎 ${file.name}` : text,
    ...(file && kind && { type: kind, media_url: file.path }),
    extra: { ...(file && kind && { file: file.name, ...(asLink && { asLink: true }) }), ...(humanAgent && { humanAgent: true }) },
  })
  if (insErr) return json({ error: insErr.message }, 400)

  // Quem responde assume a conversa (se ninguém estava com ela). O gatilho do banco pausa a IA quando um humano assume;
  // pauseForHuman cobre o caso de a conversa já estar com alguém e a IA ainda ativa.
  await userDb.from('chats').update({
    last_message_at: now, answered: true, unread: 0,
    status: chat.status === 'waiting' ? 'attending' : chat.status,
    assigned_to: chat.status !== 'resolved' && !chat.assigned_to ? member.id : chat.assigned_to,
  }).eq('id', chat.id)
  const { data: after } = await admin.from('chats').select('*').eq('id', chat.id).single()
  if (after) await pauseForHuman(admin, after, `👤 ${member.name || 'Um atendente'} respondeu pelo painel. IA pausada nesta conversa.`).catch((e) => console.error('pausa da IA', e))

  if (delivery === 'failed' && provider === 'instagram') return json({ error: file ? 'O Instagram não aceitou o arquivo. Confira o formato (foto PNG/JPEG, vídeo MP4, áudio M4A ou PDF).' : 'O Instagram recusou o envio. Confira a conexão.', delivery }, 502)
  if (delivery === 'failed') return json({ error: file ? 'O WhatsApp não aceitou o arquivo. Confira a conexão e o formato.' : 'O provedor de WhatsApp recusou o envio. Confira a conexão.', delivery }, 502)
  return json({ ok: true, delivery })
})
