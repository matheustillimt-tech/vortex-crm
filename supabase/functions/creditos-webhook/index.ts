// Aviso de pagamento da Vórtex Pay para a recarga de Créditos de IA e para o pagamento do plano. URL única:
//   POST https://SEU-PROJETO.supabase.co/functions/v1/creditos-webhook
// Cadastrar na Vórtex Pay (Webhooks) com o Secret HMAC idêntico ao segredo VORTEXPAY_WEBHOOK_SECRET.
// Ordem: assinatura X-Webhook-Signature (obrigatória; sem ela nada é creditado) → guarda o aviso (o mesmo pedido e
// evento valem uma vez; reenvio de aviso ainda não resolvido é processado de novo) → _shared/recarga.ts.
// Responde 200 para todo aviso assinado (o desfecho fica em ai_payment_events) e 401 sem assinatura válida.
// verify_jwt = false: quem chama é a Vórtex Pay.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json } from '../_shared/whatsapp.ts'
import { assinaturaConfere, lerAviso } from '../_shared/pagamento-vortexpay.ts'
import { processarAviso } from '../_shared/recarga.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const MAX_BODY = 256 * 1024
const FINAIS = ['creditado', 'ativado', 'estornado', 'ignorado', 'invalido']

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length > MAX_BODY) return json({ error: 'Corpo muito grande.' }, 413)
  let corpo: any = null
  try { corpo = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* fica null */ }

  const assinado = await assinaturaConfere(bytes, req.headers.get('x-webhook-signature'), Deno.env.get('VORTEXPAY_WEBHOOK_SECRET'))
  if (!assinado) {
    // sem o pedido no registro: um aviso falso não pode ocupar o lugar do verdadeiro
    await admin.from('ai_payment_events').insert({ event_type: String(corpo?.webhook_event_type || '').slice(0, 60), signature_ok: false, status: 'invalido',
      reason: Deno.env.get('VORTEXPAY_WEBHOOK_SECRET') ? 'assinatura inválida ou ausente' : 'VORTEXPAY_WEBHOOK_SECRET não configurado', payload: corpo ?? {} })
    return json({ error: 'assinatura inválida' }, 401)
  }

  const aviso = lerAviso(corpo)
  const pedido = 'pedido' in aviso ? aviso.pedido ?? null : null
  const tipo = String(corpo?.webhook_event_type || '').slice(0, 60)
  const novo = await admin.from('ai_payment_events').insert({ event_type: tipo, order_id: pedido, signature_ok: true, status: 'recebido', payload: corpo ?? {} }).select('id, payload').single()
  let ev = novo.data
  if (novo.error) {
    if (novo.error.code !== '23505') { console.error('creditos-webhook', novo.error.message); return json({ error: 'falha ao guardar o aviso' }, 500) }
    // reenvio: se o primeiro ainda não resolveu (em análise, sem vínculo, erro), processa de novo com o corpo novo
    const { data: antes } = await admin.from('ai_payment_events').select('id, status').eq('provider', 'vortexpay').eq('order_id', pedido).eq('event_type', tipo).neq('status', 'repetido').single()
    if (!antes || FINAIS.includes(antes.status)) {
      await admin.from('ai_payment_events').insert({ event_type: tipo, order_id: pedido, signature_ok: true, status: 'repetido', reason: `já tratado (${antes?.status || '?'})`, payload: corpo ?? {} })
      return json({ ok: true, repetido: true })
    }
    await admin.from('ai_payment_events').update({ payload: corpo ?? {} }).eq('id', antes.id)
    ev = { id: antes.id, payload: corpo }
  }
  try {
    const r = await processarAviso(admin, ev!)
    return json({ ok: true, ...r })
  } catch (e) {
    console.error('creditos-webhook processar', e)
    await admin.from('ai_payment_events').update({ status: 'erro', reason: String((e as Error)?.message || e).slice(0, 300) }).eq('id', ev!.id)
    return json({ error: 'falha ao processar' }, 500)
  }
})
