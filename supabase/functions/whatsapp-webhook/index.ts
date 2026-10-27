// Recebe eventos da Meta (Cloud API), do Zapbot e da Evolution API.
// - URL do app do Vórtex CRM na Meta (API Oficial pelo "Entrar com o Facebook"): /functions/v1/whatsapp-webhook, sem parâmetros.
//   Uma URL só para todas as contas: a assinatura X-Hub-Signature-256 com o META_APP_SECRET autentica a chamada e o
//   phone_number_id de cada mensagem indica a conexão. Eventos da conta (acesso removido, qualidade, nome, templates)
//   atualizam a conexão e ficam em meta_account_events.
// - URL por conexão: /functions/v1/whatsapp-webhook?c=<connectionId>&t=<webhookToken> (Zapbot, Evolution e Meta manual).
//   O token da URL (e, na Meta manual, a assinatura com o App Secret informado) autentica a chamada.
// Por isso verify_jwt = false.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json, onlyDigits, phoneVariants } from '../_shared/whatsapp.ts'
import { handleInbound, parseEvolution, parseMeta, parseZapbot } from '../_shared/inbound.ts'
import { companyModules } from '../_shared/access.ts'
import { withMetaToken, type Secret } from '../_shared/secrets.ts'
import { isAuthError, metaApp, subscribedApps } from '../_shared/meta.ts'
import { accountChanges, deliveryErrorText, splitByPhone, templateStatus, type AccountChange } from '../_shared/meta-webhook.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(URL_, SERVICE)

async function validSignature(raw: string, header: string | null, secret: string) {
  if (!header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
  const given = header.slice(7)
  if (given.length !== hex.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

// Módulos e configurações da empresa; null com o módulo Conexões suspenso (o evento é ignorado)
async function companyContext(companyId: string) {
  const mods = await companyModules(admin, companyId)
  if (!mods.has('conexoes')) {
    console.log('conexões suspenso; evento ignorado', companyId)
    return null
  }
  const { data: company } = await admin.from('companies').select('settings').eq('id', companyId).single()
  return { mods, settings: company?.settings || {} }
}

async function processMeta(conn: any, secret: Secret, settings: Record<string, any>, mods: Set<string>, body: any) {
  const { messages, statuses } = parseMeta(body)
  for (const m of messages) await handleInbound(admin, conn, secret, settings, m, mods).catch((e) => console.error('inbound meta', e))
  for (const s of statuses) {
    const delivery = s.status === 'failed' ? 'failed' : s.status === 'read' ? 'read' : s.status === 'delivered' ? 'delivered' : null
    if (!delivery) continue
    if (delivery === 'failed' && s.error) {
      // guarda o motivo da Meta na mensagem (o chat mostra embaixo do balão)
      console.error('entrega falhou', s.waId, s.error.code, s.error.title, s.error.details)
      const { data: msg } = await admin.from('messages').select('id, extra').eq('company_id', conn.company_id).eq('wa_id', s.waId).maybeSingle()
      if (msg) await admin.from('messages').update({ delivery, extra: { ...(msg.extra || {}), deliveryError: deliveryErrorText(s.error), deliveryErrorCode: s.error.code } }).eq('id', msg.id)
      continue
    }
    await admin.from('messages').update({ delivery }).eq('company_id', conn.company_id).eq('wa_id', s.waId)
  }
}

/* ---------- Eventos da conta (Embedded Signup) ---------- */

const REVOKED = 'O acesso do Vórtex CRM a esta conta foi removido na Meta. Conecte de novo com o Facebook.'

const patchMeta = (conn: any, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  admin.from('connections').update({ meta: { ...(conn.meta || {}), ...patch }, ...extra }).eq('id', conn.id)

async function revoke(conn: any) {
  await patchMeta(conn, { status: 'revoked', alert: REVOKED }, { status: 'disconnected' })
  await admin.from('connection_secrets').delete().eq('connection_id', conn.id)
  await admin.rpc('meta_secret_drop', { p_connection: conn.id })
}

async function handleAccountChange({ wabaId, field, value }: AccountChange) {
  if (!wabaId) return
  const { data: secrets } = await admin.from('connection_secrets').select('connection_id, provider, credentials').eq('provider', 'meta').eq('credentials->>wabaId', wabaId)
  const ids = (secrets || []).map((s: any) => s.connection_id)
  const { data: all } = ids.length ? await admin.from('connections').select('id, company_id, number, meta').in('id', ids) : { data: [] as any[] }
  // eventos de um número trazem display_phone_number; os da conta valem para todas as conexões dela
  const digits = onlyDigits(String(value.display_phone_number || ''))
  const conns = (all || []).filter((c: any) => !digits || phoneVariants(digits).includes(onlyDigits(c.number)))
  const event = String(value.event || value.decision || '') || null

  const rows = conns.length ? conns.map((c: any) => ({ connection_id: c.id, company_id: c.company_id })) : [{ connection_id: null, company_id: null }]
  await admin.from('meta_account_events').insert(rows.map((r) => ({ ...r, waba_id: wabaId, field, event, payload: value })))

  for (const conn of conns) {
    if (field === 'account_update') {
      if (event === 'ACCOUNT_DELETED' || event === 'ACCOUNT_OFFBOARDED') await revoke(conn)
      else if (event === 'PARTNER_APP_UNINSTALLED' || event === 'PARTNER_REMOVED') {
        // pode ser outro parceiro saindo da conta: só desconecta se o app perdeu mesmo o acesso
        const otherApp = value.waba_info?.partner_app_id && String(value.waba_info.partner_app_id) !== metaApp().appId
        if (otherApp) continue
        const raw = (secrets || []).find((s: any) => s.connection_id === conn.id) as Secret | undefined
        const token = raw ? (await withMetaToken(admin, conn.id, raw)).credentials.accessToken : ''
        try {
          if (!token) throw new Error('sem token')
          await subscribedApps(wabaId, token)
        } catch (e) {
          if (!token || isAuthError(e)) await revoke(conn)
        }
      } else if (event === 'DISABLED_UPDATE') {
        const state = value.ban_info?.waba_ban_state
        await patchMeta(conn, { alert: state === 'REINSTATE' ? null : state === 'SCHEDULE_FOR_DISABLE' ? 'A Meta agendou a desativação desta conta do WhatsApp. Veja os detalhes no Gerenciador do WhatsApp.' : 'A Meta desativou esta conta do WhatsApp. Veja os detalhes no Gerenciador do WhatsApp.' },
          state === 'DISABLE' ? { status: 'disconnected' } : {})
      } else if (event === 'ACCOUNT_RESTRICTION' || event === 'ACCOUNT_VIOLATION') {
        await patchMeta(conn, { alert: 'A Meta aplicou uma restrição a esta conta do WhatsApp. Veja os detalhes no Gerenciador do WhatsApp.' })
      } else if (event === 'ACCOUNT_RECONNECTED') {
        await patchMeta(conn, { alert: null })
      }
    } else if (field === 'phone_number_quality_update') {
      await patchMeta(conn, {
        messagingLimit: value.current_limit || conn.meta?.messagingLimit || null, qualityEvent: event,
        ...(event === 'FLAGGED' ? { alert: 'A qualidade deste número caiu na Meta. Revise as mensagens enviadas para não perder o limite de envios.' } : event === 'UNFLAGGED' ? { alert: null } : {}),
      })
    } else if (field === 'phone_number_name_update') {
      await patchMeta(conn, event === 'APPROVED'
        ? { nameStatus: 'APPROVED', verifiedName: value.requested_verified_name || conn.meta?.verifiedName || '' }
        : { nameStatus: event, ...(event === 'REJECTED' ? { alert: `A Meta recusou o nome de exibição "${value.requested_verified_name || ''}". Ajuste no Gerenciador do WhatsApp.` } : {}) })
    } else if (field === 'message_template_status_update' && value.message_template_name) {
      let q = admin.from('whatsapp_templates').update({ status: templateStatus(String(value.event || '')) })
        .eq('connection_id', conn.id).eq('name', value.message_template_name)
      if (value.message_template_language) q = q.eq('language', value.message_template_language)
      await q
    }
  }
}

/* ---------- URL do app do Vórtex CRM na Meta ---------- */

async function appWebhook(req: Request, url: URL) {
  const app = metaApp()
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && !!app.verifyToken && url.searchParams.get('hub.verify_token') === app.verifyToken
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405)
  if (!app.appSecret) {
    console.error('META_APP_SECRET não configurado: webhook do app recusado')
    return json({ error: 'não configurado' }, 503)
  }
  const raw = await req.text()
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256'), app.appSecret))) return json({ error: 'assinatura inválida' }, 401)
  let body: any
  try { body = JSON.parse(raw) } catch { return json({ ok: true }) }
  if (body?.object !== 'whatsapp_business_account') return json({ ok: true })

  const work = (async () => {
    for (const [phoneId, part] of splitByPhone(body)) {
      const { data: row } = await admin.from('connection_secrets').select('connection_id, provider, credentials')
        .eq('provider', 'meta').eq('credentials->>phoneNumberId', phoneId).maybeSingle()
      if (!row) {
        console.log('número sem conexão no Vórtex CRM; evento ignorado', phoneId)
        continue
      }
      const { data: conn } = await admin.from('connections').select('*').eq('id', row.connection_id).single()
      const ctx = conn && await companyContext(conn.company_id)
      if (!ctx) continue
      const secret = await withMetaToken(admin, conn.id, { provider: 'meta', credentials: row.credentials })
      await processMeta(conn, secret, ctx.settings, ctx.mods, part)
    }
    for (const ch of accountChanges(body)) await handleAccountChange(ch).catch((e) => console.error('evento da conta', ch.field, e))
  })().catch((e) => console.error('webhook app', e))

  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(work)
  return json({ ok: true })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const cid = url.searchParams.get('c')
  const token = url.searchParams.get('t')
  if (!cid && !token) return appWebhook(req, url)
  if (!cid || !token) return json({ error: 'parâmetros ausentes' }, 400)

  const { data: secret } = await admin.from('connection_secrets').select('provider, credentials').eq('connection_id', cid).maybeSingle()
  if (!secret || secret.credentials?.webhookToken !== token) return json({ error: 'não autorizado' }, 401)

  // Verificação do webhook pela Meta
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === secret.credentials.verifyToken
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405)

  const raw = await req.text()
  if (secret.provider === 'meta' && secret.credentials.appSecret && !(await validSignature(raw, req.headers.get('x-hub-signature-256'), secret.credentials.appSecret))) {
    return json({ error: 'assinatura inválida' }, 401)
  }
  let body: any
  try { body = JSON.parse(raw) } catch { return json({ ok: true }) }

  const { data: conn } = await admin.from('connections').select('*').eq('id', cid).single()
  if (!conn) return json({ ok: true })

  // Módulo Conexões suspenso: o evento é ignorado (responde 200 para o provedor não ficar reenviando).
  const ctx = await companyContext(conn.company_id)
  if (!ctx) return json({ ok: true, ignored: 'module_disabled' })

  // Responde rápido ao provedor e processa em segundo plano.
  const work = (async () => {
    const { settings, mods } = ctx
    if (secret.provider === 'meta') {
      await processMeta(conn, secret, settings, mods, body)
    } else if (secret.provider === 'zapbot' || secret.provider === 'sandbox') {
      // sandbox: conexão de teste, recebe no mesmo formato do Zapbot
      const { messages, statuses, connected } = parseZapbot(body)
      // chega no pareamento e em toda reconexão: idempotente
      if (connected) await admin.from('connections').update({ status: 'connected', ...(connected.phone ? { number: `+${connected.phone}` } : {}) }).eq('id', conn.id)
      for (const m of messages) await handleInbound(admin, conn, secret, settings, m, mods).catch((e) => console.error('inbound zapbot', e))
      for (const s of statuses) {
        const delivery = s.status === 'READ' || s.status === 'PLAYED' ? 'read' : s.status === 'RECEIVED' ? 'delivered' : null
        if (delivery) await admin.from('messages').update({ delivery }).eq('company_id', conn.company_id).eq('wa_id', s.waId)
      }
    } else if (secret.provider === 'evolution') {
      const { messages, state } = parseEvolution(body)
      if (state) await admin.from('connections').update({ status: state === 'open' ? 'connected' : state === 'connecting' ? conn.status : 'disconnected' }).eq('id', conn.id)
      for (const m of messages) await handleInbound(admin, conn, secret, settings, m, mods).catch((e) => console.error('inbound evolution', e))
    }
  })().catch((e) => console.error('webhook', e))

  // @ts-ignore EdgeRuntime existe no runtime da Supabase
  EdgeRuntime.waitUntil(work)
  return json({ ok: true })
})
