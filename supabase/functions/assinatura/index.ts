// Assinatura do plano (tela Cobrança e Assinatura), sempre com o login de quem chama:
//  - pagar (proprietário ou admin): cobrança do plano (plan_payment_create) + o link da oferta do plano na Vórtex Pay
//    com o código da cobrança. A oferta é fixa (plan_settings.checkout_url, criada no painel da Vórtex Pay): a API de
//    ofertas só aceita a partir de R$ 997. O plano só ativa quando o pagamento for confirmado (creditos-webhook).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { cors, json } from '../_shared/whatsapp.ts'
import { linkComRef } from '../_shared/pagamento-vortexpay.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  let body: any
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  if (body.action === 'pagar') {
    const { data: cfg } = await admin.from('plan_settings').select('vortexpay_product_id, checkout_url').eq('id', true).single()
    if (!cfg?.vortexpay_product_id || !String(cfg.checkout_url || '').startsWith('https://')) {
      return json({ error: 'O pagamento do plano ainda não foi ativado na plataforma. Fale com o suporte.', code: 'pagamento_nao_configurado' }, 503)
    }
    const { data: pg, error } = await userDb.rpc('plan_payment_create')
    if (error) return json({ error: error.message }, 400)
    const url = linkComRef(cfg.checkout_url, pg.ref)
    await admin.from('plan_payments').update({ checkout_url: url, updated_at: new Date().toISOString() }).eq('id', pg.id)
    return json({ id: pg.id, ref: pg.ref, url })
  }

  return json({ error: 'Ação desconhecida' }, 400)
})
