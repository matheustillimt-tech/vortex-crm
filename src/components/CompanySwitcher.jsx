// Seletor de empresas do menu lateral (referência: Datacrazy): pesquisa, as empresas da pessoa, a atual marcada e
// "Adicionar empresa". A lista vem do banco (my_companies), que só devolve empresas das quais ela é membro.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Loader2, Plus, Search } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { cx } from '../lib/utils'
import { Avatar } from './ui'

export const planLabel = (c) => (c.plan ? `Plano ${c.plan}` : c.role || '')

export default function CompanySwitcher({ onClose, onNavigate }) {
  const companies = useDB((s) => s.companies)
  const current = useDB((s) => s.company.id)
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(null)
  const inputRef = useRef(null)

  // atualiza ao abrir (pode ter entrado em outra empresa por convite em outra aba)
  useEffect(() => {
    inputRef.current?.focus()
    useDB.getState().refreshCompanies().catch(() => {})
  }, [])
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return companies.filter((c) => !t || c.name.toLowerCase().includes(t))
  }, [companies, q])

  const pick = async (c) => {
    if (String(c.id) === String(current)) return onClose()
    if (busy) return
    setBusy(c.id)
    try {
      await useDB.getState().switchCompany(c.id)
      onClose()
      onNavigate?.()
      nav('/welcome', { replace: true })
      await useDB.getState().enterCompany()
      toast(`Você está em ${c.name}.`)
    } catch (e) {
      toast(e.message, 'error')
      setBusy(null)
    }
  }

  return (
    <div role="dialog" aria-label="Trocar de empresa" className="menu-pop animate-fade-in absolute inset-x-3 top-full z-50 mt-1 overflow-hidden !p-0">
      <label className="flex items-center gap-2 border-b border-border-subtle px-3">
        <Search size={15} className="shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Pesquisar empresa"
          aria-label="Pesquisar empresa"
          className="h-11 min-w-0 flex-1 bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-muted"
        />
      </label>
      <ul className="max-h-64 overflow-y-auto py-1" aria-label="Suas empresas">
        {list.map((c) => {
          const on = String(c.id) === String(current)
          return (
            <li key={c.id}>
              <button
                onClick={() => pick(c)}
                aria-current={on ? 'true' : undefined}
                disabled={!!busy}
                className={cx('relative flex w-full items-center gap-2.5 px-3 py-2 text-left transition disabled:cursor-wait', on ? 'bg-surface-interactive' : 'hover:bg-surface-interactive')}
              >
                {on && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full" style={{ background: 'rgb(var(--accent))' }} />}
                <Avatar name={c.name} size={30} letters={1} src={c.logoUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-text-primary">{c.name}</span>
                  <span className="block truncate text-[11.5px] text-text-muted">{planLabel(c)}</span>
                </span>
                {busy === c.id ? <Loader2 size={14} className="shrink-0 animate-spin text-text-muted" /> : on && <Check size={14} className="shrink-0" style={{ color: 'rgb(var(--accent))' }} />}
              </button>
            </li>
          )
        })}
        {!list.length && <li className="px-3 py-4 text-center text-xs text-text-muted">Nenhuma empresa encontrada</li>}
      </ul>
      <div className="border-t border-border-subtle p-2">
        <button className="btn-secondary w-full justify-center text-[13px]" onClick={() => { onClose(); onNavigate?.(); nav('/empresas') }}>
          <Plus size={14} /> Adicionar empresa
        </button>
      </div>
    </div>
  )
}
