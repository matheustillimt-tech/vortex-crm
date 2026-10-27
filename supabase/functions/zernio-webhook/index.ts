// Recebe os eventos da Zernio (Direct do Instagram). Dois endereços:
// - .../zernio-webhook?c=<conexão>: conexão feita com a chave da Zernio de quem conectou. O CRM cadastra esse webhook
//   sozinho na conta da pessoa, com um segredo só dessa conexão (no Vault). Só vale para a conta do Instagram dela.
// - .../zernio-webhook (sem parâmetro): conta da plataforma, com o segredo ZERNIO_WEBHOOK_SECRET.
// Eventos: message.received, message.sent, message.read, message.deleted e account.disconnected.
// - A assinatura X-Zernio-Signature (HMAC-SHA256 do corpo cru) autentica a chamada. Por isso verify_jwt = false
//   (publicar com --no-verify-jwt).
// - A Zernio entrega "pelo menos uma vez": o id do evento vai para zernio_events (chave primária) antes de processar,
//   e evento repetido só recebe 200.
// - A Zernio espera resposta em até 5 s: o processamento roda depois da resposta (EdgeRuntime.waitUntil).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json } from '../_shared/whatsapp.ts'
import { validZernioSignature } from '../_shared/zernio.ts'
import { processZernioEvent } from '../_shared/zernio-events.ts'
import { zernioVault } from '../_shared/secrets.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const PLATFORM_SECRET = Deno.env.get('ZERNIO_WEBHOOK_SECRET') || ''
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const raw = await req.text()
  // Segredo: o da conexão (?c=) ou o da plataforma
  const cParam = new URL(req.url).searchParams.get('c')
  if (cParam && !UUID.test(cParam)) return json({ error: 'Conexão inválida' }, 400)
  const secret = cParam ? (await zernioVault(admin, cParam)).webhookSecret || '' : PLATFORM_SECRET
  if (!secret) {
    console.error('zernio-webhook sem segredo', cParam || 'plataforma')
    return json({ error: 'Webhook não configurado' }, cParam ? 404 : 503)
  }
  const sig = req.headers.get('X-Zernio-Signature') || req.headers.get('X-Late-Signature')
  if (!(await validZernioSignature(raw, sig, secret))) return json({ error: 'Assinatura inválida' }, 401)

  let ev: any
  try { ev = JSON.parse(raw) } catch { return json({ error: 'JSON inválido' }, 400) }
  const id = String(ev?.id || req.headers.get('X-Zernio-Event-Id') || '')
  if (!id || !ev?.event) return json({ error: 'Evento sem id' }, 400)

  const { error } = await admin.from('zernio_events').insert({
    id, event: String(ev.event), account_id: ev.account?.id || ev.account?.accountId || null, payload: ev,
  })
  if (error) {
    if (error.code === '23505') return json({ ok: true, duplicate: true }) // já recebido
    console.error('zernio_events', error.message)
    return json({ error: 'Falha ao registrar o evento' }, 500) // a Zernio tenta de novo
  }

  const work = processZernioEvent(admin, ev, cParam)
    .then((r) => admin.from('zernio_events').update({ status: r.status, error: r.why ?? null, connection_id: r.connectionId ?? null }).eq('id', id))
    .catch((e) => {
      console.error('evento da Zernio', id, e)
      return admin.from('zernio_events').update({ status: 'error', error: String((e as Error)?.message || e).slice(0, 500) }).eq('id', id)
    })
  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(work)
  return json({ ok: true })
})
