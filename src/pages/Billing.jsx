// Cobrança e Assinatura: plano Pro (acesso geral à ferramenta), situação da conta e faturas.
// "Ativar plano" abre a oferta do plano na Vórtex Pay (função assinatura); o plano ativa sozinho quando o pagamento é
// confirmado (creditos-webhook), e a assinatura chega aqui pelo tempo real.
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Copy, CreditCard, ExternalLink, LifeBuoy, Loader2 } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import { assinatura, planoAtivo } from '../lib/assinatura'
import { openSupport } from '../lib/support'
import { brl, cx, fmtDate } from '../lib/utils'
import { PageHeader, SectionCard, Table } from '../components/ui'

// O que o plano libera (pacote padrão "Completo")
const INCLUI = ['Conexões de WhatsApp (API Web e Oficial)', 'Chat ao vivo e contatos', 'Kanban de CRM', 'Fluxos de automação e disparos', 'Agentes de IA', 'Webhooks, Facebook e pixels']
const FATURA = { paga: 'badge-success', estornada: 'badge-danger' }
const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR')

export default function Billing() {
  const db = useDB()
  const cid = db.company.id
  const admin = ['Proprietário', 'Admin'].includes(db.team.find((m) => m.id === db.memberId)?.role || db.user.role)
  const active = planoAtivo(db)
  const [plano, setPlano] = useState(null)
  const [cobrancas, setCobrancas] = useState([])
  const [pagando, setPagando] = useState(false)

  const carregar = useCallback(async () => {
    const [p, c] = await Promise.all([assinatura.plano(), assinatura.cobrancas(cid)])
    setPlano(p); setCobrancas(c)
  }, [cid])
  useEffect(() => { carregar() }, [carregar])

  // Pagamento aberto: confere a cada 10 s até a cobrança sair de "Aguardando pagamento" (no máximo 15 min)
  const aguardando = cobrancas.some((c) => c.status === 'pendente' && Date.now() - new Date(c.createdAt) < 15 * 60e3)
  useEffect(() => {
    if (!aguardando) return
    const t = setInterval(async () => {
      const antes = cobrancas.filter((c) => c.status === 'pendente').map((c) => c.id)
      const agora = await assinatura.cobrancas(cid)
      setCobrancas(agora)
      const paga = agora.find((c) => antes.includes(c.id) && c.status === 'paga')
      if (paga) {
        toast(`Pagamento confirmado: plano ativo até ${dia(paga.periodEnd)}.`)
        assinatura.faturas(cid).then((invoices) => useDB.setState({ invoices })).catch(() => {})
      }
    }, 10_000)
    return () => clearInterval(t)
  }, [aguardando, cid, cobrancas])

  const pagar = async () => {
    setPagando(true)
    // abre a janela no clique (senão o navegador bloqueia) e manda para o link quando ele chegar
    const janela = BACKEND ? window.open('', '_blank') : null
    try {
      const r = await assinatura.pagar()
      if (r.simulado) toast(`Plano ativo até ${dia(r.ate)} (pagamento simulado).`)
      else {
        if (janela) janela.location.href = r.url
        else window.location.href = r.url
        toast('Pagamento aberto na Vórtex Pay. O plano ativa assim que o pagamento for confirmado.', 'info')
      }
      await carregar()
    } catch (e) {
      janela?.close()
      toast(e.message, 'error')
    } finally { setPagando(false) }
  }

  const ultima = cobrancas[0]
  const pendente = ultima?.status === 'pendente' && Date.now() - new Date(ultima.createdAt) < 86400e3 ? ultima : null
  const emAnalise = ultima?.status === 'em_analise' ? ultima : null
  const contaId = String(db.company.publicId ?? db.company.id)

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={CreditCard} title="Cobrança e Assinatura" subtitle="Controle seu plano e gerencie suas faturas" />
      <div className="mb-4 grid gap-4 lg:grid-cols-5">
        <SectionCard className="lg:col-span-3" title={`Canais ${plano?.name || 'Pro'}`} subtitle="Acesso geral à ferramenta" actions={active && <span className="badge-success">Plano atual</span>}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <p className="flex items-baseline gap-1">
              <span className="text-3xl font-bold">{plano ? brl(plano.priceCents / 100) : '…'}</span>
              <span className="text-sm text-text-muted">/mês</span>
            </p>
            <button className={active ? 'btn-secondary' : 'btn-primary'} disabled={!plano?.paymentReady || !admin || pagando} onClick={pagar}>
              {pagando ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />} {active ? 'Pagar próxima mensalidade' : 'Ativar plano'}
            </button>
          </div>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {INCLUI.map((t) => <li key={t} className="flex items-center gap-2 text-text-secondary"><CheckCircle2 size={14} className="shrink-0 text-green-400" />{t}</li>)}
          </ul>
          {pendente && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
              {aguardando && <Loader2 size={14} className="animate-spin" />}
              <span className="min-w-0 flex-1">Aguardando a confirmação do pagamento. O plano ativa sozinho assim que ele for aprovado.</span>
              {pendente.checkoutUrl && <a className="btn-secondary text-xs" href={pendente.checkoutUrl} target="_blank" rel="noreferrer">Abrir pagamento <ExternalLink size={12} /></a>}
            </div>
          )}
          {emAnalise && <p className="mt-4 rounded-[14px] border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">Pagamento em análise: nossa equipe confere e ativa o plano. Se precisar, fale com o suporte.</p>}
          {plano && !plano.paymentReady && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
              <span className="min-w-0 flex-1">O pagamento online do plano ainda não foi ativado. Fale com o suporte para ativar.</span>
              <button className="btn-secondary text-xs" onClick={() => openSupport()}><LifeBuoy size={13} /> Suporte</button>
            </div>
          )}
          {!admin && <p className="mt-3 text-xs text-text-muted">Só o proprietário ou um admin da empresa pode ativar o plano.</p>}
          <p className="mt-3 text-xs text-text-muted">Pagamento por Pix ou cartão na Vórtex Pay. Cada pagamento vale 1 mês (em dia, o mês novo começa no vencimento). O consumo da IA da plataforma é cobrado à parte, em Créditos de IA.</p>
        </SectionCard>

        <SectionCard className="lg:col-span-2" title="Informações da conta">
          {[
            ['Conta atual', <span key="id" className="flex items-center gap-2">{contaId}<button className="text-text-muted hover:text-text-primary" onClick={() => { navigator.clipboard?.writeText(contaId); toast('ID da conta copiado.') }} title="Copiar ID da conta"><Copy size={12} /></button></span>],
            ['Status geral', <span key="st" className={cx('badge px-3 py-1 text-xs font-bold tracking-wide ring-1', active ? 'bg-green-500/20 text-green-400 ring-green-500/50' : 'bg-red-500/20 text-red-400 ring-red-500/50')}>{active ? 'ATIVA' : 'INATIVA'}</span>],
            ['Recorrência', db.billing.recurrence || 'Mensal'],
            ['Próximo vencimento', dia(db.billing.nextDue)],
          ].map(([l, v]) => (
            <div key={l} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"><span className="text-text-muted">{l}</span><b>{v}</b></div>
          ))}
        </SectionCard>
      </div>

      <SectionCard title="Histórico de Faturas" subtitle="Faturas recentes da sua conta" actions={<button className="btn-secondary" onClick={() => openSupport()}><LifeBuoy size={14} /> Falar com suporte</button>}>
        <Table rows={[...db.invoices].sort((a, b) => b.date.localeCompare(a.date))} empty="Nenhuma fatura encontrada" columns={[
          { key: 'id', label: 'Fatura', render: (i) => <div><span className="font-mono text-text-primary">{i.number || i.id.slice(0, 8)}</span>{i.periodStart && i.periodEnd && <p className="text-xs text-text-muted">{dia(i.periodStart)} a {dia(i.periodEnd)}</p>}</div> },
          { key: 'date', label: 'Data', render: (i) => fmtDate(i.date) },
          { key: 'amount', label: 'Valor', render: (i) => <b>{brl(i.amount)}</b> },
          { key: 'status', label: 'Status', render: (i) => <span className={FATURA[i.status] || 'badge-muted'}>{i.status === 'paga' && <CheckCircle2 size={10} />} {i.status}</span> },
        ]} />
      </SectionCard>
    </div>
  )
}
