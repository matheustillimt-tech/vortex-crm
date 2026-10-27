// Coluna do Kanban com "Pausar IA e disparos" (functions/_shared/agent-core.ts → colunaPausada) e o valor por variável
// no bloco Venda aprovada ({{evento.venda.valor}} do evento `comprou` do Vórtex Call).
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/coluna-pausada.test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { colunaPausada } from '../functions/_shared/agent-core.ts'
import { runFrom } from '../functions/_shared/flow.ts'
import { bancoFalso } from './banco-falso.ts'

const empresa = 'emp1'
const tabelas = () => ({
  kanbans: [
    { id: 'k1', company_id: empresa, columns: [{ id: 'novo', name: 'Compareceu' }, { id: 'neg', name: 'Em negociação', pausa: true }, { id: 'comprou', name: 'Comprou' }] },
    { id: 'k2', company_id: 'outra', columns: [{ id: 'x', name: 'Pausada de outra empresa', pausa: true }] },
  ],
  kanban_cards: [] as any[],
  contacts: [{ id: 'ct1', company_id: empresa, name: 'Ana', labels: [] }],
  messages: [] as any[],
})
const ctx = (admin: any) => ({ admin, companyId: empresa, contact: { id: 'ct1', name: 'Ana', labels: [] }, chat: { id: 'chat1' }, settings: {}, provider: null, creds: null, run: null }) as any

Deno.test('colunaPausada: só a coluna marcada, da mesma empresa', async () => {
  const t = tabelas()
  const { admin } = bancoFalso(t)
  assertEquals(await colunaPausada(admin, empresa, 'ct1'), null)
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'novo' })
  assertEquals(await colunaPausada(admin, empresa, 'ct1'), null)
  t.kanban_cards[0].column_id = 'neg'
  assertEquals(await colunaPausada(admin, empresa, 'ct1'), 'Em negociação')
  assertEquals(await colunaPausada(admin, empresa, null), null)
  t.kanban_cards[0] = { id: 'c1', company_id: empresa, kanban_id: 'k2', contact_id: 'ct1', column_id: 'x' }
  assertEquals(await colunaPausada(admin, empresa, 'ct1'), null)
})

const fluxoMensagem = { id: 'f1', name: 'Aviso', nodes: [{ id: 'start', type: 'start', data: {} }, { id: 'msg', type: 'block', data: { kind: 'message', config: { text: 'Oi!' } } }], edges: [{ source: 'start', target: 'msg' }] }

Deno.test('negócio em Em negociação: mensagem do fluxo não sai; fora dela, sai', async () => {
  const t = tabelas()
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'neg' })
  await runFrom(ctx(bancoFalso(t).admin), fluxoMensagem, 'start')
  const enviadas = () => t.messages.filter((m: any) => m.text === 'Oi!').length
  assertEquals(enviadas(), 0)
  t.kanban_cards[0].column_id = 'novo'
  await runFrom(ctx(bancoFalso(t).admin), fluxoMensagem, 'start')
  assertEquals(enviadas(), 1)
})

Deno.test('venda aprovada com {{evento.venda.valor}}: valor do evento no negócio e na venda', async () => {
  const t = { ...tabelas(), products: [] as any[], sales: [] as any[] }
  const fluxo = {
    id: 'f2', name: 'Pay — Comprou',
    nodes: [
      { id: 'start', type: 'start', data: {} },
      { id: 'kb', type: 'block', data: { kind: 'kanban', config: { crmId: 'k1', action: 'Criar/mover card', column: 'Comprou' } } },
      { id: 'sale', type: 'block', data: { kind: 'approved_sale', config: { amount: '{{evento.venda.valor}}', crmId: 'k1' } } },
    ],
    edges: [{ source: 'start', target: 'kb' }, { source: 'kb', target: 'sale' }],
  }
  await runFrom(ctx(bancoFalso(t).admin), fluxo, 'start', { 'evento.venda.valor': '3490.12' })
  assertEquals([t.kanban_cards[0].column_id, t.kanban_cards[0].value], ['comprou', 3490.12])
  assertEquals(t.sales.map((s: any) => s.value), [3490.12])
})
