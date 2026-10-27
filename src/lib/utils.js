// UUID: é o formato das chaves no banco (Supabase)
export const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })

export const cx = (...a) => a.filter(Boolean).join(' ')

// Filtro por etiqueta: sem nenhuma escolhida passa tudo; com várias, basta o contato ter qualquer uma
export const hasAnyLabel = (contact, ids) => !ids?.length || ids.some((id) => contact?.labels?.includes(id))

export const brl = (v, currency = 'BRL') =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(Number(v) || 0)

export const fmtDate = (d) =>
  new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export const fmtDay = (d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })

export const fmtTime = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

// Iniciais do avatar: só palavras que começam com letra ou número (um "-" ou "|" no nome não vira inicial)
export const initials = (name = '', max = 2) =>
  (name || '')
    .split(/\s+/)
    .filter((p) => /^[\p{L}\p{N}]/u.test(p))
    .slice(0, max)
    .map((p) => p[0].toUpperCase())
    .join('')

export const greeting = () => {
  const h = new Date().getHours()
  if (h < 12) return ['Bom dia', '🌤️']
  if (h < 18) return ['Boa tarde', '☀️']
  return ['Boa noite', '🌙']
}

export const PERIODS = [
  { id: 'today', label: 'Hoje', days: 1 },
  { id: 'yesterday', label: 'Ontem', days: 1, offset: 1 },
  { id: '7d', label: 'Últimos 7 dias', days: 7 },
  { id: '30d', label: 'Últimos 30 dias', days: 30 },
  { id: '90d', label: 'Últimos 90 dias', days: 90 },
]

// Início e fim (dias inteiros) de um período; back = 1 é o período anterior de mesmo tamanho (para a variação %).
export const periodRange = (periodId, back = 0) => {
  const p = PERIODS.find((x) => x.id === periodId) || PERIODS[0]
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  end.setDate(end.getDate() - (p.offset || 0) - back * p.days)
  const start = new Date(end)
  start.setDate(start.getDate() - (p.days - 1))
  start.setHours(0, 0, 0, 0)
  return { start, end }
}

export const inRange = (date, { start, end }) => {
  const t = new Date(date).getTime()
  return t >= start.getTime() && t <= end.getTime()
}

export const inPeriod = (date, periodId) => inRange(date, periodRange(periodId))

export const downloadCsv = (filename, rows) => {
  if (!rows.length) return
  const head = Object.keys(rows[0])
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [head.join(';'), ...rows.map((r) => head.map((h) => esc(r[h])).join(';'))].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
