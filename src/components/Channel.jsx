import { Instagram, MessageCircle } from 'lucide-react'
import { cx } from '../lib/utils'

// Canal de uma conexão, conversa ou contato: WhatsApp (API Web e API Oficial) ou Instagram (Direct pela Zernio).
// O TikTok entra aqui quando existir uma via oficial de DM.
export const CHANNELS = {
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, bg: 'bg-[#25D366]', text: 'text-[#25D366]' },
  instagram: { label: 'Instagram', icon: Instagram, bg: 'bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF]', text: 'text-[#E1306C]' },
}

export const channelOf = (connection) => (connection?.provider === 'instagram' ? 'instagram' : 'whatsapp')
export const isInstagram = (connection) => connection?.provider === 'instagram'

// Canal da conversa: pela conexão dela
export const chatChannel = (chat, connections) => channelOf(connections.find((c) => c.id === chat?.connectionId))

// Canais de um contato: telefone = WhatsApp, id do Instagram = Instagram (um contato pode ter os dois)
export function contactChannels(contact) {
  const out = []
  if (String(contact?.phone || '').replace(/\D/g, '')) out.push('whatsapp')
  if (contact?.instagramId || contact?.instagramUsername) out.push('instagram')
  return out
}

// Logo do canal num quadradinho colorido. `size` em px do quadrado.
export function ChannelIcon({ channel = 'whatsapp', size = 18, className, title }) {
  const ch = CHANNELS[channel] || CHANNELS.whatsapp
  const I = ch.icon
  return (
    <span title={title ?? ch.label} aria-label={title ?? ch.label}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-[6px] text-white', ch.bg, className)}
      style={{ width: size, height: size }}>
      <I size={Math.round(size * 0.66)} strokeWidth={2.2} />
    </span>
  )
}

// Vários canais lado a lado (lista de contatos, card do Kanban)
export function ChannelIcons({ channels, size = 16, className }) {
  if (!channels?.length) return null
  return <span className={cx('inline-flex items-center gap-1', className)}>{channels.map((c) => <ChannelIcon key={c} channel={c} size={size} />)}</span>
}

export const igHandle = (u) => (u ? `@${String(u).replace(/^@/, '')}` : '')
export const igProfileUrl = (u) => (u ? `https://instagram.com/${String(u).replace(/^@/, '')}` : null)

// Janela de resposta do Instagram (mesma regra do servidor, supabase/functions/_shared/zernio.ts):
// open = até 24 h desde a última mensagem do cliente; human = de 24 h a 7 dias, só a equipe; closed = depois disso.
const H24 = 24 * 3600 * 1000
const D7 = 7 * 24 * 3600 * 1000
export function igWindow(lastContactAt, now = Date.now()) {
  const t = lastContactAt ? Date.parse(lastContactAt) : NaN
  if (!Number.isFinite(t)) return { state: 'closed', until: null }
  const age = now - t
  if (age < H24) return { state: 'open', until: new Date(t + H24) }
  if (age < D7) return { state: 'human', until: new Date(t + D7) }
  return { state: 'closed', until: null }
}

// "5 h", "40 min", "3 dias"
export function timeLeft(until, now = Date.now()) {
  const ms = Math.max(0, +until - now)
  const h = ms / 3600_000
  if (h >= 48) return `${Math.floor(h / 24)} dias`
  if (h >= 1) return `${Math.floor(h)} h`
  return `${Math.max(1, Math.floor(ms / 60_000))} min`
}
