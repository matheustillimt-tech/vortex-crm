// Conexão Z-API (instância da própria pessoa): reaproveita as rotas de instância do Zapbot.
// Rotas e formatos conferidos em https://developer.z-api.io (28/10/2026).
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/zapi.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { instanceCall, pairingCode, qrImage, ZapbotError, type ZapCreds } from '../functions/_shared/zapbot.ts'
import { CHALLENGE_MSG, unhookZapi, zapiCredsFrom, zapiFriendlyError, zapiStatus } from '../functions/_shared/zapi.ts'
import { outgoingKind, sendMedia, sendMenu, sendText, sendTyping } from '../functions/_shared/whatsapp.ts'
import { linkFotoZapi } from '../functions/_shared/fotos.ts'
import { parseZapbot } from '../functions/_shared/inbound.ts'

const Z: ZapCreds = { baseUrl: 'https://api.z-api.io', instanceId: 'I1', instanceToken: 'T1', clientToken: 'ct', webhookToken: 'wh' }
type Chamada = { url: string; method: string; headers: Record<string, string>; body: any }

/** Troca o fetch por respostas em fila (status 200 por padrão) e devolve as chamadas feitas. */
async function comFetch(respostas: (any | { status: number; body: any })[], fn: () => Promise<unknown>) {
  const real = globalThis.fetch
  const chamadas: Chamada[] = []
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), method: init.method || 'GET', headers: (init.headers || {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const r = respostas.shift() ?? {}
    const [status, body] = r && typeof r.status === 'number' && 'body' in r ? [r.status, r.body] : [200, r]
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = real
  }
  return chamadas
}

/* ---------- adaptador (zapbot.ts) ---------- */

Deno.test('Client-Token só vai quando preenchido (no Z-API ele é opcional)', async () => {
  const c = await comFetch([{ connected: false }, { connected: false }], async () => {
    await instanceCall({ ...Z, clientToken: '' }, 'GET', 'status')
    await instanceCall(Z, 'GET', 'status')
  })
  assertEquals(c[0].url, 'https://api.z-api.io/instances/I1/token/T1/status')
  assertEquals(c[0].headers['Client-Token'], undefined)
  assertEquals(c[1].headers['Client-Token'], 'ct')
})

Deno.test('código de pareamento: o Z-API devolve em "value", o Zapbot em "code"', async () => {
  let a: any, b: any
  await comFetch([{ value: 'A1B2C3D4' }, { code: 'K7QW-2MZD' }], async () => {
    a = await pairingCode(Z, '+55 11 99999-9999')
    b = await pairingCode(Z, '5511999999999')
  })
  assertEquals(a, { state: 'ready', code: 'A1B2C3D4' })
  assertEquals(b, { state: 'ready', code: 'K7QW-2MZD' })
})

Deno.test('QR Code: imagem, já conectado, passkey (challenge) e resposta vazia', async () => {
  const r: any[] = []
  await comFetch([{ value: 'data:image/png;base64,AAA' }, { connected: true }, { challenge: { challenge: 'x' } }, {}], async () => {
    for (let i = 0; i < 4; i++) r.push(await qrImage(Z))
  })
  assertEquals(r[0].state, 'ready')
  assertEquals(r[0].image, 'data:image/png;base64,AAA')
  assertEquals(r[1], { state: 'connected' })
  assertEquals(r[2], { state: 'challenge' })
  assertEquals(r[3], { state: 'pending' })
})

Deno.test('código de pareamento com passkey (challenge)', async () => {
  let r: any
  await comFetch([{ challenge: { challenge: 'x' } }], async () => { r = await pairingCode(Z, '5511999999999') })
  assertEquals(r, { state: 'challenge' })
})

/* ---------- credenciais coladas (zapi.ts) ---------- */

Deno.test('credenciais coladas: URL padrão, espaços e barra no fim', () => {
  assertEquals(zapiCredsFrom({ instanceId: ' I1 ', instanceToken: ' T1 ' }, 'wh'), {
    creds: { baseUrl: 'https://api.z-api.io', instanceId: 'I1', instanceToken: 'T1', clientToken: '', webhookToken: 'wh' },
  })
  assertEquals(zapiCredsFrom({ instanceId: 'I1', instanceToken: 'T1', clientToken: ' ct ', baseUrl: 'https://api.z-api.io/// ' }, 'wh'), {
    creds: { baseUrl: 'https://api.z-api.io', instanceId: 'I1', instanceToken: 'T1', clientToken: 'ct', webhookToken: 'wh' },
  })
})

Deno.test('credenciais coladas: faltando ID/token, URL sem https ou com caractere estranho', () => {
  assert('error' in zapiCredsFrom({ instanceId: '', instanceToken: 'T1' }, 'wh'))
  assert('error' in zapiCredsFrom({ instanceId: 'I1' }, 'wh'))
  assert('error' in zapiCredsFrom({ instanceId: 'I1', instanceToken: 'T1', baseUrl: 'http://api.z-api.io' }, 'wh'))
  assert('error' in zapiCredsFrom({ instanceId: 'I1/../x', instanceToken: 'T1' }, 'wh'))
  assert('error' in zapiCredsFrom({ instanceId: 'I1', instanceToken: 'T 1' }, 'wh'))
  assert('error' in zapiCredsFrom(null, 'wh'))
})

Deno.test('URL base: só o endereço do Z-API, reduzido à origem (nada de host interno, IP ou usuário na URL)', () => {
  const base = (u: string) => {
    const r = zapiCredsFrom({ instanceId: 'I1', instanceToken: 'T1', baseUrl: u }, 'wh')
    return 'creds' in r ? r.creds.baseUrl : null
  }
  assertEquals(base('https://api.z-api.io/'), 'https://api.z-api.io')
  assertEquals(base('https://api.z-api.io/instances/x?y=1'), 'https://api.z-api.io')
  assertEquals(base('https://api2.z-api.io'), 'https://api2.z-api.io')
  assertEquals(base('https://interno.empresa.com'), null)
  assertEquals(base('https://z-api.io.evil.com'), null)
  assertEquals(base('https://127.0.0.1'), null)
  assertEquals(base('https://user:pass@api.z-api.io'), null)
  assertEquals(base('https://api.z-api.io:8443'), null)
  assertEquals(base('nada'), null)
})

/* ---------- status (zapi.ts) ---------- */

Deno.test('status: "error" do Z-API é só texto de estado e é ignorado; telefone vem de /device', async () => {
  let a: any, b: any
  const c = await comFetch([
    { connected: false, error: 'You are not connected', smartphoneConnected: false },
    { connected: true, error: 'You are already connected', smartphoneConnected: true },
    { phone: '5511999999999', name: 'Loja' },
  ], async () => {
    a = await zapiStatus(Z)
    b = await zapiStatus(Z)
  })
  assertEquals(a, { connected: false, phone: '' })
  assertEquals(b, { connected: true, phone: '5511999999999' })
  assertEquals(c.map((x) => x.url.split('/T1/')[1]), ['status', 'status', 'device'])
})

Deno.test('status: sem pedir telefone, não consulta /device', async () => {
  let a: any
  const c = await comFetch([{ connected: true }], async () => { a = await zapiStatus(Z, false) })
  assertEquals(a, { connected: true, phone: '' })
  assertEquals(c.length, 1)
})

Deno.test('desligar webhooks: PUT update-every-webhooks com URL vazia', async () => {
  const c = await comFetch([{ value: true }], () => unhookZapi(Z))
  assertEquals(c[0].method, 'PUT')
  assert(c[0].url.endsWith('/instances/I1/token/T1/update-every-webhooks'))
  assertEquals(c[0].body, { value: '', notifySentByMe: false })
})

/* ---------- erros amigáveis ---------- */

Deno.test('erros do Z-API viram mensagem simples', () => {
  // Client-Token é opcional: quando o Z-API pede (ou recusa), a mensagem diz quando preencher
  for (const e of [new ZapbotError(400, 'null not allowed'), new ZapbotError(403, 'Client-Token F123 not allowed'), new ZapbotError(400, 'client-token is required')]) {
    const m = zapiFriendlyError(e)
    assert(m.includes('Client-Token') && m.includes('Só preencha se você ligou o token de segurança da conta no Z-API'), m)
  }
  assert(/ID e o token/.test(zapiFriendlyError(new ZapbotError(400, 'Instance not found'))))
  assert(/ID e o token/.test(zapiFriendlyError(new ZapbotError(404, 'HTTP 404'))))
  assert(/Número inválido/.test(zapiFriendlyError(new ZapbotError(400, 'phone number too short'))))
  assert(/Aguarde/.test(zapiFriendlyError(new ZapbotError(429, 'HTTP 429'))))
  assert(/URL base/.test(zapiFriendlyError(new TypeError('error sending request for url'))))
  assert(CHALLENGE_MSG.includes('Z-API'))
  // nunca repete o token na mensagem
  assert(!zapiFriendlyError(new ZapbotError(500, 'falhou em /instances/I1/token/T1/status')).includes('T1'))
})

/* ---------- envio (whatsapp.ts) e foto (fotos.ts) ---------- */

const ZC = Z as unknown as Record<string, string>

Deno.test('envio de texto no zapi: send-text da instância, com Client-Token', async () => {
  let id: any
  const c = await comFetch([{ zaapId: 'z1', messageId: 'M1' }], async () => { id = await sendText('zapi', ZC, '+55 11 99999-9999', 'Oi') })
  assertEquals(id, 'M1')
  assertEquals(c[0].method, 'POST')
  assertEquals(c[0].url, 'https://api.z-api.io/instances/I1/token/T1/send-text')
  assertEquals(c[0].headers['Client-Token'], 'ct')
  assertEquals(c[0].body, { phone: '5511999999999', message: 'Oi' })
})

Deno.test('menu no zapi vai como texto numerado (sem botões)', async () => {
  let r: any
  const c = await comFetch([{ messageId: 'M2' }], async () => { r = await sendMenu('zapi', ZC, '5511999999999', 'Escolha', ['Sim', 'Não']) })
  assertEquals(c.length, 1)
  assert(c[0].url.endsWith('/send-text'))
  assert(c[0].body.message.includes('1. Sim') && c[0].body.message.includes('2. Não'))
  assertEquals(r.id, 'M2')
})

Deno.test('mídia no zapi: imagem, áudio e documento pelas rotas do Z-API', async () => {
  const c = await comFetch([{ messageId: 'a' }, { messageId: 'b' }, { messageId: 'c' }], async () => {
    await sendMedia('zapi', ZC, '5511999999999', { kind: 'image', url: 'https://x/f.png', caption: 'foto' })
    await sendMedia('zapi', ZC, '5511999999999', { kind: 'audio', url: 'https://x/a.ogg' })
    await sendMedia('zapi', ZC, '5511999999999', { kind: 'document', url: 'https://x/d.pdf', fileName: 'Proposta.PDF' })
  })
  assertEquals(c.map((x) => x.url.split('/T1/')[1]), ['send-image', 'send-audio', 'send-document/pdf'])
  assertEquals(c[0].body, { phone: '5511999999999', image: 'https://x/f.png', caption: 'foto' })
  assertEquals(c[2].body.fileName, 'Proposta.PDF')
  assertEquals(outgoingKind('zapi', 'image/webp', 1024), 'image')
})

Deno.test('"digitando" não existe no Z-API: nada é chamado', async () => {
  const c = await comFetch([], () => sendTyping('zapi', ZC, '5511999999999', 2000))
  assertEquals(c.length, 0)
})

Deno.test('foto do contato no zapi: GET profile-picture?phone=', async () => {
  let a: any, b: any
  const c = await comFetch([{ link: 'https://pps.whatsapp.net/f.jpg' }, { link: null }], async () => {
    a = await linkFotoZapi(ZC, '+55 11 90000-7777')
    b = await linkFotoZapi(ZC, '5511900007777')
  })
  assertEquals(c[0].method, 'GET')
  assertEquals(c[0].url, 'https://api.z-api.io/instances/I1/token/T1/profile-picture?phone=5511900007777')
  assertEquals(a, 'https://pps.whatsapp.net/f.jpg')
  assertEquals(b, null)
})

/* ---------- webhook de entrada (inbound.ts) ---------- */

Deno.test('status da mensagem: o Z-API manda "ids" (um ou vários), o Zapbot manda "messageId"', () => {
  assertEquals(parseZapbot({ type: 'MessageStatusCallback', status: 'READ', ids: ['A', 'B'], phone: '5544999999999', isGroup: false }).statuses,
    [{ waId: 'A', status: 'READ' }, { waId: 'B', status: 'READ' }])
  assertEquals(parseZapbot({ type: 'MessageStatusCallback', status: 'received', messageId: 'C' }).statuses, [{ waId: 'C', status: 'RECEIVED' }])
})

Deno.test('desconexão (DisconnectedCallback) e conexão (ConnectedCallback)', () => {
  const d = parseZapbot({ type: 'DisconnectedCallback', error: 'Device has been disconnected', disconnected: true, momment: 1 })
  assertEquals(d.disconnected, { error: 'Device has been disconnected' })
  assertEquals(d.messages.length + d.statuses.length, 0)
  assertEquals(parseZapbot({ type: 'ConnectedCallback', phone: '5511999999999' }).connected, { phone: '5511999999999' })
  assertEquals(parseZapbot({ type: 'ConnectedCallback', phone: '5511999999999' }).disconnected, null)
})

Deno.test('mensagem recebida no formato do Z-API vira conversa', () => {
  const r = parseZapbot({ type: 'ReceivedCallback', phone: '5511900007777', fromMe: false, isGroup: false, messageId: 'X1', senderName: 'Ana', text: { message: 'Oi' } })
  assertEquals(r.messages.length, 1)
  assertEquals(r.messages[0].phone, '5511900007777')
  assertEquals(r.messages[0].text, 'Oi')
  assertEquals(r.messages[0].waId, 'X1')
})

Deno.test('erro de rede não carrega o token da instância (vai para log)', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => { throw new TypeError(`error sending request for url (${url}): dns error`) }) as typeof fetch
  try {
    await instanceCall(Z, 'GET', 'status')
    throw new Error('devia ter falhado')
  } catch (e) {
    assert(e instanceof TypeError)
    assert(!e.message.includes('T1'), e.message)
    assert(e.message.includes('/token/***'))
  } finally {
    globalThis.fetch = real
  }
})
