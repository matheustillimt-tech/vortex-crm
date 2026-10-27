// Instagram pela Zernio (Fase 1): assinatura do webhook, janela de resposta, leitura dos eventos, gravação de contato,
// conversa e mensagem, envio (tag HUMAN_AGENT, Idempotency-Key, botões) e endereço de volta do login.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/instagram.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'

Deno.env.set('ZERNIO_API_KEY', 'sk_teste')
Deno.env.set('ZERNIO_API_URL', 'https://zernio.teste/api/v1')
const z = await import('../functions/_shared/zernio.ts')
const { processZernioEvent } = await import('../functions/_shared/zernio-events.ts')
const { outgoingKind, recipientOf, sendMedia, sendMenu, sendText } = await import('../functions/_shared/whatsapp.ts')
const { windowOpen } = await import('../functions/_shared/flow.ts')

/* ---------- Banco de mentira (o pedaço do PostgREST que o Instagram usa) ---------- */

// Índices únicos que o código depende (23505 = violação de único no Postgres)
const UNICOS: Record<string, (a: any, b: any) => boolean> = {
  messages: (a, b) => !!a.wa_id && a.company_id === b.company_id && a.wa_id === b.wa_id,
  contacts: (a, b) => !!a.instagram_id && a.company_id === b.company_id && a.instagram_id === b.instagram_id,
  chats: (a, b) => !!a.external_id && a.connection_id === b.connection_id && a.external_id === b.external_id,
}
const campo = (r: any, k: string) => {
  const [col, json] = k.split('->>')
  return json ? r[col]?.[json] : r[k]
}

export function banco(tabelas: Record<string, any[]>) {
  let seq = 0
  const from = (tabela: string) => {
    const filtros: ((r: any) => boolean)[] = []
    let op = 'select', valor: any = null, um = false, talvez = false, limite = Infinity
    const q: any = {
      select: () => q, order: () => q,
      eq: (k: string, v: any) => (filtros.push((r) => campo(r, k) === v), q),
      neq: (k: string, v: any) => (filtros.push((r) => campo(r, k) !== v), q),
      in: (k: string, v: any[]) => (filtros.push((r) => v.includes(campo(r, k))), q),
      gte: (k: string, v: any) => (filtros.push((r) => String(campo(r, k)) >= String(v)), q),
      ilike: (k: string, v: string) => (filtros.push((r) => String(campo(r, k) ?? '').toLowerCase() === String(v).replace(/\\(.)/g, '$1').toLowerCase()), q),
      is: (k: string, v: any) => (filtros.push((r) => (campo(r, k) ?? null) === v), q),
      not: (k: string, _o: string, _v: any) => (filtros.push((r) => campo(r, k) != null), q),
      contains: (k: string, v: any[]) => (filtros.push((r) => v.every((x) => (campo(r, k) ?? []).includes(x))), q),
      range: () => q,
      delete: () => ((op = 'delete'), q),
      limit: (n: number) => ((limite = n), q),
      insert: (v: any) => ((op = 'insert'), (valor = v), q),
      update: (v: any) => ((op = 'update'), (valor = v), q),
      single: () => ((um = true), q),
      maybeSingle: () => ((talvez = true), q),
      then: (ok: any, erro: any) => Promise.resolve(executar()).then(ok, erro),
    }
    function executar() {
      const linhas = (tabelas[tabela] ??= [])
      if (op === 'insert') {
        const nova = { id: `${tabela}-${++seq}`, ...valor }
        if (linhas.some((r) => UNICOS[tabela]?.(r, nova))) return { data: null, error: { code: '23505', message: 'duplicado' } }
        linhas.push(nova)
        return { data: nova, error: null }
      }
      const alvo = linhas.filter((r) => filtros.every((f) => f(r))).slice(0, limite)
      if (op === 'delete') {
        tabelas[tabela] = linhas.filter((r) => !alvo.includes(r))
        return { data: null, error: null }
      }
      if (op === 'update') {
        for (const r of alvo) Object.assign(r, valor)
        return { data: alvo, error: null }
      }
      if (um || talvez) return { data: alvo[0] ?? null, error: um && !alvo[0] ? { message: 'nenhuma linha' } : null }
      return { data: alvo, error: null }
    }
    return q
  }
  return { from, rpc: async () => ({ data: null, error: null }) }
}

const base = () => ({
  connections: [{ id: 'conn1', company_id: 'emp1', provider: 'instagram', status: 'connected', extra: {} as Record<string, unknown> }],
  connection_secrets: [{ connection_id: 'conn1', company_id: 'emp1', provider: 'instagram', credentials: { profileId: 'prof1', accountId: 'acc1', username: 'loja' } }],
  company_access: [{ company_id: 'emp1', effective: ['conexoes', 'contatos', 'chat', 'instagram'] }],
  contacts: [] as any[], chats: [] as any[], messages: [] as any[], agents: [] as any[],
})

const recebida = (extra: Record<string, unknown> = {}) => ({
  id: 'ev1', event: 'message.received', timestamp: '2026-10-23T12:00:00Z',
  message: {
    id: 'msg1', conversationId: 'conv1', platform: 'instagram', platformMessageId: 'mid1', direction: 'incoming',
    text: 'Oi, quero saber do curso', attachments: [], sentAt: '2026-10-23T12:00:00Z', isRead: false,
    sender: { id: 'ig-123', name: 'Ana Souza', username: 'ana.souza', instagramProfile: { isFollower: true, isVerified: false, followerCount: 320 } },
  },
  conversation: { id: 'conv1', participantId: 'ig-123', participantName: 'Ana Souza', participantUsername: 'ana.souza' },
  account: { id: 'acc1', platform: 'instagram' },
  ...extra,
})

/* ---------- Assinatura e janela ---------- */

Deno.test('assinatura: HMAC-SHA256 do corpo em hexadecimal; errada, vazia ou sem segredo é recusada', async () => {
  const corpo = '{"id":"ev1","event":"message.received"}'
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('segredo'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(corpo))), (b) => b.toString(16).padStart(2, '0')).join('')
  assert(await z.validZernioSignature(corpo, hex, 'segredo'))
  assert(await z.validZernioSignature(corpo, hex.toUpperCase(), 'segredo'))
  assert(!(await z.validZernioSignature(corpo + ' ', hex, 'segredo')))
  assert(!(await z.validZernioSignature(corpo, hex, 'outro')))
  assert(!(await z.validZernioSignature(corpo, null, 'segredo')))
  assert(!(await z.validZernioSignature(corpo, hex, '')))
})

Deno.test('janela do Instagram: 24 h para todos, até 7 dias só humano, depois fechada', () => {
  const agora = Date.parse('2026-10-23T12:00:00Z')
  const h = (n: number) => new Date(agora - n * 3600_000).toISOString()
  assertEquals(z.igWindow(h(1), agora), 'open')
  assertEquals(z.igWindow(h(30), agora), 'human')
  assertEquals(z.igWindow(h(24 * 7 + 1), agora), 'closed')
  assertEquals(z.igWindow(null, agora), 'closed')
  // fluxo e IA: no Instagram também param fora das 24 h; no WhatsApp não oficial, não
  assertEquals(windowOpen('instagram', h(30), agora), false)
  assertEquals(windowOpen('instagram', h(2), agora), true)
  assertEquals(windowOpen('zapbot', h(300), agora), true)
})

/* ---------- Leitura dos eventos ---------- */

Deno.test('message.received vira contato com @, perfil e id da conversa', () => {
  const m = z.parseZernioMessage(recebida())!
  assertEquals([m.conversationId, m.igUserId, m.username, m.name, m.fromMe, m.type], ['conv1', 'ig-123', 'ana.souza', 'Ana Souza', false, 'text'])
  assertEquals(m.igProfile?.isFollower, true)
})

Deno.test('message.sent: o contato vem da conversa (o remetente é a empresa)', () => {
  const m = z.parseZernioMessage({ ...recebida(), event: 'message.sent', message: { ...recebida().message, direction: 'outgoing', sender: { id: 'acc-ig', name: 'Loja' } } })!
  assertEquals([m.fromMe, m.igUserId, m.username, m.igProfile], [true, 'ig-123', 'ana.souza', null])
})

Deno.test('anexo sem texto ganha rótulo; toque em botão traz o payload; outro canal é ignorado', () => {
  const ev = recebida({ metadata: { postbackPayload: 'opt-1' } })
  ev.message = { ...ev.message, text: '', attachments: [{ type: 'image', url: 'https://cdn.instagram.test/a.jpg' }] } as any
  const m = z.parseZernioMessage(ev)!
  assertEquals([m.text, m.type, m.media?.url, m.replyId], ['📷 Imagem', 'image', 'https://cdn.instagram.test/a.jpg', 'opt-1'])
  assertEquals(z.parseZernioMessage({ ...recebida(), account: { id: 'acc1', platform: 'whatsapp' }, message: { ...recebida().message, platform: 'whatsapp' } }), null)
})

/* ---------- Gravação (processZernioEvent) ---------- */

Deno.test('mensagem nova: cria contato do Instagram, conversa aguardando e mensagem do contato', async () => {
  const t = base()
  const r = await processZernioEvent(banco(t), recebida())
  assertEquals(r.status, 'ok')
  assertEquals(t.contacts.length, 1)
  const c = t.contacts[0]
  assertEquals([c.origin, c.phone, c.instagram_id, c.instagram_username, c.name], ['Instagram', '', 'ig-123', 'ana.souza', 'Ana Souza'])
  assertEquals(t.chats[0].external_id, 'conv1')
  assertEquals([t.chats[0].status, t.chats[0].unread, t.chats[0].bot_active], ['waiting', 1, false])
  assertEquals([t.messages[0].sender, t.messages[0].wa_id, t.messages[0].text], ['contact', 'msg1', 'Oi, quero saber do curso'])
})

Deno.test('mesma mensagem duas vezes (reenvio da Zernio): grava uma vez só', async () => {
  const t = base()
  const db = banco(t)
  await processZernioEvent(db, recebida())
  const r = await processZernioEvent(db, { ...recebida(), id: 'ev1-de-novo' })
  assertEquals([r.status, r.why], ['ignored', 'duplicate'])
  assertEquals([t.messages.length, t.contacts.length, t.chats.length], [1, 1, 1])
})

Deno.test('segunda mensagem da mesma pessoa: mesmo contato e mesma conversa, não lida soma', async () => {
  const t = base()
  const db = banco(t)
  await processZernioEvent(db, recebida())
  await processZernioEvent(db, { ...recebida(), id: 'ev2', message: { ...recebida().message, id: 'msg2', platformMessageId: 'mid2', text: 'Tem parcelado?' } })
  assertEquals([t.contacts.length, t.chats.length, t.messages.length, t.chats[0].unread], [1, 1, 2, 2])
})

Deno.test('resposta pelo app do Instagram entra como atendente e marca a conversa respondida', async () => {
  const t = base()
  const db = banco(t)
  await processZernioEvent(db, recebida())
  const r = await processZernioEvent(db, { ...recebida(), id: 'ev3', event: 'message.sent', message: { ...recebida().message, id: 'msg3', platformMessageId: 'mid3', direction: 'outgoing', text: 'Oi Ana! Te mando já', sender: { id: 'acc-ig' } } })
  assertEquals(r.status, 'ok')
  assertEquals([t.messages[1].sender, t.messages[1].extra.via, t.chats[0].answered], ['agent', 'app do Instagram', true])
})

Deno.test('eco de envio feito pelo painel (mesmo texto há pouco) não duplica', async () => {
  const t = base()
  const db = banco(t)
  await processZernioEvent(db, recebida())
  t.messages.push({ id: 'p1', company_id: 'emp1', chat_id: t.chats[0].id, sender: 'agent', text: 'Já te respondo', wa_id: 'outro-id', at: new Date().toISOString() })
  const r = await processZernioEvent(db, { ...recebida(), id: 'ev4', event: 'message.sent', message: { ...recebida().message, id: 'msg4', platformMessageId: 'mid4', direction: 'outgoing', text: 'Já te respondo' } })
  assertEquals([r.status, r.why, t.messages.length], ['ignored', 'echo', 2])
})

Deno.test('lida e apagada atualizam a mensagem; conta desconhecida e módulo suspenso são ignorados', async () => {
  const t = base()
  const db = banco(t)
  await processZernioEvent(db, recebida())
  await processZernioEvent(db, { id: 'ev5', event: 'message.read', message: { id: 'msg1' }, account: { id: 'acc1' } })
  assertEquals(t.messages[0].delivery, 'read')
  await processZernioEvent(db, { id: 'ev6', event: 'message.deleted', message: { id: 'msg1', platformMessageId: 'mid1' }, account: { id: 'acc1' } })
  assertEquals(t.messages[0].extra.deleted, true)
  assertEquals((await processZernioEvent(db, { ...recebida(), account: { id: 'acc-de-outro', platform: 'instagram' } })).status, 'ignored')
  t.company_access[0].effective = ['conexoes', 'chat']
  const off = await processZernioEvent(db, { ...recebida(), id: 'ev7', message: { ...recebida().message, id: 'msg7' } })
  assertEquals([off.status, off.why], ['ignored', 'módulo instagram suspenso'])
})

Deno.test('conta desconectada na Meta: conexão cai com aviso', async () => {
  const t = base()
  await processZernioEvent(banco(t), { id: 'ev8', event: 'account.disconnected', account: { accountId: 'acc1', platform: 'instagram', disconnectionType: 'unintentional', reason: 'token expirado' } })
  assertEquals(t.connections[0].status, 'disconnected')
  assert(String(t.connections[0].extra.alert).includes('token expirado'))
})

/* ---------- Envio ---------- */

function zernioFalsa() {
  const chamadas: { url: string; headers: Headers; body: any }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    chamadas.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ success: true, data: { messageId: `zmsg-${chamadas.length}` } }), { status: 200 })
  }) as typeof fetch
  return { chamadas, restaurar: () => { globalThis.fetch = original } }
}

Deno.test('envio: vai para a conversa, com a chave da Zernio e Idempotency-Key; fora das 24 h leva HUMAN_AGENT', async () => {
  const f = zernioFalsa()
  try {
    const id = await z.igSend({ accountId: 'acc1' }, 'conv1', { text: 'Oi!' }, 'chave-1')
    assertEquals(id, 'zmsg-1')
    const c = f.chamadas[0]
    assertEquals(c.url, 'https://zernio.teste/api/v1/inbox/conversations/conv1/messages')
    assertEquals([c.headers.get('Authorization'), c.headers.get('Idempotency-Key')], ['Bearer sk_teste', 'chave-1'])
    assertEquals(c.body, { accountId: 'acc1', message: 'Oi!' })
    await z.igSend({ accountId: 'acc1' }, 'conv1', { text: 'Voltando aqui', humanAgent: true })
    assertEquals([f.chamadas[1].body.messagingType, f.chamadas[1].body.messageTag], ['MESSAGE_TAG', 'HUMAN_AGENT'])
  } finally { f.restaurar() }
})

Deno.test('menu do Instagram (igMenu): até 3 opções viram botões, até 13 respostas rápidas (payload opt-N)', async () => {
  const f = zernioFalsa()
  try {
    await z.igMenu({ accountId: 'acc1' }, 'conv1', 'Escolha', ['Preço', 'Prazo'])
    assertEquals(f.chamadas[0].body.buttons, [{ type: 'postback', title: 'Preço', payload: 'opt-0' }, { type: 'postback', title: 'Prazo', payload: 'opt-1' }])
    await z.igMenu({ accountId: 'acc1' }, 'conv1', 'Escolha', ['a', 'b', 'c', 'd', 'e'])
    assertEquals(f.chamadas[1].body.quickReplies.length, 5)
    assertEquals(f.chamadas[1].body.buttons, undefined)
  } finally { f.restaurar() }
})

Deno.test('trava: fluxo, IA, disparo e MCP não mandam nada pelo Instagram (nem chamam a Zernio)', async () => {
  const f = zernioFalsa()
  try {
    let erros = 0
    for (const envio of [
      () => sendText('instagram', { accountId: 'acc1' }, 'conv1', 'Oi'),
      () => sendMenu('instagram', { accountId: 'acc1' }, 'conv1', 'Escolha', ['a', 'b']),
      () => sendMedia('instagram', { accountId: 'acc1' }, 'conv1', { kind: 'image', url: 'https://x/y.jpg' }),
    ]) { try { await envio() } catch { erros++ } }
    assertEquals(erros, 3)
    assertEquals(f.chamadas.length, 0)
  } finally { f.restaurar() }
})

Deno.test('destino e formatos: Instagram usa a conversa; MP3 e .docx viram link', () => {
  assertEquals(recipientOf('instagram', { phone: '+5500999999999' }, { external_id: 'conv1' }), 'conv1')
  assertEquals(recipientOf('zapbot', { phone: '+5500999999999' }, { external_id: 'conv1' }), '+5500999999999')
  assertEquals(outgoingKind('instagram', 'image/jpeg', 1_000_000), 'image')
  assertEquals(outgoingKind('instagram', 'image/webp', 1_000_000), 'document')
  assertEquals(outgoingKind('instagram', 'audio/mpeg', 1_000_000), 'document')
  assertEquals(outgoingKind('instagram', 'image/png', 9 * 1024 * 1024), 'document')
  assertEquals(z.igKind('application/pdf', 1000), 'file')
})

Deno.test('volta do login: só para o painel (SITE_URL, APP_ORIGINS e local)', () => {
  Deno.env.set('SITE_URL', 'https://crm.exemplo.com.br/')
  Deno.env.set('APP_ORIGINS', 'https://painel.exemplo.com.br, nada')
  assertEquals(z.returnUrl('https://crm.exemplo.com.br/connections', 'c1'), 'https://crm.exemplo.com.br/connections?ig=c1')
  assertEquals(z.returnUrl('https://painel.exemplo.com.br/x', 'c1'), 'https://painel.exemplo.com.br/connections?ig=c1')
  assertEquals(z.returnUrl('http://localhost:5173/connections', 'c1'), 'http://localhost:5173/connections?ig=c1')
  assertEquals(z.returnUrl('https://site-malicioso.com', 'c1'), null)
  assertEquals(z.returnUrl('https://crm.exemplo.com.br.malicioso.com', 'c1'), null)
  assertEquals(z.returnUrl('nada', 'c1'), null)
})

/* ---------- Conexão pela chave da Zernio de quem conecta ---------- */

Deno.test('chave da conexão: vai no Authorization do envio no lugar da chave da plataforma', async () => {
  const f = zernioFalsa()
  try {
    await z.igSend({ accountId: 'acc1', apiKey: 'chave-da-pessoa' }, 'conv1', { text: 'Oi' })
    assertEquals(f.chamadas[0].headers.get('Authorization'), 'Bearer chave-da-pessoa')
    await z.igSend({ accountId: 'acc1' }, 'conv1', { text: 'Oi' })
    assertEquals(f.chamadas[1].headers.get('Authorization'), 'Bearer sk_teste')
  } finally { f.restaurar() }
})

Deno.test('webhook da conexão: cadastrado na conta da pessoa, com segredo e só os eventos do CRM', async () => {
  const original = globalThis.fetch
  const chamadas: any[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    chamadas.push({ url: String(url), method: init.method, auth: new Headers(init.headers).get('Authorization'), body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ success: true, webhook: { _id: 'wh1' } }), { status: 200 })
  }) as typeof fetch
  try {
    const id = await z.createWebhook('sk_da_pessoa_1234567890abcd', 'Vórtex CRM · Instagram da loja', 'https://x.supabase.co/functions/v1/zernio-webhook?c=c1', 'segredo')
    assertEquals(id, 'wh1')
    assertEquals([chamadas[0].method, chamadas[0].url, chamadas[0].auth], ['POST', 'https://zernio.teste/api/v1/webhooks/settings', 'Bearer sk_da_pessoa_1234567890abcd'])
    assertEquals(chamadas[0].body.events, z.WEBHOOK_EVENTS)
    assertEquals(chamadas[0].body.secret, 'segredo')
    await z.deleteWebhook('sk_da_pessoa_1234567890abcd', 'wh1')
    assertEquals([chamadas[1].method, chamadas[1].url], ['DELETE', 'https://zernio.teste/api/v1/webhooks/settings?id=wh1'])
  } finally { globalThis.fetch = original }
})

Deno.test('chave recusada pela Zernio vira aviso claro; formato e final da chave', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as typeof fetch
  try {
    let msg = ''
    try { await z.accountsForKey('sk_errada_1234567890abcdef') } catch (e) { msg = (e as Error).message }
    assert(msg.includes('não aceitou essa chave'))
  } finally { globalThis.fetch = original }
  assert(z.looksLikeKey('sk_1234567890abcdef1234'))
  assert(z.looksLikeKey('zrk_1234567890abcdef1234'))
  assert(!z.looksLikeKey('minha senha'))
  assert(!z.looksLikeKey('sk_curta'))
  assertEquals(z.keyHint('sk_1234567890abcdef8e9a'), '••••8e9a')
})

Deno.test('evento pelo webhook de uma conexão só vale para a conta do Instagram dela', async () => {
  const t = base()
  const db = banco(t)
  assertEquals((await processZernioEvent(db, recebida(), 'conn1')).status, 'ok')
  const outra = await processZernioEvent(db, { ...recebida(), id: 'ev9', message: { ...recebida().message, id: 'msg9' } }, 'conn-de-outra-empresa')
  assertEquals([outra.status, outra.why], ['ignored', 'evento de outra conta da Zernio'])
})
