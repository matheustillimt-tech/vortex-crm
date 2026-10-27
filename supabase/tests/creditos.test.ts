// Créditos de IA: preço e custo (carteira.ts), medição nas chamadas (ai.ts), aviso da Vórtex Pay (pagamento-vortexpay.ts)
// e a escolha da recarga (recarga.ts). O saldo em si (reserva, desconto, recarga, concorrência) é testado no banco.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/creditos.test.ts
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { comCreditos, custoUsd, estimarEntrada, exigirSaldo, limparCachePrecos, medidor, modeloBase, precoDo, SemCreditos } from '../functions/_shared/carteira.ts'
import { chat, duracaoOgg, usageOf, type AiCred } from '../functions/_shared/ai.ts'
import { assinaturaConfere, lerAviso, linkComRef, pedidoConfirmado, refDoAviso, valorDoAviso } from '../functions/_shared/pagamento-vortexpay.ts'
import { avisoDoPlano, escolherRecarga } from '../functions/_shared/recarga.ts'

const PRECOS = [
  { model: 'gemini-2.5-flash', unit: 'input_mtok', usd: 0.30 }, { model: 'gemini-2.5-flash', unit: 'output_mtok', usd: 2.50 },
  { model: 'gemini-2.5-flash', unit: 'audio_input_mtok', usd: 1.00 }, { model: 'gemini-2.5-flash-lite', unit: 'input_mtok', usd: 0.10 },
  { model: 'scribe_v2', unit: 'stt_hour', usd: 0.22 }, { model: 'eleven_multilingual_v2', unit: 'tts_kchar', usd: 0.08 },
  { model: '*', unit: 'input_mtok', usd: 1 }, { model: '*', unit: 'output_mtok', usd: 5 },
]
const tabela = () => { const t: any = {}; for (const r of PRECOS) (t[r.model] ||= {})[r.unit] = r.usd; return t }
const perto = (a: number, b: number) => Math.abs(a - b) < 1e-12

Deno.test('preço do modelo: nome do gateway, versões novas e o preço de segurança', () => {
  assertEquals(modeloBase('google/gemini-2.5-flash'), 'gemini-2.5-flash')
  assertEquals(precoDo(tabela(), 'google/gemini-2.5-flash').preco.input_mtok, 0.30)
  assertEquals(precoDo(tabela(), 'gemini-2.5-flash-lite').preco.input_mtok, 0.10) // o mais específico ganha
  assertEquals(precoDo(tabela(), 'gemini-2.5-flash-preview-09-2025').preco.output_mtok, 2.50)
  const x = precoDo(tabela(), 'modelo-novo-sem-preco')
  assert(x.padrao && x.preco.output_mtok === 5)
})

Deno.test('custo em dólar: entrada, áudio, saída, transcrição e voz', () => {
  // atendimento de exemplo: 9.365 tokens de entrada e 188 de saída
  assert(perto(custoUsd(tabela(), 'google/gemini-2.5-flash', { entrada: 9365, saida: 188 }).usd, 9365 / 1e6 * 0.30 + 188 / 1e6 * 2.50))
  // áudio dentro da entrada tem preço próprio; cache sem preço cadastrado vale como entrada comum
  assert(perto(custoUsd(tabela(), 'gemini-2.5-flash', { entrada: 1000, audioEntrada: 400, cache: 100 }).usd, 500 / 1e6 * 0.30 + 100 / 1e6 * 0.30 + 400 / 1e6 * 1.00))
  assert(perto(custoUsd(tabela(), 'scribe_v2', { segundos: 90 }).usd, 0.22 * 90 / 3600))
  assert(perto(custoUsd(tabela(), 'eleven_multilingual_v2', { caracteres: 250 }).usd, 0.08 * 0.25))
})

Deno.test('estimativa de entrada: imagem conta 1.500 tokens, não o tamanho do base64', () => {
  const foto = 'data:image/jpeg;base64,' + 'A'.repeat(2_000_000)
  const est = estimarEntrada([{ role: 'system', content: 'x'.repeat(3200) }, { role: 'user', content: [{ type: 'text', text: 'oi' }, { type: 'image_url', image_url: { url: foto } }] }])
  assert(est > 1500 && est < 3000, String(est))
})

Deno.test('uso do provedor: raciocínio entra na saída (Google conta só no total; gateways já somam)', () => {
  assertEquals(usageOf({ prompt_tokens: 9000, completion_tokens: 60, total_tokens: 9800 }).output, 800) // Google: 740 de raciocínio
  assertEquals(usageOf({ prompt_tokens: 9000, completion_tokens: 800, total_tokens: 9800 }).output, 800) // OpenRouter
  assertEquals(usageOf({ prompt_tokens: 10, completion_tokens: 2, cost: 0.000123 }).cost, 0.000123)
  assertEquals(usageOf({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }).cached, 4)
  assertEquals(usageOf(undefined), { input: 0, output: 0, cached: undefined, cost: null })
})

// Ogg/Opus mínimo: página com OpusHead (pre-skip 312) e a última página com a posição em amostras de 48 kHz
function ogg(segundos: number) {
  const b = new Uint8Array(200)
  b.set([0x4f, 0x67, 0x67, 0x53], 0)
  b.set(new TextEncoder().encode('OpusHead'), 28)
  b[38] = 312 & 0xff; b[39] = 312 >> 8
  const fim = 120
  b.set([0x4f, 0x67, 0x67, 0x53], fim)
  let g = Math.round(segundos * 48000) + 312
  for (let k = 0; k < 8; k++) { b[fim + 6 + k] = g % 256; g = Math.floor(g / 256) }
  return b
}
Deno.test('duração da voz do WhatsApp lida do arquivo (Ogg/Opus)', () => {
  assertEquals(duracaoOgg(ogg(12.5)), 12.5)
  assertEquals(duracaoOgg(new TextEncoder().encode('ID3 mp3 qualquer'.padEnd(80))), null)
})

// banco de mentira: preços + rpc das funções da carteira, guardando as chamadas
function banco(reserva: any = { ok: true, id: 'r1' }) {
  const rpcs: { fn: string; args: any }[] = []
  const admin = {
    from: () => ({ select: () => Promise.resolve({ data: PRECOS, error: null }) }),
    rpc: (fn: string, args: any) => { rpcs.push({ fn, args }); return Promise.resolve({ data: fn === 'ai_wallet_reserve' ? reserva : fn === 'ai_wallet_available' ? reserva : { ok: true }, error: null }) },
  }
  return { admin, rpcs }
}
const op = { provedor: 'compat', modelo: 'google/gemini-2.5-flash', modalidade: 'texto' as const, descricao: 'Resposta da IA', estimativa: { entrada: 10_000, saida: 2500 } }
const AG = '11111111-2222-4333-8444-555555555555'

Deno.test('com saldo: reserva pela estimativa, chama e desconta o consumo apurado', async () => {
  limparCachePrecos()
  const { admin, rpcs } = banco()
  const v = await comCreditos(medidor(admin, 'emp', { agentId: AG, chatId: 'rascunho' }), op, async () => ({ valor: 'oi', uso: { entrada: 9000, saida: 60 } }))
  assertEquals(v, 'oi')
  assertEquals(rpcs.map((r) => r.fn), ['ai_wallet_reserve', 'ai_wallet_settle'])
  assert(perto(rpcs[0].args.p_cost_usd, 10_000 / 1e6 * 0.30 + 2500 / 1e6 * 2.50))
  assert(perto(rpcs[1].args.p_cost_usd, 9000 / 1e6 * 0.30 + 60 / 1e6 * 2.50))
  assertEquals(rpcs[1].args.p_info.agentId, AG)
  assertEquals(rpcs[1].args.p_info.chatId, null) // id que não é do banco não vai para o extrato
})

Deno.test('custo informado pelo gateway vale no lugar da tabela', async () => {
  limparCachePrecos()
  const { admin, rpcs } = banco()
  await comCreditos(medidor(admin, 'emp'), op, async () => ({ valor: 1, uso: { entrada: 9000, saida: 60, custoUsd: 0.0031 } }))
  assertEquals(rpcs[1].args.p_cost_usd, 0.0031)
  assertEquals(rpcs[1].args.p_info.uso.custoInformado, true)
})

Deno.test('sem saldo: não chama o provedor', async () => {
  limparCachePrecos()
  const { admin, rpcs } = banco({ ok: false, motivo: 'saldo_insuficiente', disponivel: 0.4 })
  let chamou = false
  await assertRejects(() => comCreditos(medidor(admin, 'emp'), op, async () => { chamou = true; return { valor: 1, uso: {} } }), SemCreditos)
  assertEquals(chamou, false)
  assertEquals(rpcs.map((r) => r.fn), ['ai_wallet_reserve'])
})

Deno.test('provedor falhou: devolve a reserva e não desconta', async () => {
  limparCachePrecos()
  const { admin, rpcs } = banco()
  await assertRejects(() => comCreditos(medidor(admin, 'emp'), op, async () => { throw new Error('HTTP 500') }), Error, 'HTTP 500')
  assertEquals(rpcs.map((r) => r.fn), ['ai_wallet_reserve', 'ai_wallet_release'])
})

Deno.test('antes do turno: saldo zerado ou carteira desligada param a IA', async () => {
  await assertRejects(() => exigirSaldo(medidor(banco({ modo: 'prepago', disponivel: 0 }).admin, 'emp')), SemCreditos)
  await assertRejects(() => exigirSaldo(medidor(banco(null).admin, 'emp')), SemCreditos)
  await exigirSaldo(medidor(banco({ modo: 'prepago', disponivel: 3.2 }).admin, 'emp'))
  await exigirSaldo(medidor(banco({ modo: 'interno', disponivel: -50 }).admin, 'emp'))
})

Deno.test('chat com a chave da plataforma passa pela carteira; com a da empresa, não', async () => {
  limparCachePrecos()
  const original = globalThis.fetch
  const corpos: any[] = []
  globalThis.fetch = (async (_url: any, init: any) => {
    corpos.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ model: 'google/gemini-2.5-flash', choices: [{ message: { content: 'Olá!' } }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920, cost: 0.0003 } }), { status: 200 })
  }) as typeof fetch
  try {
    const { admin, rpcs } = banco()
    const base: AiCred = { provider: 'compat', apiKey: 'k', model: 'google/gemini-2.5-flash', baseUrl: 'https://openrouter.ai/api/v1', source: 'plataforma' }
    const r = await chat({ ...base, medidor: medidor(admin, 'emp') }, { messages: [{ role: 'user', content: 'oi' }] })
    assertEquals(r.text, 'Olá!')
    assertEquals(rpcs.map((x) => x.fn), ['ai_wallet_reserve', 'ai_wallet_settle'])
    assertEquals(rpcs[1].args.p_cost_usd, 0.0003)
    assertEquals(corpos[0].usage, { include: true }) // OpenRouter: pede o custo da chamada
    const antes = rpcs.length
    await chat({ ...base, source: 'empresa', baseUrl: 'https://api.openai.com/v1' }, { messages: [{ role: 'user', content: 'oi' }] })
    assertEquals(rpcs.length, antes)
    assertEquals(corpos[1].usage, undefined)
  } finally {
    globalThis.fetch = original
  }
})

/* ---------- Vórtex Pay ---------- */

const SEGREDO = 'segredo-de-teste'
const assinar = async (s: string, segredo = SEGREDO) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, '0')).join('')
}
const compra = (mais: Record<string, unknown> = {}) => ({
  webhook_event_type: 'compra_aprovada', order_id: 'cmped0001', order_status: 'paid', payment_method: 'pix',
  Customer: { email: ' Dono@LojaExemplo.com ', full_name: 'Marina' }, Product: { product_id: 'prodcreditos' }, ...mais,
})

Deno.test('assinatura do aviso: HMAC-SHA256 do corpo; sem segredo ou errada, recusa', async () => {
  const corpo = JSON.stringify(compra(), null, 2)
  const bytes = new TextEncoder().encode(corpo)
  assert(await assinaturaConfere(bytes, await assinar(corpo), SEGREDO))
  assert(await assinaturaConfere(bytes, 'sha256=' + await assinar(corpo), SEGREDO))
  assert(await assinaturaConfere(bytes, await assinar(JSON.stringify(JSON.parse(corpo))), SEGREDO))
  assert(!(await assinaturaConfere(bytes, await assinar(corpo, 'outro'), SEGREDO)))
  assert(!(await assinaturaConfere(bytes, await assinar(corpo), '')))
  assert(!(await assinaturaConfere(bytes, null, SEGREDO)))
  assert(!(await assinaturaConfere(new TextEncoder().encode(corpo + 'x'), await assinar(corpo), SEGREDO)))
})

Deno.test('leitura do aviso: pago, estorno, teste e o resto ignorado', () => {
  assertEquals(lerAviso(compra()), { acao: 'pago', pedido: 'cmped0001', produto: 'prodcreditos', email: 'dono@lojaexemplo.com', ref: null, valorCentavos: null })
  assertEquals(lerAviso(compra({ webhook_event_type: 'compra_reembolsada', order_status: 'refunded' })).acao, 'estorno')
  assertEquals(lerAviso(compra({ webhook_event_type: 'chargeback' })).acao, 'estorno')
  assertEquals(lerAviso(compra({ order_id: 'test_123' })).acao, 'ignorar')
  assertEquals(lerAviso(compra({ webhook_event_type: 'pix_gerado', order_status: 'waiting_payment' })).acao, 'ignorar')
  assertEquals(lerAviso(compra({ order_status: 'waiting_payment' })).acao, 'ignorar') // aprovada mas não paga
  assertEquals(lerAviso(compra({ order_id: 'a/b' })).acao, 'invalido')
  assertEquals(lerAviso(compra({ Product: {} })).acao, 'invalido')
  assertEquals(lerAviso('texto').acao, 'invalido')
})

Deno.test('código da recarga e valor no aviso', () => {
  assertEquals(refDoAviso(compra({ TrackingParameters: { src: 'cr0123456789ab' } })), 'CR0123456789AB')
  assertEquals(refDoAviso(compra({ TrackingParameters: { sck: 'CR0123456789AB' } })), 'CR0123456789AB')
  assertEquals(refDoAviso(compra({ TrackingParameters: { src: 'instagram' } })), null)
  assertEquals(valorDoAviso(compra({ Commissions: { charge_amount: 30000 } })), 30000)
  assertEquals(valorDoAviso(compra({ Commissions: { charge_amount: '30000' } })), 30000)
  assertEquals(valorDoAviso(compra({ order_amount: '300.00' })), null) // campo de unidade incerta: confere na API
  assertEquals(linkComRef('https://pay.exemplo.com.br/c/x/y?a=1', 'CR0123456789AB'), 'https://pay.exemplo.com.br/c/x/y?a=1&src=CR0123456789AB&sck=CR0123456789AB&utm_content=CR0123456789AB')
})

Deno.test('conferência do pedido na API da Vórtex Pay', () => {
  const lista = [{ id: 'cmped0001', status: 'paid', totalCentavos: 30000 }, { id: 'outro', status: 'pending', totalCentavos: 30000 }]
  assertEquals(pedidoConfirmado(lista, 'cmped0001', 30000), 'pago')
  assertEquals(pedidoConfirmado(lista, 'cmped0001', 50000), 'valor_menor')
  assertEquals(pedidoConfirmado(lista, 'outro', 30000), 'nao_pago')
  assertEquals(pedidoConfirmado(lista, 'sumiu', 30000), 'nao_achado')
  assertEquals(pedidoConfirmado(null, 'x', 1), 'nao_achado')
})

const rec = (id: string, price: number, status = 'pendente', at = '2026-10-26T10:00:00Z') => ({ id, ref: 'CR' + id.padEnd(12, '0').toUpperCase(), price_cents: price, status, buyer_email: 'dono@lojaexemplo.com', created_at: at })
Deno.test('qual recarga o pagamento paga', () => {
  const porRef = rec('a', 30000)
  assertEquals(escolherRecarga({ ref: porRef.ref, email: 'x', valorCentavos: null }, porRef, []).recarga?.id, 'a')
  assertEquals(escolherRecarga({ ref: 'CR000000000000', email: 'dono@lojaexemplo.com', valorCentavos: null }, null, [rec('b', 1)]).recarga, null) // código que não existe não cai no e-mail
  const duas = [rec('b', 10000, 'pendente', '2026-10-26T09:00:00Z'), rec('c', 30000, 'pendente', '2026-10-26T08:00:00Z'), rec('d', 30000, 'pendente', '2026-10-26T09:30:00Z')]
  assertEquals(escolherRecarga({ ref: null, email: 'dono@lojaexemplo.com', valorCentavos: 30000 }, null, duas).recarga?.id, 'c') // mesmo valor, a mais antiga
  assertEquals(escolherRecarga({ ref: null, email: 'dono@lojaexemplo.com', valorCentavos: null }, null, duas).recarga, null) // sem valor e várias: à mão
  assertEquals(escolherRecarga({ ref: null, email: 'dono@lojaexemplo.com', valorCentavos: null }, null, [rec('e', 5000)]).recarga?.id, 'e')
  assertEquals(escolherRecarga({ ref: null, email: 'dono@lojaexemplo.com', valorCentavos: 99 }, null, [rec('e', 5000)]).recarga, null)
  assertEquals(escolherRecarga({ ref: null, email: 'dono@lojaexemplo.com', valorCentavos: 5000 }, null, [rec('f', 5000, 'paga')]).recarga, null) // paga não recebe de novo
})

Deno.test('aviso do plano ou da recarga', () => {
  assertEquals(refDoAviso(compra({ TrackingParameters: { src: 'as0123456789ab' } })), 'AS0123456789AB')
  assertEquals(refDoAviso(compra({ TrackingParameters: { src: 'XX0123456789AB' } })), null)
  // produtos separados: o produto decide
  assertEquals(avisoDoPlano({ produto: 'plano', ref: null }, 'plano', 'creditos'), true)
  assertEquals(avisoDoPlano({ produto: 'creditos', ref: null }, 'plano', 'creditos'), false)
  assertEquals(avisoDoPlano({ produto: 'plano', ref: 'CR0123456789AB' }, 'plano', 'creditos'), false) // código de recarga no produto do plano: não ativa
  assertEquals(avisoDoPlano({ produto: 'plano', ref: null }, '', 'creditos'), false) // plano sem produto configurado
  // mesmo produto: o código decide; sem código, recarga (como antes)
  assertEquals(avisoDoPlano({ produto: 'p', ref: 'AS0123456789AB' }, 'p', 'p'), true)
  assertEquals(avisoDoPlano({ produto: 'p', ref: 'CR0123456789AB' }, 'p', 'p'), false)
  assertEquals(avisoDoPlano({ produto: 'p', ref: null }, 'p', 'p'), false)
  // a escolha da cobrança do plano usa a mesma regra, com o nome no motivo
  assertEquals(escolherRecarga({ ref: 'AS000000000000', email: null, valorCentavos: null }, null, [], { um: 'cobrança do plano', varios: 'cobranças do plano', nenhum: 'nenhuma cobrança do plano' }).motivo, 'nenhuma cobrança do plano com o código AS000000000000')
})
