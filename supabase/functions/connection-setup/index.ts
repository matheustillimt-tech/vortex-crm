// Configura uma conexão de WhatsApp a partir do painel (só membros da empresa da conexão, com o módulo Conexões).
// Ações: zapbot-start | zapbot-qr | zapbot-code | zapbot-reset | evolution-connect | qr | status | disconnect | webhook-info | remove
// Instagram pela Zernio: instagram-key-check | instagram-key-connect (chave de quem conecta) | instagram-start | instagram-finish
// (chave da plataforma); status, disconnect e remove também
// API Oficial pelo Embedded Signup ("Entrar com o Facebook"): meta-config | meta-start | meta-event | meta-complete | meta-finish | meta-sync
// Modelos de mensagem da API Oficial: meta-templates (sincroniza) | meta-template-create
// API Oficial manual (avançado, só superadmin no painel): save-meta
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, evo, json, metaPhoneInfo, onlyDigits, randomToken, webhookUrl, type Creds } from '../_shared/whatsapp.ts'
import { companyModules, missing } from '../_shared/access.ts'
import { withMetaToken, zernioVault } from '../_shared/secrets.ts'
import * as meta from '../_shared/meta.ts'
import { templateStatus } from '../_shared/meta-webhook.ts'
import { mergeTemplateExtra, templateComponents, templateDraft, templateRow } from '../_shared/templates.ts'
import * as zap from '../_shared/zapbot.ts'
import * as zernioApi from '../_shared/zernio.ts'


const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']

const fmtPhone = (d: string) => (d ? `+${d}` : '')
// IDs da Meta chegam do navegador como texto ou número: só dígitos
const metaId = (v: unknown) => onlyDigits(String(v ?? ''))

async function setEvolutionWebhook(c: Creds, url: string) {
  // v2.1+: { webhook: {...} }; v2.0: campos na raiz. Tenta os dois.
  try {
    await evo(c, 'POST', `/webhook/set/${encodeURIComponent(c.instance)}`, { webhook: { enabled: true, url, byEvents: false, base64: false, events: EVENTS } })
  } catch {
    await evo(c, 'POST', `/webhook/set/${encodeURIComponent(c.instance)}`, { enabled: true, url, webhookByEvents: false, webhookBase64: false, events: EVENTS })
  }
}

async function evolutionNumber(c: Creds) {
  try {
    const list = await evo(c, 'GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(c.instance)}`)
    const it = Array.isArray(list) ? list[0] : list
    const jid = it?.ownerJid || it?.instance?.owner || it?.owner || ''
    return { number: fmtPhone(onlyDigits(String(jid).split('@')[0])), profileName: it?.profileName || it?.instance?.profileName || '' }
  } catch {
    return { number: '', profileName: '' }
  }
}

// Situação do número na Meta: fora do ar (desconecta no painel) ou com envio limitado (só o aviso)
const PHONE_DOWN = new Set(['BANNED', 'DELETED', 'MIGRATED'])
function phoneAlert(p: any): string | null {
  if (p?.status === 'BANNED') return 'A Meta bloqueou este número. Veja os detalhes no Gerenciador do WhatsApp.'
  if (p?.status === 'DELETED' || p?.status === 'MIGRATED') return 'Este número saiu da conta do WhatsApp Business (removido ou migrado). Conecte de novo.'
  if (['RESTRICTED', 'FLAGGED', 'RATE_LIMITED'].includes(p?.status)) return 'A Meta limitou os envios deste número. Veja a qualidade no Gerenciador do WhatsApp.'
  return null
}

// O que o painel mostra de uma conexão feita pelo "Entrar com o Facebook" (connections.meta; só o servidor grava)
function metaView(c: Record<string, any>, phone: any, waba: Awaited<ReturnType<typeof meta.wabaInfo>> | null, extra: Record<string, unknown> = {}) {
  const businessId = c.businessId || waba?.businessId || ''
  return {
    onboarding: 'embedded_signup',
    wabaId: c.wabaId, wabaName: waba?.name || '', businessId, businessName: waba?.businessName || '',
    phoneNumberId: c.phoneNumberId, verifiedName: phone?.verified_name || '', nameStatus: phone?.name_status || '',
    quality: phone?.quality_rating || '', payment: waba?.payment || 'unknown', paymentUrl: meta.paymentUrl(c.wabaId, businessId),
    connectedAt: c.connectedAt || null, syncedAt: new Date().toISOString(), ...extra,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const { action, connectionId } = body
  // App ID e Configuration ID do "Entrar com o Facebook" (não são segredos: o SDK da Meta precisa deles no navegador)
  if (action === 'meta-config') {
    const absent = meta.metaMissing()
    const { appId, configId } = meta.metaApp()
    return json({ ready: !absent.length, appId, configId, graphVersion: meta.GRAPH_VERSION, missing: absent })
  }
  // Só membros da empresa dona da conexão, e só se a empresa tiver o módulo Conexões liberado
  const admin = createClient(URL_, SERVICE)
  const { data: conn } = await admin.from('connections').select('*').eq('id', connectionId).maybeSingle()
  const { data: member } = conn
    ? await admin.from('company_members').select('id').eq('company_id', conn.company_id).eq('user_id', user.id).maybeSingle()
    : { data: null }
  if (!conn || !member) return json({ error: 'Conexão não encontrada' }, 404)
  const blocked = missing(await companyModules(admin, conn.company_id), 'conexoes')
  if (blocked) return blocked

  const { data: existing } = await admin.from('connection_secrets').select('provider, credentials').eq('connection_id', conn.id).maybeSingle()
  const saveSecret = (provider: string, credentials: Creds) =>
    admin.from('connection_secrets').upsert({ connection_id: conn.id, company_id: conn.company_id, provider, credentials })
  const setConn = (patch: Record<string, unknown>) => admin.from('connections').update(patch).eq('id', conn.id)
  // Ao reconfigurar, só reaproveita as credenciais salvas do mesmo provedor
  const prevMeta: Creds = existing?.provider === 'meta' ? existing.credentials : {}
  const prevEvo: Creds = existing?.provider === 'evolution' ? existing.credentials : {}
  // Trocou do Zapbot para outro provedor: apaga a conexão antiga no Zapbot para não ocupar vaga na conta
  const dropZapbot = () =>
    existing?.provider === 'zapbot' ? zap.deleteInstance(admin, existing.credentials.instanceId).catch((e) => console.error('zapbot delete', e)) : null
  const embedded = existing?.provider === 'meta' && !!existing.credentials?.tokenInVault

  // Tira o acesso desta conexão à conta da Meta: para de assinar os webhooks da conta (se nenhuma outra conexão da
  // plataforma usa a mesma conta) e apaga o token. O número continua registrado na Meta e pode ser conectado de novo.
  const releaseMeta = async () => {
    if (!embedded) return
    const c = (await withMetaToken(admin, conn.id, existing)).credentials
    const { count } = await admin.from('connection_secrets').select('connection_id', { count: 'exact', head: true })
      .eq('provider', 'meta').eq('credentials->>wabaId', c.wabaId).neq('connection_id', conn.id)
    if (!count && c.accessToken) await meta.unsubscribeApp(c.wabaId, c.accessToken).catch((e) => console.error('meta unsubscribe', e instanceof Error ? e.message : e))
    await admin.from('connection_secrets').delete().eq('connection_id', conn.id)
    await admin.rpc('meta_secret_drop', { p_connection: conn.id })
  }

  // Tentativa do Embedded Signup desta pessoa nesta conexão
  const patchSession = (id: unknown, patch: Record<string, unknown>) =>
    id ? admin.from('meta_signup_sessions').update(patch).eq('id', String(id)).eq('connection_id', conn.id).eq('user_id', user.id) : Promise.resolve(null)

  try {
    /* ---------- Instagram (Direct) pela chave da Zernio de quem conecta ---------- */
    // O login no Instagram é feito só na Zernio. Aqui a pessoa cola a chave da API dela:
    // 1) instagram-key-check: confere a chave e lista os Instagrams conectados nela (nada é gravado)
    // 2) instagram-key-connect: guarda a chave no Vault, cadastra o webhook desta conexão na conta da pessoa e liga a conta
    if (action === 'instagram-key-check' || action === 'instagram-key-connect') {
      const off = missing(await companyModules(admin, conn.company_id), 'instagram')
      if (off) return off
      if (existing && existing.provider !== 'instagram') return json({ error: 'Esta conexão já é de WhatsApp. Crie uma conexão nova para o Instagram.' }, 409)
      // Chave nova colada agora, ou a que já está guardada (trocar só a conta, sem colar de novo)
      const typed = String(body.apiKey || '').trim()
      const vault = existing?.credentials?.keyInVault ? await zernioVault(admin, conn.id) : {}
      const key = typed || vault.apiKey || ''
      if (!zernioApi.looksLikeKey(key)) return json({ error: 'Cole a chave da API da Zernio (começa com sk_ ou zrk_).', code: 'BAD_KEY' }, 400)

      const accounts = await zernioApi.accountsForKey(key)
      const { data: used } = await admin.from('connection_secrets').select('connection_id, credentials').eq('provider', 'instagram').neq('connection_id', conn.id)
      const taken = new Set((used || []).map((u: any) => u.credentials?.accountId).filter(Boolean))
      const list = accounts.map((a) => ({ ...a, taken: taken.has(a.accountId) }))

      if (action === 'instagram-key-check') {
        if (!list.length) return json({ accounts: [], error: 'Nenhum Instagram conectado nessa conta da Zernio. Conecte o Instagram no painel da Zernio e tente de novo.' })
        return json({ accounts: list, keyHint: zernioApi.keyHint(key) })
      }

      const pick = list.find((a) => a.accountId === String(body.accountId || ''))
      if (!pick) return json({ error: 'Escolha um dos Instagrams da lista.' }, 400)
      if (pick.taken) return json({ error: 'Esse Instagram já está ligado em outra conexão do Vórtex CRM.' }, 409)

      // Webhook desta conexão na conta da pessoa (troca o antigo, se a conexão já tinha um)
      if (vault.webhookId && vault.apiKey) await zernioApi.deleteWebhook(vault.apiKey, vault.webhookId).catch((e) => console.error('zernio webhook antigo', e instanceof Error ? e.message : e))
      const webhookSecret = randomToken(24)
      const webhookId = await zernioApi.createWebhook(key, `Vórtex CRM · ${conn.name}`, zernioApi.connectionWebhookUrl(conn.id), webhookSecret)
      const { error: vErr } = await admin.rpc('zernio_secret_set', { p_connection: conn.id, p_secret: { apiKey: key, webhookSecret, webhookId } })
      if (vErr) {
        await zernioApi.deleteWebhook(key, webhookId).catch(() => {})
        throw vErr
      }
      const { error } = await saveSecret('instagram', { mode: 'key', keyInVault: 'true', keyHint: zernioApi.keyHint(key), accountId: pick.accountId, username: pick.username })
      if (error) {
        await zernioApi.deleteWebhook(key, webhookId).catch(() => {})
        await admin.rpc('zernio_secret_drop', { p_connection: conn.id })
        if (error.code === '23505') return json({ error: 'Esse Instagram já está ligado em outra conexão do Vórtex CRM.' }, 409)
        throw error
      }
      await setConn({
        provider: 'instagram', status: 'connected', number: pick.username ? `@${pick.username}` : '',
        extra: { ...(conn.extra || {}), igName: pick.displayName, igPicture: pick.picture, keyHint: zernioApi.keyHint(key), alert: null, connectedAt: new Date().toISOString() },
      })
      return json({ connected: true, username: pick.username })
    }

    /* ---------- Instagram (Direct) pela Zernio da plataforma (reserva) ---------- */
    // 1) instagram-start: cria (ou reaproveita) o profile da empresa na Zernio e devolve o link de login da Meta.
    //    Na volta, a Zernio manda a pessoa para /connections?ig=<conexão>.
    // 2) instagram-finish: acha a conta do Instagram que entrou no profile e liga nesta conexão.
    // status | disconnect | remove também atendem o Instagram (mais abaixo).
    if (action === 'instagram-start' || action === 'instagram-finish') {
      const off = missing(await companyModules(admin, conn.company_id), 'instagram')
      if (off) return off
      if (!Deno.env.get('ZERNIO_API_KEY')) {
        return json({ error: 'A conexão do Instagram ainda não foi ativada na plataforma. Avise o administrador.', code: 'zernio_not_configured', hint: 'Configure ZERNIO_API_KEY nos segredos das Edge Functions.' }, 503)
      }
      if (existing && existing.provider !== 'instagram') return json({ error: 'Esta conexão já é de WhatsApp. Crie uma conexão nova para o Instagram.' }, 409)
      const { data: company } = await admin.from('companies').select('name').eq('id', conn.company_id).single()
      const profileId = await zernioApi.ensureProfile(admin, conn.company_id, company?.name || '')

      if (action === 'instagram-start') {
        const back = zernioApi.returnUrl(body.returnTo, conn.id)
        if (!back) return json({ error: 'Endereço de volta inválido' }, 400)
        if (!existing) await saveSecret('instagram', { profileId })
        await setConn({ provider: 'instagram', status: conn.status === 'connected' ? 'connected' : 'disconnected' })
        return json({ url: await zernioApi.connectUrl(profileId, back) })
      }

      // Contas do Instagram no profile da empresa que ainda não estão em outra conexão
      const accounts = await zernioApi.instagramAccounts(profileId)
      const { data: used } = await admin.from('connection_secrets').select('connection_id, credentials').eq('provider', 'instagram').neq('connection_id', conn.id)
      const taken = new Set((used || []).map((u: any) => u.credentials?.accountId).filter(Boolean))
      const free = accounts.filter((a) => !taken.has(a.accountId))
      const pick = body.accountId ? free.find((a) => a.accountId === String(body.accountId)) : free.length === 1 ? free[0] : null
      if (!pick) {
        if (!free.length) return json({ connected: false, error: accounts.length ? 'Essa conta do Instagram já está ligada em outra conexão.' : 'A conta do Instagram ainda não apareceu. Termine o login da Meta e tente de novo.' })
        return json({ connected: false, choose: free.map(({ accountId, username, displayName, picture }) => ({ accountId, username, displayName, picture })) })
      }
      const { error } = await saveSecret('instagram', { profileId, accountId: pick.accountId, username: pick.username })
      if (error) {
        if (error.code === '23505') return json({ connected: false, error: 'Essa conta do Instagram já está ligada em outra conexão.' }, 409)
        throw error
      }
      await setConn({
        provider: 'instagram', status: 'connected', number: pick.username ? `@${pick.username}` : '',
        extra: { ...(conn.extra || {}), igName: pick.displayName, igPicture: pick.picture, alert: null, connectedAt: new Date().toISOString() },
      })
      return json({ connected: true, username: pick.username })
    }
    if (existing?.provider === 'instagram') {
      const c = existing.credentials as Creds
      const keyMode = c.mode === 'key' || !!c.keyInVault
      const vault = keyMode ? await zernioVault(admin, conn.id) : {}
      if (action === 'status') {
        if (!c.accountId) return json({ state: 'close' })
        try {
          const h = await zernioApi.accountHealth(c.accountId, vault.apiKey)
          const bad = h?.healthy === false || h?.status === 'error' || h?.tokenValid === false
          await setConn({ status: bad ? 'disconnected' : 'connected', extra: { ...(conn.extra || {}), alert: bad ? 'A Meta não está aceitando esta conta. Conecte o Instagram de novo.' : null } })
          return json({ state: bad ? 'close' : 'open', number: c.username ? `@${c.username}` : '' })
        } catch (e) {
          if (e instanceof zernioApi.ZernioError && e.status === 404) {
            await setConn({ status: 'disconnected' })
            return json({ state: 'close' })
          }
          throw e
        }
      }
      if (action === 'disconnect' || action === 'remove') {
        if (keyMode) {
          // Conta da pessoa: só tira o webhook do CRM e esquece a chave. O Instagram continua conectado na Zernio dela.
          if (vault.apiKey && vault.webhookId) await zernioApi.deleteWebhook(vault.apiKey, vault.webhookId).catch((e) => console.error('zernio webhook', e instanceof Error ? e.message : e))
          await admin.rpc('zernio_secret_drop', { p_connection: conn.id })
          if (action === 'remove') {
            const { error } = await admin.from('connections').delete().eq('id', conn.id)
            if (error) throw error
            return json({ ok: true })
          }
          await admin.from('connection_secrets').delete().eq('connection_id', conn.id)
          await setConn({ status: 'disconnected', extra: { ...(conn.extra || {}), alert: null, keyHint: null } })
          return json({ ok: true })
        }
        // Conta da plataforma: tira a conta da Zernio (para de receber e de cobrar); o profile da empresa continua
        if (c.accountId) await zernioApi.disconnectAccount(c.accountId).catch((e) => console.error('zernio disconnect', e instanceof Error ? e.message : e))
        if (action === 'remove') {
          const { error } = await admin.from('connections').delete().eq('id', conn.id)
          if (error) throw error
          return json({ ok: true })
        }
        await saveSecret('instagram', { profileId: c.profileId })
        await setConn({ status: 'disconnected', extra: { ...(conn.extra || {}), alert: null } })
        return json({ ok: true })
      }
      return json({ error: 'Ação não disponível para o Instagram' }, 400)
    }

    /* ---------- API Oficial pelo Embedded Signup ("Entrar com o Facebook") ---------- */
    // 1) meta-start: a janela da Meta abriu. 2) meta-event: a pessoa fechou ou a Meta deu erro.
    // 3) meta-complete: troca o código (vale 30 s) pelo token, confere conta e número e guarda o token no Vault.
    // 4) meta-finish: assina os webhooks da conta, registra o número na Cloud API e confere o pagamento.
    if (action === 'meta-start') {
      const absent = meta.metaMissing()
      if (absent.length) {
        return json({ error: 'A conexão pela Meta ainda não foi ativada na plataforma. Avise o administrador.', code: 'meta_not_configured', hint: `Configure nos segredos das Edge Functions: ${absent.join(', ')}.` }, 503)
      }
      // uma tentativa aberta por conexão: a anterior deixa de valer
      await admin.from('meta_signup_sessions').update({ status: 'cancelled', step: 'nova tentativa' }).eq('connection_id', conn.id).eq('status', 'authorizing')
      const { data: s, error } = await admin.from('meta_signup_sessions').insert({ company_id: conn.company_id, connection_id: conn.id, user_id: user.id }).select('id').single()
      if (error) throw error
      return json({ sessionId: s.id })
    }

    if (action === 'meta-event') {
      const failed = body.event === 'ERROR' || !!body.errorMessage
      const cut = (v: unknown, n: number) => (v ? String(v).slice(0, n) : null)
      await admin.from('meta_signup_sessions').update({
        status: failed ? 'failed' : 'cancelled', step: cut(body.step, 80), error_code: cut(body.errorCode, 40),
        error_message: cut(body.errorMessage, 500), meta_session_id: cut(body.metaSessionId, 120),
      }).eq('id', String(body.sessionId || '')).eq('connection_id', conn.id).eq('user_id', user.id).eq('status', 'authorizing')
      return json({ ok: true })
    }

    if (action === 'meta-complete') {
      const code = String(body.code || '')
      if (!code || !body.sessionId) return json({ error: 'A autorização da Meta não chegou. Clique em "Entrar com o Facebook" de novo.' }, 400)
      const finishType = String(body.finishType || '').slice(0, 60) || null
      // Trava a tentativa antes de tudo: o mesmo código nunca é trocado duas vezes, e só vale por 30 minutos
      const { data: locked } = await admin.from('meta_signup_sessions')
        .update({ status: 'processing', step: 'exchange', finish_type: finishType, waba_id: metaId(body.wabaId) || null, phone_number_id: metaId(body.phoneNumberId) || null, business_id: metaId(body.businessId) || null })
        .eq('id', String(body.sessionId)).eq('connection_id', conn.id).eq('user_id', user.id).eq('status', 'authorizing')
        .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
        .select('id').maybeSingle()
      if (!locked) return json({ error: 'Esta autorização já foi usada ou expirou. Clique em "Entrar com o Facebook" de novo.', code: 'session_invalid' }, 409)

      let step = 'exchange'
      const fail = async (message: string, e?: unknown) => {
        if (e) console.error('meta-complete', step, e instanceof meta.MetaError ? `${e.code}/${e.subcode} ${e.message}` : e)
        await patchSession(body.sessionId, { status: 'failed', step, error_message: message, error_code: e instanceof meta.MetaError ? String(e.code ?? e.status) : null })
        return json({ error: message, step }, e ? 502 : 400)
      }
      try {
        const token = await meta.exchangeCode(code)

        step = 'validate'
        const tk = await meta.debugToken(token)
        if (!tk.valid || tk.appId !== meta.metaApp().appId) return fail('A autorização recebida não é do app do Vórtex CRM. Clique em "Entrar com o Facebook" de novo.')
        let wabaId = metaId(body.wabaId)
        if (wabaId && tk.wabaIds.length && !tk.wabaIds.includes(wabaId)) return fail('A conta do WhatsApp escolhida não foi liberada para o Vórtex CRM. Conecte de novo e mantenha a conta marcada.')
        if (!wabaId) {
          if (tk.wabaIds.length !== 1) return fail(tk.wabaIds.length ? 'Mais de uma conta do WhatsApp foi liberada. Conecte de novo escolhendo uma conta só.' : 'Nenhuma conta do WhatsApp Business foi liberada para o Vórtex CRM. Conecte de novo e conclua todas as etapas.')
          wabaId = tk.wabaIds[0]
        }
        const phones = await meta.phoneNumbers(wabaId, token)
        const askedPhone = metaId(body.phoneNumberId)
        let phone = phones.find((p) => String(p.id) === askedPhone)
        if (askedPhone && !phone) return fail('O número escolhido não pertence à conta do WhatsApp autorizada. Conecte de novo.')
        if (!phone) {
          if (phones.length !== 1) return fail(phones.length ? 'Escolha o número na janela da Meta para concluir. Conecte de novo e selecione um número.' : 'A conta do WhatsApp ainda não tem número. Conecte de novo e cadastre o número na janela da Meta.')
          phone = phones[0]
        }
        const phoneNumberId = String(phone.id)
        const { data: taken } = await admin.from('connection_secrets').select('connection_id')
          .eq('provider', 'meta').eq('credentials->>phoneNumberId', phoneNumberId).neq('connection_id', conn.id).maybeSingle()
        if (taken) return fail('Esse número já está conectado em outra conexão do Vórtex CRM. Exclua a outra conexão antes de conectar aqui.')
        const waba = await meta.wabaInfo(wabaId, token)

        step = 'save'
        const { error: vaultErr } = await admin.rpc('meta_secret_set', { p_connection: conn.id, p_secret: { accessToken: token } })
        if (vaultErr) throw vaultErr
        const creds = {
          onboarding: 'embedded_signup', tokenInVault: true, phoneNumberId, wabaId,
          businessId: metaId(body.businessId) || waba.businessId, finishType,
          coexistence: finishType === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
          tokenExpiresAt: tk.expiresAt ? new Date(tk.expiresAt * 1000).toISOString() : null,
          connectedBy: user.id, connectedAt: new Date().toISOString(),
        }
        const { error: secErr } = await saveSecret('meta', creds as unknown as Creds)
        if (secErr) {
          if (secErr.code === '23505') return fail('Esse número já está conectado em outra conexão do Vórtex CRM. Exclua a outra conexão antes de conectar aqui.')
          throw secErr
        }
        await dropZapbot()
        const view = metaView(creds, phone, waba, { status: 'authorized', alert: null })
        await setConn({ provider: 'oficial', status: 'disconnected', number: fmtPhone(onlyDigits(phone.display_phone_number || '')), meta: view })
        await patchSession(body.sessionId, { status: 'authorized', step: 'authorized', waba_id: wabaId, phone_number_id: phoneNumberId, business_id: creds.businessId || null })
        return json({ ok: true, number: phone.display_phone_number || '', ...view })
      } catch (e) {
        return fail(meta.friendlyMetaError(e), e)
      }
    }

    const syncing = action === 'meta-sync' || (action === 'status' && embedded)
    if (action === 'meta-finish' || syncing) {
      if (!embedded) return json({ error: 'Conecte com o Facebook primeiro.' }, 400)
      const c = (await withMetaToken(admin, conn.id, existing)).credentials as Record<string, any>
      if (!c.accessToken) return json({ error: 'O acesso à Meta desta conexão não foi encontrado. Conecte de novo com o Facebook.', code: 'meta_reauth' }, 400)
      const steps: Record<string, string> = { webhooks: 'pending', register: 'pending', payment: 'unknown' }
      let step = 'webhooks'
      const fail = async (e: unknown) => {
        console.error(action, step, e instanceof meta.MetaError ? `${e.code}/${e.subcode} ${e.message}` : e)
        const message = meta.friendlyMetaError(e)
        await patchSession(body.sessionId, { status: 'failed', step, error_message: message, error_code: e instanceof meta.MetaError ? String(e.code ?? e.status) : null })
        if (meta.isAuthError(e)) await setConn({ status: 'disconnected', meta: { ...(conn.meta || {}), status: 'revoked', alert: message } })
        return json({ error: message, step, steps, ...(meta.isAuthError(e) ? { code: 'meta_reauth' } : {}) }, 502)
      }
      try {
        // meta-sync (e status) só atualiza número, qualidade e pagamento (botão "Já adicionei, conferir")
        if (action === 'meta-finish') {
          await meta.subscribeApp(c.wabaId, c.accessToken)
          steps.webhooks = 'ok'

          step = 'register'
          const current = await meta.phoneInfo(c.phoneNumberId, c.accessToken)
          // Número do app WhatsApp Business (coexistência) ou já na Cloud API não é registrado de novo
          if (c.coexistence || (current.platform_type === 'CLOUD_API' && !body.pin)) steps.register = 'skipped'
          else {
            const { data: stored } = await admin.rpc('meta_secret_get', { p_connection: conn.id })
            const pin = body.pin ? metaId(body.pin) : stored?.pin || meta.randomPin()
            if (pin.length !== 6) return json({ error: 'O PIN tem 6 dígitos.', needsPin: true, steps }, 400)
            try {
              await meta.registerPhone(c.phoneNumberId, c.accessToken, pin)
            } catch (e) {
              if (e instanceof meta.MetaError && e.code === meta.PIN_MISMATCH) {
                await patchSession(body.sessionId, { status: 'needs_pin', step })
                await setConn({ meta: { ...(conn.meta || {}), status: 'needs_pin' } })
                return json({ needsPin: true, steps, error: body.pin ? 'PIN incorreto. Confira o PIN da verificação em duas etapas desse número.' : null })
              }
              throw e
            }
            await admin.rpc('meta_secret_set', { p_connection: conn.id, p_secret: { pin } })
            steps.register = 'ok'
          }
        }

        step = 'sync'
        const [phone, waba] = await Promise.all([meta.phoneInfo(c.phoneNumberId, c.accessToken), meta.wabaInfo(c.wabaId, c.accessToken)])
        steps.payment = waba.payment
        if (syncing) steps.webhooks = steps.register = 'ok'
        const down = PHONE_DOWN.has(phone.status)
        const view = metaView(c, phone, waba, { status: down ? 'disconnected' : 'connected', alert: phoneAlert(phone) })
        await setConn({ provider: 'oficial', status: down ? 'disconnected' : 'connected', number: fmtPhone(onlyDigits(phone.display_phone_number || '')), meta: view })
        if (action === 'meta-finish') await patchSession(body.sessionId, { status: 'completed', step: 'done', completed_at: new Date().toISOString() })
        if (action === 'status') return json({ state: down ? 'close' : 'open', number: phone.display_phone_number || '' })
        return json({ ok: true, steps, number: phone.display_phone_number || '', ...view })
      } catch (e) {
        return fail(e)
      }
    }

    /* ---------- Modelos de mensagem (Configurações → Templates WhatsApp) ---------- */
    // meta-templates: traz os modelos da conta da Meta para whatsapp_templates (os que não existem mais lá saem daqui).
    // meta-template-create: cria o modelo na conta; a análise da Meta chega pelo webhook (message_template_status_update).
    if (action === 'meta-templates' || action === 'meta-template-create') {
      const c = existing?.provider === 'meta' ? (await withMetaToken(admin, conn.id, existing)).credentials as Record<string, any> : {}
      if (!c.wabaId || !c.accessToken) return json({ error: 'Conecte este número pela API Oficial (Entrar com o Facebook) para gerenciar os modelos.' }, 400)
      const rowsOfConn = async () =>
        (await admin.from('whatsapp_templates').select('*').eq('connection_id', conn.id).order('name')).data || []
      // Arquivo do cabeçalho: só da pasta da empresa no bucket template-media (o painel envia antes de criar o modelo)
      const MEDIA_RULES: Record<string, { types: string[]; max: number; label: string }> = {
        IMAGE: { types: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024, label: 'imagem JPG ou PNG de até 5 MB' },
        VIDEO: { types: ['video/mp4', 'video/3gpp'], max: 16 * 1024 * 1024, label: 'vídeo MP4 de até 16 MB' },
        DOCUMENT: { types: ['application/pdf'], max: 16 * 1024 * 1024, label: 'PDF de até 16 MB' },
      }
      const templateMedia = async (format: string, url: string): Promise<{ data: Uint8Array<ArrayBuffer>; type: string; name: string } | { error: string }> => {
        const rule = MEDIA_RULES[format]
        const prefix = `${URL_}/storage/v1/object/public/template-media/${conn.company_id}/`
        if (!rule || !url.startsWith(prefix)) return { error: 'Envie o arquivo do cabeçalho de novo pela tela de templates.' }
        const r = await fetch(url)
        if (!r.ok) return { error: 'O arquivo do cabeçalho não foi encontrado. Envie de novo.' }
        const type = (r.headers.get('content-type') || '').split(';')[0].trim()
        const data = new Uint8Array(await r.arrayBuffer())
        if (!rule.types.includes(type) || data.byteLength > rule.max) return { error: `O cabeçalho precisa ser ${rule.label}.` }
        return { data, type, name: decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)) }
      }
      const templateError = (e: unknown) => {
        console.error(action, e instanceof meta.MetaError ? `${e.code}/${e.subcode} ${e.message}` : e)
        const message = e instanceof meta.MetaError && e.userMessage && !meta.isAuthError(e) ? e.userMessage : meta.friendlyMetaError(e)
        return json({ error: message, ...(meta.isAuthError(e) ? { code: 'meta_reauth' } : {}) }, meta.isAuthError(e) ? 401 : 502)
      }

      if (action === 'meta-template-create') {
        const checked = templateDraft(body.template || {})
        if ('error' in checked) return json({ error: checked.error }, 400)
        const t = checked.draft
        let created: any
        try {
          // cabeçalho de mídia: o arquivo que o painel guardou na pasta da empresa vai para a Meta como exemplo
          let handle = ''
          if (t.header?.mediaUrl) {
            const file = await templateMedia(t.header.format, t.header.mediaUrl)
            if ('error' in file) return json({ error: file.error }, 400)
            handle = await meta.uploadForTemplate(c.accessToken, file.data, file.type, file.name)
          }
          created = await meta.createTemplate(c.wabaId, c.accessToken, { ...t, components: templateComponents(t, handle) })
        } catch (e) {
          return templateError(e)
        }
        const row = {
          company_id: conn.company_id, connection_id: conn.id, name: t.name, language: t.language, category: created.category || t.category,
          body: t.body, status: templateStatus(String(created.status || 'PENDING')),
          extra: {
            metaId: String(created.id || ''), examples: t.examples, rejectedReason: '',
            ...(t.header ? { header: t.header } : {}), ...(t.footer ? { footer: t.footer } : {}), ...(t.buttons.length ? { buttons: t.buttons } : {}),
          },
        }
        const { data: same } = await admin.from('whatsapp_templates').select('id').eq('connection_id', conn.id).eq('name', t.name).eq('language', t.language).maybeSingle()
        const { error } = same ? await admin.from('whatsapp_templates').update(row).eq('id', same.id) : await admin.from('whatsapp_templates').insert(row)
        if (error) throw error
        return json({ ok: true, status: row.status, templates: await rowsOfConn() })
      }

      let remote: any[]
      try {
        remote = await meta.listTemplates(c.wabaId, c.accessToken)
      } catch (e) {
        return templateError(e)
      }
      const local = await rowsOfConn()
      const key = (r: { name: string; language: string }) => `${r.name}|${r.language}`
      const byKey = new Map(local.map((r: any) => [key(r), r]))
      const seen = new Set<string>()
      for (const t of remote) {
        const r = templateRow(t)
        if (!r.name) continue
        seen.add(key(r))
        const prev: any = byKey.get(key(r))
        const row = { ...r, extra: mergeTemplateExtra(prev?.extra, r.extra) }
        const { error } = prev
          ? await admin.from('whatsapp_templates').update(row).eq('id', prev.id)
          : await admin.from('whatsapp_templates').insert({ ...row, company_id: conn.company_id, connection_id: conn.id })
        if (error) throw error
      }
      const gone = local.filter((r: any) => !seen.has(key(r))).map((r: any) => r.id)
      if (gone.length) await admin.from('whatsapp_templates').delete().in('id', gone)
      return json({ ok: true, templates: await rowsOfConn() })
    }

    if (action === 'webhook-info' && embedded) {
      return json({ error: 'Esta conexão recebe as mensagens automaticamente pela Meta. Não há nada para configurar.' }, 400)
    }

    /* ---------- Zapbot: WhatsApp não oficial (QR Code ou código de pareamento) ---------- */
    if (action === 'zapbot-start') {
      // Reabrir a conexão reaproveita a instância já criada. Só cria outra se ela tiver sido apagada no Zapbot (404).
      if (existing?.provider === 'zapbot') {
        try {
          await zap.status(existing.credentials as zap.ZapCreds)
          return json({ ok: true, reused: true })
        } catch (e) {
          if (!(e instanceof zap.ZapbotError && e.status === 404)) return json({ ok: true, reused: true }) // o erro aparece na consulta do QR
        }
      }
      const { data: company } = await admin.from('companies').select('name').eq('id', conn.company_id).single()
      const clientToken = randomToken(16) // 32 caracteres
      const webhookToken = randomToken() // segredo da URL do webhook desta conexão
      // o prefixo identifica, na conta do Zapbot, as conexões criadas por este sistema (útil se a conta for usada por
      // outros sistemas também)
      const inst = await zap.createInstance(admin, {
        name: Array.from(`Vórtex CRM · ${company?.name || ''} · ${conn.name}`).slice(0, 40).join(''), // até 40 caracteres
        webhookUrl: webhookUrl(conn.id, webhookToken),
        clientToken,
      })
      const creds = { baseUrl: await zap.zapbotBaseUrl(admin), instanceId: inst.id, instanceToken: inst.token, clientToken, webhookToken, createdBy: user.id }
      // Sem segredo ainda: insert (não upsert). Se outra aba criou ao mesmo tempo, vale a dela e esta instância é apagada.
      const { error } = existing
        ? await saveSecret('zapbot', creds)
        : await admin.from('connection_secrets').insert({ connection_id: conn.id, company_id: conn.company_id, provider: 'zapbot', credentials: creds })
      if (error) {
        await zap.deleteInstance(admin, inst.id).catch(() => {})
        if (error.code === '23505') return json({ ok: true, reused: true })
        throw error
      }
      await setConn({ provider: 'web', status: 'disconnected' })
      return json({ ok: true, created: true })
    }

    /* ---------- Excluir a conexão (libera a vaga no provedor) ---------- */
    if (action === 'remove') {
      if (existing?.provider === 'zapbot') await zap.deleteInstance(admin, existing.credentials.instanceId)
      if (embedded) await releaseMeta().catch((e) => console.error('meta release', e)) // a conexão sai mesmo se a Meta falhar
      const { error } = await admin.from('connections').delete().eq('id', conn.id)
      if (error) throw error
      return json({ ok: true })
    }

    /* ---------- Cloud API da Meta ---------- */
    if (action === 'save-meta') {
      const creds: Creds = {
        phoneNumberId: String(body.phoneNumberId || '').trim(),
        wabaId: String(body.wabaId || '').trim(),
        accessToken: String(body.accessToken || '').trim() || prevMeta.accessToken || '',
        appSecret: String(body.appSecret || '').trim() || prevMeta.appSecret || '',
        webhookToken: prevMeta.webhookToken || randomToken(),
        verifyToken: prevMeta.verifyToken || randomToken(12),
      }
      if (!creds.phoneNumberId || !creds.accessToken) return json({ error: 'Informe o Phone Number ID e o Access Token.' }, 400)
      const info = await metaPhoneInfo(creds) // valida o token na Meta
      const { error } = await saveSecret('meta', creds)
      if (error) throw error
      await dropZapbot()
      await setConn({ provider: 'oficial', status: 'connected', number: fmtPhone(onlyDigits(info.display_phone_number || '')), extra: { ...(conn.extra || {}), profileName: info.verified_name, quality: info.quality_rating } })
      return json({ ok: true, number: info.display_phone_number, name: info.verified_name, webhookUrl: webhookUrl(conn.id, creds.webhookToken), verifyToken: creds.verifyToken })
    }

    if (action === 'webhook-info') {
      if (!existing) return json({ error: 'Conexão ainda não configurada.' }, 400)
      return json({ webhookUrl: webhookUrl(conn.id, existing.credentials.webhookToken), verifyToken: existing.credentials.verifyToken, provider: existing.provider })
    }

    /* ---------- Evolution API ---------- */
    if (action === 'evolution-connect') {
      const creds: Creds = {
        baseUrl: String(body.baseUrl || prevEvo.baseUrl || '').trim().replace(/\/+$/, ''),
        apiKey: String(body.apiKey || '').trim() || prevEvo.apiKey || '',
        instance: String(body.instance || prevEvo.instance || `vortex-crm-${conn.id.slice(0, 8)}`).trim(),
        webhookToken: prevEvo.webhookToken || randomToken(),
      }
      if (!/^https?:\/\//.test(creds.baseUrl) || !creds.apiKey) return json({ error: 'Informe a URL da sua Evolution (https://...) e a API Key.' }, 400)
      const hook = webhookUrl(conn.id, creds.webhookToken)
      let qr: any = null
      try {
        const created = await evo(creds, 'POST', '/instance/create', {
          instanceName: creds.instance, integration: 'WHATSAPP-BAILEYS', qrcode: true,
          webhook: { url: hook, byEvents: false, base64: false, events: EVENTS },
        })
        if (created?.hash && typeof created.hash === 'string') creds.instanceToken = created.hash
        qr = created?.qrcode
      } catch (e) {
        // instância já existe: segue e só pede o QR
        if (![400, 403, 409].includes((e as any).status)) throw e
      }
      const { error } = await saveSecret('evolution', creds)
      if (error) throw error
      await dropZapbot()
      await setEvolutionWebhook(creds, hook).catch((e) => console.error('webhook set', e))
      if (!qr?.base64) qr = await evo(creds, 'GET', `/instance/connect/${encodeURIComponent(creds.instance)}`)
      await setConn({ provider: 'web', status: 'disconnected' })
      return json({ ok: true, instance: creds.instance, qr: qr?.base64 || null, pairingCode: qr?.pairingCode || null })
    }

    if (!existing) return json({ error: 'Conexão ainda não configurada.' }, 400)
    const c = existing.credentials as Creds

    if (existing.provider === 'zapbot') {
      const z = c as unknown as zap.ZapCreds
      const connected = async (phone: string) => {
        await setConn({ status: 'connected', ...(phone ? { number: fmtPhone(onlyDigits(phone)) } : {}) })
        return { connected: true, phone }
      }
      if (action === 'zapbot-qr') {
        const st = await zap.status(z)
        if (st.connected) return json(await connected(st.phone))
        if (st.error) return json({ connected: false, error: st.error }) // pareamento recusado: a mensagem vem uma vez só
        const qr = await zap.qrImage(z)
        if (qr.state === 'connected') return json(await connected(''))
        return json({ connected: false, image: qr.state === 'ready' ? qr.image : null, expiresInMs: qr.state === 'ready' ? qr.expiresInMs : null })
      }
      if (action === 'zapbot-code') {
        const phone = onlyDigits(String(body.phone || ''))
        if (phone.length < 10 || phone.length > 15) return json({ error: 'Informe o número com DDI e DDD, só dígitos. Ex.: 55119XXXXXXXX.' }, 400)
        const st = await zap.status(z)
        if (st.connected) return json(await connected(st.phone))
        if (st.error) return json({ connected: false, error: st.error })
        const r = await zap.pairingCode(z, phone)
        if (r.state === 'connected') return json(await connected(''))
        return json({ connected: false, code: r.state === 'ready' ? r.code : null })
      }
      // Cancela a tentativa de pareamento em andamento (trocar de número ou voltar do código para o QR).
      // Confere o status antes: se o número acabou de conectar, não desvincula.
      if (action === 'zapbot-reset') {
        const st = await zap.status(z)
        if (st.connected) return json(await connected(st.phone))
        await zap.disconnect(z)
        return json({ connected: false })
      }
      if (action === 'status') {
        const st = await zap.status(z)
        if (st.connected) {
          await connected(st.phone)
          return json({ state: 'open', number: st.phone })
        }
        if (conn.status === 'connected') await setConn({ status: 'disconnected' })
        return json({ state: 'close', error: st.error ?? null })
      }
      if (action === 'disconnect') {
        await zap.disconnect(z)
        await setConn({ status: 'disconnected' })
        return json({ ok: true })
      }
      return json({ error: 'Ação não disponível para esta conexão' }, 400)
    }

    if (action === 'qr') {
      if (existing.provider !== 'evolution') return json({ error: 'QR Code só existe na Evolution.' }, 400)
      const qr = await evo(c, 'GET', `/instance/connect/${encodeURIComponent(c.instance)}`)
      return json({ qr: qr?.base64 || null, pairingCode: qr?.pairingCode || null })
    }

    if (action === 'status') {
      if (existing.provider === 'meta') {
        const info = await metaPhoneInfo(c)
        await setConn({ status: 'connected', number: fmtPhone(onlyDigits(info.display_phone_number || '')) })
        return json({ state: 'open', number: info.display_phone_number })
      }
      const st = await evo(c, 'GET', `/instance/connectionState/${encodeURIComponent(c.instance)}`)
      const state = st?.instance?.state || st?.state || 'close'
      if (state === 'open') {
        const { number, profileName } = await evolutionNumber(c)
        await setConn({ status: 'connected', ...(number ? { number } : {}), extra: { ...(conn.extra || {}), profileName } })
        return json({ state, number })
      }
      if (conn.status === 'connected') await setConn({ status: 'disconnected' })
      return json({ state })
    }

    if (action === 'disconnect') {
      if (embedded) {
        await releaseMeta()
        await setConn({ status: 'disconnected', meta: { ...(conn.meta || {}), status: 'disconnected', alert: null } })
        return json({ ok: true })
      }
      if (existing.provider === 'evolution') await evo(c, 'DELETE', `/instance/logout/${encodeURIComponent(c.instance)}`).catch((e) => console.error(e))
      await setConn({ status: 'disconnected' })
      return json({ ok: true })
    }

    return json({ error: 'Ação desconhecida' }, 400)
  } catch (e) {
    console.error(action, e instanceof Error ? e.message : e)
    // Configuração do servidor (credenciais do Zapbot): aviso para chamar o administrador, com a dica do que ajustar
    if (e instanceof zap.ZapbotConfigError) return json({ error: e.message, code: 'zapbot_not_configured', hint: e.hint }, 503)
    if (e instanceof zernioApi.ZernioError) return json({ error: e.code === 'BAD_KEY' ? e.message : `Instagram: ${e.message}`, code: e.code }, e.code === 'BAD_KEY' ? 400 : e.code === 'NO_KEY' ? 503 : 502)
    return json({ error: zap.friendlyError(e) }, 502)
  }
})
