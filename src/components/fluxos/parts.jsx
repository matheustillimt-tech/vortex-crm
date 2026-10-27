import { Info } from 'lucide-react'
import { cx } from '../../lib/utils'

// Peças pequenas dos painéis de gatilhos: seleção em pílulas e nota explicativa.

export function Chips({ options, value = [], onChange, empty }) {
  if (!options.length) return <p className="text-xs text-text-muted">{empty || 'Nada para escolher ainda.'}</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const id = o.value ?? o
        const on = value.includes(id)
        return (
          <button key={id} type="button" onClick={() => onChange(on ? value.filter((x) => x !== id) : [...value, id])}
            className={cx('rounded-full border px-2.5 py-1 text-xs', on ? 'chip-on' : 'border-border text-text-muted hover:border-border-hover')}>
            {o.label ?? o}
          </button>
        )
      })}
    </div>
  )
}

export function Note({ children, tone }) {
  return (
    <div className={cx('mb-4 flex gap-2 rounded-[13px] p-3 text-[11px] leading-relaxed', tone === 'warn' ? 'bg-amber-500/10 text-amber-400' : 'panel-soft text-text-muted')}>
      <Info size={13} className="mt-0.5 shrink-0" /> <div>{children}</div>
    </div>
  )
}
