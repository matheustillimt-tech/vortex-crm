// Blocos de resposta do Vórtex Inteligência (formato em supabase/functions/_shared/inteligencia/blocos.ts). Tudo vem
// de dados estruturados do servidor: aqui só se desenha com os componentes de gráfico do app (Recharts).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, ArrowUpRight, ChevronDown, Info, Lightbulb, MessageCircle, Search } from 'lucide-react'
import { useBrand } from '../../lib/palette'
import { formatar, NATUREZA } from '../../lib/inteligencia'
import { cx } from '../../lib/utils'

const tooltipStyle = { background: 'var(--surface-overlay)', border: '1px solid var(--border-default)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 12 }
const axis = { stroke: 'var(--text-muted)', fontSize: 11, tickLine: false, axisLine: false }
const dia = (x, g) => {
  const d = new Date(`${x}T12:00:00`)
  if (Number.isNaN(d.getTime())) return x
  return g === 'mes' ? d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}
const curto = (v, f) => {
  const n = Number(v) || 0
  if (f === 'moeda') { const r = n / 100; return Math.abs(r) >= 1000 ? `R$ ${(r / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${r.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}` }
  if (f === 'pct') return `${Math.round(n * 100)}%`
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

export function Blocos({ blocos = [], onAcao }) {
  return (
    <div className="space-y-3">
      {blocos.map((b, i) => <Bloco key={i} b={b} onAcao={onAcao} />)}
    </div>
  )
}

function Bloco({ b, onAcao }) {
  switch (b.tipo) {
    case 'cards': return <Cards b={b} onAcao={onAcao} />
    case 'serie': return <Serie b={b} onAcao={onAcao} />
    case 'comparacao': return <Comparacao b={b} />
    case 'distribuicao': return <Distribuicao b={b} onAcao={onAcao} />
    case 'funil': return <Funil b={b} />
    case 'tabela': return <TabelaBloco b={b} onAcao={onAcao} />
    case 'recomendacoes': return <Recomendacoes b={b} onAcao={onAcao} />
    case 'acoes': return <Acoes b={b} onAcao={onAcao} />
    case 'aviso': return <Aviso b={b} />
    default: return null
  }
}

function Caixa({ titulo, children, acoes, className }) {
  return (
    <div className={cx('rounded-2xl border border-border p-4', className)} style={{ background: 'var(--material-control)' }}>
      {(titulo || acoes) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {titulo && <h4 className="text-[13px] font-semibold text-text-primary">{titulo}</h4>}
          {acoes}
        </div>
      )}
      {children}
    </div>
  )
}

function Delta({ v, inverter }) {
  if (v == null || !Number.isFinite(v)) return null
  const bom = inverter ? v < 0 : v > 0
  const ruim = inverter ? v > 0 : v < 0
  return (
    <span className={cx('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', bom ? 'bg-green-500/15 text-green-400' : ruim ? 'bg-red-500/15 text-red-400' : 'bg-surface-interactive text-text-muted')} title="Variação contra o período de comparação">
      {v < 0 ? '↘' : '↗'}{Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
    </span>
  )
}

function Cards({ b, onAcao }) {
  return (
    <div>
      {b.titulo && <p className="eyebrow-label mb-2">{b.titulo}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {b.itens.map((c, i) => {
          const Comp = c.acao ? 'button' : 'div'
          return (
            <Comp key={i} onClick={c.acao ? () => onAcao?.(c.acao) : undefined} title={c.ajuda || undefined}
              className={cx('card p-3.5 text-left transition', c.acao && 'hover:border-border-hover')}>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] leading-tight text-text-muted">{c.rotulo}</span>
                <Delta v={c.delta} inverter={c.inverter} />
              </div>
              <div className="mt-1.5 font-display text-lg text-text-primary" style={{ fontWeight: 'var(--heading-weight)' }}>
                {c.valor == null ? <span className="text-sm text-text-muted" title="Dado indisponível: não existe registro para isso (não é zero).">dado indisponível</span> : formatar(c.valor, c.formato)}
              </div>
              {c.ajuda && <p className="mt-1 line-clamp-2 text-[11px] text-text-muted">{c.ajuda}</p>}
              {c.acao && <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-[color:var(--accent-text)]">Ver registros <ArrowUpRight size={11} /></span>}
            </Comp>
          )
        })}
      </div>
    </div>
  )
}

function Serie({ b, onAcao }) {
  const brand = useBrand()
  const [ocultas, setOcultas] = useState([])
  const direita = b.series.filter((s) => s.eixo === 'direita')
  const vazio = !b.dados?.length || b.dados.every((d) => b.series.every((s) => !Number(d[s.chave])))
  const fmt = Object.fromEntries(b.series.map((s) => [s.chave, s.formato]))
  const nome = Object.fromEntries(b.series.map((s) => [s.chave, s.rotulo]))
  const id = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, [])
  return (
    <Caixa titulo={b.titulo} acoes={b.acao && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onAcao?.(b.acao)}>Ver registros</button>}>
      {vazio ? <p className="py-8 text-center text-sm text-text-muted">Sem ocorrências no período.</p> : (
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={b.dados} margin={{ top: 4, right: direita.length ? 4 : 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={brand.chart[0]} stopOpacity={0.45} /><stop offset="100%" stopColor={brand.chart[0]} stopOpacity={0} /></linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border-default)" vertical={false} />
            <XAxis dataKey="x" {...axis} tickFormatter={(x) => dia(x, b.x)} minTickGap={16} />
            <YAxis yAxisId="e" {...axis} width={74} tickFormatter={(v) => curto(v, b.series.find((s) => s.eixo !== 'direita')?.formato)} allowDecimals={false} />
            {direita.length > 0 && <YAxis yAxisId="d" orientation="right" {...axis} width={34} allowDecimals={false} tickFormatter={(v) => curto(v, direita[0].formato)} />}
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(x) => dia(x, b.x)} formatter={(v, k) => [formatar(v, fmt[k]), nome[k] || k]} />
            <Legend wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} onClick={(e) => setOcultas((o) => (o.includes(e.dataKey) ? o.filter((x) => x !== e.dataKey) : [...o, e.dataKey]))}
              formatter={(v, e) => <span style={{ color: ocultas.includes(e.dataKey) ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: ocultas.includes(e.dataKey) ? 'line-through' : 'none' }}>{nome[v] || v}</span>} />
            {b.series.map((s, i) => (i === 0
              ? <Area key={s.chave} yAxisId={s.eixo === 'direita' ? 'd' : 'e'} type="monotone" dataKey={s.chave} name={s.chave} stroke={brand.chart[0]} strokeWidth={2} fill={`url(#${id})`} hide={ocultas.includes(s.chave)} />
              : s.eixo === 'direita'
                ? <Bar key={s.chave} yAxisId="d" dataKey={s.chave} name={s.chave} fill={brand.chart[i % brand.chart.length]} opacity={0.55} barSize={14} radius={[4, 4, 0, 0]} hide={ocultas.includes(s.chave)} />
                : <Line key={s.chave} yAxisId="e" type="monotone" dataKey={s.chave} name={s.chave} stroke={brand.chart[(i + 1) % brand.chart.length]} strokeWidth={2} dot={false} hide={ocultas.includes(s.chave)} />))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Caixa>
  )
}

function Comparacao({ b }) {
  const brand = useBrand()
  return (
    <Caixa titulo={b.titulo}>
      <div className="mb-3 flex flex-wrap gap-3 text-[11px] text-text-muted">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-full" style={{ background: brand.chart[0] }} />{b.periodos.atual}</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-full" style={{ background: brand.chart[1] }} />{b.periodos.anterior}</span>
      </div>
      <div className="space-y-3">
        {b.itens.map((it, i) => {
          const max = Math.max(Math.abs(Number(it.atual) || 0), Math.abs(Number(it.anterior) || 0)) || 1
          const v = it.atual != null && it.anterior ? ((it.atual - it.anterior) / Math.abs(it.anterior)) * 100 : null
          return (
            <div key={i}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="text-text-secondary">{it.rotulo}</span>
                <span className="flex items-center gap-2"><b className="text-text-primary">{formatar(it.atual, it.formato)}</b><span className="text-text-muted">vs {formatar(it.anterior, it.formato)}</span><Delta v={v} /></span>
              </div>
              <div className="space-y-1" title={`${b.periodos.atual}: ${formatar(it.atual, it.formato)} · ${b.periodos.anterior}: ${formatar(it.anterior, it.formato)}`}>
                <div className="h-1.5 rounded-full" style={{ width: `${(Math.abs(Number(it.atual) || 0) / max) * 100}%`, background: brand.chart[0], minWidth: it.atual ? 4 : 0 }} />
                <div className="h-1.5 rounded-full" style={{ width: `${(Math.abs(Number(it.anterior) || 0) / max) * 100}%`, background: brand.chart[1], minWidth: it.anterior ? 4 : 0 }} />
              </div>
            </div>
          )
        })}
      </div>
    </Caixa>
  )
}

function Distribuicao({ b, onAcao }) {
  const brand = useBrand()
  const total = b.itens.reduce((n, i) => n + (Number(i.valor) || 0), 0)
  if (!total) return <Caixa titulo={b.titulo}><p className="py-6 text-center text-sm text-text-muted">Sem ocorrências no período.</p></Caixa>
  return (
    <Caixa titulo={b.titulo}>
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="h-[150px] w-[150px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={b.itens} dataKey="valor" nameKey="rotulo" innerRadius={42} outerRadius={70} paddingAngle={2} stroke="none" onClick={(d) => d?.payload?.acao && onAcao?.(d.payload.acao)}>
                {b.itens.map((_, i) => <Cell key={i} fill={brand.chart[i % brand.chart.length]} style={{ cursor: b.itens[i].acao ? 'pointer' : 'default' }} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [`${formatar(v, b.formato)} (${((v / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)`, n]} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="w-full space-y-1.5 text-xs">
          {b.itens.map((it, i) => (
            <li key={i}>
              <button disabled={!it.acao} onClick={() => onAcao?.(it.acao)} className={cx('flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left', it.acao && 'hover:bg-surface-interactive')}>
                <i className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: brand.chart[i % brand.chart.length] }} />
                <span className="flex-1 truncate text-text-secondary" title={it.rotulo}>{it.rotulo}</span>
                <b className="text-text-primary">{formatar(it.valor, b.formato)}</b>
                <span className="w-12 text-right text-text-muted">{((it.valor / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Caixa>
  )
}

function Funil({ b }) {
  const brand = useBrand()
  const max = Math.max(...b.itens.map((i) => Number(i.valor) || 0), 1)
  return (
    <Caixa titulo={b.titulo}>
      <div className="space-y-2">
        {b.itens.map((it, i) => {
          const ant = i > 0 ? b.itens[i - 1].valor : null
          const conv = ant && it.valor != null ? it.valor / ant : null
          return (
            <div key={i} className="flex items-center gap-3 text-xs">
              <span className="w-36 shrink-0 text-text-secondary sm:w-44">{it.rotulo}</span>
              <div className="h-7 flex-1 overflow-hidden rounded-lg" style={{ background: 'var(--surface-interactive)' }}>
                {it.valor != null && <div className="flex h-full items-center justify-end rounded-lg px-2 text-[11px] font-semibold" style={{ width: `${Math.max(6, (it.valor / max) * 100)}%`, background: brand.chart[0], color: brand.avatarFg || '#04140c' }}>{formatar(it.valor, 'numero')}</div>}
                {it.valor == null && <div className="flex h-full items-center px-2 text-[11px] text-text-muted">dado indisponível</div>}
              </div>
              <span className="w-14 shrink-0 text-right text-text-muted" title="Em relação à etapa anterior">{conv != null ? formatar(conv, 'pct') : ''}</span>
            </div>
          )
        })}
      </div>
    </Caixa>
  )
}

function TabelaBloco({ b, onAcao }) {
  const nav = useNavigate()
  const [busca, setBusca] = useState('')
  const linhas = busca ? b.linhas.filter((l) => JSON.stringify(l).toLowerCase().includes(busca.toLowerCase())) : b.linhas
  const abrir = (l) => {
    if (b.abrir === 'conversa' && l.id) nav(`/chats?chat=${l.id}`)
    else if (b.abrir === 'agente' && l.id) onAcao?.({ tipo: 'abrir', destino: 'agente', id: l.id })
  }
  return (
    <Caixa titulo={b.titulo} acoes={b.linhas.length > 8 && (
      <div className="relative"><Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input className="input h-8 w-44 py-1 pl-8 text-xs" placeholder="Filtrar" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>)}>
      {!linhas.length ? <p className="py-6 text-center text-sm text-text-muted">{b.vazio || 'Nenhum registro.'}</p> : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead><tr className="border-b border-border">{b.colunas.map((c) => <th key={c.chave} className="eyebrow-label px-2 py-2 text-left">{c.rotulo}</th>)}{b.abrir && <th />}</tr></thead>
            <tbody>
              {linhas.slice(0, 200).map((l, i) => {
                const pode = b.abrir && l.id
                return (
                  <tr key={i} onClick={pode ? () => abrir(l) : undefined} className={cx('border-b border-border-subtle last:border-0', pode && 'cursor-pointer hover:bg-surface-interactive')}>
                    {b.colunas.map((c) => <td key={c.chave} className="max-w-[260px] truncate px-2 py-2 text-text-secondary" title={String(l[c.chave] ?? '')}>{formatar(l[c.chave], c.formato)}</td>)}
                    {b.abrir && <td className="px-2 text-right">{pode && (b.abrir === 'conversa' ? <MessageCircle size={13} className="inline text-text-muted" /> : <ArrowUpRight size={13} className="inline text-text-muted" />)}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Caixa>
  )
}

function Recomendacoes({ b }) {
  const nav = useNavigate()
  return (
    <Caixa titulo={b.titulo}>
      <ul className="space-y-2">
        {b.itens.map((r, i) => (
          <li key={i} className="flex gap-2.5 rounded-xl border border-border-subtle p-2.5">
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-[color:var(--accent-text)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-text-primary">{r.texto}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {r.frequencia != null && <span className="badge-muted">{r.frequencia} conversa{r.frequencia === 1 ? '' : 's'}</span>}
                {r.natureza && NATUREZA[r.natureza] && <span className={NATUREZA[r.natureza][0]}>{NATUREZA[r.natureza][1]}</span>}
                {(r.evidencias || []).filter((e) => e.conversaId).slice(0, 3).map((e, k) => (
                  <button key={k} className="badge-info inline-flex items-center gap-1" title={e.trecho || 'Abrir a conversa'} onClick={() => nav(`/chats?chat=${e.conversaId}`)}><MessageCircle size={10} /> evidência {k + 1}</button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Caixa>
  )
}

function Acoes({ b, onAcao }) {
  return (
    <div className="flex flex-wrap gap-2">
      {b.itens.map((a, i) => <button key={i} className="btn-secondary px-3 py-1.5 text-xs" onClick={() => onAcao?.(a.acao)}>{a.rotulo}</button>)}
    </div>
  )
}

function Aviso({ b }) {
  const I = b.nivel === 'alerta' ? AlertTriangle : Info
  return (
    <div className={cx('flex gap-2 rounded-xl border px-3 py-2.5 text-xs', b.nivel === 'alerta' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-border text-text-secondary')}>
      <I size={14} className="mt-0.5 shrink-0" />
      <span>{b.texto}</span>
    </div>
  )
}

// Período, filtros, atualização e definições das métricas
export function Rodape({ meta, definicoes }) {
  const [aberto, setAberto] = useState(false)
  const defs = definicoes || meta?.definicoes || []
  const per = meta?.periodos || []
  const filtros = Object.entries(meta?.filtros || {}).filter(([, v]) => v)
  return (
    <div className="mt-3 rounded-xl border border-border-subtle px-3 py-2 text-[11px] text-text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {per.map((p, i) => <span key={i}>📅 {p.rotulo}{p.comparacao ? ` · comparado com ${p.comparacao}` : ''}</span>)}
        {filtros.map(([k, v]) => <span key={k}>🔎 {k}: {String(v)}</span>)}
        {meta?.atualizadoEm && <span>Dados de {new Date(meta.atualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{meta.fuso ? ` (${meta.fuso})` : ''}</span>}
        {defs.length > 0 && <button className="ml-auto inline-flex items-center gap-1 hover:text-text-primary" onClick={() => setAberto(!aberto)}>Como calculamos <ChevronDown size={12} className={cx('transition', aberto && 'rotate-180')} /></button>}
      </div>
      {meta?.aviso && <p className="mt-1.5 text-amber-400">{meta.aviso}</p>}
      {aberto && <dl className="mt-2 space-y-1.5 border-t border-border-subtle pt-2">{defs.map((d) => <div key={d.termo}><dt className="inline font-semibold text-text-secondary">{d.termo}: </dt><dd className="inline">{d.texto}</dd></div>)}</dl>}
    </div>
  )
}
