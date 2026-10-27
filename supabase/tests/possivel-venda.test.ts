// Venda e etiquetas no negócio do Kanban (functions/_shared/flow.ts): blocos Possível venda e Venda aprovada
// (vendaNoNegocio), bloco Etiquetas nos negócios do contato (etiquetarNegocios) e o fluxo de compra aprovada inteiro.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/possivel-venda.test.ts
import { assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { etiquetarNegocios, runFrom, vendaNoNegocio } from '../functions/_shared/flow.ts'
import { bancoFalso } from './banco-falso.ts'

const empresa = 'emp1'
const tabelas = () => ({
  kanbans: [{ id: 'k1', company_id: empresa, columns: [{ id: 'novo', name: 'Novo lead' }, { id: 'pix', name: 'Pix gerado' }, { id: 'comprou', name: 'COMPRADOR ' }] }],
  products: [
    { id: 'p1', company_id: empresa, name: 'Curso', price: 497, currency: 'BRL' },
    { id: 'p2', company_id: 'outra', name: 'De outra empresa', price: 10, currency: 'BRL' },
  ],
  kanban_cards: [] as any[],
  contacts: [{ id: 'ct1', company_id: empresa, name: 'Ana', labels: ['quente'] }],
})
const ctx = (admin: any, run: any = null) => ({ admin, companyId: empresa, contact: { id: 'ct1', name: 'Ana', labels: ['quente'] }, chat: { id: 'chat1' }, settings: {}, provider: null, creds: null, run }) as any

Deno.test('possível venda sem negócio no Kanban: cria na primeira coluna com o valor do produto e as etiquetas do contato', async () => {
  const t = tabelas()
  const nota = await vendaNoNegocio(ctx(bancoFalso(t).admin), { productId: 'p1', crmId: 'k1' }, 'possivel')
  const card = t.kanban_cards[0]
  assertEquals([card.kanban_id, card.column_id, card.contact_id, card.title, card.value, card.labels], ['k1', 'novo', 'ct1', 'Ana', 497, ['quente']])
  assertEquals([card.extra.venda.produtoId, card.extra.venda.produto, card.extra.venda.moeda, card.extra.venda.status], ['p1', 'Curso', 'BRL', 'possivel'])
  assertMatch(nota, /Curso/)
})

Deno.test('negócio já existe: troca só o valor e guarda o produto, sem mexer na coluna nem no resto do extra', async () => {
  const t = tabelas()
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'pix', value: 0, extra: { columnSince: '2026-10-20T10:00:00Z' } })
  await vendaNoNegocio(ctx(bancoFalso(t).admin, { id: 'run1', chain: [] }), { productId: 'p1', crmId: 'k1', amount: '397' }, 'possivel')
  const card = t.kanban_cards[0]
  assertEquals([card.column_id, card.value, card.extra.columnSince, card.extra.venda.produto], ['pix', 397, '2026-10-20T10:00:00Z', 'Curso'])
  // marca da execução: o banco não dispara de novo o fluxo que fez a mudança
  assertEquals(card.extra._flow.run, 'run1')
  assertEquals(t.kanban_cards.length, 1)
})

Deno.test('sem Kanban escolhido ou produto de outra empresa: não grava produto de fora', async () => {
  const t = tabelas()
  assertMatch(await vendaNoNegocio(ctx(bancoFalso(t).admin), { productId: 'p1' }, 'possivel'), /escolha o Kanban/)
  assertEquals(t.kanban_cards.length, 0)
  await vendaNoNegocio(ctx(bancoFalso(t).admin), { productId: 'p2', crmId: 'k1' }, 'possivel')
  assertEquals([t.kanban_cards[0].value, t.kanban_cards[0].extra.venda.produto], [0, ''])
})

Deno.test('venda aprovada: põe valor, moeda do bloco e produto no negócio que existe; sem negócio, não cria', async () => {
  const t = tabelas()
  assertMatch(await vendaNoNegocio(ctx(bancoFalso(t).admin), { productId: 'p1', crmId: 'k1' }, 'aprovada'), /não tem negócio/)
  assertEquals(t.kanban_cards.length, 0)
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'comprou', value: 0, extra: {} })
  await vendaNoNegocio(ctx(bancoFalso(t).admin), { productId: 'p1', crmId: 'k1', amount: '39.90', currency: 'USD' }, 'aprovada')
  const card = t.kanban_cards[0]
  assertEquals([card.column_id, card.value, card.extra.venda.moeda, card.extra.venda.status, card.extra.venda.produto], ['comprou', 39.9, 'USD', 'aprovada', 'Curso'])
})

Deno.test('etiquetas nos negócios: entram em todos os negócios do contato, saem só as do bloco', async () => {
  const t = tabelas()
  t.kanban_cards.push(
    { id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', labels: ['vip'] },
    { id: 'c2', company_id: empresa, kanban_id: 'k2', contact_id: 'ct1', labels: [] },
    { id: 'c3', company_id: empresa, kanban_id: 'k1', contact_id: 'outro', labels: [] },
  )
  const c = ctx(bancoFalso(t).admin)
  await etiquetarNegocios(c, ['comprou'], false)
  assertEquals(t.kanban_cards.map((k) => k.labels), [['vip', 'comprou'], ['comprou'], []])
  await etiquetarNegocios(c, ['comprou'], true)
  assertEquals(t.kanban_cards.map((k) => k.labels), [['vip'], [], []])
})

// O fluxo "COMPRA APROVADA" de produção: Etiquetas (Comprou) → Kanban (COMPRADOR) → Venda aprovada (com o Kanban).
const compraAprovada = (kanbanNaVenda: boolean) => ({
  id: 'f1', name: 'COMPRA APROVADA',
  nodes: [
    { id: 'start', type: 'start', data: {} },
    { id: 'tag', type: 'block', data: { kind: 'tags', config: { action: 'Adicionar', labels: ['comprou'] } } },
    { id: 'kb', type: 'block', data: { kind: 'kanban', config: { crmId: 'k1', action: 'Criar/mover card', column: 'COMPRADOR ' } } },
    { id: 'sale', type: 'block', data: { kind: 'approved_sale', config: { productId: 'p1', amount: '39.90', currency: 'BRL', ...(kanbanNaVenda ? { crmId: 'k1' } : {}) } } },
  ],
  edges: [{ source: 'start', target: 'tag' }, { source: 'tag', target: 'kb' }, { source: 'kb', target: 'sale' }],
})

Deno.test('compra aprovada, contato sem negócio: o negócio nasce em COMPRADOR com a etiqueta e o valor da venda', async () => {
  const t = tabelas()
  await runFrom(ctx(bancoFalso(t).admin), compraAprovada(true), 'start')
  const card = t.kanban_cards[0]
  assertEquals([card.column_id, card.labels, card.value, card.extra.venda.produto], ['comprou', ['quente', 'comprou'], 39.9, 'Curso'])
  assertEquals((t as any).sales.map((s: any) => [s.product_id, s.value]), [['p1', 39.9]])
})

Deno.test('compra aprovada, negócio já no carrinho abandonado: move, etiqueta e põe o valor', async () => {
  const t = tabelas()
  t.kanban_cards.push({ id: 'c1', company_id: empresa, kanban_id: 'k1', contact_id: 'ct1', column_id: 'novo', value: 0, labels: [], extra: {} })
  await runFrom(ctx(bancoFalso(t).admin), compraAprovada(true), 'start')
  const card = t.kanban_cards[0]
  assertEquals([t.kanban_cards.length, card.column_id, card.labels, card.value], [1, 'comprou', ['comprou'], 39.9])
})

Deno.test('venda aprovada sem o Kanban escolhido: registra a venda e não mexe no valor do negócio (como antes)', async () => {
  const t = tabelas()
  await runFrom(ctx(bancoFalso(t).admin), compraAprovada(false), 'start')
  assertEquals([t.kanban_cards[0].value ?? 0, (t as any).sales.length], [0, 1])
})
