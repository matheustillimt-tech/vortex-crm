import { useEffect, useState } from 'react'
import { X, Search, CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react'
import { cx, initials } from '../lib/utils'
import { useToast } from '../lib/store'
import { useBrand } from '../lib/palette'

// Cabeçalho de página: bloco de ícone + título (escala e peso dos títulos do design system, ver .page-heading)
export function PageHeader({ title, subtitle, icon: Icon, actions, children }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3.5">
        {Icon && (
          <div className="icon-tile h-11 w-11 shrink-0">
            <Icon size={20} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="page-heading">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
          {children}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="card flex flex-col items-center justify-center border-dashed px-6 py-14 text-center">
      {Icon && (
        <div className="icon-tile mb-4 h-14 w-14">
          <Icon size={24} />
        </div>
      )}
      <p className="text-base text-text-primary" style={{ fontWeight: 650, letterSpacing: '-0.02em' }}>{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-text-muted">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// Modal: vidro com raio grande (como o card de login); no celular vira folha que sobe de baixo
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return
    const h = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size]
  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center p-0 backdrop-blur-sm sm:items-center sm:p-4" style={{ background: 'var(--scrim)' }} onMouseDown={onClose}>
      <div
        className={cx('glass-modal animate-fade-in flex max-h-[92vh] w-full flex-col rounded-t-[24px] sm:rounded-[var(--radius-hero)]', w)}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 pb-4 pt-5">
          <div>
            <h2 className="text-[19px] leading-tight text-text-primary">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
          </div>
          <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

export function Confirm({ open, onClose, onConfirm, title, message, confirmLabel = 'Excluir', danger = true }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button
            className={danger ? 'btn bg-red-500 text-white hover:bg-red-600' : 'btn-primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">{message}</p>
    </Modal>
  )
}

export function Field({ label, hint, children, className }) {
  return (
    <div className={cx('mb-4', className)}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  )
}

export function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      {(label || description) && (
        <span>
          {label && <span className="block text-sm text-text-primary" style={{ fontWeight: 600 }}>{label}</span>}
          {description && <span className="block text-xs text-text-muted">{description}</span>}
        </span>
      )}
      {/* ligado: degradê esmeralda do botão principal; desligado: material de campo */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-6 w-11 shrink-0 rounded-full border transition"
        style={checked
          ? { background: 'var(--material-primary)', borderColor: 'var(--border-accent)', boxShadow: 'var(--shadow-action)' }
          : { background: 'var(--material-control)', borderColor: 'var(--border-control)', boxShadow: 'var(--shadow-inset)' }}
      >
        <span className={cx('absolute top-[1px] h-5 w-5 rounded-full bg-white transition-all', checked ? 'left-[21px]' : 'left-[1px]')} style={{ boxShadow: '0 1px 3px rgba(0,0,0,.3)' }} />
      </button>
    </label>
  )
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    // segmentado no material de campo, como a pílula de tema da referência
    <div role="tablist" className={cx('no-scrollbar flex gap-1 overflow-x-auto rounded-[16px] border border-border p-1', className)} style={{ background: 'var(--material-control)', boxShadow: 'var(--shadow-inset)' }}>
      {tabs.map((t) => {
        const id = t.id ?? t
        const label = t.label ?? t
        return (
          <button
            key={id}
            role="tab"
            aria-selected={value === id}
            onClick={() => onChange(id)}
            className={cx(
              'flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-[12px] px-4 py-2 text-[13px] transition',
              value === id ? 'is-selected' : 'text-text-secondary hover:text-text-primary',
            )}
            style={{ fontWeight: 650 }}
          >
            {t.icon && <t.icon size={15} />}
            {label}
            {t.count != null && <span className="rounded-full bg-surface-interactive px-1.5 text-xs">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Pills({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const id = o.id ?? o
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={cx(
              'rounded-full border px-3 py-1 text-xs font-[600] transition',
              value === id ? 'chip-on' : 'border-border text-text-secondary hover:border-border-hover hover:text-text-primary',
            )}
          >
            {o.label ?? o}
          </button>
        )
      })}
    </div>
  )
}

// Escolha de uma ou mais etiquetas (filtros): value = ids escolhidos, nas cores de cada etiqueta
export function LabelPicker({ labels, value, onChange }) {
  if (!labels.length) return <p className="text-xs text-text-muted">Nenhuma etiqueta criada.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((l) => {
        const on = value.includes(l.id)
        return (
          <button key={l.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== l.id) : [...value, l.id])} className="rounded-full border px-2.5 py-1 text-xs transition"
            style={on ? { background: l.color + '30', borderColor: l.color, color: l.color } : { borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            {l.name}
          </button>
        )
      })}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Buscar...', className }) {
  return (
    <div className={cx('relative', className)}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input type="search" className="input pl-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}

export function Select({ value, onChange, options, className, placeholder }) {
  return (
    <select className={cx('input cursor-pointer pr-8', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value ?? o} value={o.value ?? o}>
          {o.label ?? o}
        </option>
      ))}
    </select>
  )
}

// letters: quantas iniciais (empresas usam 1, como no seletor de empresas)
// src: foto/logo no lugar das iniciais (se não carregar, volta para as iniciais)
export function Avatar({ name, size = 36, color, emoji, letters = 2, src }) {
  const brand = useBrand()
  const colors = brand.avatar
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  // avatares sempre em tons da paleta verde (a identidade não usa outras cores)
  const c = colors[(name || '').length % colors.length]
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name ? `Logo de ${name}` : ''}
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full bg-surface-interactive object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, background: emoji ? 'var(--surface-interactive)' : c, color: brand.avatarFg, fontSize: size * (emoji ? 0.55 : 0.38) }}
    >
      {emoji || initials(name, letters)}
    </div>
  )
}

// delta: variação % contra o período anterior; sem valor (null) o selo não aparece. invert: subir é ruim (ex.: gasto).
export function StatCard({ icon: Icon, label, value, delta = null, invert = false, deltaTitle, title, color = '#8B5CF6', valueClass, onClick }) {
  const brand = useBrand()
  const iconColor = brand.statIcon || color
  const shown = delta != null && Number.isFinite(delta)
  const good = invert ? delta < 0 : delta > 0
  const bad = invert ? delta > 0 : delta < 0
  return (
    <button onClick={onClick} title={title} className="card group p-4 text-left transition hover:border-border-hover">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: iconColor + '22', color: iconColor }}>
          {Icon && <Icon size={16} />}
        </div>
        {shown && (
          <span title={deltaTitle} className={cx('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', good ? 'bg-green-500/15 text-green-400' : bad ? 'bg-red-500/15 text-red-400' : 'bg-surface-interactive text-text-muted')}>
            {delta < 0 ? '↘' : '↗'}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <div className={cx('font-display text-xl', valueClass)} style={{ fontWeight: 'var(--heading-weight)' }}>{value}</div>
      <div className="mt-0.5 text-xs text-text-muted">{label}</div>
    </button>
  )
}

export function SectionCard({ title, subtitle, actions, children, className }) {
  return (
    <div className={cx('card p-5', className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-text-primary">{title}</h3>}
            {subtitle && <p className="text-xs text-text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

export function Toasts() {
  const { toasts, dismiss } = useToast()
  const icons = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
  const colors = { success: 'text-green-400', error: 'text-red-400', warning: 'text-amber-400', info: 'text-blue-400' }
  return (
    <div className="fixed right-4 top-4 z-[300] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((t) => {
        const I = icons[t.type] || Info
        return (
          <div key={t.id} className="glass-modal animate-fade-in flex items-start gap-3 rounded-[16px] p-3.5">
            <I size={18} className={colors[t.type]} />
            <p className="flex-1 text-sm text-text-primary">{t.message}</p>
            <button onClick={() => dismiss(t.id)} className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Table({ columns, rows, empty = 'Nenhum registro.', onRowClick }) {
  return (
    <div className="overflow-x-auto border border-border" style={{ borderRadius: 'var(--radius-btn)', background: 'var(--material-control)' }}>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border" style={{ background: 'var(--material-secondary)' }}>
            {columns.map((c) => (
              <th key={c.key} className="eyebrow-label px-4 py-3 text-left">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.id || i} onClick={() => onRowClick?.(r)} className={cx('border-b border-border-subtle last:border-0 hover:bg-surface-interactive', onRowClick && 'cursor-pointer')}>
                {columns.map((c) => (
                  <td key={c.key} className="px-4 py-3 text-text-secondary">
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function useForm(initial) {
  const [form, setForm] = useState(initial)
  const bind = (k) => ({ value: form[k] ?? '', onChange: (e) => setForm((f) => ({ ...f, [k]: e.target.value })) })
  return [form, setForm, bind]
}
