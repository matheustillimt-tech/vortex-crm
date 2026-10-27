// Créditos de IA da empresa: saldo, compra (Vórtex Pay), extrato, recargas e consumo por agente e por tipo.
// O saldo vale para todos os agentes da empresa e só é gasto quando a IA usa a chave da plataforma.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Bot, CheckCircle2, Coins, ExternalLink, History, Loader2, Mic, ReceiptText, ShieldCheck, Sparkles, Type, Volume2 } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { creditos, fmtCred, KIND, MODALITY, ORIGIN, RECHARGE, reais } from '../lib/creditos'
import { cx, fmtDate } from '../lib/utils'
import { EmptyState, Field, PageHeader, Pills, SectionCard, Table, Tabs } from '../components/ui'

const PERIODOS = [{ id: 7, label: '7 dias' }, { id: 30, label: '30 dias' }, { id: 90, label: '90 dias' }]
const MOD_ICON = { texto: Type, audio: Mic, voz: Volume2 }
const desde = (dias) => new Date(Date.now() - dias * 86400e3).toISOString()
// previsão de duração do saldo só com alguns dias de uso (com menos, a média engana)
const MIN_DIAS_PREVISAO = 3
// dias inteiros entre um dia (AAAA-MM-DD, horário de Brasília) e hoje
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const diasDesde = (dia) => Math.max(0, Math.round((Date.parse(hojeSP()) - Date.parse(String(dia).slice(0, 10))) / 86400e3))

export default function AiCredits() {
  const db = useDB()
  const nav = useNavigate()
  const cid = db.company.id
  const admin = ['Proprietário', 'Admin'].includes(db.team.find((m) => m.id === db.memberId)?.role || db.user.role)
  const [s, setS] = useState(null)
  const [erro, setErro] = useState(null)
  const [pacotes, setPacotes] = useState([])
  const [recargas, setRecargas] = useState([])
  const [tab, setTab] = useState('extrato')
  const [comprando, setComprando] = useState(null)
  const [uso30, setUso30] = useState(null)

  const carregar = useCallback(async () => {
    try {
      const [sum, pk, rc, u] = await Promise.all([creditos.summary(cid), creditos.packages(), creditos.recharges(cid), creditos.usage(cid, desde(30))])
      setS(sum); setPacotes(pk); setRecargas(rc); setUso30(u); setErro(null)
    } catch (e) { setErro(e.message) }
  }, [cid])
  useEffect(() => { carregar() }, [carregar])

  // Pagamento aberto: confere a cada 10 s até a recarga sair de "Aguardando pagamento" (no máximo 15 min)
  const aguardando = recargas.some((r) => r.status === 'pendente' && Date.now() - new Date(r.createdAt) < 15 * 60e3)
  useEffect(() => {
    if (!aguardando) return
    const t = setInterval(async () => {
      const antes = recargas.filter((r) => r.status === 'pendente').map((r) => r.id)
      await carregar()
      const pagas = (await creditos.recharges(cid)).filter((r) => antes.includes(r.id) && r.status === 'paga')
      if (pagas.length) toast(`Pagamento confirmado: +${fmtCred(pagas.reduce((n, r) => n + Number(r.credits) + Number(r.bonus), 0))} créditos.`)
    }, 10_000)
    return () => clearInterval(t)
  }, [aguardando, carregar, cid, recargas])

  const comprar = async (p) => {
    setComprando(p.id)
    // abre a janela no clique (senão o navegador bloqueia) e manda para o link quando ele chegar
    const janela = window.open('', '_blank')
    try {
      const r = await creditos.buy(p.id)
      if (janela) janela.location.href = r.url
      else window.location.href = r.url
      toast('Pagamento aberto na Vórtex Pay. Os créditos entram assim que o pagamento for confirmado.', 'info')
      await carregar()
    } catch (e) {
      janela?.close()
      toast(e.message, 'error')
    } finally { setComprando(null) }
  }

  if (erro) return <div className="mx-auto max-w-[1100px]"><PageHeader icon={Coins} title="Créditos de IA" /><div className="card p-6 text-sm text-red-400">Não foi possível carregar: {erro} <button className="btn-secondary ml-3 text-xs" onClick={carregar}>Tentar de novo</button></div></div>
  if (!s) return <div className="mx-auto max-w-[1100px]"><PageHeader icon={Coins} title="Créditos de IA" /><div className="card flex items-center gap-2 p-6 text-sm text-text-muted"><Loader2 size={15} className="animate-spin" /> Carregando…</div></div>

  const interno = s.mode === 'interno'
  const semCarteira = !s.exists || !s.active
  const consumo30 = (uso30?.byDay || []).reduce((n, d) => n + Number(d.credits), 0)
  // média pelos dias desde o primeiro consumo do período (não por 30: com um dia de uso, a conta daria anos)
  const diasDeUso = uso30?.byDay?.length ? Math.min(30, diasDesde(uso30.byDay[0].day) + 1) : 0
  const porDia = diasDeUso ? consumo30 / diasDeUso : 0
  const poucoUso = diasDeUso < MIN_DIAS_PREVISAO
  const diasDeSaldo = !poucoUso && porDia > 0 ? Math.floor(Math.max(0, s.available) / porDia) : null

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader icon={Coins} title="Créditos de IA" subtitle="O saldo da IA da plataforma, dividido entre todos os agentes da empresa" />

      {semCarteira ? (
        <EmptyState icon={ShieldCheck} title="A IA da plataforma não está liberada para esta empresa"
          hint="Os agentes respondem com a chave de IA que vocês conectarem em Configurações → Integrações (sem créditos). Para usar a IA da plataforma com créditos pré-pagos, fale com o suporte."
          action={<button className="btn-secondary" onClick={() => nav('/settings?tab=integrations')}>Abrir Integrações</button>} />
      ) : (
        <>
          <SaldoAviso s={s} interno={interno} />
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="card p-4">
              <p className="eyebrow-label">Saldo disponível</p>
              <p className={cx('mt-2 font-display text-[28px] leading-none', s.available <= 0 && !interno ? 'text-red-400' : 'text-text-primary')} style={{ fontWeight: 650, letterSpacing: '-0.04em' }}>{interno ? '—' : fmtCred(s.available)}</p>
              <p className="mt-1 text-xs text-text-muted">{interno ? 'Uso interno: sem cobrança' : `créditos · ${reais(Math.max(0, s.available) * s.creditBrl * 100)} de saldo`}</p>
            </div>
            <div className="card p-4">
              <p className="eyebrow-label">Consumo nos últimos 30 dias</p>
              <p className="mt-2 font-display text-[28px] leading-none" style={{ fontWeight: 650, letterSpacing: '-0.04em' }}>{fmtCred(consumo30)}</p>
              <p className="mt-1 text-xs text-text-muted">créditos · {diasDeUso ? `${fmtCred(porDia)} por dia em ${diasDeUso} dia${diasDeUso === 1 ? '' : 's'} de uso` : 'sem uso ainda'}</p>
            </div>
            <div className="card p-4">
              <p className="eyebrow-label">O saldo dura</p>
              <p className="mt-2 font-display text-[28px] leading-none" style={{ fontWeight: 650, letterSpacing: '-0.04em' }}>{interno ? '—' : diasDeSaldo == null ? '—' : `${diasDeSaldo} dia${diasDeSaldo === 1 ? '' : 's'}`}</p>
              <p className="mt-1 text-xs text-text-muted">{s.reserved > 0 ? `${fmtCred(s.reserved)} reservados agora em respostas em andamento` : poucoUso ? `aparece depois de ${MIN_DIAS_PREVISAO} dias de uso` : `no ritmo dos últimos ${diasDeUso} dias`}</p>
            </div>
          </div>

          {!interno && (
            <SectionCard className="mb-5" title="Comprar créditos" subtitle="1 crédito = R$ 0,01 de saldo. O pagamento é pela Vórtex Pay (Pix ou cartão) e os créditos entram quando ele for confirmado.">
              {!s.paymentReady && <p className="mb-3 flex gap-2 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-400"><AlertTriangle size={14} className="mt-px shrink-0" />A compra ainda não foi ativada na plataforma. Fale com o suporte para recarregar.</p>}
              {!admin && <p className="mb-3 text-xs text-text-muted">Só o proprietário ou um admin da empresa compra créditos.</p>}
              {pacotes.length === 0 ? <p className="text-sm text-text-muted">Nenhum pacote à venda no momento.</p> : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {pacotes.map((p) => {
                    const total = Number(p.credits) + Number(p.bonus)
                    return (
                      <div key={p.id} className={cx('relative flex flex-col rounded-[18px] border p-4', p.highlight ? 'choice-on' : 'border-border')}>
                        {p.highlight && <span className="badge-success absolute right-3 top-3">Mais escolhido</span>}
                        <p className="text-sm font-semibold">{p.name}</p>
                        <p className="mt-1 font-display text-2xl" style={{ fontWeight: 650 }}>{fmtCred(total)} <span className="text-sm font-normal text-text-muted">créditos</span></p>
                        {Number(p.bonus) > 0 && <p className="text-xs text-green-400">inclui {fmtCred(p.bonus)} de bônus</p>}
                        {p.description && <p className="mt-1 text-xs text-text-muted">{p.description}</p>}
                        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                          <span className="text-lg font-semibold">{reais(p.priceCents)}</span>
                          <button className="btn-primary text-xs" disabled={!admin || !s.paymentReady || comprando} onClick={() => comprar(p)}>
                            {comprando === p.id ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Comprar
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {aguardando && <p className="mt-3 flex items-center gap-2 text-xs text-text-muted"><Loader2 size={13} className="animate-spin" /> Esperando a confirmação do pagamento…</p>}
            </SectionCard>
          )}

          <Tabs className="mb-4 max-w-md" value={tab} onChange={setTab} tabs={[{ id: 'extrato', label: 'Extrato', icon: ReceiptText }, { id: 'recargas', label: 'Recargas', icon: History }, { id: 'consumo', label: 'Consumo', icon: Bot }]} />
          {tab === 'extrato' && <Extrato cid={cid} />}
          {tab === 'recargas' && <Recargas lista={recargas} admin={admin} onChange={carregar} />}
          {tab === 'consumo' && <Consumo cid={cid} />}
          {!interno && admin && <AvisoSaldo s={s} cid={cid} onSaved={carregar} />}
        </>
      )}
    </div>
  )
}

function SaldoAviso({ s, interno }) {
  if (interno) return <p className="mb-4 flex gap-2 rounded-[14px] border border-border p-3 text-sm text-text-secondary"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-400" />Empresa interna: a IA da plataforma está liberada sem cobrança. O consumo aparece aqui para acompanhamento.</p>
  if (s.available <= 0) return <p className="mb-4 flex gap-2 rounded-[14px] bg-red-500/10 p-3 text-sm text-red-400"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Sem créditos: a IA não responde e as conversas vão para a equipe, que continua atendendo pelo Chat. Recarregue abaixo.</p>
  if (s.available < s.alertCredits) return <p className="mb-4 flex gap-2 rounded-[14px] bg-amber-500/10 p-3 text-sm text-amber-400"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Saldo baixo: menos de {fmtCred(s.alertCredits)} créditos. Quando acabar, a IA para de responder.</p>
  return null
}

function Extrato({ cid }) {
  const db = useDB()
  const [lista, setLista] = useState(null)
  const [fim, setFim] = useState(false)
  const agentes = useMemo(() => Object.fromEntries(db.agents.map((a) => [a.id, a.name])), [db.agents])
  const mais = async (antes) => {
    const l = await creditos.ledger(cid, antes)
    setLista((x) => [...(antes ? x || [] : []), ...l])
    setFim(l.length < 50)
  }
  useEffect(() => { mais().catch((e) => toast(e.message, 'error')) }, [cid]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!lista) return <div className="card p-6 text-sm text-text-muted">Carregando…</div>
  return (
    <>
      <Table empty="Nenhum lançamento ainda." rows={lista} columns={[
        { key: 'createdAt', label: 'Quando', render: (r) => <span className="whitespace-nowrap">{fmtDate(r.createdAt)}</span> },
        { key: 'kind', label: 'Tipo', render: (r) => <span className={KIND[r.kind]?.[0]}>{KIND[r.kind]?.[1] || r.kind}</span> },
        { key: 'description', label: 'Descrição', render: (r) => (
          <span className="text-text-primary">{r.description}{r.agentId && <span className="block text-xs text-text-muted">{agentes[r.agentId] || 'Agente excluído'}{r.origin && r.origin !== 'atendimento' ? ` · ${ORIGIN[r.origin]}` : ''}</span>}</span>
        ) },
        { key: 'modality', label: 'Uso', render: (r) => (r.modality ? <span className="inline-flex items-center gap-1 text-xs">{(() => { const I = MOD_ICON[r.modality] || Type; return <I size={12} /> })()}{MODALITY[r.modality]}</span> : '—') },
        { key: 'credits', label: 'Créditos', render: (r) => <span className={cx('whitespace-nowrap font-semibold', r.credits > 0 ? 'text-green-400' : r.credits < 0 ? 'text-text-primary' : 'text-text-muted')}>{fmtCred(r.credits, { sinal: true })}</span> },
        { key: 'balanceAfter', label: 'Saldo', render: (r) => <span className="whitespace-nowrap">{fmtCred(r.balanceAfter)}</span> },
      ]} />
      {!fim && lista.length > 0 && <button className="btn-secondary mt-3 text-xs" onClick={() => mais(lista.at(-1).n)}>Carregar mais</button>}
    </>
  )
}

function Recargas({ lista, admin, onChange }) {
  const cancelar = async (r) => { try { await creditos.cancelRecharge(r.id); toast('Recarga cancelada.'); onChange() } catch (e) { toast(e.message, 'error') } }
  return (
    <Table empty="Nenhuma recarga ainda." rows={lista} columns={[
      { key: 'createdAt', label: 'Pedido em', render: (r) => <span className="whitespace-nowrap">{fmtDate(r.createdAt)}</span> },
      { key: 'packageName', label: 'Pacote', render: (r) => <span className="text-text-primary">{r.packageName}<span className="block text-xs text-text-muted">{r.ref}</span></span> },
      { key: 'credits', label: 'Créditos', render: (r) => `${fmtCred(Number(r.credits) + Number(r.bonus))}${Number(r.bonus) > 0 ? ' (com bônus)' : ''}` },
      { key: 'priceCents', label: 'Valor', render: (r) => reais(r.priceCents) },
      { key: 'status', label: 'Situação', render: (r) => <span title={r.note || ''} className={RECHARGE[r.status]?.[0]}>{RECHARGE[r.status]?.[1] || r.status}</span> },
      { key: 'paidAt', label: 'Pago em', render: (r) => (r.paidAt ? fmtDate(r.paidAt) : '—') },
      { key: 'acoes', label: '', render: (r) => r.status === 'pendente' && (
        <span className="flex gap-1.5">
          {r.checkoutUrl && <a className="btn-secondary px-2 py-1 text-xs" href={r.checkoutUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Pagar</a>}
          {admin && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => cancelar(r)}>Cancelar</button>}
        </span>
      ) },
    ]} />
  )
}

function Barra({ label, valor, max, sub, icon: I }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-text-primary">{I && <I size={12} />}{label}</span>
        <span className="whitespace-nowrap text-text-muted">{fmtCred(valor)} créditos{sub ? ` · ${sub}` : ''}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-interactive"><div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(2, (valor / max) * 100) : 0}%`, background: 'var(--material-primary)' }} /></div>
    </div>
  )
}

function Consumo({ cid }) {
  const [dias, setDias] = useState(30)
  const [u, setU] = useState(null)
  useEffect(() => { setU(null); creditos.usage(cid, desde(dias)).then(setU).catch((e) => toast(e.message, 'error')) }, [cid, dias])
  if (!u) return <div className="card p-6 text-sm text-text-muted">Carregando…</div>
  const tot = (l) => l.reduce((n, x) => n + Number(x.credits), 0)
  const maxDia = Math.max(0, ...u.byDay.map((d) => Number(d.credits)))
  return (
    <div className="space-y-4">
      <Pills options={PERIODOS} value={dias} onChange={setDias} />
      {u.byDay.length === 0 ? <div className="card p-6 text-sm text-text-muted">Nenhum consumo no período.</div> : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard title="Por agente" subtitle={`${fmtCred(tot(u.byAgent))} créditos no período`}>
              {u.byAgent.map((a) => <Barra key={a.agentId || a.name} label={a.name} valor={Number(a.credits)} max={Number(u.byAgent[0]?.credits)} sub={`${a.ops} operações`} icon={Bot} />)}
            </SectionCard>
            <SectionCard title="Por tipo" subtitle="Texto (conversa), áudio (transcrição do cliente) e voz (resposta em áudio)">
              {u.byModality.map((m) => <Barra key={m.modality} label={MODALITY[m.modality] || m.modality} valor={Number(m.credits)} max={Number(u.byModality[0]?.credits)} sub={`${m.ops} operações`} icon={MOD_ICON[m.modality]} />)}
              {u.byOrigin.some((o) => o.origin !== 'atendimento') && (
                <p className="mt-3 text-xs text-text-muted">Inclui {u.byOrigin.filter((o) => o.origin !== 'atendimento').map((o) => `${ORIGIN[o.origin] || o.origin}: ${fmtCred(o.credits)}`).join(' · ')}</p>
              )}
            </SectionCard>
          </div>
          <SectionCard title="Por dia">
            <div className="flex h-36 items-end gap-1">
              {u.byDay.map((d) => (
                <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end" title={`${new Date(d.day + 'T12:00').toLocaleDateString('pt-BR')}: ${fmtCred(d.credits)} créditos · ${d.chats} conversas`}>
                  <div className="w-full rounded-t-[4px]" style={{ height: `${maxDia ? Math.max(3, (Number(d.credits) / maxDia) * 100) : 0}%`, background: 'var(--material-primary)' }} />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-muted">Passe o mouse em cada barra para ver o dia. Média de {fmtCred(tot(u.byDay) / Math.max(1, u.byDay.reduce((n, d) => n + Number(d.chats), 0)))} créditos por conversa atendida.</p>
          </SectionCard>
        </>
      )}
    </div>
  )
}

function AvisoSaldo({ s, cid, onSaved }) {
  const [v, setV] = useState(String(Math.round(s.alertCredits)))
  const salvar = async (padrao = false) => {
    try { await creditos.setAlert(cid, padrao ? null : Math.max(0, Number(v) || 0)); toast('Aviso de saldo baixo salvo.'); onSaved() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <SectionCard className="mt-5" title="Aviso de saldo baixo" subtitle="Abaixo deste saldo o painel avisa a equipe. Com o saldo zerado, a IA para e as conversas vão para a equipe.">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Avisar abaixo de (créditos)" className="mb-0 w-48"><input className="input" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} /></Field>
        <button className="btn-primary" onClick={() => salvar()}>Salvar</button>
        {s.ownAlert && <button className="btn-ghost text-xs" onClick={() => salvar(true)}>Voltar ao padrão</button>}
      </div>
    </SectionCard>
  )
}
