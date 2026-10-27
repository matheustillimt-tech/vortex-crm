// Bloco Kanban (functions/_shared/flow.ts, blocoKanban): ação "Anotar no negócio" (sem mover de coluna) e modo
// "Acrescentar no fim" da anotação. Usado pelo fluxo "Call — Resumo" do Vórtex Call.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/kanban-anotacao.test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { blocoKanban, notasDoCard } from '../functions/_shared/flow.ts'
import { bancoFalso } from './banco-falso.ts'

const empresa = 'emp1'
const tabelas = () => ({
  kanbans: [{ id: 'k1', company_id: empresa, columns: [{ id: 'novo', name: 'Novo agendamento' }, { id: 'veio', name: 'Compareceu' }] }],
  kanban_cards: [] as any[],
  company_members: [{ id: 'atendente1', company_id: empresa }],
  contacts: [{ id: 'ct1', company_id: empresa, name: 'Ana', labels: [] }],
  messages: [] as any[],
})
const ctx = (admin: any) => ({ admin, companyId: empresa, contact: { id: 'ct1', name: 'Ana', labels: [] }, chat: { id: 'chat1' }, settings: {}, provider: null, creds: null, run: null }) as any
const V = { 'evento.resumo_texto': 'RESUMO DA CALL\nNegócio: Clínica' }

Deno.test('notasDoCard: troca por padrão; acrescenta com linha em branco; nunca passa de 8.000', () => {
  assertEquals(notasDoCard('Horário: 15:00', 'novo', undefined), 'novo')
  assertEquals(notasDoCard('Horário: 15:00\n', 'novo', 'acrescentar'), 'Horário: 15:00\n\nnovo')
  assertEquals(notasDoCard('', 'novo', 'acrescentar'), 'novo')
  assertEquals(notasDoCard(null, 'novo', 'acrescentar'), 'novo')
  const longo = notasDoCard('a'.repeat(7000), 'b'.repeat(2000), 'acrescentar')
  assertEquals([longo.length, longo.endsWith('b'.repeat(2000))], [8000, true])
})

Deno.test('anotar no negócio: acrescenta o resumo sem mover de coluna e põe o responsável se vazio', async () => {
  const t = tabelas()
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'veio', notes: 'Horário: 26/10 15:00', assignee: null, extra: {} })
  await blocoKanban(ctx(bancoFalso(t).admin), { action: 'Anotar no negócio', crmId: 'k1', column: '', notes: '{{evento.resumo_texto}}', notesMode: 'acrescentar', assignee: 'atendente1' }, V)
  const card = t.kanban_cards[0]
  assertEquals([card.column_id, card.notes, card.assignee], ['veio', 'Horário: 26/10 15:00\n\nRESUMO DA CALL\nNegócio: Clínica', 'atendente1'])
  assertEquals(t.kanban_cards.length, 1)
})

Deno.test('anotar no negócio sem negócio no Kanban: não cria card', async () => {
  const t = tabelas()
  await blocoKanban(ctx(bancoFalso(t).admin), { action: 'Anotar no negócio', crmId: 'k1', notes: '{{evento.resumo_texto}}', notesMode: 'acrescentar' }, V)
  assertEquals(t.kanban_cards.length, 0)
})

Deno.test('criar/mover continua igual: sem modo, troca a anotação; coluna vazia vai pra primeira', async () => {
  const t = tabelas()
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'veio', notes: 'antiga', extra: {} })
  await blocoKanban(ctx(bancoFalso(t).admin), { action: 'Criar/mover card', crmId: 'k1', column: '', notes: 'nova' }, V)
  assertEquals([t.kanban_cards[0].column_id, t.kanban_cards[0].notes], ['novo', 'nova'])
  await blocoKanban(ctx(bancoFalso(t).admin), { action: 'Criar/mover card', crmId: 'k1', column: 'Compareceu', notes: 'mais', notesMode: 'acrescentar' }, V)
  assertEquals([t.kanban_cards[0].column_id, t.kanban_cards[0].notes], ['veio', 'nova\n\nmais'])
})
