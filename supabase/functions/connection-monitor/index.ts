// Chamado a cada 2 minutos pelo pg_cron. O Zapbot não avisa quando um número cai, então aqui se consulta o status
// de cada conexão Zapbot (e Z-API, instância da própria pessoa, que usa as mesmas rotas), atualiza o painel e, se a conexão acabou de cair, tenta um restart. Também liga no webhook o aviso
// das mensagens enviadas pelo próprio número (conexão nova pega na primeira rodada depois de criada).
// Em lotes, para aguentar muitos números: conexões e módulos de todas as empresas vêm de uma vez; as conferidas há
// mais tempo vão primeiro; até 8 consultas em paralelo, no máximo 20 chamadas por segundo (o limite do Zapbot é 30/s) e cada
// rodada para em 90 s (a próxima começa 2 min depois). Cada conexão é conferida no máximo a cada 90 s.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { json, webhookUrl } from '../_shared/whatsapp.ts'
import * as zap from '../_shared/zapbot.ts'
import { zapiStatus } from '../_shared/zapi.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const MIN_INTERVAL = 90_000
const BUDGET = 90_000
const PARALLEL = 8
const RATE = 20 // chamadas por segundo ao Zapbot nesta rodada (status e restart)
const PAGE = 1000
const CHUNK = 200 // ids por consulta .in() (mantém a URL curta)

// espaça o início das chamadas (1000/RATE ms entre uma e outra), seja qual for a velocidade de resposta
let nextSlot = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function slot() {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + 1000 / RATE
  if (at > now) await sleep(at - now)
}

const chunks = <T>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))

async function allSecrets() {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('connection_secrets').select('connection_id, company_id, provider, credentials').in('provider', ['zapbot', 'zapi']).order('connection_id').range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

async function byIds(table: string, col: string, ids: string[], cols: string) {
  const rows: any[] = []
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await admin.from(table).select(cols).in(col, part)
    if (error) throw error
    rows.push(...(data ?? []))
  }
  return rows
}

Deno.serve(async () => {
  const started = Date.now()
  const secrets = await allSecrets()
  const conns = new Map((await byIds('connections', 'id', secrets.map((s) => s.connection_id), 'id, status, number, extra')).map((c) => [c.id, c]))
  const companies = [...new Set(secrets.map((s) => s.company_id))]
  const access = await byIds('company_access', 'company_id', companies, 'company_id, effective')
  const withModule = new Set(access.filter((a) => (a.effective ?? []).includes('conexoes')).map((a) => a.company_id))

  const lastCheck = (c: any) => (c.extra?.lastCheckAt ? new Date(c.extra.lastCheckAt).getTime() : 0)
  const queue = secrets
    .map((s) => ({ s, conn: conns.get(s.connection_id) }))
    // sem a linha da conexão, empresa com Conexões suspenso (não mexe) ou conferida há menos de 90 s: fica para depois
    .filter(({ s, conn }) => conn && withModule.has(s.company_id) && Date.now() - lastCheck(conn) >= MIN_INTERVAL)
    .sort((a, b) => lastCheck(a.conn) - lastCheck(b.conn))

  let checked = 0
  let changed = 0
  let failed = 0
  let webhooks = 0
  const total = queue.length

  // Avisos do webhook (o que sai pelo celular): aplica quando o que está gravado na conexão é diferente do que ela
  // precisa. Mensagens de grupo ficam desligadas (o recebimento ignora grupos).
  const syncWebhook = async (_s: any, conn: any, creds: zap.ZapCreds & { webhookFlags?: zap.WebhookFlags }) => {
    if (!creds.webhookToken) return
    const flags: zap.WebhookFlags = { notifySentByMe: true, notifyGroupMessages: false }
    const now = creds.webhookFlags
    if (now?.notifySentByMe === flags.notifySentByMe && now?.notifyGroupMessages === flags.notifyGroupMessages) return
    await slot()
    await zap.setWebhook(creds, webhookUrl(conn.id, creds.webhookToken), flags)
    // só grava se a instância continua a mesma (a conexão pode ter sido recriada enquanto isso)
    await admin.from('connection_secrets').update({ credentials: { ...creds, webhookFlags: flags } })
      .eq('connection_id', conn.id).eq('credentials->>instanceId', creds.instanceId)
    webhooks++
  }

  const check = async ({ s, conn }: { s: any; conn: any }) => {
    const creds = s.credentials as zap.ZapCreds
    try {
      await slot()
      // Z-API: "error" do status é só texto de estado; o telefone (de /device) só quando a conexão ainda não tem número
      const st: { connected: boolean; phone: string; error?: string } = s.provider === 'zapi' ? await zapiStatus(creds, !conn.number) : await zap.status(creds)
      checked++
      const extra = conn.extra || {}
      const status = st.connected ? 'connected' : 'disconnected'
      // Z-API: o status não traz motivo; mantém o que o aviso de desconexão gravou até a conexão voltar
      const lastError = s.provider === 'zapi' ? (st.connected ? null : extra.lastError ?? null) : st.error ?? null
      const patch: Record<string, unknown> = { extra: { ...extra, lastCheckAt: new Date().toISOString(), lastError } }
      if (status !== conn.status) {
        patch.status = status
        changed++
      }
      if (st.connected && st.phone) patch.number = `+${st.phone.replace(/\D/g, '')}`
      // Caiu agora (estava conectada): tenta reconectar mantendo a sessão. Se o WhatsApp desvinculou, precisa parear de novo.
      if (!st.connected && conn.status === 'connected') await slot().then(() => zap.restart(creds)).catch((e) => console.error('restart', conn.id, e instanceof Error ? e.message : e))
      await admin.from('connections').update(patch).eq('id', conn.id)
      await syncWebhook(s, conn, creds).catch((e) => console.error('webhook', conn.id, e instanceof Error ? e.message : e))
    } catch (e) {
      failed++
      console.error('monitor', conn.id, e instanceof Error ? e.message : e)
      // Z-API (URL e credenciais da pessoa): a falha também conta como conferida, para ir para o fim da fila e não
      // segurar a rodada de todo mundo. No Zapbot continua como antes.
      if (s.provider === 'zapi') await admin.from('connections').update({ extra: { ...(conn.extra || {}), lastCheckAt: new Date().toISOString() } }).eq('id', conn.id).then(() => {}, () => {})
    }
  }

  // PARALLEL "trabalhadores" tirando da fila até ela acabar ou o tempo da rodada estourar
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length && Date.now() - started < BUDGET) await check(queue.shift()!)
  }))

  return json({ ok: true, total, checked, changed, failed, webhooks, pending: queue.length, ms: Date.now() - started })
})
