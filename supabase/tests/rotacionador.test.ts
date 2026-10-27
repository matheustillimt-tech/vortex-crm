// Rotacionador: regras puras (functions/_shared/rotacionador.ts) e o agente que atende nos números da roda (resolveAgent).
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/rotacionador.test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { isPreviewBot, numerosNoAr, slugOf, waLink } from '../functions/_shared/rotacionador.ts'
import { resolveAgent } from '../functions/_shared/agent-core.ts'
import { bancoFalso } from './banco-falso.ts'

Deno.test('slugOf: minúsculo, sem acento, espaço vira hífen; curto ou vazio não serve', () => {
  assertEquals(slugOf('Aluno me chamou'), 'aluno-me-chamou')
  assertEquals(slugOf('  Suporte  Átrio!! '), 'suporte-atrio')
  assertEquals(slugOf('--ja-vem-com-hifen--'), 'ja-vem-com-hifen')
  assertEquals(slugOf('ab'), '')
  assertEquals(slugOf(''), '')
  assertEquals(slugOf(null), '')
  assertEquals(slugOf('a'.repeat(80)).length, 60)
})

const conns = [
  { id: 'a', number: '+55 00 98888-1001', status: 'connected', provider: 'web' },
  { id: 'b', number: '+55 00 97777-2002', status: 'disconnected', provider: 'web' },
  { id: 'c', number: '+55 00 96666-3003', status: 'connected', provider: 'oficial' },
  { id: 'd', number: '@loja', status: 'connected', provider: 'instagram' },
  { id: 'e', number: '', status: 'connected', provider: 'web' },
]

Deno.test('numerosNoAr: só os conectados, na ordem da roda; o que caiu, Instagram, sem número e excluído ficam de fora', () => {
  assertEquals(numerosNoAr(['c', 'b', 'a'], conns).map((c) => c.id), ['c', 'a'])
  assertEquals(numerosNoAr(['a', 'd', 'e', 'apagada'], conns).map((c) => c.id), ['a'])
  assertEquals(numerosNoAr(['b'], conns), [])
  assertEquals(numerosNoAr(null, conns), [])
})

Deno.test('waLink: só dígitos e a mensagem pronta codificada', () => {
  assertEquals(waLink('+55 00 98888-1001', ''), 'https://wa.me/5500988881001')
  assertEquals(waLink('+55 00 98888-1001', ' Oi! Vim da área de membros & preciso de ajuda '), 'https://wa.me/5500988881001?text=Oi!%20Vim%20da%20%C3%A1rea%20de%20membros%20%26%20preciso%20de%20ajuda')
})

Deno.test('isPreviewBot: prévia do WhatsApp e robôs não andam a roda; navegador de verdade anda', () => {
  assertEquals(isPreviewBot('WhatsApp/2.23.20.0 A'), true)
  assertEquals(isPreviewBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), true)
  assertEquals(isPreviewBot('TelegramBot (like TwitterBot)'), true)
  assertEquals(isPreviewBot(''), true)
  assertEquals(isPreviewBot('Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), false)
  assertEquals(isPreviewBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), false)
  assertEquals(isPreviewBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0'), false)
})

const banco = () => bancoFalso({
  agents: [
    { id: 'proprio', company_id: 'emp', name: 'Próprio do A', active: true, connection_id: 'a', extra: {} },
    { id: 'suporte', company_id: 'emp', name: 'Suporte', active: true, connection_id: null, extra: {} },
    { id: 'fluxo', company_id: 'emp', name: 'Do fluxo', active: true, connection_id: null, extra: {} },
  ],
  rotators: [
    { id: 'r1', company_id: 'emp', active: true, agent_id: 'suporte', connection_ids: ['a', 'b', 'c'] },
    { id: 'r2', company_id: 'emp', active: false, agent_id: 'fluxo', connection_ids: ['x'] },
    { id: 'r3', company_id: 'outra', active: true, agent_id: 'fluxo', connection_ids: ['y'] },
  ],
})

Deno.test('resolveAgent: número da roda sem agente próprio é atendido pelo agente do rotacionador', async () => {
  const { admin } = banco()
  const quem = async (chat: any) => (await resolveAgent(admin, { company_id: 'emp', ...chat }))?.id ?? null
  assertEquals(await quem({ connection_id: 'b' }), 'suporte')
  assertEquals(await quem({ connection_id: 'c' }), 'suporte')
  // o agente próprio do número vence
  assertEquals(await quem({ connection_id: 'a' }), 'proprio')
  // o definido por um fluxo vence tudo
  assertEquals(await quem({ connection_id: 'b', ai_agent_id: 'fluxo' }), 'fluxo')
  // rotacionador pausado não põe agente
  assertEquals(await quem({ connection_id: 'x' }), null)
  // rotacionador de outra empresa não vale
  assertEquals(await quem({ connection_id: 'y' }), null)
  assertEquals(await quem({ connection_id: null }), null)
})
