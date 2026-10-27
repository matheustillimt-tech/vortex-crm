// Testes da API Oficial pelo Embedded Signup (sem banco; a Graph API é simulada trocando o fetch).
// Rodar: npx deno test -A --no-lock --node-modules-dir=none supabase/tests/meta.test.ts
import { assert, assertEquals, assertMatch, assertRejects } from 'jsr:@std/assert@1'
import { accountChanges, splitByPhone, templateStatus } from '../functions/_shared/meta-webhook.ts'
import { parseMeta } from '../functions/_shared/inbound.ts'

Deno.env.set('META_APP_ID', '111')
Deno.env.set('META_APP_SECRET', 'segredo')
Deno.env.set('META_CONFIG_ID', '222')
Deno.env.set('META_WEBHOOK_VERIFY_TOKEN', 'verifica')
const meta = await import('../functions/_shared/meta.ts')

// fetch simulado: cada chamada devolve a próxima resposta da fila e guarda a URL pedida
function fakeGraph(responses: [number, unknown][]) {
  const calls: { url: string; method: string; auth: string | null; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const [status, body] = responses.shift() ?? [500, { error: { message: 'sem resposta' } }]
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), method: init?.method || 'GET', auth: headers.get('Authorization'), body: (init?.body as string) ?? null })
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const msgChange = (phoneId: string, from: string, id: string) => ({
  field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId, display_phone_number: '5500300000001' }, contacts: [{ wa_id: from, profile: { name: 'Ana' } }], messages: [{ id, from, type: 'text', text: { body: 'oi' } }] },
})

Deno.test('webhook do app: separa as mensagens por número e mantém o formato que o parseMeta lê', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      { id: 'WABA1', changes: [msgChange('P1', '5500999990000', 'm1'), msgChange('P2', '5500999990001', 'm2')] },
      { id: 'WABA2', changes: [msgChange('P1', '5500999990002', 'm3'), { field: 'account_update', value: { event: 'PARTNER_ADDED', waba_info: { waba_id: 'WABA2' } } }] },
    ],
  }
  const parts = splitByPhone(body)
  assertEquals([...parts.keys()], ['P1', 'P2'])
  assertEquals(parseMeta(parts.get('P1')).messages.map((m) => m.waId), ['m1', 'm3'])
  assertEquals(parseMeta(parts.get('P2')).messages.map((m) => m.phone), ['5500999990001'])
  assertEquals(accountChanges(body), [{ wabaId: 'WABA2', field: 'account_update', value: { event: 'PARTNER_ADDED', waba_info: { waba_id: 'WABA2' } } }])
})

Deno.test('webhook do app: eventos de conta usam o entry.id e ignoram campos fora da lista', () => {
  const body = { entry: [{ id: 'W9', changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '5500300000001', event: 'FLAGGED' } }, { field: 'history', value: {} }] }] }
  assertEquals(accountChanges(body).map((c) => [c.wabaId, c.field]), [['W9', 'phone_number_quality_update']])
  assertEquals(splitByPhone(body).size, 0)
  assertEquals(templateStatus('APPROVED'), 'APROVADO')
  assertEquals(templateStatus('NOVO_STATUS'), 'NOVO_STATUS')
})

Deno.test('troca do código: usa o app da plataforma e aceita JSON ou texto puro', async () => {
  const g = fakeGraph([[200, { access_token: 'TOKEN1', token_type: 'bearer' }], [200, 'TOKEN2']])
  try {
    assertEquals(await meta.exchangeCode('abc'), 'TOKEN1')
    assertEquals(await meta.exchangeCode('def'), 'TOKEN2')
    const u = new URL(g.calls[0].url)
    assertMatch(u.pathname, /^\/v\d+\.0\/oauth\/access_token$/)
    assertEquals([u.searchParams.get('client_id'), u.searchParams.get('client_secret'), u.searchParams.get('code')], ['111', 'segredo', 'abc'])
  } finally {
    g.restore()
  }
})

Deno.test('debug_token: lê o app, a validade e as contas do WhatsApp liberadas', async () => {
  const g = fakeGraph([[200, { data: { app_id: '111', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_management'], granular_scopes: [
    { scope: 'whatsapp_business_management', target_ids: ['W1', 'W2'] }, { scope: 'whatsapp_business_messaging', target_ids: ['W1'] }, { scope: 'business_management', target_ids: ['B1'] },
  ] } }]])
  try {
    const t = await meta.debugToken('TOKEN')
    assertEquals(t, { appId: '111', valid: true, expiresAt: 0, scopes: ['whatsapp_business_management'], wabaIds: ['W1', 'W2'] })
    assertEquals(new URL(g.calls[0].url).searchParams.get('access_token'), '111|segredo')
  } finally {
    g.restore()
  }
})

Deno.test('conta: pagamento ok, pendente ou desconhecido conforme o primary_funding_id', async () => {
  const base: [number, unknown] = [200, { id: 'W1', name: 'Loja', currency: 'BRL', account_review_status: 'APPROVED' }]
  const owner: [number, unknown] = [200, { owner_business_info: { id: 'B1', name: 'Loja Ltda' } }]
  for (const [funding, expected] of [[[200, { primary_funding_id: 'F1' }], 'ok'], [[200, { id: 'W1' }], 'pending'], [[400, { error: { message: 'campo', code: 100 } }], 'unknown']] as const) {
    const g = fakeGraph([base, owner, funding as [number, unknown]])
    try {
      const w = await meta.wabaInfo('W1', 'TOKEN')
      assertEquals([w.name, w.businessId, w.businessName, w.payment], ['Loja', 'B1', 'Loja Ltda', expected])
    } finally {
      g.restore()
    }
  }
})

Deno.test('registro do número: PIN de 6 dígitos e erro de PIN reconhecido', async () => {
  for (let i = 0; i < 50; i++) assertMatch(meta.randomPin(), /^\d{6}$/)
  const g = fakeGraph([[400, { error: { message: 'Two step verification PIN Mismatch', code: 133005 } }]])
  try {
    const e = await assertRejects(() => meta.registerPhone('P1', 'TOKEN', '123456'), meta.MetaError)
    assertEquals(e.code, meta.PIN_MISMATCH)
    assertEquals(JSON.parse(g.calls[0].body!), { messaging_product: 'whatsapp', pin: '123456' })
    assertEquals(g.calls[0].auth, 'Bearer TOKEN')
    assertMatch(meta.friendlyMetaError(e), /PIN/)
  } finally {
    g.restore()
  }
})

Deno.test('erros da Meta viram mensagens sem jargão; token revogado é reconhecido', () => {
  const expired = new meta.MetaError('Error validating access token', 400, 190)
  assert(meta.isAuthError(expired))
  assertMatch(meta.friendlyMetaError(expired), /Conecte de novo/)
  assertMatch(meta.friendlyMetaError(new meta.MetaError('This authorization code has expired.', 400, 100, 36007)), /30 segundos/)
  assertMatch(meta.friendlyMetaError(new meta.MetaError('Permissions error', 403, 10)), /^O Vórtex CRM não recebeu permissão/)
  assert(!meta.isAuthError(new meta.MetaError('outro', 400, 100)))
  assertEquals(meta.paymentUrl('W1', 'B1'), 'https://business.facebook.com/wa/manage/home/?business_id=B1&waba_id=W1')
  assertEquals(meta.metaMissing(), [])
})

/* ---------- Modelos de mensagem (Configurações → Templates WhatsApp) ---------- */

const { templateDraft, templateRow, templateVars } = await import('../functions/_shared/templates.ts')

Deno.test('modelo: monta o pedido da Meta com os exemplos das variáveis', () => {
  assertEquals(templateVars('Olá {{1}}, pedido {{2}} e de novo {{1}}.'), [1, 2])
  const r = templateDraft({ name: 'confirmacao_pedido', category: 'utility', language: 'pt_BR', body: 'Olá {{1}}, seu pedido {{2}} foi confirmado.', examples: ['Ana', '1234'] })
  assert('draft' in r)
  assertEquals(r.draft.category, 'UTILITY')
  assertEquals(r.draft.components, [{ type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} foi confirmado.', example: { body_text: [['Ana', '1234']] } }])
  const plain = templateDraft({ name: 'boas_vindas', category: 'MARKETING', language: 'pt_BR', body: 'Bem-vindo à loja!' })
  assert('draft' in plain)
  assertEquals(plain.draft.components, [{ type: 'BODY', text: 'Bem-vindo à loja!' }])
})

Deno.test('modelo: recusa nome, categoria, variáveis e exemplos que a Meta não aceita', () => {
  const base = { name: 'aviso', category: 'UTILITY', language: 'pt_BR', body: 'Seu pedido saiu.' }
  const err = (over: Record<string, unknown>) => {
    const r = templateDraft({ ...base, ...over })
    return 'error' in r ? r.error : ''
  }
  assertMatch(err({ name: 'Aviso Pedido' }), /minúsculas/)
  assertMatch(err({ category: 'AUTHENTICATION' }), /Marketing ou Utilidade/)
  assertMatch(err({ language: 'fr_FR' }), /idioma/)
  assertMatch(err({ body: '  ' }), /Escreva/)
  assertMatch(err({ body: 'Olá {{2}}, tudo bem?', examples: ['x'] }), /sequência/)
  assertMatch(err({ body: '{{1}}, seu pedido saiu.', examples: ['Ana'] }), /começar nem terminar/)
  assertMatch(err({ body: 'Seu código é {{1}}.', examples: ['123'] }), /começar nem terminar/)
  assertMatch(err({ body: 'Olá {{1}}, seu pedido saiu.', examples: [''] }), /exemplo/)
})

Deno.test('modelo: o que a Meta devolve vira a linha da tela, com status em português e motivo da recusa', () => {
  const row = templateRow({ id: '991', name: 'confirmacao_pedido', language: 'pt_BR', category: 'UTILITY', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'HEADER', format: 'TEXT', text: 'Pedido' }, { type: 'BODY', text: 'Olá {{1}}' }] })
  assertEquals(row, { name: 'confirmacao_pedido', language: 'pt_BR', category: 'UTILITY', status: 'REJEITADO', body: 'Olá {{1}}', extra: { metaId: '991', rejectedReason: 'INVALID_FORMAT', header: { format: 'TEXT', text: 'Pedido' } } })
  assertEquals(templateRow({ id: '1', name: 'a', language: 'pt_BR', status: 'APPROVED', rejected_reason: 'NONE', components: [] }).extra.rejectedReason, '')
})

Deno.test('modelos na Graph API: lista seguindo as páginas e cria com o token da conta', async () => {
  const g = fakeGraph([
    [200, { data: [{ id: '1', name: 'a' }], paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next' } }],
    [200, { data: [{ id: '2', name: 'b' }], paging: { cursors: { after: 'CUR2' } } }],
    [200, { id: '77', status: 'PENDING', category: 'UTILITY' }],
  ])
  try {
    const list = await meta.listTemplates('WABA1', 'tok')
    assertEquals(list.map((t: any) => t.id), ['1', '2'])
    assertMatch(g.calls[0].url, /\/WABA1\/message_templates\?fields=id%2Cname%2Clanguage%2Ccategory%2Cstatus%2Ccomponents%2Crejected_reason&limit=100$/)
    assertMatch(g.calls[1].url, /after=CUR1/)
    assertEquals(g.calls[0].auth, 'Bearer tok')

    const created = await meta.createTemplate('WABA1', 'tok', { name: 'aviso', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Oi' }] })
    assertEquals(created.id, '77')
    assertEquals(g.calls[2].method, 'POST')
    assertMatch(g.calls[2].url, /\/WABA1\/message_templates$/)
    assertEquals(JSON.parse(g.calls[2].body!), { name: 'aviso', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Oi' }] })
  } finally {
    g.restore()
  }
})

/* ---------- Bloco Template WhatsApp dos fluxos (sendTemplate com variáveis) ---------- */

const wa = await import('../functions/_shared/whatsapp.ts')

Deno.test('template do fluxo: manda os valores de {{1}}, {{2}} na ordem; sem variáveis não manda components', async () => {
  const g = fakeGraph([[200, { messages: [{ id: 'wamid.1' }] }], [200, { messages: [{ id: 'wamid.2' }] }]])
  try {
    const creds = { phoneNumberId: 'P1', accessToken: 'tok' } as any
    assertEquals(await wa.sendTemplate('meta', creds, '+55 (00) 99921-2174', 'pedido_confirmado', 'pt_BR', { params: ['Ana', '1234'] }), 'wamid.1')
    assertMatch(g.calls[0].url, /\/P1\/messages$/)
    assertEquals(JSON.parse(g.calls[0].body!), {
      messaging_product: 'whatsapp', to: '5500999212174', type: 'template',
      template: { name: 'pedido_confirmado', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '1234' }] }] },
    })
    await wa.sendTemplate('meta', creds, '5500999212174', 'boas_vindas')
    assertEquals(JSON.parse(g.calls[1].body!).template, { name: 'boas_vindas', language: { code: 'pt_BR' } })
  } finally {
    g.restore()
  }
  assertEquals(wa.templateText('Olá, tudo bem {{1}}.\n\nPedido {{2}} confirmado.', ['Ana', '1234']), 'Olá, tudo bem Ana.\n\nPedido 1234 confirmado.')
  assertEquals(wa.templateText('Oi {{1}} e {{2}}', ['Ana']), 'Oi Ana e {{2}}')
})

/* ---------- Entrega que falhou: motivo da Meta ---------- */

const { deliveryErrorText } = await import('../functions/_shared/meta-webhook.ts')

Deno.test('entrega falhou: o webhook lê o motivo da Meta e o chat recebe o texto em português', () => {
  const body = { entry: [{ id: 'W1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P1' }, statuses: [
    { id: 'wamid.1', status: 'failed', errors: [{ code: 131042, title: 'Business eligibility payment issue', error_data: { details: 'Message failed to send because there were one or more errors related to your payment method.' } }] },
    { id: 'wamid.2', status: 'delivered' },
  ] } }] }] }
  const { statuses } = parseMeta(body)
  assertEquals(statuses[0].error?.code, 131042)
  assertEquals(statuses[1].error, null)
  assertMatch(deliveryErrorText(statuses[0].error!), /^Não entregue: falta forma de pagamento .* \(erro 131042\)$/)
  assertEquals(deliveryErrorText({ code: 999, title: 'Outro', details: 'Detalhe da Meta' }), 'Não entregue: Detalhe da Meta (erro 999)')
})
