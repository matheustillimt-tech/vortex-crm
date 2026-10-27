// Resultado de cada bloco em cada execução (flow.ts → newTrail / flow_runs.steps): o editor soma por bloco e mostra
// Sucessos / Alertas / Erros em todos os blocos.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/resultado-blocos.test.ts
import { assertEquals, assertMatch, assertRejects } from 'jsr:@std/assert@1'
import { runFrom } from '../functions/_shared/flow.ts'
import { bancoFalso } from './banco-falso.ts'

const E = 'emp1'
const bloco = (id: string, kind: string, config: Record<string, unknown> = {}) => ({ id, type: 'block', data: { kind, config } })
const fluxo = (id: string, nodes: any[]) => ({
  id, name: id, status: 'active', nodes: [{ id: 'start', type: 'start', data: {} }, ...nodes],
  edges: ['start', ...nodes.map((n) => n.id)].slice(0, -1).map((s, i) => ({ source: s, target: nodes[i].id })),
})

// banco de mentira + espião das gravações dos passos (rpc flow_run_steps_add)
function mundo(extra: Record<string, any[]> = {}) {
  const t: any = { kanbans: [], kanban_cards: [], contacts: [{ id: 'ct1', company_id: E }], chats: [{ id: 'chat1' }], flow_runs: [{ id: 'run1' }], ...extra }
  const gravados: { run: string; passos: any[] }[] = []
  const admin: any = bancoFalso(t).admin
  admin.rpc = (name: string, a: any) => { if (name === 'flow_run_steps_add') gravados.push({ run: a.p_run, passos: a.p_steps }); return Promise.resolve({ error: null }) }
  const ctx = (run: any) => ({ admin, companyId: E, contact: { id: 'ct1', name: 'Ana', labels: [] }, chat: { id: 'chat1', flow_state: {} }, settings: {}, provider: null, creds: null, run }) as any
  const resumo = () => gravados.flatMap((g) => g.passos.map((p) => `${g.run}:${p.n}:${p.s}`))
  return { t, admin, gravados, ctx, resumo }
}

Deno.test('cada bloco vira um passo: ok, e alerta com o motivo quando o bloco foi pulado', async () => {
  const m = mundo()
  await runFrom(m.ctx({ id: 'run1', chain: [], alerts: 0 }), fluxo('f1', [
    bloco('tag', 'tags', { action: 'Adicionar', labels: ['x'] }),
    bloco('kb', 'kanban', { crmId: 'nao-existe', action: 'Criar/mover card' }),
    bloco('fim', 'chat_controller', { status: 'Resolvido' }),
  ]), 'start')
  assertEquals(m.resumo(), ['run1:tag:ok', 'run1:kb:alert', 'run1:fim:ok'])
  assertMatch(m.gravados[0].passos[1].r, /Kanban escolhido não existe/)
  assertEquals(m.gravados.length, 1) // um trecho = uma gravação
})

Deno.test('bloco que quebra: o passo fica como erro com a mensagem e o erro continua subindo', async () => {
  const m = mundo()
  const from = m.admin.from
  m.admin.from = (tab: string) => { if (tab === 'sales') throw new Error('banco fora do ar'); return from(tab) }
  await assertRejects(() => runFrom(m.ctx({ id: 'run1', chain: [], alerts: 0 }), fluxo('f1', [
    bloco('tag', 'tags', { action: 'Adicionar', labels: ['x'] }),
    bloco('venda', 'approved_sale', { amount: '10' }),
    bloco('nunca', 'tags', { action: 'Adicionar', labels: ['y'] }),
  ]), 'start'))
  assertEquals(m.resumo(), ['run1:tag:ok', 'run1:venda:error'])
  assertEquals(m.gravados[0].passos[1].r, 'banco fora do ar')
})

Deno.test('venda que o banco recusa e integração que falha contam no bloco certo', async () => {
  const m = mundo()
  const from = m.admin.from
  m.admin.from = (tab: string) => (tab === 'sales' ? { insert: () => Promise.resolve({ error: { message: 'sem permissão' } }) } : from(tab))
  const fetch0 = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response('ops', { status: 500 }))
  try {
    await runFrom(m.ctx({ id: 'run1', chain: [], alerts: 0 }), fluxo('f1', [
      bloco('venda', 'approved_sale', { amount: '10' }),
      bloco('api', 'integration', { url: 'https://exemplo.test/x', method: 'POST' }),
    ]), 'start')
  } finally { globalThis.fetch = fetch0 }
  assertEquals(m.resumo(), ['run1:venda:error', 'run1:api:alert'])
  assertEquals(m.gravados[0].passos.map((p: any) => p.r), ['Venda não registrada: sem permissão', 'Integração falhou: HTTP 500'])
})

Deno.test('execução que espera: o trecho até a espera é gravado e, na volta, os passos novos entram depois', async () => {
  const m = mundo()
  const f = fluxo('f1', [bloco('espera', 'smart_interval', { amount: 7, unit: 'minutos' }), bloco('tag', 'tags', { action: 'Adicionar', labels: ['x'] })])
  const c = m.ctx({ id: 'run1', chain: [], alerts: 0 })
  await runFrom(c, f, 'start')
  await runFrom(c, f, c.chat.flow_state.nodeId, {}, { id: 'run1', chain: [], alerts: 0 }) // o agendador continua
  assertEquals(m.resumo(), ['run1:espera:ok', 'run1:tag:ok'])
  assertEquals(m.gravados.length, 2)
})

Deno.test('Conexão de Fluxo: os passos de cada fluxo vão para a execução certa', async () => {
  const destino = fluxo('f2', [bloco('outro', 'tags', { action: 'Adicionar', labels: ['y'] })])
  const m = mundo({ flows: [{ ...destino, company_id: E }] })
  await runFrom(m.ctx({ id: 'run1', chain: [], alerts: 0 }), fluxo('f1', [bloco('tag', 'tags', { action: 'Adicionar', labels: ['x'] }), bloco('vai', 'connection_flow', { flowId: 'f2' })]), 'start')
  const novo = m.t.flow_runs.find((r: any) => r.flow_id === 'f2').id
  assertEquals(m.resumo(), ['run1:tag:ok', 'run1:vai:ok', `${novo}:outro:ok`])
})

Deno.test('sem execução registrada (simulação, testes antigos): não grava nada', async () => {
  const m = mundo()
  await runFrom(m.ctx(null), fluxo('f1', [bloco('tag', 'tags', { action: 'Adicionar', labels: ['x'] })]), 'start')
  assertEquals(m.gravados.length, 0)
})
