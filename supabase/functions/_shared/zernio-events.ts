// O que fazer com cada evento da Zernio (zernio-webhook). Separado do handler HTTP para dar para testar.
import { companyModules } from './access.ts'
import { handleInstagramInbound } from './inbound.ts'
import { parseZernioMessage } from './zernio.ts'
import { connectionSecret } from './secrets.ts'
import { avancar, funilDaEmpresa } from './funil.ts'

const INBOX = new Set(['message.received', 'message.sent'])

export async function connectionByAccount(admin: any, accountId: string) {
  if (!accountId) return null
  const { data: secret } = await admin.from('connection_secrets').select('connection_id').eq('provider', 'instagram').eq('credentials->>accountId', accountId).maybeSingle()
  if (!secret) return null
  const { data: conn } = await admin.from('connections').select('*').eq('id', secret.connection_id).maybeSingle()
  return conn
}

// Devolve o resultado para o registro em zernio_events: ok | ignored (com o motivo)
// `onlyConnection`: evento que chegou pelo webhook de uma conexão (?c=). Só vale para a conta do Instagram dela: um
// evento de outra conta da mesma Zernio (outro Instagram, TikTok) é ignorado.
export async function processZernioEvent(admin: any, ev: any, onlyConnection?: string | null): Promise<{ status: 'ok' | 'ignored'; why?: string; connectionId?: string }> {
  const accountId = String(ev?.account?.id || ev?.account?.accountId || '')
  const conn = await connectionByAccount(admin, accountId)
  if (!conn) return { status: 'ignored', why: 'conta sem conexão no CRM' }
  if (onlyConnection && conn.id !== onlyConnection) return { status: 'ignored', why: 'evento de outra conta da Zernio' }

  if (ev.event === 'account.disconnected') {
    const reason = String(ev.account?.reason || 'A conta do Instagram foi desconectada na Zernio')
    await admin.from('connections').update({
      status: 'disconnected',
      extra: { ...(conn.extra || {}), alert: ev.account?.disconnectionType === 'intentional' ? null : `Instagram desconectado: ${reason}. Conecte de novo.` },
    }).eq('id', conn.id)
    return { status: 'ok', connectionId: conn.id }
  }

  const mods = await companyModules(admin, conn.company_id)
  for (const m of ['conexoes', 'chat', 'instagram']) if (!mods.has(m)) return { status: 'ignored', why: `módulo ${m} suspenso`, connectionId: conn.id }

  if (INBOX.has(ev.event)) {
    const msg = parseZernioMessage(ev)
    if (!msg) return { status: 'ignored', why: 'mensagem sem conversa, remetente ou fora do Instagram', connectionId: conn.id }
    const secret = await connectionSecret(admin, conn.id).catch(() => null)
    const r = await handleInstagramInbound(admin, conn, msg, secret)
    // DM da automação de comentário: a pessoa entra no funil em "Comentou e recebeu a DM"
    if (msg.automationId && msg.fromMe) await entrarNoFunil(admin, conn, msg.igUserId).catch((e) => console.error('funil (comentou)', e))
    return r === 'ok' ? { status: 'ok', connectionId: conn.id } : { status: 'ignored', why: r, connectionId: conn.id }
  }

  const ids = [ev.message?.id, ev.message?.platformMessageId].filter(Boolean).map(String)
  if (ev.event === 'message.read' || ev.event === 'message.delivered') {
    if (!ids.length) return { status: 'ignored', why: 'sem id da mensagem', connectionId: conn.id }
    await admin.from('messages').update({ delivery: ev.event === 'message.read' ? 'read' : 'delivered' }).eq('company_id', conn.company_id).in('wa_id', ids)
    return { status: 'ok', connectionId: conn.id }
  }

  if (ev.event === 'message.deleted') {
    // O cliente apagou a mensagem: fica marcada (o texto continua guardado, para o histórico do atendimento)
    const { data: rows } = await admin.from('messages').select('id, extra').eq('company_id', conn.company_id).in('wa_id', ids)
    for (const r of rows || []) await admin.from('messages').update({ extra: { ...(r.extra || {}), deleted: true } }).eq('id', r.id)
    return { status: 'ok', connectionId: conn.id }
  }

  return { status: 'ignored', why: `evento ${ev.event} não usado`, connectionId: conn.id }
}

async function entrarNoFunil(admin: any, conn: any, igUserId: string) {
  const funil = await funilDaEmpresa(admin, conn.company_id)
  if (!funil) return
  const { data: contact } = await admin.from('contacts').select('*').eq('company_id', conn.company_id).eq('instagram_id', igUserId).maybeSingle()
  if (contact) await avancar(admin, funil, contact, 'comentou')
}
