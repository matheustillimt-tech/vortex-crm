import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  Users, DollarSign, ShoppingCart, TrendingUp, Percent, Receipt, Wallet, Megaphone, RotateCcw, Bookmark, RefreshCw, Settings2,
  Trophy, Download, Plus, Trash2, MessageCircle, CheckCircle2, Clock, MessageSquareOff, UserCheck, Filter,
} from 'lucide-react'
import { useDB, useHasModule, toast } from '../lib/store'
import { useBrand } from '../lib/palette'
import { brl, cx, downloadCsv, fmtDate, greeting, inPeriod, inRange, periodRange, PERIODS, uid } from '../lib/utils'
import { Field, Modal, SectionCard, Select, StatCard, Tabs, Table } from '../components/ui'

const tooltipStyle = { background: 'var(--surface-overlay)', border: '1px solid var(--border-default)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 12 }
const axis = { stroke: 'var(--text-muted)', fontSize: 11, tickLine: false, axisLine: false }

function NoData() {
  return <p className="py-10 text-center text-sm text-text-muted">Nenhum dado no período selecionado.</p>
}

// Gasto com anúncios informado à mão (configurações da empresa, expenses.ads: [{ id, from, to, amount, currency }]).
// Num período do Dashboard entra a parte proporcional aos dias do lançamento que caem nele.
const DAY = 86400000
const ymd = (d) => d.toLocaleDateString('en-CA')
const dayOf = (s) => new Date(`${s}T00:00:00`)
const fmtDay = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
function adSpendIn(ads, { start, end }, currency) {
  return (ads || []).filter((a) => (a.currency || 'BRL') === currency).reduce((sum, a) => {
    const from = dayOf(a.from).getTime()
    const to = dayOf(a.to || a.from).getTime() + DAY - 1
    const s = Math.max(from, start.getTime())
    const e = Math.min(to, end.getTime())
    if (e < s) return sum
    return sum + ((+a.amount || 0) * Math.round((e - s + 1) / DAY)) / Math.round((to - from + 1) / DAY)
  }, 0)
}
// variação % contra o período anterior; sem base para comparar (anterior zerado ou sem valor), não mostra
const variation = (cur, prev) => (cur == null || prev == null || !prev ? null : ((cur - prev) / Math.abs(prev)) * 100)

// Lançamentos do gasto com anúncios: período (de/até), valor e moeda. Começa com o período do filtro do Dashboard.
function AdsModal({ open, onClose, range, currency }) {
  const db = useDB()
  const blank = () => ({ from: ymd(range.start), to: ymd(range.end), amount: '', currency })
  const [f, setF] = useState(blank)
  useEffect(() => { if (open) setF(blank()) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const ads =[...(db.expenses.ads || [])].sort((a, b) => String(b.from).localeCompare(String(a.from)))
  const save = (list) => db.setKey('expenses', { ...db.expenses, ads: list })
  const add = () => {
    if (!(+f.amount > 0)) return toast('Informe o valor gasto.', 'error')
    if (!f.from || !f.to || f.to < f.from) return toast('Confira as datas: o fim não pode ser antes do início.', 'error')
    save([...(db.expenses.ads || []), { id: uid(), from: f.from, to: f.to, amount: +f.amount, currency: f.currency }])
    setF({ ...blank(), currency: f.currency })
    toast('Gasto lançado.')
  }
  const days = (a) => Math.round((dayOf(a.to || a.from) - dayOf(a.from)) / DAY) + 1
  return (
    <Modal open={open} onClose={onClose} title="Gasto com anúncios" subtitle="Quanto você gastou na Meta (ou em outra plataforma) em cada período. Entra no ROAS e no lucro."
      footer={<button className="btn-primary" onClick={onClose}>Concluir</button>}>
      <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
        <Field label="De"><input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="Até"><input type="date" className="input" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Valor gasto"><input type="number" min={0} step="0.01" className="input" placeholder="0,00" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} /></Field>
        <Field label="Moeda"><Select value={f.currency} onChange={(v) => setF({ ...f, currency: v })} options={['BRL', 'USD', 'EUR', 'MXN']} /></Field>
      </div>
      <button className="btn-primary mb-4 w-full" onClick={add}><Plus size={15} /> Lançar gasto</button>
      <p className="mb-2 text-xs font-semibold text-text-secondary">Lançamentos</p>
      {ads.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-text-muted">Nenhum gasto lançado ainda.</p>}
      <div className="space-y-1.5">
        {ads.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm">
            <span className="flex-1 text-text-secondary">{fmtDay(dayOf(a.from))}{a.to && a.to !== a.from ? ` a ${fmtDay(dayOf(a.to))}` : ''}/{dayOf(a.to || a.from).getFullYear()} <span className="text-xs text-text-muted">· {days(a)} {days(a) === 1 ? 'dia' : 'dias'}</span></span>
            <b className="text-red-400">{brl(a.amount, a.currency || 'BRL')}</b>
            <button className="btn-ghost p-1.5" title="Excluir lançamento" aria-label="Excluir lançamento" onClick={() => save((db.expenses.ads || []).filter((x) => x.id !== a.id))}><Trash2 size={14} className="text-red-400" /></button>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-text-muted">Quando o filtro do Dashboard pega só parte de um lançamento, entra a parte proporcional aos dias. Ex.: R$ 300 lançados de 01 a 30 contam R$ 70 nos últimos 7 dias.</p>
    </Modal>
  )
}

function MetricToggle({ value, onChange }) {
  return (
    <div className="seg" role="group" aria-label="Alternar métrica do gráfico">
      {['Valor', 'Qtd'].map((m) => (
        <button key={m} onClick={() => onChange(m)} className={cx('px-2.5 py-1 text-xs font-[650]', value === m ? 'is-selected' : 'text-text-secondary')}>
          {m}
        </button>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const db = useDB()
  const brand = useBrand()
  const PALETTE = brand.chart
  const nav = useNavigate()
  const [tab, setTab] = useState('vendas')
  const hasChat = useHasModule('chat') // a aba Atendimento mostra dados das conversas
  const [period, setPeriod] = useState('30d')
  const [conn, setConn] = useState('')
  const [product, setProduct] = useState('')
  const [currency, setCurrency] = useState('BRL')
  const [chartMetric, setChartMetric] = useState('Valor')
  const [prodMetric, setProdMetric] = useState('Valor')
  const [saleModal, setSaleModal] = useState(false)
  const [feeModal, setFeeModal] = useState(false)
  const [adsModal, setAdsModal] = useState(false)
  const [trail, setTrail] = useState(false)
  const [g, emoji] = greeting()

  // Os mesmos números no período escolhido e no anterior de mesmo tamanho (para a variação % de cada card)
  const range = useMemo(() => periodRange(period), [period])
  const prevRange = useMemo(() => periodRange(period, 1), [period])
  const metricsOf = (r) => {
    const ss = db.sales.filter((s) => inRange(s.at, r) && (!conn || s.connectionId === conn) && (!product || s.productId === product) && s.currency === currency)
    const ls = db.contacts.filter((c) => inRange(c.createdAt, r) && (!conn || c.connectionId === conn))
    const revenue = ss.reduce((a, s) => a + (+s.value || 0), 0)
    const adSpend = adSpendIn(db.expenses.ads, r, currency)
    return {
      sales: ss, leads: ls, revenue, adSpend,
      profit: revenue - adSpend - (ss.length * (+db.expenses.fee || 0) + (+db.expenses.fixed || 0)),
      roas: adSpend ? revenue / adSpend : null,
      conv: ls.length ? (ss.length / ls.length) * 100 : 0,
      ticket: ss.length ? revenue / ss.length : 0,
    }
  }
  const cur = useMemo(() => metricsOf(range), [db.sales, db.contacts, db.expenses, range, conn, product, currency]) // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(() => metricsOf(prevRange), [db.sales, db.contacts, db.expenses, prevRange, conn, product, currency]) // eslint-disable-line react-hooks/exhaustive-deps
  const { sales, leads, revenue, adSpend, profit, roas, conv, ticket } = cur
  const vs = (fmt) => `vs. ${fmtDay(prevRange.start)}${prevRange.start.toDateString() === prevRange.end.toDateString() ? '' : ` a ${fmtDay(prevRange.end)}`}: ${fmt}`

  const p = PERIODS.find((x) => x.id === period)
  const byPeriod = useMemo(() => {
    const map = new Map()
    const byHour = p.days <= 2
    sales.forEach((s) => {
      const d = new Date(s.at)
      const key = byHour ? `${String(d.getHours()).padStart(2, '0')}h` : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
      const sortKey = byHour ? d.getHours() : d.getTime() - (d.getTime() % 86400000)
      const cur = map.get(key) || { name: key, Valor: 0, Qtd: 0, sort: sortKey }
      cur.Valor += s.value
      cur.Qtd += 1
      map.set(key, cur)
    })
    return [...map.values()].sort((a, b) => a.sort - b.sort)
  }, [sales, p])

  const byHour = Array.from({ length: 24 }, (_, h) => ({ name: `${String(h).padStart(2, '0')}h`, Vendas: sales.filter((s) => new Date(s.at).getHours() === h).length })).slice(6, 24)
  const byConn = db.connections.map((c) => ({ name: c.name, Vendas: sales.filter((s) => s.connectionId === c.id).length, Faturamento: sales.filter((s) => s.connectionId === c.id).reduce((a, s) => a + s.value, 0) })).filter((x) => x.Vendas)
  const byState = Object.entries(sales.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] || 0) + 1 }), {})).map(([name, Vendas]) => ({ name, Vendas })).sort((a, b) => b.Vendas - a.Vendas)
  const byProduct = db.products.map((pr) => ({ name: pr.name, Valor: sales.filter((s) => s.productId === pr.id).reduce((a, s) => a + s.value, 0), Qtd: sales.filter((s) => s.productId === pr.id).length })).filter((x) => x.Qtd)

  const cname = (id) => db.contacts.find((c) => c.id === id)?.name || '—'
  const pname = (id) => db.products.find((x) => x.id === id)?.name || '—'
  const conObj = (id) => db.connections.find((c) => c.id === id)

  const clearFilters = () => { setPeriod('today'); setConn(''); setProduct(''); setCurrency('BRL') }

  return (
    <div className="mx-auto max-w-[1400px]">
      {/* Greeting */}
      {/* Saudação no estilo de título da referência: rótulo com ponto verde + título grande com tracking negativo */}
      <div className="mb-5 flex flex-col gap-4 px-1 pt-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow-label eyebrow-dot mb-3" style={{ color: 'var(--accent-text)' }}>Dashboard</p>
          <h1 className="page-heading page-heading-lg flex flex-wrap items-center gap-x-2">{g}, {db.user.name}! {emoji}</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Operação <span className="link-accent">{db.company.name}</span> • <b className="text-text-primary" style={{ fontWeight: 650 }}>{db.contacts.length}</b> leads acumulados
          </p>
        </div>
        <button className="btn-secondary self-start sm:self-auto" onClick={() => setTrail(true)}><Trophy size={15} /> Trilha de onboarding</button>
      </div>

      {db.billing.status !== 'active' && (
        <div className="card mb-4 flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-semibold">Assinatura inativa</p>
            <p className="text-sm text-text-secondary">Sua assinatura está inativa. Assine um plano para começar a usar o serviço.</p>
          </div>
          <button className="btn-primary" onClick={() => nav('/billing')}>Assinar agora</button>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-4 p-3">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
          <Tabs className="2xl:w-72" value={hasChat ? tab : 'vendas'} onChange={setTab} tabs={hasChat ? [{ id: 'vendas', label: 'Vendas' }, { id: 'atendimento', label: 'Atendimento' }] : [{ id: 'vendas', label: 'Vendas' }]} />
          <div className="grid flex-1 grid-cols-2 gap-2 md:grid-cols-4">
            <Select value={period} onChange={setPeriod} options={PERIODS.map((x) => ({ value: x.id, label: x.label }))} />
            <Select value={conn} onChange={setConn} placeholder="Todas as conexões" options={db.connections.map((c) => ({ value: c.id, label: c.name }))} />
            <Select value={product} onChange={setProduct} placeholder="Todos os produtos" options={db.products.map((x) => ({ value: x.id, label: x.name }))} />
            <Select value={currency} onChange={setCurrency} options={['BRL', 'USD', 'EUR', 'MXN']} />
          </div>
          <div className="flex gap-1">
            <button className="btn-ghost p-2" title="Limpar filtros" onClick={clearFilters}><RotateCcw size={16} /></button>
            <button className="btn-ghost p-2" title="Salvar grupo de filtro" onClick={() => toast('Grupo de filtro salvo.')}><Bookmark size={16} /></button>
            <button className="btn-ghost p-2 text-violet-400" title="Atualizar dados" onClick={() => toast('Dados atualizados.', 'info')}><RefreshCw size={16} /></button>
            <button className="btn-ghost p-2" title="Configurar taxas e despesas" onClick={() => setFeeModal(true)}><Settings2 size={16} /></button>
          </div>
        </div>
      </div>

      {tab === 'vendas' || !hasChat ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard icon={Users} color="#3B82F6" label="Leads novos" value={leads.length} delta={variation(leads.length, prev.leads.length)} deltaTitle={vs(prev.leads.length)} />
            <StatCard icon={DollarSign} color="#14B8A6" label="Faturamento" value={brl(revenue, currency)} valueClass="text-violet-300" delta={variation(revenue, prev.revenue)} deltaTitle={vs(brl(prev.revenue, currency))} />
            <StatCard icon={ShoppingCart} color="#8B5CF6" label="Vendas" value={sales.length} delta={variation(sales.length, prev.sales.length)} deltaTitle={vs(prev.sales.length)} />
            <StatCard icon={TrendingUp} color="#F59E0B" label="ROAS" value={roas == null ? '—' : roas.toFixed(2)} delta={variation(roas, prev.roas)} deltaTitle={vs(prev.roas == null ? '—' : prev.roas.toFixed(2))}
              title={roas == null ? 'Informe o gasto com anúncios do período para calcular o ROAS' : 'Faturamento ÷ gasto com anúncios'} onClick={roas == null ? () => setAdsModal(true) : undefined} />
            <StatCard icon={Percent} color="#14B8A6" label="Taxa de Conversão" value={conv.toFixed(2) + '%'} delta={variation(conv, prev.conv)} deltaTitle={vs(prev.conv.toFixed(2) + '%')} />
            <StatCard icon={Receipt} color="#8B5CF6" label="Ticket médio" value={brl(ticket, currency)} delta={variation(ticket, prev.ticket)} deltaTitle={vs(brl(prev.ticket, currency))} />
            <StatCard icon={Wallet} color="#22C55E" label="Lucro" value={brl(profit, currency)} valueClass="text-green-400" delta={variation(profit, prev.profit)} deltaTitle={vs(brl(prev.profit, currency))}
              title="Faturamento − gasto com anúncios − taxas e despesas" />
            <StatCard icon={Megaphone} color="#EF4444" label="Gasto Meta (Ad)" invert onClick={() => setAdsModal(true)}
              value={adSpend ? brl(adSpend, currency) : <span className="text-sm text-text-muted">+ Informar gasto</span>} valueClass={adSpend ? 'text-red-400' : undefined}
              delta={variation(adSpend, prev.adSpend)} deltaTitle={vs(brl(prev.adSpend, currency))} title="Gasto com anúncios informado por período (clique para lançar)" />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <SectionCard title="Vendas por período" subtitle="Histórico temporal das conversões e faturamento" actions={<MetricToggle value={chartMetric} onChange={setChartMetric} />}>
              {byPeriod.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={byPeriod}>
                    <defs>
                      <linearGradient id="gv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={brand.accent} stopOpacity={0.5} /><stop offset="100%" stopColor={brand.accent} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border-default)" vertical={false} />
                    <XAxis dataKey="name" {...axis} />
                    <YAxis {...axis} width={50} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => (chartMetric === 'Valor' ? brl(v, currency) : v)} />
                    <Area type="monotone" dataKey={chartMetric} stroke={brand.accent} strokeWidth={2} fill="url(#gv)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <NoData />}
            </SectionCard>
            <SectionCard title="Vendas por horário" subtitle="Total de vendas do período filtrado, por hora do dia">
              {sales.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={byHour}>
                    <CartesianGrid stroke="var(--border-default)" vertical={false} />
                    <XAxis dataKey="name" {...axis} />
                    <YAxis {...axis} width={30} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: `rgba(${brand.accentRgb},.08)` }} />
                    <Bar dataKey="Vendas" fill={brand.accent} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <NoData />}
            </SectionCard>
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-3">
            <SectionCard title="Vendas por instância" subtitle="Operações por conexão ativa">
              {byConn.length ? <HBar data={byConn} k="Vendas" /> : <NoData />}
            </SectionCard>
            <SectionCard title="Faturamento por instância" subtitle="Receita por conexão ativa">
              {byConn.length ? <HBar data={byConn} k="Faturamento" money /> : <NoData />}
            </SectionCard>
            <SectionCard title="Vendas por estado" subtitle="Distribuição geográfica das vendas">
              {byState.length ? (
                <div className="space-y-2">
                  {byState.slice(0, 7).map((s, i) => (
                    <div key={s.name} className="flex items-center gap-3 text-sm">
                      <span className="w-8 font-semibold text-text-secondary">{s.name}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-interactive">
                        <div className="h-full rounded-full" style={{ width: `${(s.Vendas / byState[0].Vendas) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                      </div>
                      <span className="w-6 text-right text-text-muted">{s.Vendas}</span>
                    </div>
                  ))}
                </div>
              ) : <NoData />}
            </SectionCard>
          </div>

          <SectionCard
            className="mb-4"
            title="Histórico de vendas"
            subtitle="Auditoria e emissão fiscal de notas"
            actions={
              <div className="flex gap-2">
                <button className="btn-secondary" title="Exportar vendas do filtro atual em planilha" onClick={() => downloadCsv('vendas.csv', sales.map((s) => ({ instancia: conObj(s.connectionId)?.name, numero: conObj(s.connectionId)?.number, cliente: cname(s.contactId), produto: pname(s.productId), valor: s.value, moeda: s.currency, source_id: s.sourceId, data: fmtDate(s.at) })))}>
                  <Download size={15} /> Exportar CSV
                </button>
                <button className="btn-primary" onClick={() => setSaleModal(true)}><Plus size={15} /> Nova venda</button>
              </div>
            }
          >
            <Table
              empty="Nenhuma venda registrada no histórico do período."
              rows={[...sales].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25)}
              columns={[
                { key: 'inst', label: 'Instância', render: (s) => conObj(s.connectionId)?.name },
                { key: 'num', label: 'Nº da Instância', render: (s) => <span className="text-xs">{conObj(s.connectionId)?.number}</span> },
                { key: 'cli', label: 'Cliente (nome)', render: (s) => <span className="text-text-primary">{cname(s.contactId)}</span> },
                { key: 'prod', label: 'Produto', render: (s) => pname(s.productId) },
                { key: 'v', label: 'Valor', render: (s) => <span className="font-semibold text-green-400">{brl(s.value, s.currency)}</span> },
                { key: 'currency', label: 'Moeda' },
                { key: 'src', label: 'Source ID', render: (s) => <span className="text-xs text-text-muted">{s.sourceId || '—'}</span> },
                { key: 'at', label: 'Data', render: (s) => <span className="text-xs">{fmtDate(s.at)}</span> },
                { key: 'a', label: 'Ações', render: (s) => <button className="btn-ghost p-1.5 text-red-400" onClick={() => { db.remove('sales', s.id); toast('Venda removida.') }}><Trash2 size={14} /></button> },
              ]}
            />
          </SectionCard>

          <SectionCard title="Performance dos produtos" subtitle="Participação no total" actions={<MetricToggle value={prodMetric} onChange={setProdMetric} />}>
            {byProduct.length ? (
              <div className="grid items-center gap-4 md:grid-cols-2">
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={byProduct} dataKey={prodMetric} nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={3} stroke="none">
                      {byProduct.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => (prodMetric === 'Valor' ? brl(v) : v)} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {byProduct.map((x, i) => {
                    const total = byProduct.reduce((a, y) => a + y[prodMetric], 0)
                    return (
                      <div key={x.name} className="panel-soft flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                        <span className="flex-1">{x.name}</span>
                        <span className="font-semibold">{prodMetric === 'Valor' ? brl(x.Valor) : x.Qtd}</span>
                        <span className="w-12 text-right text-xs text-text-muted">{((x[prodMetric] / total) * 100).toFixed(1)}%</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : <NoData />}
          </SectionCard>
        </>
      ) : (
        <Atendimento period={period} conn={conn} />
      )}

      <NewSaleModal open={saleModal} onClose={() => setSaleModal(false)} />
      <Modal open={feeModal} onClose={() => setFeeModal(false)} title="Taxas e despesas" subtitle="Usadas no cálculo de lucro do dashboard" size="sm"
        footer={<button className="btn-primary" onClick={() => setFeeModal(false)}>Salvar</button>}>
        <Field label="Taxa por venda (R$)"><input type="number" className="input" value={db.expenses.fee} onChange={(e) => db.setKey('expenses', { ...db.expenses, fee: +e.target.value })} /></Field>
        <Field label="Despesas fixas no período (R$)"><input type="number" className="input" value={db.expenses.fixed} onChange={(e) => db.setKey('expenses', { ...db.expenses, fixed: +e.target.value })} /></Field>
        <button className="btn-secondary w-full text-xs" onClick={() => { setFeeModal(false); setAdsModal(true) }}><Megaphone size={14} /> Gasto com anúncios</button>
      </Modal>
      <AdsModal open={adsModal} onClose={() => setAdsModal(false)} range={range} currency={currency} />
      <Modal open={trail} onClose={() => setTrail(false)} title="Trilha de onboarding" subtitle="Complete as etapas para colocar sua operação no ar">
        {[
          ['Criar a primeira conexão do WhatsApp', db.connections.length > 0, '/connections'],
          ['Montar um fluxo de boas-vindas', db.flows.length > 0, '/flows'],
          ['Criar um agente de IA', db.agents.length > 0, '/agentes'],
          ['Organizar o funil no Kanban', db.kanbans.length > 0, '/crms'],
          ['Cadastrar produtos', db.products.length > 0, '/settings?tab=products'],
          ['Registrar a primeira venda', db.sales.length > 0, '/welcome'],
        ].map(([t, done, to]) => (
          <button key={t} onClick={() => { setTrail(false); nav(to) }} className="mb-2 flex w-full items-center gap-3 panel-soft px-3 py-2.5 text-left text-sm hover:border-border-hover">
            <CheckCircle2 size={18} className={done ? 'text-green-400' : 'text-text-muted'} />
            <span className={cx('flex-1', done && 'text-text-muted line-through')}>{t}</span>
          </button>
        ))}
      </Modal>
    </div>
  )
}

function HBar({ data, k, money }) {
  const brand = useBrand()
  const PALETTE = brand.chart
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.length * 48)}>
      <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" {...axis} width={110} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (money ? brl(v) : v)} cursor={{ fill: `rgba(${brand.accentRgb},.08)` }} />
        <Bar dataKey={k} radius={[0, 6, 6, 0]}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function NewSaleModal({ open, onClose }) {
  const db = useDB()
  const [f, setF] = useState({ productId: db.products[0]?.id || '', contactId: db.contacts[0]?.id || '', connectionId: db.connections[0]?.id || '', value: db.products[0]?.price || 0, currency: 'BRL', sourceId: '' })
  const save = () => {
    const c = db.contacts.find((x) => x.id === f.contactId)
    db.add('sales', { ...f, value: +f.value, state: c?.state || 'SP', at: new Date().toISOString() })
    toast('Venda registrada!')
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title="Nova venda" subtitle="Registre manualmente uma venda no painel"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Registrar venda</button></>}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Produto">
          <Select value={f.productId} onChange={(v) => setF({ ...f, productId: v, value: db.products.find((p) => p.id === v)?.price || f.value })} options={db.products.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <Field label="Cliente"><Select value={f.contactId} onChange={(v) => setF({ ...f, contactId: v })} options={db.contacts.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Conexão"><Select value={f.connectionId} onChange={(v) => setF({ ...f, connectionId: v })} options={db.connections.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Valor"><input type="number" className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        <Field label="Moeda"><Select value={f.currency} onChange={(v) => setF({ ...f, currency: v })} options={['BRL', 'USD', 'EUR', 'MXN']} /></Field>
        <Field label="Source ID (opcional)"><input className="input" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

function Atendimento({ period, conn }) {
  const db = useDB()
  const brand = useBrand()
  const PALETTE = brand.chart
  const [view, setView] = useState('Tabela')
  const chats = db.chats.filter((c) => inPeriod(db.messages[c.id]?.[0]?.at || c.lastMessageAt, period) && (!conn || c.connectionId === conn))
  const attended = chats.filter((c) => c.status !== 'waiting')
  const resolved = chats.filter((c) => c.status === 'resolved')
  const unanswered = chats.filter((c) => !c.answered)
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const heat = DAYS.map((_, d) => Array.from({ length: 24 }, (_, h) => chats.filter((c) => { const t = new Date(db.messages[c.id]?.[0]?.at || c.lastMessageAt); return t.getDay() === d && t.getHours() === h }).length))
  const max = Math.max(1, ...heat.flat())
  const perDay = Object.values(chats.reduce((a, c) => { const t = new Date(c.lastMessageAt); const k = `${t.getDate()}/${t.getMonth() + 1}`; a[k] = a[k] || { name: k, Chats: 0, sort: t.getTime() }; a[k].Chats++; return a }, {})).sort((a, b) => a.sort - b.sort)
  const status = [
    { name: 'Aguardando', value: chats.filter((c) => c.status === 'waiting').length },
    { name: 'Atendendo', value: chats.filter((c) => c.status === 'attending').length },
    { name: 'Resolvidos', value: resolved.length },
  ]
  const byConn = db.connections.map((c) => ({ name: c.name, Leads: chats.filter((x) => x.connectionId === c.id).length }))
  const agents = db.team.map((u) => ({ name: u.name, atendidos: chats.filter((c) => c.assignedTo === u.id).length, emAtendimento: chats.filter((c) => c.assignedTo === u.id && c.status === 'attending').length, resolvidos: chats.filter((c) => c.assignedTo === u.id && c.status === 'resolved').length, tempo: '—' }))

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard icon={Users} color="#3B82F6" label="Leads novos" value={chats.length} />
        <StatCard icon={UserCheck} color="#8B5CF6" label="Leads atendidos" value={attended.length} />
        <StatCard icon={CheckCircle2} color="#22C55E" label="Leads finalizados" value={resolved.length} />
        <StatCard icon={Clock} color="#F59E0B" label="Tempo de resposta" value={chats.length ? '2m 14s' : '—'} />
        <StatCard icon={MessageSquareOff} color="#EF4444" label="Sem resposta" value={unanswered.length} />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Atendimentos no período" subtitle="Chats abertos no período, a mesma base dos leads novos.">
          {perDay.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={perDay}>
                <CartesianGrid stroke="var(--border-default)" vertical={false} />
                <XAxis dataKey="name" {...axis} /><YAxis {...axis} width={30} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area dataKey="Chats" stroke={PALETTE[3]} fill={PALETTE[3] + '33'} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <NoData />}
        </SectionCard>
        <SectionCard title="Atendimentos por hora" subtitle="Chats abertos no período, por dia da semana e hora.">
          <div className="overflow-x-auto">
            <div className="min-w-[520px]">
              <div className="ml-9 grid grid-cols-24 gap-0.5 text-[9px] text-text-muted" style={{ gridTemplateColumns: 'repeat(24,1fr)' }}>
                {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center">{String(h).padStart(2, '0')}</span>)}
              </div>
              {heat.map((row, d) => (
                <div key={d} className="mt-0.5 flex items-center gap-1">
                  <span className="w-8 text-[10px] text-text-muted">{DAYS[d]}</span>
                  <div className="grid flex-1 gap-0.5" style={{ gridTemplateColumns: 'repeat(24,1fr)' }}>
                    {row.map((v, h) => <div key={h} title={`${DAYS[d]} ${h}h: ${v}`} className="aspect-square rounded-sm" style={{ background: v ? `rgba(${brand.accentRgb},${0.2 + (v / max) * 0.8})` : 'var(--surface-interactive)' }} />)}
                  </div>
                </div>
              ))}
              <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-text-muted">Menos {[0.2, 0.4, 0.6, 0.8, 1].map((o) => <span key={o} className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgba(${brand.accentRgb},${o})` }} />)} Mais</div>
            </div>
          </div>
        </SectionCard>
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <SectionCard title="Tempo de resposta" subtitle="Média da primeira mensagem enviada por um atendente.">
          <p className="py-6 text-center text-3xl font-bold text-amber-400">{chats.length ? '2m 14s' : '—'}</p>
          <p className="text-center text-xs text-text-muted">{unanswered.length} sem resposta de atendente</p>
        </SectionCard>
        <SectionCard title="Leads por status">
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={status} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} stroke="none">
                {status.map((_, i) => <Cell key={i} fill={brand.statusPie[i]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </SectionCard>
        <SectionCard title="Distribuição de leads por conexão">
          <HBar data={byConn} k="Leads" />
        </SectionCard>
      </div>
      <SectionCard
        title="Desempenho por atendente"
        subtitle="Atendidos e tempo são das primeiras respostas que ele escreveu. Em atendimento e resolvidos são os chats que estão com ele agora."
        actions={<div className="seg">{['Tabela', 'Gráfico'].map((v) => <button key={v} onClick={() => setView(v)} className={cx('px-2.5 py-1 text-xs font-[650]', view === v ? 'is-selected' : 'text-text-secondary')}>{v}</button>)}</div>}
      >
        {view === 'Tabela' ? (
          <Table rows={agents} empty="Nenhum dado de atendimento encontrado" columns={[
            { key: 'name', label: 'Atendente', render: (r) => <span className="text-text-primary">{r.name}</span> },
            { key: 'atendidos', label: 'Atendidos' },
            { key: 'emAtendimento', label: 'Em atendimento' },
            { key: 'resolvidos', label: 'Resolvidos' },
            { key: 'tempo', label: 'Tempo médio' },
          ]} />
        ) : (
          <HBar data={agents.map((a) => ({ name: a.name, Atendidos: a.atendidos }))} k="Atendidos" />
        )}
      </SectionCard>
    </>
  )
}
