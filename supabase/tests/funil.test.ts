// Funil no Kanban e fotos de perfil: o card só anda para a frente, cada aviso conta uma vez, cada fonte vira a etapa
// certa, o contato é achado pelo WhatsApp (com e sem o 9), pelo e-mail ou pelo @, e a foto é guardada no bucket.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/funil.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { avancar, contatoInstagram, contatoPorTelefoneOuEmail, decidir, registrar, type Funil } from '../functions/_shared/funil.ts'
import { assinaturaValida, etapasDoRegistro, lerAviso, mesmoToken } from '../functions/_shared/funil-fontes.ts'
import { atualizarFoto, procurouHaPouco } from '../functions/_shared/fotos.ts'

/* ---------- Banco de mentira ---------- */
const UNICOS: Record<string, (a: any, b: any) => boolean> = {
  funil_eventos: (a, b) => a.funil_id === b.funil_id && a.fonte === b.fonte && a.chave === b.chave,
}
const digitos = (s: string) => String(s || '').replace(/\D/g, '')
function banco(tabelas: Record<string, any[]>) {
  let seq = 0
  const arquivos: Record<string, Uint8Array> = {}
  const from = (tabela: string) => {
    const filtros: ((r: any) => boolean)[] = []
    let op = 'select', valor: any = null, um = false, talvez = false, limite = Infinity
    const q: any = {
      select: () => q, order: () => q, range: () => q,
      eq: (k: string, v: any) => (filtros.push((r) => r[k] === v), q),
      in: (k: string, v: any[]) => (filtros.push((r) => v.includes(r[k])), q),
      ilike: (k: string, v: string) => (filtros.push((r) => String(r[k] ?? '').toLowerCase() === String(v).replace(/\\(.)/g, '$1').toLowerCase()), q),
      limit: (n: number) => ((limite = n), q),
      insert: (v: any) => ((op = 'insert'), (valor = v), q),
      update: (v: any) => ((op = 'update'), (valor = v), q),
      single: () => ((um = true), q), maybeSingle: () => ((talvez = true), q),
      then: (ok: any, erro: any) => Promise.resolve(executar()).then(ok, erro),
    }
    function executar() {
      const linhas = (tabelas[tabela] ??= [])
      if (op === 'insert') {
        const nova = { id: `${tabela}-${++seq}`, ...valor, ...(tabela === 'contacts' ? { phone_digits: digitos(valor.phone) } : {}) }
        if (linhas.some((r) => UNICOS[tabela]?.(r, nova))) return { data: null, error: { code: '23505' } }
        linhas.push(nova)
        return { data: nova, error: null }
      }
      const alvo = linhas.filter((r) => filtros.every((f) => f(r))).slice(0, limite)
      if (op === 'update') {
        for (const r of alvo) Object.assign(r, valor, tabela === 'contacts' && valor.phone ? { phone_digits: digitos(valor.phone) } : {})
        return { data: alvo, error: null }
      }
      if (um || talvez) return { data: alvo[0] ?? null, error: null }
      return { data: alvo, error: null }
    }
    return q
  }
  const storage = {
    from: () => ({
      upload: async (path: string, bytes: Uint8Array) => ((arquivos[path] = bytes), { error: null }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.teste/avatares/${path}` } }),
    }),
  }
  return { from, storage, arquivos }
}

const FUNIL: Funil = { id: 'f1', company_id: 'emp1', kanban_id: 'k1', ativo: true, colunas: { comentou: 'c1', clicou: 'c2', cadastrou: 'c3', grupo: 'c4', aula: 'c5', comprou: 'c6' } }

/* ---------- O card só anda para a frente ---------- */

Deno.test('decidir: sem card cria, etapa à frente move, etapa atrás ou igual mantém, card fora do funil não mexe', () => {
  assertEquals(decidir(FUNIL, null, 'aula'), 'criar')
  assertEquals(decidir(FUNIL, { column_id: 'c2' }, 'grupo'), 'mover')
  assertEquals(decidir(FUNIL, { column_id: 'c5' }, 'cadastrou'), 'manter')
  assertEquals(decidir(FUNIL, { column_id: 'c4' }, 'grupo'), 'manter')
  assertEquals(decidir(FUNIL, { column_id: 'coluna-da-equipe' }, 'comprou'), 'manter')
})

Deno.test('avancar: cria o card na coluna, move para a frente e guarda a data de cada etapa', async () => {
  const t: Record<string, any[]> = { kanban_cards: [] }
  const db = banco(t)
  const ct = { id: 'ct1', name: 'Ana' }
  assertEquals(await avancar(db, FUNIL, ct, 'cadastrou', '2026-10-23T10:00:00Z'), 'criado')
  assertEquals([t.kanban_cards[0].column_id, t.kanban_cards[0].title, t.kanban_cards[0].kanban_id], ['c3', 'Ana', 'k1'])
  assertEquals(await avancar(db, FUNIL, ct, 'aula', '2026-10-23T20:00:00Z'), 'movido')
  assertEquals(await avancar(db, FUNIL, ct, 'grupo', '2026-10-23T21:00:00Z'), 'mantido')
  assertEquals(t.kanban_cards.length, 1)
  assertEquals(t.kanban_cards[0].column_id, 'c5')
  assertEquals(t.kanban_cards[0].extra.funil, { cadastrou: '2026-10-23T10:00:00Z', aula: '2026-10-23T20:00:00Z', grupo: '2026-10-23T21:00:00Z' })
})

Deno.test('registrar: o mesmo aviso (mesma chave) conta uma vez só', async () => {
  const db = banco({})
  assert(await registrar(db, FUNIL, 'isca', 'lead:1'))
  assert(!(await registrar(db, FUNIL, 'isca', 'lead:1')))
  assert(await registrar(db, FUNIL, 'grupo', 'lead:1'))
})

/* ---------- Achar o contato ---------- */

Deno.test('contato pelo WhatsApp: acha com e sem o 9, completa o e-mail; sem achar, cria', async () => {
  const t: Record<string, any[]> = { contacts: [{ id: 'ct1', company_id: 'emp1', name: 'Bia', phone: '+550099123456', phone_digits: '550099123456', email: '' }] }
  const db = banco(t)
  const a = await contatoPorTelefoneOuEmail(db, 'emp1', { telefone: '+55 00 99912-3456', email: 'BIA@x.com', origem: 'Isca' })
  assertEquals(a.id, 'ct1')
  assertEquals(t.contacts[0].email, 'bia@x.com')
  const b = await contatoPorTelefoneOuEmail(db, 'emp1', { telefone: '00988887777', nome: 'Caio', origem: 'Vórtex Grupo' })
  assertEquals([b.name, b.phone, b.origin], ['Caio', '+5500988887777', 'Vórtex Grupo'])
  const c = await contatoPorTelefoneOuEmail(db, 'emp1', { email: 'bia@x.com', origem: 'Vórtex Webinar' })
  assertEquals(c.id, 'ct1')
  assertEquals(await contatoPorTelefoneOuEmail(db, 'emp1', { telefone: '123', origem: 'Isca' }), null)
})

Deno.test('contato do Instagram: acha pelo @ (sem diferenciar maiúscula), cria sem o id do Direct', async () => {
  const t: Record<string, any[]> = { contacts: [{ id: 'ct1', company_id: 'emp1', instagram_username: 'Ana.Souza', instagram_id: 'igsid-1' }] }
  const db = banco(t)
  assertEquals((await contatoInstagram(db, 'emp1', { username: '@ana.souza', id: 'outro' })).id, 'ct1')
  const novo = await contatoInstagram(db, 'emp1', { username: 'pedro_x', id: 'com-9', nome: 'Pedro' })
  assertEquals([novo.instagram_username, novo.instagram_id, novo.fields.instagramComentarioId, novo.origin], ['pedro_x', undefined, 'com-9', 'Instagram'])
  // _ não vira curinga: "pedroax" não é "pedro_x"
  assertEquals((await contatoInstagram(db, 'emp1', { username: 'pedroax' })).instagram_username, 'pedroax')
})

/* ---------- O que cada sistema manda ---------- */

const H = (o: Record<string, string> = {}) => new Headers(o)

Deno.test('isca: lead.novo vira "cadastrou" pelo id do lead; outros eventos são ignorados', () => {
  const a = lerAviso('isca', { id: 'L1', whatsapp: '+5500988887777', nome: 'Ana', email: '', isca: 'guia-guia-de-vendas', slug: 'guia', tema: 'Guia de vendas' }, H({ 'x-vortex-evento': 'lead.novo' }))
  assert(a.ok)
  assertEquals([a.etapa, a.chave, a.pessoa], ['cadastrou', 'lead:L1', { telefone: '+5500988887777', email: '', nome: 'Ana' }])
  assertEquals([a.detalhe?.isca, a.detalhe?.tema], ['guia', 'Guia de vendas'])
  assertEquals(lerAviso('isca', { id: 'L1' }, H({ 'x-vortex-evento': 'lead.etapa' })).ok, false)
})

Deno.test('grupo: "entrou" vira "grupo"; "saiu" é ignorado', () => {
  const a = lerAviso('grupo', { evento: 'entrou', telefone: '5500999999999', campanha: 'aula-12', grupo: 'AULA AO VIVO #12' }, H())
  assert(a.ok && a.etapa === 'grupo' && a.chave === 'entrou:5500999999999:aula-12:AULA AO VIVO #12')
  assertEquals(lerAviso('grupo', { evento: 'saiu', telefone: '5500999999999' }, H()).ok, false)
})

Deno.test('webinar: precisa do id do envio e de telefone ou e-mail', () => {
  const a = lerAviso('webinar', { nome: 'Ana', telefone: '+5500988887777', email: 'a@x.com' }, H({ 'X-VortexWebinar-Disparo': 'D9' }))
  assert(a.ok && a.etapa === 'aula' && a.chave === 'disparo:D9')
  assertEquals(lerAviso('webinar', { nome: 'Ana', telefone: '1' }, H()).ok, false)
  assertEquals(lerAviso('webinar', { nome: 'Ana' }, H({ 'X-VortexWebinar-Disparo': 'D9' })).ok, false)
})

Deno.test('plataforma: com produto configurado, só a compra dele vira "comprou"; outro produto é ignorado', () => {
  const corpo = { evento: 'compra.aprovada', pedido: 'P1', produto: { id: 'x', slug: 'curso' }, comprador: { nome: 'Ana', email: 'a@x.com', telefone: '+5500988887777' } }
  const a = lerAviso('plataforma', corpo, H(), 'curso')
  assert(a.ok && a.etapa === 'comprou' && a.chave === 'pedido:P1:x')
  const low = lerAviso('plataforma', { ...corpo, produto: { id: 'y', slug: 'ebook' } }, H(), 'curso')
  assert(!low.ok && low.chave === 'pedido:P1:y')
  // sem produto configurado, qualquer compra aprovada conta
  assert(lerAviso('plataforma', { ...corpo, produto: { id: 'y', slug: 'ebook' } }, H()).ok)
})

Deno.test('assinatura sha256=<hmac> do corpo e token comparados em tempo constante', async () => {
  const corpo = '{"evento":"entrou"}'
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('seg'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(corpo))), (b) => b.toString(16).padStart(2, '0')).join('')
  assert(await assinaturaValida(corpo, `sha256=${hex}`, 'seg'))
  assert(await assinaturaValida(corpo, hex, 'seg'))
  assert(!(await assinaturaValida(corpo + ' ', `sha256=${hex}`, 'seg')))
  assert(!(await assinaturaValida(corpo, null, 'seg')))
  assert(mesmoToken('abc', 'abc') && !mesmoToken('abc', 'abd') && !mesmoToken('', ''))
})

Deno.test('registro da automação: DM enviada = comentou; com clique = comentou e clicou; pulado = nada', () => {
  assertEquals(etapasDoRegistro({ id: '1', status: 'sent' }), ['comentou'])
  assertEquals(etapasDoRegistro({ id: '1', status: 'sent', clickedAt: '2026-10-23T10:00:00Z' }), ['comentou', 'clicou'])
  assertEquals(etapasDoRegistro({ id: '1', status: 'skipped' }), [])
})

/* ---------- Fotos ---------- */

Deno.test('foto do WhatsApp (API Web): baixa, guarda no bucket e marca a data; procura de novo só depois de 7 dias', async () => {
  const original = globalThis.fetch
  const chamadas: string[] = []
  globalThis.fetch = (async (url: string) => {
    chamadas.push(String(url))
    if (String(url).endsWith('/contact-picture')) return new Response(JSON.stringify({ hasPicture: true, url: 'https://pps.whatsapp.net/foto.jpg' }), { status: 200 })
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch
  try {
    const t: Record<string, any[]> = { contacts: [{ id: 'ct1', company_id: 'emp1', phone: '+5500988887777', avatar_at: null }] }
    const db = banco(t)
    const secret = { provider: 'zapbot', credentials: { baseUrl: 'https://zap.teste', instanceId: 'i', instanceToken: 't', clientToken: 'c' } }
    const url = await atualizarFoto(db, t.contacts[0], null, secret)
    assert(String(url).startsWith('https://cdn.teste/avatares/emp1/ct1-'))
    assertEquals(t.contacts[0].avatar_url, url)
    assert(t.contacts[0].avatar_at)
    assert(procurouHaPouco(t.contacts[0].avatar_at))
    assert(!procurouHaPouco(new Date(Date.now() - 8 * 86_400_000).toISOString()))
    chamadas.length = 0
    await atualizarFoto(db, t.contacts[0], null, secret)
    assertEquals(chamadas.length, 0) // já procurou há pouco
  } finally { globalThis.fetch = original }
})

Deno.test('foto: sem foto marca a data mesmo assim; API Oficial não procura; erro não quebra', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ hasPicture: false }), { status: 200 })) as typeof fetch
  try {
    const t: Record<string, any[]> = { contacts: [{ id: 'ct1', company_id: 'emp1', phone: '+5500988887777' }] }
    const db = banco(t)
    assertEquals(await atualizarFoto(db, t.contacts[0], null, { provider: 'zapbot', credentials: {} }), null)
    assert(t.contacts[0].avatar_at && !t.contacts[0].avatar_url)
    const t2: Record<string, any[]> = { contacts: [{ id: 'ct2', company_id: 'emp1', phone: '+5500988887777' }] }
    assertEquals(await atualizarFoto(banco(t2), t2.contacts[0], null, { provider: 'meta', credentials: {} }), null)
    assertEquals(t2.contacts[0].avatar_at, undefined)
    globalThis.fetch = (async () => { throw new Error('rede') }) as typeof fetch
    assertEquals(await atualizarFoto(banco({ contacts: [] }), { id: 'x', company_id: 'e', phone: '1' }, null, { provider: 'zapbot', credentials: {} }, true), null)
  } finally { globalThis.fetch = original }
})

Deno.test('webinar: cada regra vira a etapa certa (15 min = aula, pitch, clicou na oferta)', () => {
  const h = H({ 'X-VortexWebinar-Disparo': 'D1' })
  const de = (evento: string) => { const a = lerAviso('webinar', { evento, telefone: '+5500988887777' }, h); return a.ok ? a.etapa : null }
  assertEquals([de('permaneceu'), de('pitch'), de('clicou_oferta'), de('{{TAG}}')], ['aula', 'pitch', 'oferta', 'aula'])
})

Deno.test('checkout (Vórtex Pay): recusado, Pix e aprovada; outros eventos ignorados', () => {
  const corpo = (e: string) => ({ webhook_event_type: e, order_id: 'O1', Customer: { full_name: 'Ana Souza', email: 'a@x.com', mobile: '+5500988887777' } })
  const r = lerAviso('checkout', corpo('compra_recusada'), H())
  assert(r.ok && r.etapa === 'recusado' && r.chave === 'compra_recusada:O1' && r.pessoa.nome === 'Ana Souza' && r.pessoa.telefone === '+5500988887777')
  const p = lerAviso('checkout', corpo('pix_gerado'), H())
  assert(p.ok && p.etapa === 'pix')
  const a = lerAviso('checkout', corpo('compra_aprovada'), H())
  assert(a.ok && a.etapa === 'comprou')
  assertEquals(lerAviso('checkout', corpo('compra_reembolsada'), H()).ok, false)
  assertEquals(lerAviso('checkout', { webhook_event_type: 'pix_gerado' }, H()).ok, false)
})

Deno.test('ordem: Pix depois de cartão recusado anda; recusado depois de Pix fica no Pix', () => {
  const F: Funil = { ...FUNIL, colunas: { ...FUNIL.colunas, pitch: 'c7', oferta: 'c8', recusado: 'c9', pix: 'c10' } }
  assertEquals(decidir(F, { column_id: 'c9' }, 'pix'), 'mover')
  assertEquals(decidir(F, { column_id: 'c10' }, 'recusado'), 'manter')
  assertEquals(decidir(F, { column_id: 'c5' }, 'pitch'), 'mover')
  assertEquals(decidir(F, { column_id: 'c10' }, 'comprou'), 'mover')
})

Deno.test('dois avisos da mesma pessoa ao mesmo tempo: o segundo atualiza o card em vez de criar outro', async () => {
  const t: Record<string, any[]> = { kanban_cards: [] }
  const db = banco(t)
  // simula o índice único (um card por pessoa no quadro do funil) e o outro aviso chegando entre a busca e a criação
  const from = db.from
  let primeira = true
  ;(db as any).from = (tabela: string) => {
    const q = from(tabela)
    if (tabela !== 'kanban_cards') return q
    const insert = q.insert
    q.insert = (v: any) => {
      if (primeira) { primeira = false; t.kanban_cards.push({ id: 'outro', kanban_id: 'k1', contact_id: 'ct1', column_id: 'c4', extra: { funil: { grupo: 'x' } } }); return { then: (ok: any) => Promise.resolve({ data: null, error: { code: '23505' } }).then(ok) } }
      return insert(v)
    }
    return q
  }
  assertEquals(await avancar(db, FUNIL, { id: 'ct1', name: 'Ana' }, 'aula'), 'movido')
  assertEquals(t.kanban_cards.length, 1)
  assertEquals(t.kanban_cards[0].column_id, 'c5')
})

Deno.test('horário real: cada fonte traz a hora do acontecimento e a etapa guarda a mais antiga', async () => {
  const g = lerAviso('grupo', { evento: 'entrou', telefone: '5500999999999', campanha: 'aula', grupo: 'G', em: '2026-10-22T13:05:00Z' }, H())
  assert(g.ok && g.quando === '2026-10-22T13:05:00.000Z')
  const w = lerAviso('webinar', { evento: 'pitch', telefone: '+5500988887777', data: '2026-10-22T23:40:00Z' }, H({ 'X-VortexWebinar-Disparo': 'D' }))
  assert(w.ok && w.quando === '2026-10-22T23:40:00.000Z')
  const sem = lerAviso('webinar', { evento: 'pitch', telefone: '+5500988887777', data: '{{DATA}}' }, H({ 'X-VortexWebinar-Disparo': 'D' }))
  assert(sem.ok && sem.quando === undefined)
  const t: Record<string, any[]> = { kanban_cards: [] }
  const db = banco(t)
  await avancar(db, FUNIL, { id: 'ct1' }, 'grupo', '2026-10-23T10:00:00.000Z')
  await avancar(db, FUNIL, { id: 'ct1' }, 'grupo', '2026-10-22T13:05:00.000Z')
  await avancar(db, FUNIL, { id: 'ct1' }, 'grupo', '2026-10-23T20:00:00.000Z')
  assertEquals(t.kanban_cards[0].extra.funil.grupo, '2026-10-22T13:05:00.000Z')
})
