// Link público do rotacionador (Conexões → Rotacionador):
//   GET https://seu-dominio.com.br/r/<endereço>   (a Vercel repassa para /functions/v1/rotacionador/<endereço>)
// Cada clique vai para um dos números conectados do rotacionador (302 para wa.me, com a mensagem pronta), revezando a
// cada clique ou a cada hora. Número que caiu sai da roda na hora; sem nenhum no ar, vai para a página
// /rotacionador-indisponivel. Prévia de link (WhatsApp, Telegram...) recebe o próximo número sem andar a roda.
// Ninguém faz login para clicar: verify_jwt = false.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { companyModules } from '../_shared/access.ts'
import { isPreviewBot, numerosNoAr, slugOf, waLink } from '../_shared/rotacionador.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
// Endereço do painel (segredo SITE_URL), para onde vai quem clica num link sem número no ar
const SITE = (Deno.env.get('SITE_URL') || '').replace(/\/$/, '')

const go = (location: string) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Use GET.', { status: 405 })
  const url = new URL(req.url)
  const last = url.pathname.split('/').filter(Boolean).pop() || ''
  const slug = slugOf(last !== 'rotacionador' ? decode(last) : url.searchParams.get('s'))
  const fora = (motivo: string) => SITE
    ? go(`${SITE}/rotacionador-indisponivel?motivo=${motivo}${slug ? `&r=${slug}` : ''}`)
    : new Response('Link indisponível no momento.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  if (!slug) return fora('link')

  try {
    const { data: r } = await admin.from('rotators').select('id, company_id, connection_ids, message, active').eq('slug', slug).maybeSingle()
    if (!r?.active) return fora('link')
    if (!(await companyModules(admin, r.company_id)).has('conexoes')) return fora('link')
    const ids: string[] = r.connection_ids || []
    const { data: conns } = ids.length
      ? await admin.from('connections').select('id, number, status, provider').eq('company_id', r.company_id).in('id', ids)
      : { data: [] }
    const live = numerosNoAr(ids, conns || [])
    const count = req.method === 'GET' && !isPreviewBot(req.headers.get('user-agent'))
    const { data: chosen, error } = await admin.rpc('rotator_hit', { p_id: r.id, p_available: live.map((c) => c.id), p_count: count })
    if (error) console.error('rotator_hit', error.message)
    // se a contagem falhar, o clique não fica sem resposta: vai para o primeiro no ar
    const pick = live.find((c) => c.id === chosen) || live[0]
    return pick ? go(waLink(pick.number, r.message)) : fora('sem-numero')
  } catch (e) {
    console.error('rotacionador', e)
    return fora('erro')
  }
})
