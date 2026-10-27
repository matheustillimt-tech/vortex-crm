// Funil no Kanban (supabase/functions/_shared/funil.ts). verify_jwt = false (publicar com --no-verify-jwt):
// - POST ?f=<funil>&fonte=<isca|grupo|webinar|plataforma>&t=<token>: aviso de outro sistema. O token da fonte (e, nas que
//   assinam, a assinatura HMAC) autentica. Responde 200 também para aviso ignorado, para o sistema não reenviar.
// - POST { action: "tick" } (pg_cron, a cada 5 min): lê os registros das automações de comentário da Zernio que
//   dispararam nos últimos 3 dias e move para "Comentou" / "Clicou na isca". Só lê; cada registro conta uma vez.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json } from '../_shared/whatsapp.ts'
import { anotar, avancar, contatoInstagram, contatoPorTelefoneOuEmail, ORIGEM, registrar, type Funil } from '../_shared/funil.ts'
import { registrarPagamento } from '../_shared/inteligencia/pagamentos.ts'
import { assinaturaValida, detalheDaAutomacao, etapasDoRegistro, FONTES, HEADER_ASSINATURA, headerAssinatura, lerAviso, mesmoToken, type Fonte, type RegistroZernio } from '../_shared/funil-fontes.ts'
import { zernio } from '../_shared/zernio.ts'
import { connectionSecret, zernioVault } from '../_shared/secrets.ts'
import { atualizarFoto } from '../_shared/fotos.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JANELA_MS = 3 * 86_400_000
const LIMITE_MS = 100_000 // por rodada; o que sobrar fica para a próxima (cada registro conta uma vez)
// A chave da Zernio tem limite por minuto para a conta inteira (600/min com 3+ contas), dividido com as publicações e
// automações da pessoa. A rotina usa no máximo ~80 chamadas por minuto, para nunca atrapalhar o resto.
const INTERVALO_ZERNIO_MS = 750
let ultimaChamada = 0
async function zernioDevagar(path: string, key: string) {
  const espera = ultimaChamada + INTERVALO_ZERNIO_MS - Date.now()
  if (espera > 0) await new Promise((r) => setTimeout(r, espera))
  ultimaChamada = Date.now()
  return zernio('GET', path, undefined, {}, key)
}

/** Todas as linhas de uma consulta, de 1000 em 1000 (o limite do PostgREST por chamada). */
async function todas(consulta: (de: number, ate: number) => any, max = 20000) {
  const out: any[] = []
  for (let de = 0; de < max; de += 1000) {
    const { data, error } = await consulta(de, de + 999)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const url = new URL(req.url)
  const raw = await req.text()
  if (!url.searchParams.get('f')) {
    let body: any = {}
    try { body = JSON.parse(raw || '{}') } catch { /* nada */ }
    if (body.action !== 'tick') return json({ error: 'Ação desconhecida' }, 400)
    // responde na hora (o pg_net desiste em segundos) e trabalha em segundo plano até o limite de tempo
    const trabalho = Promise.all([tick(), fotosPendentes()]).then((r) => console.log('funil tick', JSON.stringify(r))).catch((e) => console.error('funil tick', e))
    // @ts-ignore EdgeRuntime existe no runtime da Supabase
    EdgeRuntime.waitUntil(trabalho)
    return json({ ok: true, iniciado: true })
  }
  return receber(url, raw, req.headers)
})

/* ---------- Avisos dos outros sistemas ---------- */

async function receber(url: URL, raw: string, headers: Headers) {
  const f = url.searchParams.get('f') || ''
  const fonte = url.searchParams.get('fonte') as Fonte
  if (!UUID.test(f) || !FONTES.includes(fonte)) return json({ error: 'Endereço inválido' }, 404)
  const [{ data: funil }, { data: seg }] = await Promise.all([
    admin.from('funis').select('*').eq('id', f).eq('ativo', true).maybeSingle(),
    admin.from('funil_segredos').select('fontes').eq('funil_id', f).maybeSingle(),
  ])
  const cfg = seg?.fontes?.[fonte]
  if (!funil || !cfg?.token || !mesmoToken(url.searchParams.get('t') || '', cfg.token)) return json({ error: 'Não autorizado' }, 401)
  if (HEADER_ASSINATURA[fonte] && cfg.segredo && !(await assinaturaValida(raw, headerAssinatura(fonte, headers), cfg.segredo))) return json({ error: 'Assinatura inválida' }, 401)

  let corpo: any
  try { corpo = JSON.parse(raw) } catch { return json({ error: 'JSON inválido' }, 400) }
  // Vórtex Inteligência: o aviso do checkout também vira pedido normalizado (repetido não conta duas vezes)
  if (fonte === 'checkout') await registrarPagamento(admin, funil.company_id, corpo)
  const aviso = lerAviso(fonte, corpo, headers, cfg.produto)
  if (!aviso.ok) {
    if (aviso.chave) await registrar(admin, funil, fonte, aviso.chave, { status: 'ignorado', motivo: aviso.motivo, payload: corpo }).catch(() => {})
    return json({ ok: true, ignorado: aviso.motivo })
  }
  const novo = await registrar(admin, funil, fonte, aviso.chave, { etapa: aviso.etapa, payload: corpo })
  if (!novo) return json({ ok: true, repetido: true })
  try {
    const contact = await contatoPorTelefoneOuEmail(admin, funil.company_id, { ...aviso.pessoa, origem: ORIGEM[fonte] })
    if (!contact) {
      await anotar(admin, funil, fonte, aviso.chave, { status: 'ignorado', motivo: 'sem telefone nem e-mail válido' })
      return json({ ok: true, ignorado: 'sem telefone nem e-mail válido' })
    }
    const r = await avancar(admin, funil, contact, aviso.etapa, aviso.quando, aviso.detalhe ?? null)
    await anotar(admin, funil, fonte, aviso.chave, { contact_id: contact.id, motivo: r })
    return json({ ok: true, etapa: aviso.etapa, card: r })
  } catch (e) {
    const motivo = String((e as Error)?.message || e).slice(0, 300)
    await anotar(admin, funil, fonte, aviso.chave, { status: 'erro', motivo })
    // apaga o registro para o sistema poder reenviar e tentar de novo
    await admin.from('funil_eventos').delete().eq('funil_id', funil.id).eq('fonte', fonte).eq('chave', aviso.chave.slice(0, 300))
    console.error('funil', fonte, motivo)
    return json({ error: 'Falha ao processar' }, 500)
  }
}

/* ---------- Fotos de perfil que faltam (todas as empresas) ---------- */

// Contatos com conversa recente que nunca foram procurados: 30 por rodada, das conversas mais recentes para as antigas.
async function fotosPendentes() {
  const inicio = Date.now()
  // contatos nunca procurados, dos mais recentes para os mais antigos; cada um vai uma vez (avatar_at marca)
  const { data: contatos } = await admin.from('contacts').select('*').is('avatar_at', null).order('created_at', { ascending: false }).limit(60)
  const segredos = new Map<string, any>()
  let achadas = 0, procuradas = 0
  for (const c of contatos || []) {
    if (Date.now() - inicio > 60_000 || procuradas >= 30) break
    const { data: chats } = await admin.from('chats').select('id, connection_id, external_id').eq('contact_id', c.id).not('connection_id', 'is', null).order('last_message_at', { ascending: false }).limit(1)
    const chat = chats?.[0]
    if (!chat) {
      // sem conversa (ex.: só comentou no Instagram): marca para não voltar nele toda rodada
      await admin.from('contacts').update({ avatar_at: new Date().toISOString() }).eq('id', c.id)
      continue
    }
    if (!segredos.has(chat.connection_id)) segredos.set(chat.connection_id, await connectionSecret(admin, chat.connection_id).catch(() => null))
    const url = await atualizarFoto(admin, c, chat, segredos.get(chat.connection_id))
    procuradas++
    if (url) achadas++
  }
  return { fotos: { procuradas, achadas } }
}

/* ---------- Cliques no link da DM (Zernio) ---------- */

async function tick() {
  const inicio = Date.now()
  const desde = new Date(Date.now() - JANELA_MS).toISOString()
  const { data: funis } = await admin.from('funis').select('*').eq('ativo', true)
  const out: Record<string, unknown> = {}
  for (const funil of (funis || []) as Funil[]) {
    // uma pessoa = um card: une contatos e cards repetidos (avisos simultâneos podem criar a mesma pessoa duas vezes)
    const { data: unidos, error: erroUnir } = await admin.rpc('funil_unir_duplicados', { p_funil: funil.id })
    if (erroUnir) console.error('unir repetidos', erroUnir.message)
    else out[`unidos:${funil.id}`] = unidos
    // o que já foi lido (cada registro × etapa conta uma vez): carrega de uma vez e só trata o que é novo
    const feitos = new Set((await todas((de, ate) => admin.from('funil_eventos').select('chave').eq('funil_id', funil.id).eq('fonte', 'zernio')
      .gte('recebido_em', new Date(Date.now() - JANELA_MS - 86_400_000).toISOString()).range(de, ate), 100000)).map((r: any) => r.chave))
    // Instagrams da empresa conectados pela chave da Zernio
    const { data: conns } = await admin.from('connections').select('id').eq('company_id', funil.company_id).eq('provider', 'instagram')
    for (const conn of conns || []) {
      const v = await zernioVault(admin, conn.id)
      if (!v.apiKey) continue
      // automações que mandaram DM por esta conta nos últimos 3 dias
      const evs = await todas((de, ate) => admin.from('zernio_events').select('aid:payload->message->>automationId').eq('connection_id', conn.id)
        .eq('event', 'message.sent').gte('received_at', desde).not('payload->message->>automationId', 'is', null).range(de, ate))
      const automacoes = [...new Set(evs.map((e: any) => e.aid).filter(Boolean))] as string[]
      let lidos = 0, movidos = 0
      for (const aid of automacoes.slice(0, 40)) {
        if (Date.now() - inicio > LIMITE_MS) break // a rotina roda de novo em 5 min
        // nome, palavra-chave e isca da automação (vão para o card, junto com o comentário da pessoa)
        const auto = await zernioDevagar(`/comment-automations/${encodeURIComponent(aid)}`, v.apiKey).catch(() => null)
        const daAutomacao = detalheDaAutomacao(auto?.automation ?? auto?.data ?? auto)
        // a cada rodada só a página mais nova; os 3 dias inteiros (cliques em DMs mais antigas) uma vez por hora
        const paginas = new Date().getMinutes() < 5 ? 1000 : 100
        for (let skip = 0; skip < paginas; skip += 100) {
          if (Date.now() - inicio > LIMITE_MS) break
          const j = await zernioDevagar(`/comment-automations/${encodeURIComponent(aid)}/logs?limit=100&skip=${skip}`, v.apiKey).catch((e) => {
            console.error('logs da automação', aid, e instanceof Error ? e.message : e)
            return null
          })
          const logs: RegistroZernio[] = j?.logs || []
          for (const r of logs) {
            if (Date.now() - inicio > LIMITE_MS) break
            if (r.createdAt && r.createdAt < desde) continue
            lidos++
            for (const etapa of etapasDoRegistro(r)) {
              const chave = `${r.id}:${etapa}:v2` // v2: com o detalhe (isca, comentário); a v1 não tinha
              if (feitos.has(chave)) continue
              feitos.add(chave)
              if (!(await registrar(admin, funil, 'zernio', chave, { etapa }))) continue
              try {
                const contact = await contatoInstagram(admin, funil.company_id, { username: r.commenterUsername, id: r.commenterId, nome: r.commenterName, connectionId: conn.id })
                if (!contact) {
                  await anotar(admin, funil, 'zernio', chave, { status: 'ignorado', motivo: 'registro sem @' })
                  continue
                }
                const detalhe = etapa === 'comentou'
                  ? { ...daAutomacao, comentario: r.commentText, por: r.source === 'dm' ? 'Direct' : r.source === 'story_reply' ? 'resposta ao story' : 'comentário' }
                  : { isca: daAutomacao.isca, link: daAutomacao.link, cliques: r.clickCount }
                const res = await avancar(admin, funil, contact, etapa, r.clickedAt && etapa === 'clicou' ? r.clickedAt : (r.createdAt || undefined), detalhe)
                if (res === 'criado' || res === 'movido') movidos++
                await anotar(admin, funil, 'zernio', chave, { contact_id: contact.id, motivo: res })
              } catch (e) {
                // tira o registro para tentar de novo na próxima rodada
                await admin.from('funil_eventos').delete().eq('funil_id', funil.id).eq('fonte', 'zernio').eq('chave', chave)
                feitos.delete(chave)
                console.error('funil zernio', chave, e instanceof Error ? e.message : e)
              }
            }
          }
          const ultimo = logs[logs.length - 1]?.createdAt
          if (!j?.pagination?.hasMore || logs.length < 100 || (ultimo && ultimo < desde)) break
        }
      }
      out[conn.id] = { automacoes: automacoes.length, lidos, movidos }
    }
  }
  return { ok: true, ...out, ms: Date.now() - inicio }
}
