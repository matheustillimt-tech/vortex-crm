// Disparos em massa (tela Disparos em Massa): cada disparo "andamento" manda o fluxo para o próximo contato da lista
// (dispatches.contacts), um de cada vez, respeitando o intervalo em segundos. Roda no flow-tick (a cada minuto).
// O progresso fica em dispatches.sent. Em extra: lastAt (último envio), failed e lastError (contatos em que o fluxo não
// começou) e reason (por que o disparo está parado ou foi cancelado).
import { startFlow } from './triggers.ts'
import { companyModules } from './access.ts'

const MIN_GAP_S = 5
export type DispatchStep =
  | { action: 'send'; contactId: string }
  | { action: 'wait'; ms: number }
  | { action: 'done' }
  | { action: 'invalid'; reason: string }

// O que fazer agora com um disparo: mandar para o próximo contato, esperar o intervalo, concluir ou cancelar
export function dispatchStep(d: any, now: number): DispatchStep {
  const contacts: string[] = Array.isArray(d.contacts) ? d.contacts : []
  if (!contacts.length) return { action: 'invalid', reason: 'Este disparo não guardou a lista de contatos (foi criado antes do envio real). Crie o disparo de novo.' }
  const sent = Number(d.sent) || 0
  if (sent >= contacts.length) return { action: 'done' }
  const gap = Math.max(MIN_GAP_S, Number(d.interval) || 15) * 1000
  const last = Date.parse(d.extra?.lastAt || '') || 0
  const ms = last + gap - now
  return ms > 0 ? { action: 'wait', ms } : { action: 'send', contactId: contacts[sent] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function processDispatches(admin: any, deadline: number) {
  const { data: list, error } = await admin.from('dispatches').select('*').eq('status', 'andamento').order('created_at').limit(20)
  if (error) return console.error('disparos', error.message)
  for (const first of list ?? []) {
    if (Date.now() > deadline - 2000) break
    let d = first
    const setExtra = (patch: Record<string, unknown>) => {
      d = { ...d, extra: { ...(d.extra || {}), ...patch } }
      return admin.from('dispatches').update({ extra: d.extra }).eq('id', d.id)
    }
    const step0 = dispatchStep(d, Date.now())
    if (step0.action === 'invalid') {
      await admin.from('dispatches').update({ status: 'cancelado', extra: { ...(d.extra || {}), reason: step0.reason } }).eq('id', d.id)
      continue
    }
    // fluxo pausado, apagado ou módulo tirado: o disparo espera (não gasta contatos) e a tela mostra o motivo
    const [{ data: flow }, { data: company }, modules] = await Promise.all([
      admin.from('flows').select('id, company_id, name, status, nodes, edges').eq('id', d.flow_id).eq('company_id', d.company_id).maybeSingle(),
      admin.from('companies').select('settings').eq('id', d.company_id).single(),
      companyModules(admin, d.company_id),
    ])
    const reason = !flow ? 'O fluxo deste disparo foi excluído.'
      : flow.status !== 'active' ? `O fluxo "${flow.name}" está pausado: ative o fluxo para o disparo continuar.`
      : !modules.has('disparos') || !modules.has('fluxos') || !modules.has('conexoes') ? 'Os módulos de disparos, fluxos ou conexões não estão liberados para a empresa.'
      : ''
    if (reason) {
      if (d.extra?.reason !== reason) await setExtra({ reason })
      continue
    }
    if (d.extra?.reason) await setExtra({ reason: '' })

    const env = { admin, companyId: d.company_id, settings: company?.settings || {}, modules }
    while (Date.now() < deadline - 2000) {
      const step = dispatchStep(d, Date.now())
      if (step.action === 'done') {
        await admin.from('dispatches').update({ status: 'concluido' }).eq('id', d.id).eq('status', 'andamento')
        break
      }
      if (step.action === 'invalid') break
      if (step.action === 'wait') {
        if (Date.now() + step.ms > deadline - 2000) break
        await sleep(step.ms)
        continue
      }
      // trava: só segue quem avançar o contador primeiro (duas rodadas nunca mandam para o mesmo contato)
      const { data: claimed } = await admin.from('dispatches')
        .update({ sent: d.sent + 1, extra: { ...(d.extra || {}), lastAt: new Date().toISOString() } })
        .eq('id', d.id).eq('sent', d.sent).eq('status', 'andamento').select('*')
      if (!claimed?.length) break
      d = claimed[0]
      const r = await startFlow(env, flow, null, {
        type: 'dispatch', key: `disparo:${d.id}:${step.contactId}`, contactId: step.contactId, connectionId: d.connection_id,
        data: { disparo: d.name || '' },
      })
      if (r.status === 'skipped' || r.status === 'error') {
        await setExtra({ failed: (Number(d.extra?.failed) || 0) + 1, lastError: r.reason || 'O fluxo não começou para este contato.' })
      }
    }
  }
}
