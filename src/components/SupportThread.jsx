// Peças da conversa do suporte, usadas na janela do botão Suporte e na Central de suporte do superadmin.
import { useLayoutEffect, useRef } from 'react'
import { AlertCircle, Clock, Loader2, RotateCw, Send } from 'lucide-react'
import { BRAND } from '../lib/brand'
import { MAX_BODY, SUPPORT_STATUS } from '../lib/support'
import { cx, fmtTime } from '../lib/utils'
import { BrandSymbol } from './BrandSymbol'

export function TeamMark({ size = 28 }) {
  return (
    <div className="brand-mark flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size }} aria-hidden>
      <BrandSymbol size={Math.round(size * 0.58)} />
    </div>
  )
}

export function SupportStatusBadge({ status }) {
  const s = SUPPORT_STATUS[status] || SUPPORT_STATUS.open
  return <span className={cx(s.badge, 'whitespace-nowrap')}>{s.label}</span>
}

// "agora", "há 5 min", "há 2 h", "ontem", "12/10"
export function ago(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const min = Math.floor((Date.now() - d) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return `há ${Math.floor(min / 60)} h`
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

const dayLabel = (iso) => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Hoje'
  if (d.toDateString() === yesterday.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

const firstName = (n = '') => n.trim().split(/\s+/)[0] || ''

/*
 * Lista de mensagens. viewer = 'user' (janela do usuário) ou 'admin' (central): as mensagens de quem está vendo ficam à direita.
 * Acompanha o fim da conversa, a menos que a pessoa tenha rolado para cima para ler o histórico.
 * Monte com key={ticketId} para começar no fim ao trocar de conversa.
 */
export function SupportMessages({ messages, viewer, meId, loading, intro, onRetry }) {
  const box = useRef(null)
  const stick = useRef(true)
  const last = messages[messages.length - 1]

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const mine = last && last.senderId === meId && last.senderRole !== 'system'
    if (stick.current || mine) el.scrollTop = el.scrollHeight
  }, [messages.length, last?.id, last?.state, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = box.current
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  let lastDay = ''
  return (
    <div
      ref={box}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto overscroll-contain px-3.5 py-4"
      style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0)', backgroundSize: '22px 22px' }}
      aria-live="polite"
    >
      {intro && (
        <div className="mb-3 flex items-end gap-2">
          <TeamMark size={26} />
          <div className="max-w-[82%] rounded-2xl rounded-bl-md bg-surface-overlay px-3.5 py-2.5 text-sm text-text-primary">{intro}</div>
        </div>
      )}
      {loading && !messages.length && (
        <p className="flex items-center justify-center gap-2 py-8 text-xs text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando conversa…</p>
      )}
      {messages.map((m) => {
        const day = new Date(m.createdAt).toDateString()
        const showDay = day !== lastDay
        lastDay = day
        if (m.senderRole === 'system') {
          return (
            <div key={m.id}>
              {showDay && <DaySep iso={m.createdAt} />}
              <p className="my-2.5 text-center text-[11px] text-text-muted">
                <span className="rounded-full bg-surface-overlay px-3 py-1">{m.body} · {fmtTime(m.createdAt)}</span>
              </p>
            </div>
          )
        }
        const right = viewer === 'admin' ? m.senderRole === 'admin' : m.senderRole === 'user'
        const team = m.senderRole === 'admin'
        // quem escreveu: na janela do usuário, "Equipe Vórtex CRM · Nome"; na central, o nome do usuário ou do colega da equipe
        const who = viewer === 'user'
          ? team && `Equipe ${BRAND.name}${m.senderName ? ' · ' + firstName(m.senderName) : ''}`
          : team ? (m.senderId !== meId ? `${m.senderName || 'Equipe'} · Equipe` : '') : m.senderName
        return (
          <div key={m.id}>
            {showDay && <DaySep iso={m.createdAt} />}
            <div className={cx('mb-2 flex items-end gap-2', right ? 'justify-end' : 'justify-start')}>
              {!right && viewer === 'user' && <TeamMark size={26} />}
              <div className={cx('flex max-w-[82%] flex-col', right ? 'items-end' : 'items-start')}>
                {who && <p className="mb-0.5 px-1 text-[11px] text-text-muted" style={{ fontWeight: 600 }}>{who}</p>}
                <div
                  className={cx(
                    'rounded-2xl px-3.5 py-2 text-sm shadow-sm',
                    right ? 'bubble-mine rounded-br-md' : 'rounded-bl-md bg-surface-overlay text-text-primary',
                    m.state === 'sending' && 'opacity-70',
                    m.state === 'failed' && 'ring-2 ring-red-500/70',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={cx('mt-0.5 flex items-center justify-end gap-1 text-[10px]', right ? 'text-white/70' : 'text-text-muted')}>
                    {fmtTime(m.createdAt)}
                    {m.state === 'sending' && <Clock size={10} aria-label="Enviando" />}
                    {m.state === 'failed' && <AlertCircle size={10} aria-label="Não enviada" />}
                  </p>
                </div>
                {m.state === 'failed' && onRetry && (
                  <button className="mt-1 flex items-center gap-1 px-1 text-[11px] text-red-400 hover:underline" onClick={() => onRetry(m)}>
                    <RotateCw size={11} /> Não enviada · Tentar de novo
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DaySep({ iso }) {
  return (
    <div className="my-3 text-center">
      <span className="rounded-full bg-surface-overlay px-3 py-1 text-[11px] text-text-muted">{dayLabel(iso)}</span>
    </div>
  )
}

// Campo de envio: Enter envia, Shift+Enter quebra a linha; cresce até ~6 linhas.
export function SupportComposer({ value, onChange, onSend, busy, placeholder = 'Escreva sua mensagem…', hint, inputRef, autoFocus }) {
  const local = useRef(null)
  const ref = inputRef || local

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 136) + 'px'
  }, [value, ref])

  const can = value.trim().length > 0 && !busy
  const submit = () => can && onSend()

  return (
    <div className="border-t border-border-subtle p-3" style={{ background: 'var(--material-control)' }}>
      {hint && <p className="mb-2 px-1 text-[11px] text-text-muted">{hint}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_BODY}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
          aria-label="Mensagem para o suporte"
          // 16px no celular: abaixo disso o iPhone dá zoom ao tocar no campo
          className="input min-h-[42px] flex-1 resize-none py-2.5 text-base sm:text-sm"
        />
        <button className="btn-primary h-[42px] w-[42px] shrink-0 p-0" disabled={!can} onClick={submit} aria-label="Enviar mensagem" title="Enviar (Enter)">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
      {value.length > MAX_BODY - 300 && <p className="mt-1 text-right text-[11px] text-text-muted">{value.length}/{MAX_BODY}</p>}
    </div>
  )
}
