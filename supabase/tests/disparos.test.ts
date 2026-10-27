// Disparos em massa: o que o flow-tick faz com cada disparo em andamento (supabase/functions/_shared/disparos.ts).
// Rodar: npx deno test -A --no-lock --node-modules-dir=none supabase/tests/disparos.test.ts
import { assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { dispatchStep } from '../functions/_shared/disparos.ts'

const agora = Date.parse('2026-10-23T18:40:00Z')
const base = { contacts: ['c1', 'c2', 'c3'], sent: 0, interval: 10, extra: {} }

Deno.test('disparo: manda para o próximo contato da lista, na ordem', () => {
  assertEquals(dispatchStep(base, agora), { action: 'send', contactId: 'c1' })
  assertEquals(dispatchStep({ ...base, sent: 2 }, agora), { action: 'send', contactId: 'c3' })
})

Deno.test('disparo: espera o intervalo desde o último envio (mínimo de 5 s)', () => {
  const recente = { ...base, sent: 1, extra: { lastAt: new Date(agora - 4000).toISOString() } }
  assertEquals(dispatchStep(recente, agora), { action: 'wait', ms: 6000 })
  assertEquals(dispatchStep({ ...recente, extra: { lastAt: new Date(agora - 10000).toISOString() } }, agora), { action: 'send', contactId: 'c2' })
  // intervalo menor que 5 s vira 5 s
  assertEquals(dispatchStep({ ...recente, interval: 1 }, agora), { action: 'wait', ms: 1000 })
})

Deno.test('disparo: conclui quando todos receberam e cancela o que não guardou os contatos', () => {
  assertEquals(dispatchStep({ ...base, sent: 3 }, agora), { action: 'done' })
  const velho = dispatchStep({ contacts: [], sent: 0, total: 1, interval: 5, extra: {} }, agora)
  assertEquals(velho.action, 'invalid')
  assertMatch((velho as { reason: string }).reason, /Crie o disparo de novo/)
})
