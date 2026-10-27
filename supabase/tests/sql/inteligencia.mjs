// Vórtex Inteligência no banco (0035): coleta de pagamentos (repetidos, fora de ordem, várias tentativas), métricas,
// atribuição da recuperação, isolamento entre empresas, permissões, trava de execução, versões e restauração.
import assert from 'node:assert/strict'

const U1 = '00000000-0000-0000-0000-0000000000a1' // dono da empresa A
const U2 = '00000000-0000-0000-0000-0000000000a2' // membro da empresa A
const U3 = '00000000-0000-0000-0000-0000000000b1' // dono da empresa B
let falhas = 0
const caso = async (nome, fn) => {
  try { await fn(); console.log('ok  ', nome) } catch (e) {
    falhas++
    console.log('FALHOU', nome, '\n   ', String(e.message).split('\n').filter(Boolean).slice(0, 2).join(' '), e.actual !== undefined ? `| atual=${JSON.stringify(e.actual)} esperado=${JSON.stringify(e.expected)}` : '', '|', (e.stack || '').split('\n').find((l) => l.includes('inteligencia.mjs')) || '')
  }
}

export default async function ({ conn }) {
  const c = conn()
  await c.connect()
  const q = async (sql, args = []) => (await c.query(sql, args)).rows
  // executa como um usuário logado (ou como o servidor) dentro de uma transação
  const como = async (uid, fn) => {
    await c.query('begin')
    try {
      if (uid === 'service') {
        await c.query("select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)")
        await c.query('set local role service_role')
      } else {
        await c.query("select set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)", [uid])
        await c.query('set local role authenticated')
      }
      const r = await fn()
      await c.query('commit')
      return r
    } catch (e) {
      await c.query('rollback')
      throw e
    }
  }
  const um = async (uid, sql, args) => (await como(uid, () => q(sql, args)))[0]

  // ---------- empresas, pessoas e módulos ----------
  await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'a1@x.com', '{"company":"Empresa A"}'), ($2, 'b1@x.com', '{"company":"Empresa B"}')`, [U1, U3])
  const [{ company_id: A }] = await q('select company_id from public.company_members where user_id = $1', [U1])
  const [{ company_id: B }] = await q('select company_id from public.company_members where user_id = $1', [U3])
  await q(`insert into auth.users (id, email) values ($1, 'a2@x.com')`, [U2]).catch(() => {})
  // o cadastro de U2 cria uma empresa própria; ele também entra na A como Membro
  await q(`insert into public.company_members (company_id, user_id, name, email, role) values ($1, $2, 'Membro', 'a2@x.com', 'Membro') on conflict do nothing`, [A, U2])
  const todos = ['conexoes', 'contatos', 'chat', 'kanban', 'fluxos', 'agentes', 'inteligencia']
  for (const cid of [A, B]) {
    await q(`insert into public.company_access (company_id, selected, effective) values ($1, $2, $2)
      on conflict (company_id) do update set selected = excluded.selected, effective = excluded.effective`, [cid, todos])
  }
  const [{ id: conexao }] = await q(`insert into public.connections (company_id, name) values ($1, 'Número') returning id`, [A])
  const contato = async (cid, nome, fone, email = '') => (await q(`insert into public.contacts (company_id, name, phone, email) values ($1, $2, $3, $4) returning id`, [cid, nome, fone, email]))[0].id
  const ana = await contato(A, 'Ana', '+55 00 98888-1111', 'ana@x.com')
  const bia = await contato(A, 'Bia', '+55 00 97777-2222')
  const caio = await contato(A, 'Caio', '+55 00 96666-3333', 'caio@x.com')
  const outroB = await contato(B, 'Cliente B', '+55 00 98888-1111', 'ana@x.com')
  const conversa = async (cid, ct) => (await q(`insert into public.chats (company_id, contact_id, connection_id) values ($1, $2, $3) returning id`, [cid, ct, cid === A ? conexao : null]))[0].id
  const chatAna = await conversa(A, ana)
  const chatBia = await conversa(A, bia)
  const msg = (cid, chat, sender, text, at, extra = {}) => q(`insert into public.messages (company_id, chat_id, sender, text, at, extra) values ($1, $2, $3, $4, $5, $6)`, [cid, chat, sender, text, at, extra])

  const T0 = new Date('2026-10-20T12:00:00-03:00')
  const h = (n) => new Date(T0.getTime() + n * 3600e3).toISOString()
  const ingest = (cid, ev) => um('service', 'select public.intel_ingest($1, $2) r', [cid, ev]).then((x) => x.r)
  const ev = (o) => ({ fonte: 'kiwify', tipo: 'pedido', moeda: 'BRL', produto: { id: 'p1', nome: 'Curso X' }, ...o })

  await caso('evento repetido não conta duas vezes e fora de ordem não rebaixa o status', async () => {
    // a aprovação chega antes do aviso do Pix e é reenviada
    const ok = await ingest(A, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:O1', pedido: 'O1', status: 'pago', metodo: 'pix', valorCentavos: 19700, quando: h(2), tentativa: 'pix', cliente: { email: 'ANA@x.com', telefone: '5500988881111' } }))
    assert.equal(ok.ok, true)
    const rep = await ingest(A, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:O1', pedido: 'O1', status: 'pago', metodo: 'pix', valorCentavos: 19700, quando: h(2), tentativa: 'pix' }))
    assert.equal(rep.repetido, true)
    await ingest(A, ev({ evento: 'pix_gerado', dedupe: 'k:pix:O1', pedido: 'O1', status: 'pendente', metodo: 'pix', valorCentavos: 19700, quando: h(0), tentativa: 'pix', cliente: { telefone: '5500988881111' } }))
    const [o] = await q(`select * from public.intel_orders where external_id = 'O1'`)
    assert.equal(o.status, 'pago')
    assert.equal(o.events, 2)
    assert.equal(o.contact_id, ana, 'achou o contato pelo WhatsApp/e-mail')
    assert.equal(new Date(o.opened_at).toISOString(), h(0))
    assert.equal(new Date(o.paid_at).toISOString(), h(2))
    const t = await q(`select status from public.intel_payment_attempts where order_id = $1`, [o.id])
    assert.deepEqual(t.map((x) => x.status), ['pago'])
  })

  await caso('reembolso vence a aprovação, mesmo com aprovação atrasada', async () => {
    await ingest(A, ev({ evento: 'reembolso', dedupe: 'k:reemb:O1', pedido: 'O1', status: 'reembolsado', quando: h(30) }))
    await ingest(A, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:O1:atrasada', pedido: 'O1', status: 'pago', metodo: 'pix', valorCentavos: 19700, quando: h(2) }))
    const [o] = await q(`select * from public.intel_orders where external_id = 'O1'`)
    assert.equal(o.status, 'reembolsado')
    assert.equal(new Date(o.refunded_at).toISOString(), h(30))
  })

  // Bia: cartão recusado (O2), a IA fala com ela 20 min depois, e ela compra no Pix 3 h depois (O3)
  await ingest(A, ev({ evento: 'pagamento_recusado', dedupe: 'k:rec:O2', pedido: 'O2', status: 'recusado', metodo: 'cartao', valorCentavos: 19700, quando: h(1), tentativa: 'cartao:1', cliente: { telefone: '00977772222' } }))
  await msg(A, chatBia, 'contact', 'meu cartão não passou', h(1.2))
  await msg(A, chatBia, 'bot', 'Posso te mandar um Pix?', h(1.3), { agentId: null })
  await ingest(A, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:O3', pedido: 'O3', status: 'pago', metodo: 'pix', valorCentavos: 19700, quando: h(4), tentativa: 'pix', cliente: { telefone: '00977772222' } }))
  // Caio: Pix gerado e nunca pago (O4); Pix pago em 5 minutos (O5) não é oportunidade
  await ingest(A, ev({ evento: 'pix_gerado', dedupe: 'k:pix:O4', pedido: 'O4', status: 'pendente', metodo: 'pix', valorCentavos: 29700, quando: h(5), tentativa: 'pix', cliente: { email: 'caio@x.com' }, produto: { id: 'p2', nome: 'Mentoria' } }))
  await ingest(A, ev({ evento: 'pix_gerado', dedupe: 'k:pix:O5', pedido: 'O5', status: 'pendente', metodo: 'pix', valorCentavos: 4990, quando: h(6), tentativa: 'pix', cliente: { email: 'z@x.com' }, produto: { id: 'p3', nome: 'Ebook' } }))
  await ingest(A, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:O5', pedido: 'O5', status: 'pago', metodo: 'pix', valorCentavos: 4990, quando: h(6.08), tentativa: 'pix', cliente: { email: 'z@x.com' }, produto: { id: 'p3', nome: 'Ebook' } }))
  // carrinho abandonado sem valor de alguém que não comprou
  await ingest(A, ev({ evento: 'carrinho_abandonado', dedupe: 'k:cart:C1', pedido: 'C1', tipo: 'carrinho', status: 'abandonado', quando: h(7), cliente: { email: 'w@x.com' } }))
  // a mesma pessoa da empresa A comprou na empresa B: não pode aparecer na A
  await ingest(B, ev({ evento: 'compra_aprovada', dedupe: 'k:aprov:B1', pedido: 'B1', status: 'pago', metodo: 'pix', valorCentavos: 100000, quando: h(3), cliente: { email: 'ana@x.com' } }))

  const de = new Date(T0.getTime() - 86400e3).toISOString()
  const ate = new Date(T0.getTime() + 3 * 86400e3).toISOString()

  await caso('vendas: só pedidos pagos da empresa, sem somar tentativas nem outra empresa', async () => {
    const { r } = await um(U1, 'select public.intel_m_vendas($1, $2, $3) r', [A, de, ate])
    assert.equal(r.fonte, 'pagamentos')
    assert.equal(r.pagamentos.aprovadas, 3) // O1, O3, O5
    assert.equal(r.pagamentos.receitaCentavos, 19700 + 19700 + 4990)
    assert.equal(r.pagamentos.reembolsadoCentavos, 19700)
    assert.equal(r.pagamentos.liquidoCentavos, 19700 + 4990)
    assert.equal(r.pagamentos.serie.length, 5) // um ponto por dia do período (19 a 23/10)
    const { r: rb } = await um(U3, 'select public.intel_m_vendas($1, $2, $3) r', [B, de, ate])
    assert.equal(rb.pagamentos.receitaCentavos, 100000)
  })

  await caso('recuperação: Pix pago na hora não é oportunidade; compra após contato atribuída; potencial não convertido', async () => {
    const { r } = await um(U1, 'select public.intel_m_recuperacao($1, $2, $3) r', [A, de, ate])
    // oportunidades: Ana (O1 pago 2 h depois do Pix), Bia (O2 recusado → O3), Caio (O4 pendente), carrinho C1
    assert.equal(r.oportunidades, 4, JSON.stringify(r.porTipo))
    assert.equal(r.convertidas, 2) // Ana e Bia
    assert.equal(r.recuperadas, 1) // só a Bia teve contato antes de pagar
    assert.equal(r.receitaRecuperadaCentavos, 19700)
    assert.equal(r.compraAposContato, 1)
    assert.equal(r.naoConvertidas, 2)
    assert.equal(r.valorPotencialCentavos, 29700) // O4 (valor informado)
    assert.equal(r.valorPotencialEstimadoCentavos, 19700) // carrinho sem valor: preço médio pago do mesmo produto, à parte
    assert.equal(r.valorPotencialSemValor, 0)
    assert.equal(r.pix.gerados, 4) // O1, O3 (aprovado direto no Pix), O4, O5
    assert.equal(r.pix.pagos, 3)
    assert.equal(r.pix.pessoasSemPagar, 1) // Caio
  })

  await caso('registros: oportunidades pendentes e pedidos pagos, com o contato e a conversa', async () => {
    const { r } = await um(U1, `select public.intel_m_registros($1, 'oportunidades', $2, $3, '{"status":"recuperada"}') r`, [A, de, ate])
    assert.equal(r.linhas.length, 1)
    assert.equal(r.linhas[0].conversaId, chatBia)
    const { r: p } = await um(U1, `select public.intel_m_registros($1, 'pedidos', $2, $3, '{"status":"pago","produto":"curso"}') r`, [A, de, ate])
    assert.equal(p.linhas.length, 2) // O1 e O3 (filtro pelo nome do produto)
  })

  await caso('isolamento: dono da B não consulta a A; membro sem permissão de conversas não lê conversas', async () => {
    await assert.rejects(um(U3, 'select public.intel_m_vendas($1, $2, $3) r', [A, de, ate]), /permissão/)
    const { r } = await um(U2, 'select public.intel_m_suporte($1, $2, $3) r', [A, de, ate])
    assert.equal(r.disponivel, true)
    await assert.rejects(um(U2, `select public.intel_m_registros($1, 'nao_resolvidas', $2, $3) r`, [A, de, ate]), /conversas/)
    // tabelas cruas: nada direto pela API
    await assert.rejects(um(U1, 'select count(*) from public.intel_orders'), /permission denied/)
  })

  await caso('permissões configuráveis: dar "conversas" ao Membro; sem o módulo, nada', async () => {
    await um(U1, `select public.intel_settings_save($1, '{"conversas":["Admin","Membro"]}', '{}', '{}')`, [A])
    const { r } = await um(U2, `select public.intel_m_registros($1, 'conversas', $2, $3) r`, [A, de, ate])
    assert.equal(r.linhas.length, 1) // só a Bia mandou mensagem
    await assert.rejects(um(U2, `select public.intel_settings_save($1, '{}', '{}', '{}')`, [A]), /configurar/)
    await q(`update public.company_access set effective = array_remove(effective, 'inteligencia') where company_id = $1`, [A])
    await assert.rejects(um(U1, 'select public.intel_m_vendas($1, $2, $3) r', [A, de, ate]), /permissão/)
    await q(`update public.company_access set effective = effective || '{inteligencia}' where company_id = $1`, [A])
  })

  await caso('eventos internos: concluído, reaberto, IA não resolveu, transferência e etapa do CRM', async () => {
    await q(`update public.chats set status = 'resolved' where id = $1`, [chatAna])
    await q(`update public.chats set status = 'waiting', ai_state = ai_state || '{"precisaHumano":{"motivo":"cliente pediu reembolso"}}' where id = $1`, [chatAna])
    await q(`update public.chats set ai_paused = true, ai_pause_reason = 'transferido' where id = $1`, [chatAna])
    const [{ id: k }] = await q(`insert into public.kanbans (company_id, name, columns) values ($1, 'Vendas', '[{"id":"c1","name":"Novo"},{"id":"c2","name":"Negociando"}]') returning id`, [A])
    const [{ id: card }] = await q(`insert into public.kanban_cards (company_id, kanban_id, column_id, contact_id, value) values ($1, $2, 'c1', $3, 197) returning id`, [A, k, ana])
    await q(`update public.kanban_cards set column_id = 'c2' where id = $1`, [card])
    const kinds = (await q(`select kind from public.intel_events where company_id = $1 and source = 'interno' order by id`, [A])).map((x) => x.kind)
    for (const k2 of ['lead_entrou', 'conversa_iniciada', 'atendimento_concluido', 'atendimento_reaberto', 'ia_nao_resolveu', 'transferencia_humana', 'crm_negocio_criado', 'crm_etapa']) {
      assert.ok(kinds.includes(k2), `faltou ${k2}: ${kinds.join(',')}`)
    }
    const [e] = await q(`select data from public.intel_events where kind = 'crm_etapa'`)
    assert.equal(e.data.deNome, 'Novo')
    assert.equal(e.data.paraNome, 'Negociando')
    const { r } = await um(U1, 'select public.intel_m_funil($1, $2, $3) r', [A, de, new Date(Date.now() + 86400e3).toISOString()])
    assert.equal(r.kanban[0].colunas[1].negocios, 1)
    const { r: s } = await um(U1, 'select public.intel_m_suporte($1, $2, $3) r', [A, de, new Date(Date.now() + 86400e3).toISOString()])
    assert.equal(s.iaNaoResolveu, 1)
    assert.equal(s.motivosTransferencia[0].motivo, 'cliente pediu reembolso')
  })

  await caso('consumo e opções respondem (sem carteira: créditos zerados, não erro)', async () => {
    const { r } = await um(U1, 'select public.intel_m_consumo($1, $2, $3) r', [A, de, ate])
    assert.equal(Number(r.creditos), 0)
    const { r: o } = await um(U1, 'select public.intel_opcoes($1) r', [A])
    assert.ok(o.produtos.some((p) => p.nome === 'Curso X'))
    const { r: d } = await um(U1, 'select public.intel_m_duvidas($1, $2, $3) r', [A, de, ate])
    assert.equal(d.disponivel, true)
  })

  // ---------- Evolução do agente ----------
  const [{ id: agente }] = await q(`insert into public.agents (company_id, name, extra) values ($1, 'Leo', $2) returning id`, [A,
    { prompt: 'Você é o Leo. Nunca dê desconto.', examples: 'Oi!', rules: 'Frete grátis acima de R$ 197.', knowledge: [{ id: 'k1', title: 'Prazo', content: '7 dias' }], settings: { aiProvider: '' } }])

  let job
  await caso('uma execução por agente; membro sem permissão não inicia', async () => {
    await assert.rejects(um(U2, 'select public.intel_job_start($1, $2, 0.5, $3) id', [A, agente, {}]), /melhorar/)
    job = (await um(U1, 'select public.intel_job_start($1, $2, 0.5, $3) id', [A, agente, { creditos: 100 }])).id
    await assert.rejects(um(U1, 'select public.intel_job_start($1, $2, 0.5, $3) id', [A, agente, {}]), /andamento/)
    await assert.rejects(um(U3, 'select public.intel_job_start($1, $2, 0.5, $3) id', [A, agente, {}]), /permissão/)
  })

  await caso('fila: duas rodadas não pegam a mesma execução', async () => {
    const a = await como('service', () => q('select id from public.intel_job_claim(60)'))
    const b = await como('service', () => q('select id from public.intel_job_claim(60)'))
    assert.equal(a.length, 1)
    assert.equal(b.length, 0)
  })

  await caso('publicar: guarda a versão anterior, aplica só campos permitidos e protege o editor aberto', async () => {
    const r = (await um('service', `select public.intel_apply($1, $2, 'Respostas mais curtas') r`, [job,
      { prompt: 'Você é o Leo. Nunca dê desconto. Responda em até 3 frases.', settings: { aiProvider: 'openai' }, knowledge: [{ id: 'k1', title: 'Prazo', content: '7 dias úteis' }] }])).r
    assert.equal(r.ok, true, JSON.stringify(r))
    const [a] = await q('select extra from public.agents where id = $1', [agente])
    assert.match(a.extra.prompt, /3 frases/)
    assert.equal(a.extra.settings.aiProvider, '', 'configuração do modelo não muda')
    assert.equal(a.extra.intelRev, 1)
    const vs = await q('select numero, origem from public.intel_agent_versions where agent_id = $1 order by numero', [agente])
    assert.deepEqual(vs.map((v) => v.origem), ['copia', 'melhoria'])
    // editor aberto antes (intelRev 0) salvando por cima
    await assert.rejects(um(U1, `update public.agents set extra = $2 where id = $1`, [agente, { prompt: 'velho', intelRev: 0 }]), /Recarregue/)
    // a segunda aplicação da mesma execução (base_rev 0) vê o conflito
    const r2 = (await um('service', `select public.intel_apply($1, '{"prompt":"x"}', 'x') r`, [job])).r
    assert.equal(r2.motivo, 'conflito')
  })

  await caso('aprovar alteração protegida e restaurar a versão anterior', async () => {
    const [{ id: ch }] = await q(`insert into public.intel_agent_changes (company_id, agent_id, job_id, campo, operacao, depois, motivo, protegida, area, estado)
      values ($1, $2, $3, 'knowledge', 'adicionar', '{"title":"Garantia","content":"30 dias"}', 'clientes perguntam', true, 'garantia', 'pendente_aprovacao') returning id`, [A, agente, job])
    await assert.rejects(um(U2, 'select public.intel_change_decide($1, true)', [ch]), /aprovar/)
    const r = (await um(U1, 'select public.intel_change_decide($1, true) r', [ch])).r
    assert.equal(r.estado, 'aprovada')
    let [a] = await q('select extra from public.agents where id = $1', [agente])
    assert.ok(a.extra.knowledge.some((k) => k.title === 'Garantia'))
    assert.equal(a.extra.intelRev, 2)
    const [{ id: v1 }] = await q(`select id from public.intel_agent_versions where agent_id = $1 and numero = 1`, [agente])
    await assert.rejects(um(U3, 'select public.intel_version_restore($1)', [v1]), /permissão/)
    await um(U1, 'select public.intel_version_restore($1)', [v1])
    ;[a] = await q('select extra from public.agents where id = $1', [agente])
    assert.equal(a.extra.prompt, 'Você é o Leo. Nunca dê desconto.')
    assert.equal(a.extra.knowledge.length, 1)
    assert.equal(a.extra.intelRev, 3)
    const ev = (await um(U1, 'select public.intel_evolucao($1, $2) r', [A, agente])).r
    assert.ok(ev.versoes.length >= 5)
    assert.ok(ev.desempenho, 'tem antes/depois da última publicação')
  })

  await caso('aprendizados: repetir a análise não duplica e conversa nova reabre o que já foi aplicado', async () => {
    const it = (chats) => [{ chave: 'prazo-de-entrega', tipo: 'duvida_recorrente', titulo: 'Prazo', chats, evidencias: chats.map((c) => ({ chat: c, trecho: 'x' })) }]
    await um('service', 'select public.intel_learning_merge($1, $2, $3, $4)', [A, agente, job, JSON.stringify(it([chatAna, chatBia]))])
    await um('service', 'select public.intel_learning_merge($1, $2, $3, $4)', [A, agente, job, JSON.stringify(it([chatAna]))])
    let [l] = await q(`select chats, evidencias, estado from public.intel_learnings where agent_id = $1`, [agente])
    assert.equal(l.chats.length, 2)
    assert.equal(l.evidencias.length, 2)
    await q(`update public.intel_learnings set estado = 'aplicado' where agent_id = $1`, [agente])
    await um('service', 'select public.intel_learning_merge($1, $2, $3, $4)', [A, agente, job, JSON.stringify(it([chatAna]))])
    ;[l] = await q(`select estado from public.intel_learnings where agent_id = $1`, [agente])
    assert.equal(l.estado, 'aplicado', 'mesma conversa não reabre')
    const novo = await conversa(A, caio)
    await um('service', 'select public.intel_learning_merge($1, $2, $3, $4)', [A, agente, job, JSON.stringify(it([novo]))])
    ;[l] = await q(`select estado, cardinality(chats) n from public.intel_learnings where agent_id = $1`, [agente])
    assert.equal(l.estado, 'aberto')
    assert.equal(l.n, 3)
  })

  await caso('conversas do agente: só onde ele participou', async () => {
    await msg(A, chatAna, 'contact', 'oi', h(1))
    await msg(A, chatAna, 'bot', 'olá', h(1.1), { agentId: agente })
    const r = await um('service', 'select count(*)::int n from public.intel_chats_do_agente($1, $2)', [A, agente])
    assert.equal(r.n, 1) // a conversa da Bia teve mensagem de bot sem este agente
    await assert.rejects(um(U1, 'select * from public.intel_chats_do_agente($1, $2)', [A, agente]), /permission denied/)
  })

  await caso('retomar execução pausada e cancelar', async () => {
    await q(`update public.intel_agent_jobs set status = 'pausado', motivo_pausa = 'orcamento' where id = $1`, [job])
    await um(U1, 'select public.intel_job_resume($1, 0.2)', [job])
    const [j] = await q('select status, orcamento_usd, base_rev from public.intel_agent_jobs where id = $1', [job])
    assert.equal(j.status, 'na_fila')
    assert.equal(Number(j.orcamento_usd), 0.7)
    assert.equal(j.base_rev, 3)
    await um(U1, 'select public.intel_job_cancel($1)', [job])
    const [j2] = await q('select status from public.intel_agent_jobs where id = $1', [job])
    assert.equal(j2.status, 'cancelado')
  })

  await caso('contatos repetidos: pedidos vão para o contato que fica', async () => {
    const dup = await contato(A, 'Ana 2', '+5500988881111')
    await q(`update public.intel_orders set contact_id = $1 where external_id = 'O3'`, [dup])
    await q('select private.unir_contatos($1, $2)', [ana, dup])
    const [o] = await q(`select contact_id from public.intel_orders where external_id = 'O3'`)
    assert.equal(o.contact_id, ana)
  })

  await caso('conversas do assistente: cada usuário só vê as suas', async () => {
    const [{ id: cv }] = await q(`insert into public.intel_conversations (company_id, user_id) values ($1, $2) returning id`, [A, U1])
    await q(`insert into public.intel_messages (conversation_id, company_id, user_id, role, text) values ($1, $2, $3, 'user', 'oi')`, [cv, A, U1])
    assert.equal((await como(U1, () => q('select id from public.intel_messages'))).length, 1)
    assert.equal((await como(U2, () => q('select id from public.intel_messages'))).length, 0)
  })

  await c.end()
  console.log(falhas ? `\n${falhas} caso(s) falharam` : '\ntodos os casos passaram')
  if (falhas) process.exitCode = 1
}
