// Créditos de IA (painel). Ações (sempre com o login de quem chama):
//  - comprar     (proprietário ou admin): pedido de recarga do pacote (ai_recharge_create) + o link de pagamento com o
//                código da recarga. O link é o da oferta fixa do pacote (ai_credit_packages.checkout_url, criada no painel
//                da Vórtex Pay); sem ele, a oferta é criada pela API (que só aceita a partir de R$ 997). Os créditos só
//                entram quando o pagamento for confirmado (creditos-webhook).
//  - reprocessar (superadmin): processa de novo um aviso de pagamento guardado (em análise, sem vínculo ou erro).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { linkComRef } from '../_shared/pagamento-vortexpay.ts'
import { PAY_KEY, PAY_URL, processarAviso } from '../_shared/recarga.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  if (body.action === 'comprar') {
    const [{ data: cfg }, { data: pacote }] = await Promise.all([
      admin.from('ai_billing_settings').select('vortexpay_product_id').eq('id', true).single(),
      admin.from('ai_credit_packages').select('checkout_url').eq('id', body.packageId).maybeSingle(),
    ])
    const fixo = typeof pacote?.checkout_url === 'string' && pacote.checkout_url.startsWith('https://') ? pacote.checkout_url : ''
    if (!cfg?.vortexpay_product_id || (!fixo && !PAY_KEY())) {
      return json({ error: 'A compra de créditos ainda não foi ativada na plataforma. Fale com o suporte.', code: 'pagamento_nao_configurado' }, 503)
    }
    const { data: rc, error } = await userDb.rpc('ai_recharge_create', { p_package: body.packageId })
    if (error) return json({ error: error.message }, 400)
    const pronto = async (link: string) => {
      const url = linkComRef(link, rc.ref)
      await admin.from('ai_recharges').update({ checkout_url: url, updated_at: new Date().toISOString() }).eq('id', rc.id)
      return json({ id: rc.id, ref: rc.ref, url })
    }
    // oferta fixa do pacote: abre direto (o valor pago é conferido no aviso de pagamento)
    if (fixo) return pronto(fixo)
    const falhou = async (motivo: string, msg: string, status = 502) => {
      await admin.from('ai_recharges').update({ status: 'cancelada', note: motivo.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', rc.id)
      return json({ error: msg }, status)
    }
    let r: Response
    try {
      r = await fetch(`${PAY_URL}/api/integracao/ofertas`, {
        method: 'POST', headers: { Authorization: `Bearer ${PAY_KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ produtoId: cfg.vortexpay_product_id, valorCentavos: rc.priceCents, autor: 'Vórtex CRM · Créditos de IA' }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      return falhou(`Vórtex Pay fora do ar: ${(e as Error).message}`, 'A Vórtex Pay não respondeu. Tente de novo em instantes.')
    }
    const j = await r.json().catch(() => ({}))
    if (r.status === 422) return falhou(`abaixo do mínimo da Vórtex Pay (${j.minimoCentavos ?? '?'})`, `Valor abaixo do mínimo da Vórtex Pay${j.minimoCentavos ? ` (${reais(j.minimoCentavos)})` : ''}. Fale com o suporte.`, 400)
    if (!r.ok || typeof j.url !== 'string') return falhou(`Vórtex Pay HTTP ${r.status}: ${String(j.erro || '').slice(0, 200)}`, 'Não deu para gerar o link de pagamento. Tente de novo em instantes.')
    return pronto(j.url)
  }

  if (body.action === 'reprocessar') {
    const { data: isSuper } = await userDb.rpc('am_i_superadmin')
    if (!isSuper) return json({ error: 'Só o superadmin.' }, 403)
    const { data: ev } = await admin.from('ai_payment_events').select('id, payload, signature_ok, status').eq('id', body.eventId).maybeSingle()
    if (!ev) return json({ error: 'Aviso não encontrado.' }, 404)
    if (!ev.signature_ok) return json({ error: 'Aviso sem assinatura válida: não pode creditar.' }, 400)
    if (!['sem_vinculo', 'em_analise', 'erro', 'recebido'].includes(ev.status)) return json({ error: `Este aviso já foi tratado (${ev.status}).` }, 400)
    return json(await processarAviso(admin, ev))
  }

  return json({ error: 'Ação desconhecida' }, 400)
})
