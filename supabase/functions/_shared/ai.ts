// Provedores de IA do agente. Um formato só: o da API da OpenAI (/chat/completions com ferramentas), aceito pela
// OpenAI, pelo Google Gemini (endpoint compatível), Groq, DeepSeek, OpenRouter e outros. Trocar de provedor é trocar
// a chave em Configurações → Integrações; o motor do agente não muda.
// - Chaves por empresa: public.ai_credentials (só o servidor lê).
// - Sem chave da empresa vale a chave da plataforma, nos segredos das Edge Functions: AI_PROVIDER (openai |
//   gemini | compat), AI_API_KEY, AI_MODEL e, no compat, AI_BASE_URL. Áudio: ELEVENLABS_API_KEY (e ELEVENLABS_VOICE_ID,
//   opcional). Só para empresa com a carteira de IA ativa (public.ai_wallets): as outras não gastam a nossa chave.
// - "simulado": respostas automáticas para testar o atendimento sem provedor (só entra por SQL).
// - Créditos de IA (carteira.ts): a credencial da plataforma sai daqui com o Medidor da empresa, e toda chamada com
//   ela (conversa, transcrição, voz, teste) reserva e desconta créditos. Chave da empresa não passa pela carteira.
import { comCreditos, estimarEntrada, medidor as novoMedidor, SAIDA_ESTIMADA, segundosEstimados, type Medidor, type Origem } from './carteira.ts'

export type AiCred = { provider: string; apiKey: string; model: string; baseUrl: string; source: 'empresa' | 'plataforma'; medidor?: Medidor }
export type Creds = Record<string, AiCred>

export const PROVIDERS: Record<string, { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  compat: { label: 'Compatível com OpenAI', baseUrl: '', model: '' },
  simulado: { label: 'Simulado (testes)', baseUrl: '', model: 'simulado' },
}
const CHAT_ORDER = ['openai', 'gemini', 'compat', 'simulado']

export class AiError extends Error {
  constructor(message: string, readonly kind: 'config' | 'auth' | 'limite' | 'modelo' | 'provedor', readonly status = 0) {
    super(message)
  }
}

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMsg =
  | { role: 'system' | 'user'; content: string | ChatPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
export type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ParsedCall = { id: string; name: string; args: Record<string, unknown>; parseError?: string }
// usage.output já inclui o raciocínio do modelo (cobrado como saída); cached e cost só quando o provedor informa
export type ChatResult = { text: string; calls: ParsedCall[]; message: ChatMsg; usage: { input: number; output: number; cached?: number; cost?: number | null }; model: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------- Chaves ---------- */

// As chaves da plataforma entram como "plataforma" (conversa) e "elevenlabs_plataforma" (áudio), só com a carteira ativa,
// e levam o Medidor: quem chama diz a origem (atendimento, teste, verificação, vendas), o agente e a conversa.
export async function loadCreds(admin: any, companyId: string, uso: { origem?: Origem; agentId?: string | null; chatId?: string | null; ref?: string | null } = {}): Promise<Creds> {
  const out: Creds = {}
  const [{ data }, { data: wallet }] = await Promise.all([
    admin.from('ai_credentials').select('provider, api_key, model, base_url').eq('company_id', companyId),
    admin.from('ai_wallets').select('active').eq('company_id', companyId).maybeSingle(),
  ])
  for (const r of data ?? []) {
    if (!r.api_key && r.provider !== 'simulado') continue
    out[r.provider] = { provider: r.provider, apiKey: r.api_key, model: r.model || PROVIDERS[r.provider]?.model || '', baseUrl: r.base_url || PROVIDERS[r.provider]?.baseUrl || '', source: 'empresa' }
  }
  if (wallet?.active) {
    const m = novoMedidor(admin, companyId, uso)
    const chat = platformChat()
    if (chat) out.plataforma = { ...chat, medidor: m }
    const eleven = Deno.env.get('ELEVENLABS_API_KEY') || ''
    if (eleven) out.elevenlabs_plataforma = { provider: 'elevenlabs', apiKey: eleven, model: '', baseUrl: '', source: 'plataforma', medidor: m }
  }
  return out
}

function platformChat(): AiCred | null {
  const provider = Deno.env.get('AI_PROVIDER') || ''
  const apiKey = Deno.env.get('AI_API_KEY') || ''
  if (!PROVIDERS[provider] || provider === 'simulado' || !apiKey) return null
  return { provider, apiKey, model: Deno.env.get('AI_MODEL') || PROVIDERS[provider].model, baseUrl: Deno.env.get('AI_BASE_URL') || PROVIDERS[provider].baseUrl, source: 'plataforma' }
}

// Qual chave responde: a escolhida no agente (se conectada), senão a primeira conectada na empresa, senão a da plataforma.
export function pickChatCred(creds: Creds, preferred?: string): AiCred | null {
  if (preferred && creds[preferred]) return creds[preferred]
  for (const p of CHAT_ORDER) if (creds[p]) return creds[p]
  return creds.plataforma ?? null
}

// A da empresa primeiro; a da plataforma vem com o Medidor (gasta créditos)
const elevenCred = (creds: Creds): AiCred | null => (creds.elevenlabs?.apiKey ? creds.elevenlabs : creds.elevenlabs_plataforma?.apiKey ? creds.elevenlabs_plataforma : null)
const elevenKey = (creds: Creds) => elevenCred(creds)?.apiKey || ''
const openaiAudio = (creds: Creds): AiCred | null => {
  if (creds.openai) return creds.openai
  const p = creds.plataforma
  return p?.provider === 'openai' ? p : null
}

// Para a tela do agente: o que está disponível para ouvir e falar.
export function audioSupport(creds: Creds) {
  const sim = !!creds.simulado
  return { hear: sim || !!elevenKey(creds) || !!openaiAudio(creds), speak: sim || !!elevenKey(creds) || !!openaiAudio(creds) }
}

/* ---------- Conversa (chat completions com ferramentas) ---------- */

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60_000) {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      if (attempt < 1) { await sleep(1500); continue }
      throw new AiError(`Sem resposta do provedor de IA (${(e as Error).name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`, 'provedor')
    }
    const text = await res.text()
    let json: any = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 300) } }
    if (res.ok) return json
    const retry = res.status === 429 || res.status >= 500
    if (retry && attempt < 2) {
      const wait = Math.min(10_000, (+(res.headers.get('retry-after') || 0) * 1000) || 1500 * 2 ** attempt)
      await sleep(wait)
      continue
    }
    const msg = String((Array.isArray(json) ? json[0]?.error?.message : json?.error?.message) || json?.message || json?.raw || `HTTP ${res.status}`).slice(0, 300)
    if (res.status === 401 || res.status === 403) throw new AiError(`O provedor recusou a chave de API (${msg}).`, 'auth', res.status)
    if (res.status === 404) throw new AiError(`Modelo ou endereço não encontrado no provedor (${msg}).`, 'modelo', res.status)
    if (res.status === 429) throw new AiError(`Limite de uso do provedor atingido (${msg}).`, 'limite', res.status)
    throw new AiError(`Erro do provedor de IA: ${msg}`, 'provedor', res.status)
  }
}

const DESCRICAO: Record<Origem, string> = {
  atendimento: 'Resposta da IA', teste: 'Teste ao vivo do agente', verificacao: 'Teste da chave de IA', vendas: 'Agente de vendas',
  inteligencia: 'Vórtex Inteligência', melhoria: 'Melhoria do agente', validacao: 'Validação do agente',
}

export async function chat(cred: AiCred, req: { messages: ChatMsg[]; tools?: ToolDef[] }): Promise<ChatResult> {
  if (cred.provider === 'simulado') return simulate(req)
  if (!cred.medidor) return chatRaw(cred, req)
  const model = cred.model || PROVIDERS[cred.provider]?.model || ''
  return comCreditos(cred.medidor, {
    provedor: cred.provider, modelo: model, modalidade: 'texto', descricao: DESCRICAO[cred.medidor.origem],
    estimativa: { entrada: estimarEntrada(req.messages, req.tools), saida: SAIDA_ESTIMADA },
  }, async () => {
    const r = await chatRaw(cred, req)
    return { valor: r, modelo: r.model, uso: { entrada: r.usage.input, cache: r.usage.cached, saida: r.usage.output, custoUsd: r.usage.cost ?? null } }
  })
}

async function chatRaw(cred: AiCred, req: { messages: ChatMsg[]; tools?: ToolDef[] }): Promise<ChatResult> {
  const base = (cred.baseUrl || PROVIDERS[cred.provider]?.baseUrl || '').replace(/\/+$/, '')
  const model = cred.model || PROVIDERS[cred.provider]?.model
  if (!base) throw new AiError('Falta a URL base do provedor de IA.', 'config')
  if (!model) throw new AiError('Falta o nome do modelo de IA.', 'config')
  // corpo mínimo: parâmetros como max_tokens e temperature mudam de nome ou são recusados conforme o modelo
  const body: Record<string, unknown> = { model, messages: req.messages }
  if (req.tools?.length) { body.tools = req.tools; body.tool_choice = 'auto' }
  // OpenRouter informa o custo de cada chamada quando pedido (vira o custo comprovado na carteira)
  if (/(^|\.)openrouter\.ai$/i.test(hostOf(base))) body.usage = { include: true }
  const j = await post(`${base}/chat/completions`, { Authorization: `Bearer ${cred.apiKey}` }, body)
  const msg = j.choices?.[0]?.message
  if (!msg) throw new AiError('O provedor de IA não devolveu resposta.', 'provedor')
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).filter((t: any) => t?.function?.name).map((t: any, i: number) => ({
    id: t.id || `call_${i}_${Date.now()}`, type: 'function', function: { name: t.function.name, arguments: t.function.arguments || '{}' },
  }))
  const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text || '').join('') : ''
  return {
    text: (content || '').trim(),
    calls: toolCalls.map(parseCall),
    message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    usage: usageOf(j.usage),
    model: j.model || model,
  }
}

const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return '' } }

// Uso informado pelo provedor. O endpoint compatível do Google não soma o raciocínio na saída (só no total); os
// gateways já somam. Raciocínio é cobrado como saída, então a saída vale o maior dos dois.
export function usageOf(u: any): ChatResult['usage'] {
  const input = Math.max(0, Number(u?.prompt_tokens) || 0)
  const completion = Math.max(0, Number(u?.completion_tokens) || 0)
  const total = Math.max(0, Number(u?.total_tokens) || 0)
  const cost = Number(u?.cost)
  return {
    input,
    output: Math.max(completion, total - input),
    cached: Math.max(0, Number(u?.prompt_tokens_details?.cached_tokens) || 0) || undefined,
    cost: u?.cost != null && Number.isFinite(cost) && cost >= 0 ? cost : null,
  }
}

function parseCall(t: ToolCall): ParsedCall {
  try {
    const args = JSON.parse(t.function.arguments || '{}')
    return { id: t.id, name: t.function.name, args: args && typeof args === 'object' ? args : {} }
  } catch {
    return { id: t.id, name: t.function.name, args: {}, parseError: 'argumentos em JSON inválido' }
  }
}

// Teste rápido da chave (Configurações → Integrações → Testar).
export async function checkChat(cred: AiCred) {
  const t0 = Date.now()
  const r = await chat(cred, { messages: [{ role: 'user', content: 'Responda só com a palavra OK.' }] })
  return { ok: true, model: r.model, reply: r.text.slice(0, 40), ms: Date.now() - t0 }
}

/* ---------- Provedor simulado (testes) ---------- */
// Responde com um resumo do que recebeu. Ações de teste: "#acao <ferramenta> {json}" no texto do cliente;
// "#baloes" responde em três balões; "#vazio" não responde nada.
function simulate(req: { messages: ChatMsg[]; tools?: ToolDef[] }): ChatResult {
  const msgs = req.messages
  const last = msgs[msgs.length - 1]
  const reply = (text: string, calls: ToolCall[] = []): ChatResult => ({
    text, calls: calls.map(parseCall), model: 'simulado', usage: { input: 0, output: 0 },
    message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
  })
  if (last?.role === 'tool') {
    const results: string[] = []
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i--) results.unshift(String((msgs[i] as any).content))
    return reply(`[simulado] Resultado das ações: ${results.join(' | ')}`)
  }
  const texts: string[] = []
  let images = 0
  for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'user'; i--) {
    const c = (msgs[i] as any).content
    if (typeof c === 'string') texts.unshift(c)
    else for (const p of c as ChatPart[]) p.type === 'text' ? texts.unshift(p.text) : images++
  }
  const said = texts.join(' / ')
  const sys = String((msgs.find((m) => m.role === 'system') as any)?.content || '')
  const tools = (req.tools ?? []).map((t) => t.function.name)
  const calls: ToolCall[] = [...said.matchAll(/#acao\s+(\w+)\s*(\{[^#]*?\})?(?=\s*(#|$|\/))/g)].map((m, i) => ({
    id: `sim_${i}_${Date.now()}`, type: 'function', function: { name: m[1], arguments: m[2] || '{}' },
  }))
  if (calls.length) return reply('', calls)
  if (/#vazio/.test(said)) return reply('')
  if (/#baloes/.test(said)) return reply('[simulado] Primeiro balão.\n\nSegundo balão.\n\nTerceiro balão.')
  const facts = [
    `conhecimento: ${sys.includes('# Conhecimento') ? 'sim' : 'não'}`,
    `imagens: ${images}`,
    `ferramentas: ${tools.join(',') || 'nenhuma'}`,
  ]
  return reply(`[simulado] Recebi: "${said.slice(0, 400)}" (${facts.join(' · ')})`)
}

/* ---------- Áudio: ouvir (transcrição) e falar (voz) ---------- */

const extOf = (mime: string) => (mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : mime.includes('webm') ? 'webm' : 'ogg')

// Transcreve o áudio do cliente. ElevenLabs (Scribe) primeiro, senão OpenAI (whisper-1). Sem provedor: null.
export async function transcribe(creds: Creds, bytes: Uint8Array, mime: string): Promise<{ text: string; provider: string } | null> {
  if (creds.simulado) return { text: '[transcrição simulada do áudio]', provider: 'simulado' }
  const blob = new Blob([bytes as BlobPart], { type: mime || 'audio/ogg' })
  const name = `audio.${extOf(mime)}`
  // duração cobrada: a do arquivo (voz do WhatsApp é Ogg/Opus); sem ela, pelo tamanho (estimativa)
  const exata = duracaoOgg(bytes)
  const segundos = exata ?? segundosEstimados(bytes.byteLength)
  const medir = <T>(cred: AiCred, modelo: string, fn: () => Promise<T | null>) => (cred.medidor
    ? comCreditos(cred.medidor, { provedor: cred.provider, modelo, modalidade: 'audio', descricao: `Transcrição de áudio (${Math.round(segundos)} s)`, estimativa: { segundos: segundosEstimados(bytes.byteLength) } },
      async () => { const v = await fn(); if (v === null) throw new AiError('transcrição recusada', 'provedor'); return { valor: v, uso: { segundos, estimado: exata === null } } })
    : fn())
  const ev = elevenCred(creds)
  if (ev) {
    const t = await medir(ev, 'scribe_v2', async () => {
      const form = new FormData()
      form.append('file', blob, name)
      form.append('model_id', 'scribe_v2')
      form.append('language_code', 'pt')
      form.append('tag_audio_events', 'false')
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ev.apiKey }, body: form, signal: AbortSignal.timeout(60_000) })
      if (r.ok) {
        const j = await r.json()
        if (typeof j.text === 'string') return { text: j.text.trim(), provider: 'elevenlabs' }
      } else console.error('transcrição elevenlabs', r.status, (await r.text()).slice(0, 200))
      return null
    }).catch((e) => { if (e instanceof AiError) return null; throw e })
    if (t) return t
  }
  const oa = openaiAudio(creds)
  if (oa) {
    return await medir(oa, 'whisper-1', async () => {
      const form = new FormData()
      form.append('file', blob, name)
      form.append('model', 'whisper-1')
      form.append('language', 'pt')
      const base = (oa.baseUrl || PROVIDERS.openai.baseUrl).replace(/\/+$/, '')
      const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${oa.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) })
      if (r.ok) {
        const j = await r.json()
        if (typeof j.text === 'string') return { text: j.text.trim(), provider: 'openai' }
      } else console.error('transcrição openai', r.status, (await r.text()).slice(0, 200))
      return null
    }).catch((e) => { if (e instanceof AiError) return null; throw e })
  }
  return null
}

// Duração de um Ogg/Opus (a voz do WhatsApp): posição da última página ÷ 48 kHz, menos o pre-skip. null se não for Ogg/Opus.
export function duracaoOgg(b: Uint8Array): number | null {
  if (b.length < 64 || b[0] !== 0x4f || b[1] !== 0x67 || b[2] !== 0x67 || b[3] !== 0x53) return null
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  const head = ascii(28, 8) === 'OpusHead' ? 28 : -1
  if (head < 0) return null
  const preSkip = b[head + 10] | (b[head + 11] << 8)
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] !== 0x4f || b[i + 1] !== 0x67 || b[i + 2] !== 0x67 || b[i + 3] !== 0x53) continue
    let g = 0
    for (let k = 7; k >= 0; k--) g = g * 256 + b[i + 6 + k]
    const s = (g - preSkip) / 48000
    return s > 0 && s < 4 * 3600 ? s : null
  }
  return null
}

let elevenDefaultVoice: string | null = null
async function elevenVoice(key: string, wanted?: string) {
  if (wanted) return wanted
  if (Deno.env.get('ELEVENLABS_VOICE_ID')) return Deno.env.get('ELEVENLABS_VOICE_ID')!
  if (elevenDefaultVoice) return elevenDefaultVoice
  // sem voz definida: a primeira voz da conta
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15_000) })
  const j = r.ok ? await r.json() : {}
  elevenDefaultVoice = j.voices?.[0]?.voice_id || null
  return elevenDefaultVoice
}

// Gera a voz do agente (mp3). ElevenLabs primeiro (voz escolhida em Vozes), senão OpenAI. Sem provedor: null.
export async function synthesize(creds: Creds, text: string, voice: { elevenVoiceId?: string } = {}): Promise<{ bytes: Uint8Array; mime: string; provider: string } | null> {
  if (creds.simulado) return { bytes: new TextEncoder().encode('ID3 audio simulado'), mime: 'audio/mpeg', provider: 'simulado' }
  type Voz = { bytes: Uint8Array; mime: string; provider: string }
  // a voz é cobrada por caractere do texto (a ElevenLabs informa no cabeçalho character-cost)
  const medir = (cred: AiCred, modelo: string, fn: () => Promise<{ voz: Voz; caracteres?: number } | null>): Promise<Voz | null> => (cred.medidor
    ? comCreditos(cred.medidor, { provedor: cred.provider, modelo, modalidade: 'voz', descricao: `Resposta em áudio (${text.length} caracteres)`, estimativa: { caracteres: text.length } },
      async () => { const v = await fn(); if (!v) throw new AiError('voz recusada', 'provedor'); return { valor: v.voz, uso: { caracteres: v.caracteres ?? text.length } } })
    : fn().then((v) => v?.voz ?? null)
  ).catch((e) => { if (e instanceof AiError) return null; throw e })
  const ev = elevenCred(creds)
  if (ev) {
    const id = await elevenVoice(ev.apiKey, voice.elevenVoiceId)
    if (id) {
      const v = await medir(ev, 'eleven_multilingual_v2', async () => {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
          method: 'POST', headers: { 'xi-api-key': ev.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }), signal: AbortSignal.timeout(60_000),
        })
        if (r.ok) return { voz: { bytes: new Uint8Array(await r.arrayBuffer()), mime: 'audio/mpeg', provider: 'elevenlabs' }, caracteres: Number(r.headers.get('character-cost')) || undefined }
        console.error('voz elevenlabs', r.status, (await r.text()).slice(0, 200))
        return null
      })
      if (v) return v
    }
  }
  const oa = openaiAudio(creds)
  if (oa) {
    const base = (oa.baseUrl || PROVIDERS.openai.baseUrl).replace(/\/+$/, '')
    for (const model of ['gpt-4o-mini-tts', 'tts-1']) {
      const v = await medir(oa, model, async () => {
        const r = await fetch(`${base}/audio/speech`, {
          method: 'POST', headers: { Authorization: `Bearer ${oa.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, voice: 'alloy', input: text, response_format: 'mp3' }), signal: AbortSignal.timeout(60_000),
        })
        if (r.ok) return { voz: { bytes: new Uint8Array(await r.arrayBuffer()), mime: 'audio/mpeg', provider: 'openai' } }
        console.error('voz openai', model, r.status, (await r.text()).slice(0, 200))
        return null
      })
      if (v) return v
    }
  }
  return null
}

// Teste da chave da ElevenLabs (Integrações → Testar).
export async function checkEleven(key: string) {
  const t0 = Date.now()
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15_000) })
  if (r.status === 401 || r.status === 403) throw new AiError('A ElevenLabs recusou a chave de API.', 'auth', r.status)
  if (!r.ok) throw new AiError(`Erro da ElevenLabs (HTTP ${r.status}).`, 'provedor', r.status)
  const j = await r.json()
  return { ok: true, model: `${j.voices?.length ?? 0} vozes na conta`, reply: '', ms: Date.now() - t0 }
}

/* ---------- utilitários ---------- */

export function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// Tipo real da imagem pelos primeiros bytes (o informado pelo WhatsApp às vezes vem errado).
export function imageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  const ascii = (a: number, z: number) => String.fromCharCode(...b.subarray(a, z))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  return null
}
