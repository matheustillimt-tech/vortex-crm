// O que cada sistema manda para o funil e como vira etapa. Puro (testado em supabase/tests/funil.test.ts).
// Endereço: /functions/v1/funil?f=<funil>&fonte=<isca|grupo|webinar|plataforma>&t=<token da fonte>
// - isca (iscas-vortex, webhook "lead.novo"): corpo webhook_dados_lead; assinatura x-vortex-assinatura: sha256=<hmac>
// - grupo (Vórtex Grupo, evento "entrou"): { evento, telefone, campanha, grupo, em }; X-Vortex-Grupo-Assinatura (ou
//   X-Vortex-Assinatura): sha256=<hmac>
// - webinar (Vórtex Webinar, regra "permaneceu" 15 min): corpo montado na regra; id do envio em X-VortexWebinar-Disparo
// - plataforma (área de membros, compra aprovada): { evento, pedido, produto{slug}, comprador{nome,email,telefone} };
//   x-vortex-assinatura: sha256=<hmac>. Se a fonte tiver `produto` configurado (funil_segredos), só esse slug conta.
// - checkout (Vórtex Pay, formato Kiwify): webhook_event_type
//   compra_recusada → recusado, pix_gerado → pix, compra_aprovada → comprou; Customer{full_name,email,mobile}
import type { Etapa } from './funil.ts'

export const FONTES = ['isca', 'grupo', 'webinar', 'plataforma', 'checkout'] as const
export type Fonte = (typeof FONTES)[number]

export type Aviso =
  | { ok: true; etapa: Etapa; chave: string; pessoa: { telefone?: string | null; email?: string | null; nome?: string | null }; detalhe?: Record<string, unknown>; quando?: string }
  | { ok: false; motivo: string; chave?: string }

const txt = (v: unknown) => (v == null ? '' : String(v)).trim()

/** Horário real do acontecimento (vem de cada sistema). Sem data válida, recente e não futura, vale a hora do aviso. */
export function dataValida(...vs: unknown[]): string | undefined {
  for (const v of vs) {
    const t = Date.parse(txt(v))
    if (Number.isFinite(t) && t <= Date.now() + 5 * 60_000 && t > Date.now() - 400 * 86_400_000) return new Date(t).toISOString()
  }
  return undefined
}

export function lerAviso(fonte: Fonte, corpo: any, headers: Headers, produto?: string | null): Aviso {
  if (fonte === 'isca') {
    const evento = txt(headers.get('x-vortex-evento') || corpo?.evento || 'lead.novo')
    if (evento !== 'lead.novo') return { ok: false, motivo: `evento ${evento} não usado` }
    const chave = txt(corpo?.id) || txt(headers.get('x-vortex-entrega'))
    if (!chave) return { ok: false, motivo: 'lead sem id' }
    return { ok: true, etapa: 'cadastrou', chave: `lead:${chave}`, pessoa: { telefone: corpo?.whatsapp, email: corpo?.email, nome: corpo?.nome },
      detalhe: { isca: txt(corpo?.slug) || txt(corpo?.isca).split('-')[0], tema: corpo?.tema, iscaId: corpo?.isca, utm: corpo?.origem?.utm_campaign || corpo?.origem?.utm_source },
      quando: dataValida(corpo?.criadoEm, corpo?.created_at) }
  }
  if (fonte === 'grupo') {
    if (txt(corpo?.evento) !== 'entrou') return { ok: false, motivo: `evento ${txt(corpo?.evento) || '?'} não usado` }
    const tel = txt(corpo?.telefone).replace(/\D/g, '')
    if (!tel) return { ok: false, motivo: 'sem telefone' }
    // a mesma pessoa entrando de novo no mesmo grupo não conta duas vezes
    return { ok: true, etapa: 'grupo', chave: `entrou:${tel}:${txt(corpo?.campanha)}:${txt(corpo?.grupo)}`, pessoa: { telefone: tel },
      detalhe: { campanha: corpo?.campanha_nome || corpo?.campanha, grupo: corpo?.grupo }, quando: dataValida(corpo?.em) }
  }
  if (fonte === 'webinar') {
    const chave = txt(headers.get('x-vortexwebinar-disparo'))
    if (!chave) return { ok: false, motivo: 'envio sem id (X-VortexWebinar-Disparo)' }
    // uma regra por gatilho no Vórtex Webinar; o corpo diz qual (permaneceu = ficou 15 min)
    const etapa = WEBINAR[txt(corpo?.evento)] ?? 'aula'
    if (!txt(corpo?.telefone) && !txt(corpo?.email)) return { ok: false, motivo: 'sem telefone nem e-mail', chave }
    const seg = Number(corpo?.tempo_seg)
    return { ok: true, etapa, chave: `disparo:${chave}`, pessoa: { telefone: corpo?.telefone, email: corpo?.email, nome: corpo?.nome },
      detalhe: { webinar: corpo?.webinar, ...(Number.isFinite(seg) && seg > 0 ? { minutos: Math.round(seg / 60) } : {}) }, quando: dataValida(corpo?.data) }
  }
  if (fonte === 'checkout') {
    const evento = txt(corpo?.webhook_event_type)
    const etapa = CHECKOUT[evento]
    const pedido = txt(corpo?.order_id || corpo?.order_ref)
    if (!etapa) return { ok: false, motivo: `evento ${evento || '?'} não usado`, ...(pedido ? { chave: `${evento}:${pedido}` } : {}) }
    if (!pedido) return { ok: false, motivo: 'pedido sem id' }
    const c = corpo?.Customer || {}
    const valor = Number(corpo?.Commissions?.charge_amount)
    return { ok: true, etapa, chave: `${evento}:${pedido}`, pessoa: { telefone: c.mobile, email: c.email, nome: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') },
      detalhe: { pedido: corpo?.order_ref || pedido, produto: corpo?.Product?.product_name, pagamento: corpo?.payment_method, ...(Number.isFinite(valor) && valor > 0 ? { valor: valor / 100 } : {}) },
      quando: etapa === 'comprou' ? dataValida(corpo?.approved_date, corpo?.updated_at, corpo?.created_at) : dataValida(corpo?.updated_at, corpo?.created_at) }
  }
  // plataforma
  if (txt(corpo?.evento) !== 'compra.aprovada') return { ok: false, motivo: `evento ${txt(corpo?.evento) || '?'} não usado` }
  const chave = `pedido:${txt(corpo?.pedido)}:${txt(corpo?.produto?.id || corpo?.produto?.slug)}`
  if (produto && txt(corpo?.produto?.slug) !== produto) return { ok: false, motivo: `produto ${txt(corpo?.produto?.slug) || '?'} não é o do funil (${produto})`, chave }
  const c = corpo?.comprador || {}
  return { ok: true, etapa: 'comprou', chave, pessoa: { telefone: c.telefone, email: c.email, nome: c.nome }, detalhe: { pedido: corpo?.pedido, produto: corpo?.produto?.nome }, quando: dataValida(corpo?.em) }
}

const WEBINAR: Record<string, Etapa> = { permaneceu: 'aula', pitch: 'pitch', oferta: 'pitch', clicou_oferta: 'oferta' }
const CHECKOUT: Record<string, Etapa> = { compra_recusada: 'recusado', pix_gerado: 'pix', compra_aprovada: 'comprou' }

/** Headers de assinatura de cada fonte (as que assinam); vale o primeiro que vier no aviso. */
export const HEADER_ASSINATURA: Partial<Record<Fonte, string[]>> = {
  isca: ['x-vortex-assinatura'], grupo: ['x-vortex-grupo-assinatura', 'x-vortex-assinatura'], plataforma: ['x-vortex-assinatura'],
}
export const headerAssinatura = (fonte: Fonte, headers: Headers) => {
  for (const h of HEADER_ASSINATURA[fonte] ?? []) { const v = headers.get(h); if (v) return v }
  return null
}

/** sha256=<hex> (ou só o hex) = HMAC-SHA256 do corpo cru com o segredo. Comparação em tempo constante. */
export async function assinaturaValida(raw: string, header: string | null, segredo: string) {
  if (!header || !segredo) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), (b) => b.toString(16).padStart(2, '0')).join('')
  const dado = header.trim().toLowerCase().replace(/^sha256=/, '')
  if (dado.length !== hex.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ dado.charCodeAt(i)
  return diff === 0
}

export function mesmoToken(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/* ---------- Clique no link da DM (registros das automações de comentário da Zernio) ---------- */

export type RegistroZernio = { id: string; commenterId?: string; commenterUsername?: string; commenterName?: string; commentText?: string; source?: string; status?: string; clickedAt?: string | null; clickCount?: number; createdAt?: string }

/** O que a automação diz da isca: nome, palavra-chave e o link do botão (o slug da isca vem do link). */
export function detalheDaAutomacao(a: any) {
  const url = String((a?.buttons || []).find((b: any) => b?.url)?.url || '')
  let isca = ''
  // ISCAS_DOMINIO (opcional): só links desse domínio contam como isca (ex.: iscas.seu-dominio.com.br)
  const dominio = (typeof Deno !== 'undefined' ? Deno.env.get('ISCAS_DOMINIO') : '') || ''
  try { const u = new URL(url); if (!dominio || u.hostname === dominio || u.hostname.endsWith('.' + dominio)) isca = u.pathname.split('/').filter(Boolean)[0] || '' } catch { /* sem link */ }
  return { automacao: a?.name, palavra: (a?.keywords || []).join(', '), isca, link: url }
}

/** Etapas que um registro comprova: DM enviada = comentou; com clique = clicou. */
export function etapasDoRegistro(r: RegistroZernio): Etapa[] {
  const out: Etapa[] = []
  const enviada = ['sent', 'delivered', 'read', 'success', 'completed'].includes(String(r.status || '').toLowerCase())
  const clicou = !!r.clickedAt || Number(r.clickCount || 0) > 0
  if (enviada || clicou) out.push('comentou')
  if (clicou) out.push('clicou')
  return out
}
