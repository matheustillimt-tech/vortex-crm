// Servidor MCP do Vórtex CRM, no mesmo modelo do Vórtex Grupo: transporte Streamable HTTP SEM estado (sem
// Mcp-Session-Id, sem SSE). POST recebe uma mensagem JSON-RPC 2.0 (ou um lote) e responde JSON; só notificações → 202.
// Autentica pela chave "vcrm_…" criada em Configurações → Ferramentas MCP (public.mcp_keys, só o hash fica no banco).
// Cada requisição (inclusive cada uma de um lote) conta no limite de 60 por minuto por chave; só 1 envio por lote.
// Publicar com --no-verify-jwt: quem chama manda a chave do MCP, não um login do Supabase.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { acharFerramenta, chamarFerramenta, listaDeFerramentas, type Chave } from './ferramentas.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const VERSAO_PROTOCOLO = '2025-06-18'
const VERSOES_SUPORTADAS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAXIMO_CORPO = 256 * 1024
const MAXIMO_LOTE = 20
const LIMITE_MINUTO = 60
const FORMATO_CHAVE = /^vcrm_[0-9A-Za-z]{40}$/
const ERRO = { parse: -32700, requisicaoInvalida: -32600, metodo: -32601, parametros: -32602 } as const

const INSTRUCOES =
  'Vórtex CRM: contatos, conversas e grupos de WhatsApp da empresa dona da chave. listar_* (inclusive listar_grupos), buscar_contatos, ver_contato e ler_conversa só leem. ' +
  'enviar_mensagem (privado) e enviar_mensagem_grupo (grupo) mandam mensagem REAL pelo WhatsApp da empresa: mostre ao usuário o destinatário (no grupo, nome e tamanho) e o texto e só envie depois do OK dele. ' +
  'Grupo só em conexão por QR Code; entre um grupo e outro, espace os envios. ' +
  'salvar_contato cria ou altera contato. Para mandar arquivo do computador: preparar_upload, PUT do arquivo no link, depois enviar_mensagem ou enviar_mensagem_grupo com arquivo.'

type Id = string | number | null
type Rpc = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } }

const ok = (id: Id, result: unknown): Rpc => ({ jsonrpc: '2.0', id, result })
const falha = (id: Id, code: number, message: string): Rpc => ({ jsonrpc: '2.0', id, error: { code, message } })
const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
const ehObjeto = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const ehId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
const ehRequisicao = (m: unknown) => ehObjeto(m) && typeof m.method === 'string' && 'id' in m

async function sha256(texto: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Chave do header → linha da chave, ou a resposta de erro pronta. Nunca loga a chave nem o header.
async function autenticar(req: Request): Promise<Chave | Response> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')
  if (!m || !FORMATO_CHAVE.test(m[1])) return json(falha(null, ERRO.requisicaoInvalida, 'Chave ausente ou inválida.'), 401)
  const { data, error } = await admin.from('mcp_keys').select('id, company_id, name, scope, revoked_at').eq('hash', await sha256(m[1])).maybeSingle()
  if (error) return json(falha(null, ERRO.requisicaoInvalida, 'Serviço indisponível. Tente de novo.'), 503)
  if (!data || data.revoked_at) return json(falha(null, ERRO.requisicaoInvalida, 'Chave ausente ou inválida.'), 401)
  return { id: data.id, companyId: data.company_id, nome: data.name, escopo: data.scope }
}

// Conta uma chamada; null = dentro do limite.
async function contarUso(chave: Chave): Promise<Response | null> {
  const { data, error } = await admin.rpc('mcp_register_use', { p_key: chave.id })
  if (error) return json(falha(null, ERRO.requisicaoInvalida, 'Serviço indisponível. Tente de novo.'), 503)
  if (Number(data) > LIMITE_MINUTO)
    return json(falha(null, ERRO.requisicaoInvalida, `Limite de ${LIMITE_MINUTO} chamadas por minuto. Espere um pouco.`), 429, { 'retry-after': String(60 - new Date().getUTCSeconds()) })
  return null
}

async function tratar(m: unknown, chave: Chave, permitirEnvio: boolean): Promise<Rpc | null> {
  if (!ehObjeto(m) || m.jsonrpc !== '2.0') return falha(ehObjeto(m) && ehId(m.id) ? m.id : null, ERRO.requisicaoInvalida, 'Requisição JSON-RPC inválida.')
  if (typeof m.method !== 'string') return 'result' in m || 'error' in m ? null : falha(ehId(m.id) ? m.id : null, ERRO.requisicaoInvalida, 'Requisição JSON-RPC inválida.')
  if (!('id' in m)) return null // notificação
  if (!ehId(m.id)) return falha(null, ERRO.requisicaoInvalida, 'id deve ser texto ou número.')
  const id = m.id
  const params = m.params === undefined ? {} : m.params
  if (!ehObjeto(params)) return falha(id, ERRO.parametros, 'params deve ser um objeto.')

  switch (m.method) {
    case 'initialize': {
      const pedida = params.protocolVersion
      return ok(id, {
        protocolVersion: typeof pedida === 'string' && VERSOES_SUPORTADAS.includes(pedida) ? pedida : VERSAO_PROTOCOLO,
        capabilities: { tools: {} },
        serverInfo: { name: 'Vórtex CRM', version: '1.0.0' },
        instructions: INSTRUCOES,
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: listaDeFerramentas() })
    case 'tools/call': {
      if (typeof params.name !== 'string') return falha(id, ERRO.parametros, 'Informe o nome da ferramenta (params.name).')
      const f = acharFerramenta(params.name)
      if (!f) return falha(id, ERRO.parametros, `Ferramenta desconhecida: ${params.name}`)
      if (f.envio && !permitirEnvio) return ok(id, { content: [{ type: 'text', text: 'Só um envio por chamada.' }], isError: true })
      const args = params.arguments === undefined ? {} : params.arguments
      if (!ehObjeto(args)) return falha(id, ERRO.parametros, 'arguments deve ser um objeto.')
      try {
        return ok(id, await chamarFerramenta(admin, f, chave, args))
      } catch (e) {
        console.error('mcp', f.name, e)
        return ok(id, { content: [{ type: 'text', text: 'Erro interno. Tente de novo.' }], isError: true })
      }
    }
    default:
      return falha(id, ERRO.metodo, `Método não encontrado: ${m.method}`)
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(falha(null, ERRO.requisicaoInvalida, 'Use POST: este servidor MCP não abre SSE nem guarda sessão.'), 405, { allow: 'POST' })
  // Navegador de outro site (DNS rebinding) não entra; CLI e servidores não mandam Origin.
  if (req.headers.get('origin')) return json(falha(null, ERRO.requisicaoInvalida, 'Origem não permitida.'), 403)

  const chave = await autenticar(req)
  if (chave instanceof Response) return chave
  const limite = await contarUso(chave)
  if (limite) return limite

  if (Number(req.headers.get('content-length')) > MAXIMO_CORPO) return json(falha(null, ERRO.requisicaoInvalida, 'Corpo grande demais.'), 413)
  const texto = await req.text()
  if (new TextEncoder().encode(texto).length > MAXIMO_CORPO) return json(falha(null, ERRO.requisicaoInvalida, 'Corpo grande demais.'), 413)
  let corpo: unknown
  try { corpo = JSON.parse(texto) } catch { return json(falha(null, ERRO.parse, 'JSON inválido.'), 400) }

  const lote = Array.isArray(corpo)
  const mensagens: unknown[] = lote ? corpo as unknown[] : [corpo]
  if (!mensagens.length) return json(falha(null, ERRO.requisicaoInvalida, 'Lote vazio.'), 400)
  if (mensagens.length > MAXIMO_LOTE) return json(falha(null, ERRO.requisicaoInvalida, `Lote grande demais (máximo ${MAXIMO_LOTE}).`), 400)

  const versao = req.headers.get('mcp-protocol-version')
  const temInitialize = mensagens.some((m) => ehObjeto(m) && m.method === 'initialize')
  if (versao && !temInitialize && !VERSOES_SUPORTADAS.includes(versao))
    return json(falha(null, ERRO.requisicaoInvalida, `Versão do protocolo MCP não suportada: ${versao.slice(0, 40)}. Use ${VERSAO_PROTOCOLO}.`), 400)

  // A autenticação já contou 1 chamada; cada requisição a mais do lote conta mais uma.
  for (let i = 1; i < mensagens.filter(ehRequisicao).length; i++) {
    const r = await contarUso(chave)
    if (r) return r
  }

  let envios = 0
  const respostas: Rpc[] = []
  for (const m of mensagens) {
    const ehEnvio = ehObjeto(m) && m.method === 'tools/call' && ehObjeto(m.params) && acharFerramenta(String(m.params.name))?.envio === true
    const permitir = !ehEnvio || envios === 0
    if (ehEnvio && permitir) envios++
    const r = await tratar(m, chave, permitir)
    if (r) respostas.push(r)
  }
  if (!respostas.length) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
  return json(lote ? respostas : respostas[0])
})
