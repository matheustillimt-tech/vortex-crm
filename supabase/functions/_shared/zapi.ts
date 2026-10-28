// Conexão "zapi": a pessoa cola uma instância que ela já tem no Z-API (ID, token, Client-Token e, se quiser, a URL base).
// As rotas de instância do Z-API são as mesmas do Zapbot (/instances/{id}/token/{token}/*, header Client-Token), então o
// envio, o QR Code e o webhook usam zapbot.ts. Aqui fica só o que é diferente:
// - o CRM nunca cria nem apaga instância na conta Z-API (não tem as credenciais da conta: nada de /account/*);
// - o Client-Token é opcional (só existe se a pessoa ativou o "Token de segurança da conta" no painel do Z-API);
// - GET /status não traz o telefone e o campo "error" vem sempre, como texto de estado ("You are not connected");
// - "remover" só desliga os webhooks da instância (best effort).
// Referência: https://developer.z-api.io (instance/status, instance/device, instance/qr-code-image, instance/phone-code,
// webhooks/update-every-webhooks, security/client-token), consultada em 28/10/2026.
import { instanceCall, status, ZapbotError, type ZapCreds } from './zapbot.ts'

export const ZAPI_DEFAULT_URL = 'https://api.z-api.io'

export const CHALLENGE_MSG =
  'Este celular pede a chave de acesso (passkey) para conectar. Conecte o número pelo painel do Z-API e depois volte aqui: o Vórtex CRM reconhece sozinho.'

const SAFE = /^[^\s/?#]+$/
export const CLIENT_TOKEN_HINT = 'Só preencha se você ligou o token de segurança da conta no Z-API.'

// URL base: só endereços do Z-API (https, *.z-api.io, porta padrão), reduzida à origem. O servidor chama essa URL com as
// credenciais (e o monitor a consulta a cada 2 minutos): host qualquer abriria chamada do servidor para endereço interno.
function zapiOrigin(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  if (host !== 'z-api.io' && !host.endsWith('.z-api.io')) return null
  return `https://${host}`
} // ID e token vão no caminho da URL: sem espaço, barra, ? ou #
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '')

// Credenciais coladas na tela. `webhookToken` é o segredo da URL do webhook desta conexão (quem chama decide se reaproveita).
export function zapiCredsFrom(body: any, webhookToken: string): { creds: ZapCreds } | { error: string } {
  const instanceId = str(body?.instanceId)
  const instanceToken = str(body?.instanceToken)
  const clientToken = str(body?.clientToken)
  const baseUrl = zapiOrigin(str(body?.baseUrl) || ZAPI_DEFAULT_URL)
  if (!instanceId || !instanceToken) return { error: 'Informe o ID e o token da instância do Z-API.' }
  if (!SAFE.test(instanceId) || !SAFE.test(instanceToken) || (clientToken && /\s/.test(clientToken))) {
    return { error: 'O ID, o token ou o Client-Token têm algum caractere estranho. Copie de novo do painel do Z-API.' }
  }
  if (!baseUrl) return { error: 'A URL base precisa ser um endereço do Z-API começando com https://, como https://api.z-api.io. Na dúvida, deixe em branco.' }
  return { creds: { baseUrl, instanceId, instanceToken, clientToken, webhookToken } }
}

// Telefone do número conectado (o /status do Z-API não traz).
export async function devicePhone(c: ZapCreds): Promise<string> {
  const r = await instanceCall(c, 'GET', 'device')
  return r.status === 200 ? digits(r.json.phone) : ''
}

// Status no Z-API. O "error" do Z-API é só o texto do estado, não uma recusa de pareamento como no Zapbot: fica de fora.
// `wantPhone`: consulta /device quando conectado (o monitor só pede se a conexão ainda não tem número).
export async function zapiStatus(c: ZapCreds, wantPhone = true): Promise<{ connected: boolean; phone: string }> {
  const st = await status(c)
  const connected = st.connected === true
  let phone = digits(st.phone)
  if (connected && !phone && wantPhone) phone = await devicePhone(c).catch(() => '')
  return { connected, phone }
}

// Desliga os webhooks da instância (ao remover a conexão ou trocar de instância). A doc não diz se aceita URL vazia:
// quem chama ignora a falha. Mesmo se ficar ligado, o webhook do CRM recusa (o segredo da conexão some).
export async function unhookZapi(c: ZapCreds) {
  const r = await instanceCall(c, 'PUT', 'update-every-webhooks', { value: '', notifySentByMe: false })
  if (r.status >= 300) throw new ZapbotError(r.status, r.json?.error ?? `HTTP ${r.status}`, r.json)
}

// Mensagem simples para o que dá errado ao conectar uma instância do Z-API. Nunca repete a resposta crua (pode ter o token).
export function zapiFriendlyError(e: unknown): string {
  if (e instanceof ZapbotError) {
    const msg = String(e.message || '')
    if (/not allowed|client[- ]?token/i.test(msg)) {
      return `O Z-API pediu o Client-Token (ou não aceitou o que foi colado). ${CLIENT_TOKEN_HINT} Ele fica na aba Segurança do painel do Z-API, em "Token de segurança da conta".`
    }
    if (/phone|telefone/i.test(msg)) return 'Número inválido. Use DDI + DDD + número, por exemplo 5511999999999.'
    if (e.status === 429) return 'Muitas tentativas seguidas. Aguarde alguns segundos e tente de novo.'
    if ([400, 401, 403, 404].includes(e.status) || /not found|invalid|inv[aá]lid/i.test(msg)) {
      return 'O Z-API não reconheceu essa instância. Confira o ID e o token da instância no painel do Z-API.'
    }
    return `O Z-API respondeu com erro (HTTP ${e.status}). Tente de novo em instantes.`
  }
  if (e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')) {
    return 'Não deu para falar com o Z-API nesse endereço. Confira a URL base (o padrão é https://api.z-api.io).'
  }
  return 'Não deu para falar com o Z-API agora. Tente de novo em instantes.'
}
