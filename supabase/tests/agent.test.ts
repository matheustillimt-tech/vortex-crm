// Testes da lógica pura do agente de IA (sem banco nem rede).
// Rodar: npx deno test --no-lock supabase/tests/agent.test.ts  (com "nodeModulesDir": "none" se houver package.json acima)
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { agentConfig, blockReason, buildSystem, fieldKey, isOpen, noProgress, numberAllowed, offHoursText, splitReply } from '../functions/_shared/agent.ts'
import { audioSupport, chat, imageType, loadCreds, pickChatCred } from '../functions/_shared/ai.ts'
import { bancoFalso } from './banco-falso.ts'
import { motivoFalha, prometeuHumano, toWaiting } from '../functions/_shared/agent-core.ts'

const agentRow = (extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ id: 'a1', company_id: 'c1', name: 'Leo', active: true, connection_id: 'k1', extra, ...over })

Deno.test('balões: divide por linha em branco, junta o excesso e assina só o último', () => {
  assertEquals(splitReply('Oi!\n\nTudo bem?', true, ''), ['Oi!', 'Tudo bem?'])
  assertEquals(splitReply('Oi!\n\nTudo bem?', false, ''), ['Oi!\n\nTudo bem?'])
  assertEquals(splitReply('a\n\nb\n\nc\n\nd\n\ne', true, ''), ['a', 'b', 'c', 'd\n\ne'])
  assertEquals(splitReply('a\n\nb', true, 'Leo'), ['a', 'b\n— Leo'])
})

Deno.test('modo de teste: só responde aos números da lista (com e sem o nono dígito)', () => {
  const a = agentConfig(agentRow({ settings: { testNumbers: '+55 00 99999-8888, 5500912345678' } }))
  assert(numberAllowed(a, '+5500999998888'))
  assert(numberAllowed(a, '550099998888')) // sem o 9
  assert(numberAllowed(a, '+55 00 91234-5678'))
  assert(!numberAllowed(a, '+5500988887777'))
  assert(numberAllowed(agentConfig(agentRow()), '+5500988887777')) // lista vazia: todos
})

Deno.test('bloqueios: pausa, bot desligado, fluxo em andamento, agente pausado, módulo', () => {
  const mods = new Set(['agentes', 'chat', 'conexoes'])
  const a = agentConfig(agentRow())
  const chatOk = { bot_active: true, ai_paused: false, status: 'waiting', flow_state: {} }
  const contact = { phone: '+5500999999999' }
  assertEquals(blockReason(chatOk, a, mods, contact), null)
  assertMatch(blockReason({ ...chatOk, ai_paused: true, ai_pause_reason: 'humano' }, a, mods, contact)!, /pausada/)
  assertMatch(blockReason({ ...chatOk, bot_active: false }, a, mods, contact)!, /bot desligado/)
  assertMatch(blockReason({ ...chatOk, flow_state: { waiting: { type: 'menu' } } }, a, mods, contact)!, /fluxo/)
  assertMatch(blockReason(chatOk, agentConfig(agentRow({}, { active: false })), mods, contact)!, /pausado/)
  assertMatch(blockReason(chatOk, a, new Set(['chat', 'conexoes']), contact)!, /módulo/)
  assertMatch(blockReason(chatOk, null, mods, contact)!, /nenhum agente/)
})

Deno.test('horário comercial no fuso da empresa', () => {
  const hours = [
    { day: 'Segunda', open: true, from: '08:00', to: '18:00' }, { day: 'Terça', open: true, from: '08:00', to: '18:00' },
    { day: 'Quarta', open: true, from: '08:00', to: '18:00' }, { day: 'Quinta', open: true, from: '08:00', to: '18:00' },
    { day: 'Sexta', open: true, from: '08:00', to: '18:00' }, { day: 'Sábado', open: true, from: '09:00', to: '13:00' },
    { day: 'Domingo', open: false, from: '09:00', to: '13:00' },
  ]
  const tz = 'America/Sao_Paulo' // UTC-3
  assert(isOpen(hours, tz, new Date('2026-10-16T13:00:00Z'))) // sexta 10h
  assert(!isOpen(hours, tz, new Date('2026-10-16T22:00:00Z'))) // sexta 19h
  assert(!isOpen(hours, tz, new Date('2026-10-18T13:00:00Z'))) // domingo
  assert(isOpen([], tz, new Date())) // sem horário: sempre aberto
  assertMatch(offHoursText(hours, tz, new Date('2026-10-16T22:00:00Z')), /Voltamos amanhã às 09:00/)
  assertMatch(offHoursText(hours, tz, new Date('2026-10-18T13:00:00Z')), /Voltamos amanhã às 08:00/)
  assertMatch(offHoursText(hours, tz, new Date('2026-10-16T09:00:00Z')), /Voltamos hoje às 08:00/) // sexta 6h
})

Deno.test('nome do campo vira variável válida', () => {
  assertEquals(fieldKey('Nome'), 'nome')
  assertEquals(fieldKey('Produto de interesse'), 'produto_de_interesse')
  assertEquals(fieldKey('e-mail'), 'e_mail')
  assertEquals(fieldKey(''), '')
})

Deno.test('instruções levam regras, conhecimento, arquivos, dados e o contexto do contato', () => {
  const a = agentConfig(agentRow({
    does: 'vende o kit', rules: 'frete grátis acima de 197', forbidden: 'concorrente',
    knowledge: [{ id: 'k', title: 'Troca', content: 'Troca em 7 dias.' }],
    files: [{ id: 'f', name: 'tabela de preço', path: 'c1/a1/x.pdf', when: 'pedirem preço' }],
    fields: [{ id: 'x', desc: 'Nome do lead', field: 'nome' }, { id: 'y', desc: 'Cidade', field: 'cidade' }],
  }))
  const turn: any = { agent: a, company: { name: 'Loja X', timezone: 'America/Sao_Paulo' }, contact: { name: 'Ana', phone: '+55', fields: { cidade: 'BH' }, labels: [] }, refs: { labels: [] } }
  const s = buildSystem(turn, ['transferir_para_humano', 'salvar_dados', 'enviar_arquivo'])
  assertMatch(s, /Sua função: vende o kit/)
  assertMatch(s, /frete grátis acima de 197/)
  assertMatch(s, /Nunca fale sobre: concorrente/)
  assertMatch(s, /# Conhecimento[\s\S]*Troca em 7 dias/)
  assertMatch(s, /arquivo_1: tabela de preço — enviar quando: pedirem preço/)
  assertMatch(s, /Dados já salvos \(não pergunte de novo\): cidade = BH/)
  assertMatch(s, /Dados que ainda faltam: nome/)
  assertMatch(s, /"ok": true/)
})

Deno.test('provedor simulado: ações de teste, balões e resumo do contexto', async () => {
  const cred = { provider: 'simulado', apiKey: '', model: 'simulado', baseUrl: '', source: 'empresa' as const }
  const tools = [{ type: 'function' as const, function: { name: 'salvar_dados', description: '', parameters: {} } }]
  const r1 = await chat(cred, { messages: [{ role: 'system', content: '# Conhecimento' }, { role: 'user', content: 'meu nome é Ana #acao salvar_dados {"dados":{"nome":"Ana"}}' }], tools })
  assertEquals(r1.calls.map((c) => [c.name, c.args]), [['salvar_dados', { dados: { nome: 'Ana' } }]])
  const r2 = await chat(cred, { messages: [{ role: 'user', content: 'oi' }, r1.message, { role: 'tool', tool_call_id: r1.calls[0].id, content: '{"ok":true}' }] })
  assertMatch(r2.text, /Resultado das ações/)
  const r3 = await chat(cred, { messages: [{ role: 'system', content: '# Conhecimento' }, { role: 'user', content: 'oi' }, { role: 'user', content: 'tudo bem?' }] })
  assertMatch(r3.text, /Recebi: "oi \/ tudo bem\?" \(conhecimento: sim/)
  const r4 = await chat(cred, { messages: [{ role: 'user', content: '#baloes' }] })
  assertEquals(splitReply(r4.text, true, '').length, 3)
})

Deno.test('escolha da chave: a do agente, senão a primeira conectada', () => {
  const c = (provider: string) => ({ provider, apiKey: 'k', model: 'm', baseUrl: 'https://x', source: 'empresa' as const })
  assertEquals(pickChatCred({ gemini: c('gemini'), openai: c('openai') })?.provider, 'openai')
  assertEquals(pickChatCred({ gemini: c('gemini'), openai: c('openai') }, 'gemini')?.provider, 'gemini')
  assertEquals(pickChatCred({ compat: c('compat') }, 'openai')?.provider, 'compat')
})

Deno.test('sem avanço: 3 áudios seguidos não são "mensagem repetida"; texto e transcrição repetidos são', () => {
  const audio = (transcript?: string) => ({ sender: 'contact', type: 'audio', text: '🎤 Áudio', extra: transcript ? { transcript } : {} })
  const texto = (text: string) => ({ sender: 'contact', type: 'text', text, extra: {} })
  assert(!noProgress([audio(), audio(), audio()]))
  assert(!noProgress([{ sender: 'contact', type: 'image', text: '📷 Imagem', extra: {} }, audio(), audio()]))
  assert(noProgress([texto('não recebi o acesso'), texto('Não recebi o acesso!'), texto('não recebi o acesso')]))
  assert(noProgress([audio('cadê o link do grupo'), texto('cadê o link do grupo'), audio('Cadê o link do grupo?')]))
  const ia = (text: string) => ({ sender: 'bot', type: 'text', text, extra: { agentId: 'a1' } })
  assert(noProgress([ia('Não entendi o áudio'), ia('Não entendi o áudio'), ia('não entendi o áudio')]))
})

Deno.test('chave da plataforma: só para empresa com a carteira de IA ativa', async () => {
  const env = { AI_PROVIDER: 'gemini', AI_API_KEY: 'chave-vortex', ELEVENLABS_API_KEY: 'eleven-vortex' }
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v)
  try {
    const { admin } = bancoFalso({ ai_credentials: [], ai_wallets: [{ company_id: 'c1', active: true }, { company_id: 'c2', active: false }] })
    const ativa = await loadCreds(admin, 'c1')
    assertEquals(pickChatCred(ativa)?.source, 'plataforma')
    assertEquals(pickChatCred(ativa)?.provider, 'gemini')
    assert(audioSupport(ativa).hear)
    for (const empresa of ['c2', 'c3']) { // carteira desligada e empresa sem carteira
      const creds = await loadCreds(admin, empresa)
      assertEquals(pickChatCred(creds), null)
      assert(!audioSupport(creds).hear)
    }
    // a chave própria da empresa continua valendo sem carteira
    const { admin: outro } = bancoFalso({ ai_credentials: [{ company_id: 'c3', provider: 'openai', api_key: 'k', model: '', base_url: '' }], ai_wallets: [] })
    assertEquals(pickChatCred(await loadCreds(outro, 'c3'))?.source, 'empresa')
  } finally {
    for (const k of Object.keys(env)) Deno.env.delete(k)
  }
})

Deno.test('adaptador OpenAI/Gemini: pedido no formato chat/completions, ferramentas e erros', async () => {
  const real = globalThis.fetch
  const seen: any[] = []
  let status = 200
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) })
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status })
    return new Response(JSON.stringify({
      model: 'gemini-x', usage: { prompt_tokens: 12, completion_tokens: 3 },
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'transferir_para_humano', arguments: '{"motivo":"pediu"}' } }] } }],
    }), { status: 200 })
  }) as typeof fetch
  try {
    const cred = { provider: 'gemini', apiKey: 'chave', model: '', baseUrl: '', source: 'empresa' as const }
    const tools = [{ type: 'function' as const, function: { name: 'transferir_para_humano', description: 'x', parameters: { type: 'object' } } }]
    const r = await chat(cred, { messages: [{ role: 'user', content: 'quero um humano' }], tools })
    assertEquals(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    assertEquals((seen[0].headers as any).Authorization, 'Bearer chave')
    assertEquals(seen[0].body.model, 'gemini-2.5-flash')
    assertEquals(seen[0].body.tool_choice, 'auto')
    assertEquals(seen[0].body.max_tokens, undefined) // corpo mínimo, aceito por todos os provedores
    assertEquals(r.calls, [{ id: 'c1', name: 'transferir_para_humano', args: { motivo: 'pediu' } }])
    assertEquals(r.usage, { input: 12, output: 3, cached: undefined, cost: null })
    status = 401
    let err: any = null
    try { await chat({ ...cred, provider: 'openai' }, { messages: [{ role: 'user', content: 'oi' }] }) } catch (e) { err = e }
    assertEquals(err?.kind, 'auth')
    assertEquals(seen[1].url, 'https://api.openai.com/v1/chat/completions')
  } finally {
    globalThis.fetch = real
  }
})

Deno.test('tipo de imagem pelos bytes', () => {
  assertEquals(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assertEquals(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png')
  assertEquals(imageType(new Uint8Array([1, 2, 3, 4])), null)
})

/* ---------- A IA não resolveu: a conversa vai para Aguardando ---------- */

Deno.test('instruções: sem resposta no conhecimento ou sem solução, transfere (não só oferece)', () => {
  const a = agentConfig(agentRow())
  const turn: any = { agent: a, company: { name: 'Loja X' }, contact: { labels: [] }, refs: { labels: [] } }
  const s = buildSystem(turn, ['transferir_para_humano'])
  assertMatch(s, /não conseguir resolver o que o cliente pediu, use transferir_para_humano/)
  assertMatch(s, /quando a resposta não estiver nas instruções nem no conhecimento/)
  assert(!/ofereça passar para um atendente/.test(s))
})

Deno.test('promessa de atendente sem transferir é reconhecida; resposta comum não', () => {
  for (const t of [
    'Vou te passar para um atendente, só um instante.',
    'Um momento, vou transferir você para nossa equipe.',
    'Nossa equipe vai te responder por aqui em breve.',
    'O responsável vai entrar em contato com você.',
    'Vou verificar com a equipe e já te retorno.',
    'Vou confirmar com o gerente e te aviso.',
  ]) assert(prometeuHumano(t), t)
  for (const t of [
    'O kit custa R$ 197 com frete grátis.',
    'Seu horário está marcado para amanhã às 10h. Nossa equipe vai adorar te receber!',
    'Pode me passar seu nome completo?',
    'Vou te mandar a tabela de preços.',
  ]) assert(!prometeuHumano(t), t)
})

Deno.test('motivo da falha da IA em português para a equipe', () => {
  assertEquals(motivoFalha('400 {"type":"error","error":{"message":"Your credit balance is too low"}}'), 'sem crédito na conta da IA')
  assertEquals(motivoFalha('401 invalid x-api-key'), 'a chave da IA foi recusada')
  assertEquals(motivoFalha('429 rate_limit_error'), 'limite de uso da IA atingido')
  assertEquals(motivoFalha('529 overloaded_error'), 'o provedor da IA está instável')
  assertEquals(motivoFalha('Request timed out'), 'a resposta demorou demais')
  assertEquals(motivoFalha(''), 'erro inesperado')
})

Deno.test('para Aguardando: marca o motivo, pausa só na transferência e não repete a nota', async () => {
  const banco: any = { chat: { id: 'ch1', company_id: 'c1', status: 'attending', ai_state: { day: 'x' } }, notas: [] as string[] }
  const admin = {
    from: (t: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { status: banco.chat.status, ai_state: banco.chat.ai_state } }) }) }),
      update: (patch: any) => ({ eq: async () => { Object.assign(banco.chat, patch); return { error: null } } }),
      insert: async (row: any) => { if (t === 'messages') banco.notas.push(row.text); return { error: null } },
    }),
  }
  const chat = { ...banco.chat }
  await toWaiting(admin, chat, 'sem crédito', { textOnce: 'nota 1' })
  assertEquals(banco.chat.status, 'waiting')
  assertEquals(banco.chat.ai_state.day, 'x')
  assertEquals(banco.chat.ai_state.precisaHumano.motivo, 'sem crédito')
  assertEquals(banco.chat.ai_paused, undefined)
  await toWaiting(admin, chat, 'sem crédito de novo', { textOnce: 'nota 2' })
  assertEquals(banco.notas, ['nota 1'])
  await toWaiting(admin, chat, 'pediu humano', { pause: true, text: 'transferiu' })
  assertEquals([banco.chat.ai_paused, banco.chat.ai_pause_reason], [true, 'transferido'])
  assertEquals(banco.notas, ['nota 1', 'transferiu'])
})
