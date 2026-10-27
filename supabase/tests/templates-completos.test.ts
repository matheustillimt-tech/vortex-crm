// Templates com cabeçalho (texto, imagem, vídeo, documento), rodapé e botões: regras, componentes da Meta, upload do
// arquivo do cabeçalho e envio com a mídia. A Graph API é simulada trocando o fetch.
// Rodar: npx deno test -A --no-lock --node-modules-dir=none supabase/tests/templates-completos.test.ts
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { mergeTemplateExtra, templateComponents, templateDraft, templateRow } from '../functions/_shared/templates.ts'

Deno.env.set('META_APP_ID', '111')
const meta = await import('../functions/_shared/meta.ts')
const wa = await import('../functions/_shared/whatsapp.ts')

function fakeGraph(responses: [number, unknown][]) {
  const calls: { url: string; method: string; auth: string | null; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const [status, body] = responses.shift() ?? [500, { error: { message: 'sem resposta' } }]
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), method: init?.method || 'GET', auth: headers.get('Authorization'), body: typeof init?.body === 'string' ? init.body : null })
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const BANNER = 'https://x.supabase.co/storage/v1/object/public/template-media/emp/banner.jpg'

Deno.test('modelo completo: cabeçalho de imagem, rodapé e botões viram os componentes da Meta', () => {
  const r = templateDraft({
    name: 'promo_semana', category: 'MARKETING', language: 'pt_BR', body: 'Oi {{1}}, a promoção começou!', examples: ['Ana'],
    header: { format: 'image', mediaUrl: BANNER },
    footer: 'Vórtex CRM',
    buttons: [
      { type: 'URL', text: 'Ver ofertas', url: 'https://loja.com.br/ofertas' },
      { type: 'QUICK_REPLY', text: 'Quero' },
      { type: 'PHONE_NUMBER', text: 'Ligar', phone: '+55 (00) 99999-0000' },
    ],
  })
  assert('draft' in r)
  assertEquals(r.draft.header, { format: 'IMAGE', mediaUrl: BANNER })
  // respostas rápidas vão na frente; o telefone fica só com dígitos e +
  assertEquals(r.draft.buttons.map((b) => b.type), ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'])
  assertEquals(templateComponents(r.draft, 'HANDLE1'), [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE1'] } },
    { type: 'BODY', text: 'Oi {{1}}, a promoção começou!', example: { body_text: [['Ana']] } },
    { type: 'FOOTER', text: 'Vórtex CRM' },
    {
      type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Quero' },
        { type: 'URL', text: 'Ver ofertas', url: 'https://loja.com.br/ofertas' },
        { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5500999990000' },
      ],
    },
  ])
  const txt = templateDraft({ name: 'aviso', category: 'UTILITY', language: 'pt_BR', body: 'Seu pedido saiu.', header: { format: 'TEXT', text: 'Pedido a caminho' } })
  assert('draft' in txt)
  assertEquals(txt.draft.components[0], { type: 'HEADER', format: 'TEXT', text: 'Pedido a caminho' })
})

Deno.test('modelo completo: recusa cabeçalho sem arquivo, botões demais e textos longos', () => {
  const base = { name: 'aviso', category: 'UTILITY', language: 'pt_BR', body: 'Seu pedido saiu.' }
  const err = (over: Record<string, unknown>) => {
    const r = templateDraft({ ...base, ...over })
    return 'error' in r ? r.error : ''
  }
  assertMatch(err({ header: { format: 'VIDEO' } }), /arquivo do cabeçalho/)
  assertMatch(err({ header: { format: 'TEXT', text: 'Olá {{1}}' } }), /não aceita variáveis/)
  assertMatch(err({ footer: 'x'.repeat(61) }), /rodapé tem no máximo 60/)
  assertMatch(err({ buttons: [{ type: 'QUICK_REPLY', text: 'Um texto grande demais para botão' }] }), /no máximo 25/)
  assertMatch(err({ buttons: [{ type: 'URL', text: 'Site', url: 'loja' }] }), /link completo/)
  assertMatch(err({ buttons: [{ type: 'PHONE_NUMBER', text: 'Ligar', phone: '1234' }] }), /DDI e DDD/)
  assertMatch(err({ buttons: [1, 2, 3].map((i) => ({ type: 'URL', text: `L${i}`, url: `https://a.com/${i}` })) }), /no máximo 2 botões de link/)
  assertMatch(err({ buttons: Array.from({ length: 11 }, (_, i) => ({ type: 'QUICK_REPLY', text: `B${i}` })) }), /no máximo 10 botões/)
})

Deno.test('sincronizar: cabeçalho, rodapé e botões vêm da Meta e o arquivo enviado pelo painel continua', () => {
  const row = templateRow({
    id: '5', name: 'promo', language: 'pt_BR', status: 'APPROVED', components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent/temporario.jpg'] } },
      { type: 'BODY', text: 'Oi' }, { type: 'FOOTER', text: 'Rodapé' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero' }, { type: 'URL', text: 'Site', url: 'https://a.com' }] },
    ],
  })
  assertEquals(row.extra.header, { format: 'IMAGE' })
  assertEquals(row.extra.buttons, [{ type: 'QUICK_REPLY', text: 'Quero' }, { type: 'URL', text: 'Site', url: 'https://a.com' }])
  const merged = mergeTemplateExtra({ examples: ['x'], header: { format: 'IMAGE', mediaUrl: 'https://meu/arquivo.jpg' }, footer: 'antigo' }, row.extra)
  assertEquals(merged.header, { format: 'IMAGE', mediaUrl: 'https://meu/arquivo.jpg' })
  assertEquals(merged.footer, 'Rodapé')
  assertEquals(merged.examples, ['x'])
  // o cabeçalho mudou de tipo na Meta: o arquivo antigo não vale mais; o rodapé removido lá também sai daqui
  const video = templateRow({ id: '5', name: 'promo', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Oi' }] })
  const outro = mergeTemplateExtra({ header: { format: 'IMAGE', mediaUrl: 'https://meu/arquivo.jpg' }, footer: 'antigo' }, video.extra)
  assertEquals(outro.header, { format: 'VIDEO' })
  assertEquals(outro.footer, undefined)
})

Deno.test('upload do cabeçalho: abre a sessão no app e manda os bytes; o envio leva o link da mídia', async () => {
  const g = fakeGraph([[200, { id: 'upload:SESS1' }], [200, { h: 'HANDLE-XYZ' }], [200, { messages: [{ id: 'wamid.9' }] }]])
  try {
    assertEquals(await meta.uploadForTemplate('tok', new Uint8Array([1, 2, 3, 4]), 'image/jpeg', 'banner.jpg'), 'HANDLE-XYZ')
    assertMatch(g.calls[0].url, /\/111\/uploads\?file_name=banner\.jpg&file_length=4&file_type=image%2Fjpeg$/)
    assertEquals(g.calls[0].method, 'POST')
    assertMatch(g.calls[1].url, /\/upload:SESS1$/)
    assertEquals(g.calls[1].auth, 'OAuth tok')

    await wa.sendTemplate('meta', { phoneNumberId: 'P1', accessToken: 'tok' } as any, '5500999990000', 'promo', 'pt_BR',
      { params: ['Ana'], header: { format: 'IMAGE', link: 'https://meu/arquivo.jpg' } })
    assertEquals(JSON.parse(g.calls[2].body!).template.components, [
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://meu/arquivo.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
    ])
  } finally {
    g.restore()
  }
})
