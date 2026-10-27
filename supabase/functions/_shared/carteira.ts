// Carteira de Créditos de IA (migration 0031). Só a chave da plataforma gasta crédito: loadCreds (ai.ts)
// entrega a credencial da plataforma já com o Medidor da empresa, e chat, transcribe e synthesize passam por
// comCreditos: reserva antes pela estimativa, chama o provedor, desconta o consumo apurado (ou devolve a reserva se o
// provedor falhou). Sem saldo, lança SemCreditos antes de chamar o provedor.
// O dinheiro (câmbio, acréscimo, multiplicador, valor do crédito) é calculado no banco; aqui só o custo em dólar.

// inteligencia, melhoria e validacao: Vórtex Inteligência (assistente, "Melhorar agente" e os testes da versão candidata)
export type Origem = 'atendimento' | 'teste' | 'verificacao' | 'vendas' | 'inteligencia' | 'melhoria' | 'validacao'
// ref: a que a operação pertence (conversa:<id>, job:<id>), gravada no uso técnico do extrato
export type Medidor = { admin: any; companyId: string; origem: Origem; agentId?: string | null; chatId?: string | null; ref?: string | null }
// Uso de uma operação. entrada inclui cache e áudio; custoUsd: o que o gateway informou (quando informa).
export type Uso = { entrada?: number; cache?: number; audioEntrada?: number; saida?: number; segundos?: number; caracteres?: number; custoUsd?: number | null; estimado?: boolean }
export type Modalidade = 'texto' | 'audio' | 'voz'
export type Operacao = { provedor: string; modelo: string; modalidade: Modalidade; descricao: string; estimativa: Uso }

export class SemCreditos extends Error {
  constructor(readonly disponivel: number | null, readonly motivo = 'saldo_insuficiente') {
    super(motivo === 'carteira_inativa' ? 'A IA da plataforma não está liberada para esta empresa' : 'Acabaram os Créditos de IA da empresa')
  }
}

export const medidor = (admin: any, companyId: string, o: { origem?: Origem; agentId?: string | null; chatId?: string | null; ref?: string | null } = {}): Medidor =>
  ({ admin, companyId, origem: o.origem || 'atendimento', agentId: o.agentId ?? null, chatId: o.chatId ?? null, ref: o.ref ?? null })

/* ---------- Preços (dólar), da tabela ai_prices ---------- */

type Precos = Record<string, Record<string, number>> // modelo → unidade → US$
let cache: { at: number; precos: Precos } | null = null
const CACHE_MS = 60_000

export async function precos(admin: any): Promise<Precos> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.precos
  const { data, error } = await admin.from('ai_prices').select('model, unit, usd')
  if (error) throw new Error(`preços da IA: ${error.message}`)
  const out: Precos = {}
  for (const r of data ?? []) (out[r.model] ||= {})[r.unit] = Number(r.usd)
  cache = { at: Date.now(), precos: out }
  return out
}
export const limparCachePrecos = () => { cache = null }

// "google/gemini-2.5-flash" → "gemini-2.5-flash" (o gateway põe o fornecedor na frente)
export const modeloBase = (m: string) => String(m || '').toLowerCase().trim().replace(/^[a-z0-9_.-]+\//, '')

// Preço do modelo: o nome exato, senão o mais longo que for começo dele (versões novas), senão o "*" de segurança.
export function precoDo(p: Precos, modelo: string): { preco: Record<string, number>; padrao: boolean } {
  const base = modeloBase(modelo)
  if (p[base]) return { preco: { ...p['*'], ...p[base] }, padrao: false }
  const casa = Object.keys(p).filter((k) => k !== '*' && base.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return casa ? { preco: { ...p['*'], ...p[casa] }, padrao: false } : { preco: p['*'] || {}, padrao: true }
}

// Custo em dólar de uma operação. Cache e áudio de entrada têm preço próprio (sem ele, valem como entrada comum).
export function custoUsd(p: Precos, modelo: string, u: Uso): { usd: number; padrao: boolean } {
  const { preco, padrao } = precoDo(p, modelo)
  const entrada = Math.max(0, u.entrada || 0)
  const cache = Math.min(entrada, Math.max(0, u.cache || 0))
  const audio = Math.min(entrada - cache, Math.max(0, u.audioEntrada || 0))
  const comum = entrada - cache - audio
  const pIn = preco.input_mtok ?? 0
  const usd = comum / 1e6 * pIn
    + cache / 1e6 * (preco.cached_mtok ?? pIn)
    + audio / 1e6 * (preco.audio_input_mtok ?? pIn)
    + Math.max(0, u.saida || 0) / 1e6 * (preco.output_mtok ?? 0)
    + Math.max(0, u.segundos || 0) / 3600 * (preco.stt_hour ?? 0)
    + Math.max(0, u.caracteres || 0) / 1000 * (preco.tts_kchar ?? 0)
  return { usd, padrao }
}

/* ---------- Estimativas (para reservar antes da chamada) ---------- */

// Tokens de entrada de uma conversa: texto ÷ 3,2 (português com JSON das ferramentas) + 1.500 por imagem (as
// imagens vão em base64 dentro da mensagem e não podem contar pelo tamanho do texto).
export function estimarEntrada(messages: any[], tools?: unknown[]): number {
  let chars = 0
  let imagens = 0
  for (const m of messages) {
    const c = m?.content
    if (typeof c === 'string') chars += c.length
    else if (Array.isArray(c)) for (const p of c) p?.type === 'image_url' ? imagens++ : (chars += String(p?.text || '').length)
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length
    chars += 12
  }
  if (tools?.length) chars += JSON.stringify(tools).length
  return Math.ceil(chars / 3.2) + imagens * 1500
}
// Resposta com folga para o raciocínio do modelo (que é cobrado como saída)
export const SAIDA_ESTIMADA = 2500
// Áudio de voz do WhatsApp (Opus, ~16 kbit/s): ~2 KB por segundo; mínimo de 5 s
export const segundosEstimados = (bytes: number) => Math.max(5, Math.ceil(bytes / 2000))

/* ---------- Reserva → provedor → desconto ---------- */

const chave = () => crypto.randomUUID()
// agente de rascunho e conversa de teste podem vir sem id de banco: no extrato só entra id de verdade
const uuidOu = (s: unknown) => (typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null)

// Antes do turno: a empresa tem saldo para pelo menos uma resposta? (evita baixar mídia e montar contexto à toa)
export async function exigirSaldo(m: Medidor) {
  const { data, error } = await m.admin.rpc('ai_wallet_available', { p_company: m.companyId })
  if (error) throw new Error(`saldo da IA: ${error.message}`)
  if (!data) throw new SemCreditos(null, 'carteira_inativa')
  if (data.modo === 'prepago' && Number(data.disponivel) <= 0) throw new SemCreditos(Number(data.disponivel))
}

export async function comCreditos<T>(m: Medidor, op: Operacao, chamar: () => Promise<{ valor: T; uso: Uso; modelo?: string }>): Promise<T> {
  const tabela = await precos(m.admin)
  const est = custoUsd(tabela, op.modelo, op.estimativa)
  const { data: r, error } = await m.admin.rpc('ai_wallet_reserve', {
    p_company: m.companyId, p_cost_usd: est.usd, p_key: chave(),
    p_meta: { origem: m.origem, agentId: m.agentId, chatId: m.chatId, modalidade: op.modalidade, modelo: op.modelo, ...(m.ref ? { ref: m.ref } : {}) },
  })
  if (error) throw new Error(`reserva de créditos: ${error.message}`)
  if (!r?.ok) throw new SemCreditos(r?.disponivel != null ? Number(r.disponivel) : null, r?.motivo || 'saldo_insuficiente')

  let res: { valor: T; uso: Uso; modelo?: string }
  try {
    res = await chamar()
  } catch (e) {
    // o provedor não respondeu: nada a cobrar
    await m.admin.rpc('ai_wallet_release', { p_reservation: r.id }).then(({ error: x }: any) => x && console.error('devolver reserva', x.message), () => undefined)
    throw e
  }

  const modelo = res.modelo || op.modelo
  const calc = custoUsd(tabela, modelo, res.uso)
  // o gateway informou o custo da chamada: vale ele (é o que ele cobra); senão, a tabela de preços
  const informado = typeof res.uso.custoUsd === 'number' && Number.isFinite(res.uso.custoUsd) && res.uso.custoUsd >= 0
  const usd = informado ? res.uso.custoUsd! : calc.usd
  const { data: s, error: e2 } = await m.admin.rpc('ai_wallet_settle', {
    p_reservation: r.id, p_cost_usd: usd,
    p_info: {
      descricao: op.descricao, agentId: uuidOu(m.agentId), chatId: uuidOu(m.chatId), origem: m.origem, modalidade: op.modalidade, provedor: op.provedor, modelo,
      estimado: !!res.uso.estimado, uso: { ...res.uso, custoTabelaUsd: calc.usd, precoPadrao: calc.padrao || undefined, custoInformado: informado || undefined, ref: m.ref || undefined },
    },
  })
  // a resposta já existe e segue: se o desconto falhar, a reserva vence sem descontar e o erro fica no log
  if (e2 || !s?.ok) console.error('desconto de créditos', e2?.message || s?.motivo, r.id)
  return res.valor
}
