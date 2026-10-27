// Acesso ao desenvolvedor → Créditos de IA: custo real, receita de consumo e margem; carteiras (liberar, modo,
// multiplicador, ajuste de saldo, extrato com custo); pacotes; preços dos provedores; pagamentos da Vórtex Pay e a
// configuração (valor do crédito, multiplicador, câmbio). Tudo passa pelas funções sa_ai_* (só superadmin).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Calculator, Coins, Copy, Link2, Package, Pencil, Plus, ReceiptText, RefreshCw, Settings2, Tags, Trash2, Wallet } from 'lucide-react'
import { toast } from '../lib/store'
import { SUPABASE_URL } from '../lib/supabase'
import { sa } from '../lib/superadmin'
import { saCreditos, fmtCred, reais, brl4, KIND, MODALITY, ORIGIN, RECHARGE } from '../lib/creditos'
import { cx, fmtDate } from '../lib/utils'
import { Confirm, Field, Modal, PageHeader, Pills, Select, Table, Tabs, Toggle } from '../components/ui'
import { Metric } from './SuperAdmin'

const PERIODOS = [{ id: 7, label: '7 dias' }, { id: 30, label: '30 dias' }, { id: 90, label: '90 dias' }]
const UNIDADES = { input_mtok: 'Entrada (US$/milhão de tokens)', cached_mtok: 'Entrada em cache (US$/milhão)', audio_input_mtok: 'Entrada de áudio (US$/milhão)', output_mtok: 'Saída (US$/milhão de tokens)', stt_hour: 'Transcrição (US$/hora)', tts_kchar: 'Voz (US$/mil caracteres)' }
const WEBHOOK = `${String(SUPABASE_URL || 'https://SEU-PROJETO.supabase.co').replace(/\/+$/, '')}/functions/v1/creditos-webhook`
const EVENTO = { creditado: 'badge-success', ativado: 'badge-success', estornado: 'badge-danger', ignorado: 'badge-muted', repetido: 'badge-muted', sem_vinculo: 'badge-warning', em_analise: 'badge-warning', invalido: 'badge-danger', erro: 'badge-danger', recebido: 'badge-info' }
const pct = (v) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
const n = (v) => Number(v) || 0

function useCarga(fn, deps) {
  const [st, setSt] = useState({ data: null, erro: null })
  const load = useCallback(async () => {
    try { setSt({ data: await fn(), erro: null }) } catch (e) { setSt({ data: null, erro: e.message }) }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])
  return { ...st, reload: load }
}

export default function SuperCredits() {
  const [tab, setTab] = useState('geral')
  const cfg = useCarga(() => saCreditos.settings(), [])
  return (
    <div>
      <PageHeader icon={Coins} title="Créditos de IA" subtitle="Saldo pré-pago das empresas para a IA da plataforma: custo, receita, margem e pagamentos" />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[
        { id: 'geral', label: 'Visão geral', icon: Wallet }, { id: 'pacotes', label: 'Pacotes', icon: Package }, { id: 'precos', label: 'Preços', icon: Tags },
        { id: 'pagamentos', label: 'Pagamentos', icon: ReceiptText }, { id: 'config', label: 'Configuração', icon: Settings2 },
      ]} />
      {cfg.erro && <div className="card p-5 text-sm text-red-400">{cfg.erro}</div>}
      {cfg.data && tab === 'geral' && <Geral cfg={cfg.data} />}
      {cfg.data && tab === 'pacotes' && <Pacotes cfg={cfg.data} onSaved={cfg.reload} />}
      {cfg.data && tab === 'precos' && <Precos cfg={cfg.data} onSaved={cfg.reload} />}
      {cfg.data && tab === 'pagamentos' && <Pagamentos />}
      {cfg.data && tab === 'config' && <Config cfg={cfg.data} onSaved={cfg.reload} />}
    </div>
  )
}

/* ---------- Visão geral e carteiras ---------- */

function Geral({ cfg }) {
  const [dias, setDias] = useState(30)
  const periodo = useMemo(() => [new Date(Date.now() - dias * 86400e3).toISOString(), new Date(Date.now() + 60e3).toISOString()], [dias])
  const w = useCarga(() => saCreditos.wallets(periodo[0], periodo[1]), [periodo])
  const [modal, setModal] = useState(null)
  const [liberar, setLiberar] = useState('')
  const empresas = useCarga(() => sa.companies(), [])
  const lista = w.data || []
  const tot = lista.reduce((a, x) => ({ custo: a.custo + n(x.costBrl), receita: a.receita + n(x.revenueBrl), recargas: a.recargas + n(x.rechargedCents), saldo: a.saldo + (x.mode === 'prepago' ? n(x.balance) : 0) }), { custo: 0, receita: 0, recargas: 0, saldo: 0 })
  const margem = tot.receita - tot.custo
  const semCarteira = (empresas.data || []).filter((c) => !lista.some((x) => x.id === c.id && x.hasWallet))

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Pills options={PERIODOS} value={dias} onChange={setDias} />
        <button className="btn-ghost text-xs" onClick={w.reload}><RefreshCw size={13} /> Atualizar</button>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Custo real" value={brl4(tot.custo)} />
        <Metric label="Receita de consumo" value={brl4(tot.receita)} />
        <Metric label="Margem" value={brl4(margem)} tone={margem >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Metric label="Margem %" value={tot.receita ? pct(margem / tot.receita) : '—'} />
        <Metric label="Recargas pagas" value={reais(tot.recargas)} />
      </div>
      <p className="mb-4 text-xs text-text-muted">
        Custo real = o que os provedores cobram (preço em dólar × câmbio {cfg.settings.usdBrl} × {1 + n(cfg.settings.surchargePct) / 100} de IOF e taxas). Receita = créditos
        consumidos × {reais(cfg.settings.creditBrl * 100)}. Créditos ainda não usados nas carteiras: {fmtCred(tot.saldo / 1)} ({reais(tot.saldo * cfg.settings.creditBrl * 100)}).
      </p>
      {w.erro && <div className="card p-5 text-sm text-red-400">{w.erro}</div>}
      <Table empty="Nenhuma empresa com carteira." rows={lista} columns={[
        { key: 'name', label: 'Empresa', render: (x) => <span className="text-text-primary">{x.name}<span className="block text-xs text-text-muted">{!x.active ? 'IA da plataforma desligada' : x.mode === 'interno' ? 'Interno (sem cobrança)' : `Pré-pago · ×${x.multiplier ?? cfg.settings.multiplier}`}</span></span> },
        { key: 'balance', label: 'Saldo', render: (x) => <span className={cx(n(x.balance) - n(x.reserved) <= 0 && x.mode === 'prepago' && 'text-red-400')}>{fmtCred(x.balance)}{x.lowAlertAt && x.mode === 'prepago' && <AlertTriangle size={12} className="ml-1 inline text-amber-400" />}</span> },
        { key: 'ops', label: 'Operações', render: (x) => n(x.ops).toLocaleString('pt-BR') },
        { key: 'creditsUsed', label: 'Consumo', render: (x) => `${fmtCred(x.creditsUsed)} cr.` },
        { key: 'costBrl', label: 'Custo', render: (x) => brl4(x.costBrl) },
        { key: 'revenueBrl', label: 'Receita', render: (x) => brl4(x.revenueBrl) },
        { key: 'm', label: 'Margem', render: (x) => (n(x.revenueBrl) ? <span className={n(x.revenueBrl) - n(x.costBrl) >= 0 ? 'text-green-400' : 'text-red-400'}>{pct((n(x.revenueBrl) - n(x.costBrl)) / n(x.revenueBrl))}</span> : '—') },
        { key: 'rechargedCents', label: 'Recargas', render: (x) => reais(x.rechargedCents) },
        { key: 'acoes', label: '', render: (x) => (
          <span className="flex gap-1">
            <button className="btn-ghost p-1.5" title="Configurar carteira" onClick={() => setModal({ config: x })}><Pencil size={13} /></button>
            <button className="btn-ghost p-1.5" title="Ajustar saldo" onClick={() => setModal({ ajuste: x })}><Coins size={13} /></button>
            <button className="btn-ghost p-1.5" title="Extrato com custo" onClick={() => setModal({ extrato: x })}><ReceiptText size={13} /></button>
            <button className="btn-ghost p-1.5" title="Sugestão de pacotes" onClick={() => setModal({ sugestao: x })}><Calculator size={13} /></button>
          </span>
        ) },
      ]} />
      <div className="card mt-4 flex flex-wrap items-end gap-2 p-4">
        <Field label="Liberar a IA da plataforma para outra empresa" className="mb-0 min-w-[260px] flex-1">
          <Select value={liberar} onChange={setLiberar} placeholder="Escolha a empresa" options={semCarteira.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <button className="btn-primary" disabled={!liberar} onClick={() => setModal({ config: { id: liberar, name: semCarteira.find((c) => c.id === liberar)?.name, active: true, mode: 'prepago', novo: true } })}><Plus size={14} /> Configurar</button>
      </div>
      {modal?.config && <CarteiraModal w={modal.config} cfg={cfg} onClose={() => setModal(null)} onSaved={() => { setModal(null); setLiberar(''); w.reload() }} />}
      {modal?.ajuste && <AjusteModal w={modal.ajuste} onClose={() => setModal(null)} onSaved={() => { setModal(null); w.reload() }} />}
      {modal?.extrato && <ExtratoModal w={modal.extrato} onClose={() => setModal(null)} />}
      {modal?.sugestao && <SugestaoModal w={modal.sugestao} cfg={cfg} onClose={() => setModal(null)} />}
    </>
  )
}

function CarteiraModal({ w, cfg, onClose, onSaved }) {
  const [f, setF] = useState({ active: w.active !== false, mode: w.mode || 'prepago', multiplier: w.multiplier ?? '', alertCredits: w.alertCredits ?? '' })
  const salvar = async () => {
    try {
      await saCreditos.setWallet(w.id, { ...f, multiplier: f.multiplier === '' ? null : Number(f.multiplier), alertCredits: f.alertCredits === '' ? null : Number(f.alertCredits) })
      toast('Carteira salva.'); onSaved()
    } catch (e) { toast(e.message, 'error') }
  }
  return (
    <Modal open onClose={onClose} title={`Carteira · ${w.name}`} subtitle="Com a IA da plataforma ligada, os agentes desta empresa que não têm chave própria usam a chave da plataforma."
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={salvar}>Salvar</button></>}>
      <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="IA da plataforma liberada" description={f.active ? 'Os agentes podem usar a chave da plataforma' : 'Só com a chave própria da empresa'} />
      <Field label="Modo">
        <Select value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[{ value: 'prepago', label: 'Pré-pago: desconta Créditos de IA do saldo' }, { value: 'interno', label: 'Interno (empresa sua): registra o custo, não desconta' }]} />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Multiplicador próprio" hint={`Vazio = o da plataforma (×${cfg.settings.multiplier})`}><input className="input" inputMode="decimal" placeholder={String(cfg.settings.multiplier)} value={f.multiplier} onChange={(e) => setF({ ...f, multiplier: e.target.value.replace(',', '.') })} /></Field>
        <Field label="Aviso de saldo baixo (créditos)" hint={`Vazio = o padrão (${fmtCred(cfg.settings.alertCredits)})`}><input className="input" inputMode="numeric" value={f.alertCredits} onChange={(e) => setF({ ...f, alertCredits: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
    </Modal>
  )
}

function AjusteModal({ w, onClose, onSaved }) {
  const [f, setF] = useState({ credits: '', reason: '' })
  const salvar = async () => {
    const c = Number(String(f.credits).replace(',', '.'))
    if (!c) return toast('Informe os créditos (positivo dá, negativo tira).', 'error')
    try { const r = await saCreditos.adjust(w.id, c, f.reason); toast(`Ajuste feito. Saldo: ${fmtCred(r.saldo)} créditos.`); onSaved() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <Modal open onClose={onClose} title={`Ajustar saldo · ${w.name}`} subtitle={`Saldo atual: ${fmtCred(w.balance)} créditos. O ajuste entra no extrato da empresa, com o motivo.`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={salvar}>Ajustar</button></>}>
      <Field label="Créditos" hint="Positivo para dar (cortesia, correção), negativo para tirar"><input className="input" autoFocus inputMode="decimal" placeholder="Ex.: 1000 ou -250" value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value })} /></Field>
      <Field label="Motivo"><input className="input" placeholder="Ex.: créditos de teste da implantação" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
    </Modal>
  )
}

function ExtratoModal({ w, onClose }) {
  const l = useCarga(() => saCreditos.ledger(w.id), [w.id])
  return (
    <Modal open onClose={onClose} size="xl" title={`Extrato · ${w.name}`} subtitle="Com o custo real de cada operação (o cliente não vê custo nem multiplicador)">
      {l.erro && <p className="text-sm text-red-400">{l.erro}</p>}
      {l.data && (
        <Table empty="Nenhum lançamento." rows={l.data} columns={[
          { key: 'createdAt', label: 'Quando', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.createdAt)}</span> },
          { key: 'kind', label: 'Tipo', render: (r) => <span className={KIND[r.kind]?.[0]}>{KIND[r.kind]?.[1]}</span> },
          { key: 'description', label: 'Descrição', render: (r) => <span className="text-xs text-text-primary">{r.description}<span className="block text-text-muted">{[r.agentName, r.origin && ORIGIN[r.origin], r.modality && MODALITY[r.modality], r.model].filter(Boolean).join(' · ')}{r.estimated ? ' · estimado' : ''}</span></span> },
          { key: 'units', label: 'Uso', render: (r) => <span className="text-xs">{usoTexto(r.units)}</span> },
          { key: 'costBrl', label: 'Custo', render: (r) => (r.costBrl != null ? <span className="text-xs">{brl4(r.costBrl)}</span> : '—') },
          { key: 'credits', label: 'Créditos', render: (r) => <span className="whitespace-nowrap text-xs font-semibold">{fmtCred(r.credits, { sinal: true })}</span> },
          { key: 'balanceAfter', label: 'Saldo', render: (r) => <span className="text-xs">{fmtCred(r.balanceAfter)}</span> },
        ]} />
      )}
    </Modal>
  )
}
const usoTexto = (u) => {
  if (!u || typeof u !== 'object') return '—'
  const p = []
  if (u.entrada) p.push(`${n(u.entrada).toLocaleString('pt-BR')} entrada`)
  if (u.saida) p.push(`${n(u.saida).toLocaleString('pt-BR')} saída`)
  if (u.segundos) p.push(`${Math.round(n(u.segundos))} s`)
  if (u.caracteres) p.push(`${u.caracteres} caract.`)
  if (u.custoInformado) p.push('custo do gateway')
  return p.join(' · ') || '—'
}

/* ---------- Sugestão de pacotes ---------- */

const redondo = (v) => (v >= 10000 ? Math.ceil(v / 5000) * 5000 : v >= 1000 ? Math.ceil(v / 1000) * 1000 : Math.ceil(v / 100) * 100)
function SugestaoModal({ w, cfg, onClose }) {
  const h = useCarga(() => saCreditos.history(w.id, new Date(Date.now() - 90 * 86400e3).toISOString()), [w.id])
  const s = cfg.settings
  const fator = n(s.usdBrl) * (1 + n(s.surchargePct) / 100)
  const base = useMemo(() => {
    const ms = h.data?.models || []
    const runs = ms.reduce((a, m) => a + n(m.runs), 0)
    const chats = ms.reduce((a, m) => a + n(m.chats), 0)
    const usd = ms.reduce((a, m) => a + n(m.costUsd), 0)
    return { runs, chats, usd, porResposta: runs ? usd / runs : 0, respostasPorConversa: chats ? runs / chats : 0 }
  }, [h.data])
  const [f, setF] = useState({ porDia: 50, respostas: '', audios: 1, segundos: 30, dias: 30, mult: '', taxaPg: 5 })
  const resp = f.respostas === '' ? Math.max(1, Math.round(base.respostasPorConversa || 5)) : n(f.respostas)
  const mult = f.mult === '' ? n(w.multiplier ?? s.multiplier) : n(f.mult)
  const precoScribe = cfg.prices.find((p) => p.model === 'scribe_v2' && p.unit === 'stt_hour')?.usd ?? 0.22
  const usdConversa = resp * base.porResposta + n(f.audios) * n(f.segundos) / 3600 * n(precoScribe)
  const custoMes = usdConversa * fator * n(f.porDia) * n(f.dias)
  const creditosMes = custoMes * mult / n(s.creditBrl)
  const receitaMes = creditosMes * n(s.creditBrl)
  const margemLiq = receitaMes ? (receitaMes * (1 - n(f.taxaPg) / 100) - custoMes) / receitaMes : 0
  const sugestoes = creditosMes > 0 ? [['Essencial', 1 / 3, 0], ['Mensal', 1, 0.05], ['Volume', 2, 0.1]].map(([nome, k, bonus]) => {
    const cred = redondo(creditosMes * k)
    return { nome, cred, bonus: Math.round(cred * bonus), preco: cred * n(s.creditBrl) }
  }) : []
  return (
    <Modal open onClose={onClose} size="lg" title={`Sugestão de pacotes · ${w.name}`} subtitle="A partir do uso medido (últimos 90 dias, antes e depois da carteira) e do volume esperado">
      {h.erro && <p className="text-sm text-red-400">{h.erro}</p>}
      {h.data && (
        <>
          <div className="mb-4 rounded-[14px] border border-border p-3 text-xs text-text-secondary">
            {base.runs ? <>
              Medido: <b className="text-text-primary">{base.runs}</b> respostas da IA em <b className="text-text-primary">{base.chats}</b> conversas ({h.data.days} dia{h.data.days === 1 ? '' : 's'} com uso),
              custo de <b className="text-text-primary">US$ {base.usd.toFixed(4)}</b> ({brl4(base.usd * fator)}): <b className="text-text-primary">{brl4(base.porResposta * fator)}</b> por resposta,
              {' '}{base.respostasPorConversa.toFixed(1)} respostas por conversa. {h.data.transcripts?.n ? `${h.data.transcripts.n} áudios transcritos.` : ''}
              <span className="block pt-1 text-text-muted">Custo pela tabela de preços (tokens registrados em ai_runs): estimativa, não a fatura do provedor.</span>
            </> : 'Sem uso medido desta empresa ainda: preencha o volume e use o custo por resposta de outra empresa parecida.'}
          </div>
          <div className="grid gap-x-4 sm:grid-cols-3">
            <Field label="Conversas por dia"><input className="input" inputMode="numeric" value={f.porDia} onChange={(e) => setF({ ...f, porDia: e.target.value })} /></Field>
            <Field label="Respostas por conversa" hint={`medido: ${base.respostasPorConversa ? base.respostasPorConversa.toFixed(1) : '—'}`}><input className="input" inputMode="decimal" placeholder={String(resp)} value={f.respostas} onChange={(e) => setF({ ...f, respostas: e.target.value })} /></Field>
            <Field label="Dias cobertos"><input className="input" inputMode="numeric" value={f.dias} onChange={(e) => setF({ ...f, dias: e.target.value })} /></Field>
            <Field label="Áudios por conversa"><input className="input" inputMode="decimal" value={f.audios} onChange={(e) => setF({ ...f, audios: e.target.value })} /></Field>
            <Field label="Segundos por áudio"><input className="input" inputMode="numeric" value={f.segundos} onChange={(e) => setF({ ...f, segundos: e.target.value })} /></Field>
            <Field label="Multiplicador" hint={`atual: ×${w.multiplier ?? s.multiplier}`}><input className="input" inputMode="decimal" placeholder={String(mult)} value={f.mult} onChange={(e) => setF({ ...f, mult: e.target.value })} /></Field>
            <Field label="Taxa do pagamento (%)" hint="Pix/cartão na Vórtex Pay"><input className="input" inputMode="decimal" value={f.taxaPg} onChange={(e) => setF({ ...f, taxaPg: e.target.value })} /></Field>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Custo no período" value={brl4(custoMes)} />
            <Metric label="Créditos no período" value={fmtCred(creditosMes)} />
            <Metric label="Cobrado do cliente" value={brl4(receitaMes)} />
            <Metric label="Margem líquida" value={pct(margemLiq)} tone={margemLiq > 0 ? 'text-green-400' : 'text-red-400'} />
          </div>
          {sugestoes.length > 0 && (
            <Table rows={sugestoes.map((x) => ({ id: x.nome, ...x }))} columns={[
              { key: 'nome', label: 'Pacote' },
              { key: 'cred', label: 'Créditos', render: (x) => `${fmtCred(x.cred)}${x.bonus ? ` + ${fmtCred(x.bonus)} de bônus` : ''}` },
              { key: 'preco', label: 'Preço', render: (x) => reais(x.preco * 100) },
              { key: 'dura', label: 'Dura', render: (x) => `~${Math.round((x.cred + x.bonus) / (creditosMes / n(f.dias)))} dias` },
              { key: 'mg', label: 'Margem com o bônus', render: (x) => pct(((x.preco * (1 - n(f.taxaPg) / 100)) - (x.cred + x.bonus) / mult * n(s.creditBrl)) / x.preco) },
            ]} />
          )}
          <p className="mt-3 text-xs text-text-muted">Cadastre os pacotes na aba Pacotes. A margem líquida desconta a taxa do pagamento; o bônus reduz a margem do pacote.</p>
        </>
      )}
    </Modal>
  )
}

/* ---------- Pacotes ---------- */

function Pacotes({ cfg, onSaved }) {
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  const s = cfg.settings
  return (
    <>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setEdit({ name: '', description: '', credits: '', bonus: 0, priceCents: '', active: true, highlight: false, sort: cfg.packages.length + 1, checkoutUrl: '' })}><Plus size={14} /> Novo pacote</button></div>
      <Table empty="Nenhum pacote. Crie o primeiro (use a Sugestão de pacotes na Visão geral)." rows={cfg.packages} columns={[
        { key: 'name', label: 'Pacote', render: (p) => <span className="text-text-primary">{p.name}{p.highlight && <span className="badge-success ml-2">Destaque</span>}<span className="block text-xs text-text-muted">{p.description}</span></span> },
        { key: 'credits', label: 'Créditos', render: (p) => `${fmtCred(p.credits)}${n(p.bonus) ? ` + ${fmtCred(p.bonus)}` : ''}` },
        { key: 'priceCents', label: 'Preço', render: (p) => reais(p.priceCents) },
        { key: 'cpm', label: 'Por crédito', render: (p) => brl4(n(p.priceCents) / 100 / (n(p.credits) + n(p.bonus))) },
        { key: 'mg', label: 'Margem sobre o custo', render: (p) => { const custo = (n(p.credits) + n(p.bonus)) * n(s.creditBrl) / n(s.multiplier); const preco = n(p.priceCents) / 100; return pct((preco - custo) / preco) } },
        { key: 'active', label: 'À venda', render: (p) => (p.active ? <span className="badge-success">Sim</span> : <span className="badge-muted">Não</span>) },
        { key: 'checkoutUrl', label: 'Oferta', render: (p) => (p.checkoutUrl ? <a className="text-xs underline" href={p.checkoutUrl} target="_blank" rel="noreferrer">link fixo</a> : <span className="badge-warning" title="Sem link: a compra tenta criar a oferta pela API, que só aceita a partir de R$ 997">sem link</span>) },
        { key: 'a', label: '', render: (p) => <span className="flex gap-1"><button className="btn-ghost p-1.5" onClick={() => setEdit({ ...p })}><Pencil size={13} /></button><button className="btn-ghost p-1.5 text-red-400" onClick={() => setDel(p)}><Trash2 size={13} /></button></span> },
      ]} />
      <p className="mt-3 text-xs text-text-muted">Margem sobre o custo considera o multiplicador padrão (×{s.multiplier}); não inclui a taxa do pagamento.</p>
      {edit && <PacoteModal p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onSaved() }} />}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir pacote" message={`Excluir "${del?.name}"? Se ele já foi vendido, só sai de venda (as recargas continuam no histórico).`} onConfirm={async () => { try { await saCreditos.deletePackage(del.id); onSaved() } catch (e) { toast(e.message, 'error') } }} />
    </>
  )
}

function PacoteModal({ p, onClose, onSaved }) {
  const [f, setF] = useState({ ...p, price: p.priceCents ? String(n(p.priceCents) / 100).replace('.', ',') : '' })
  const salvar = async () => {
    const priceCents = Math.round(Number(String(f.price).replace(/\./g, '').replace(',', '.')) * 100)
    if (!f.name?.trim() || !(n(f.credits) > 0) || !(priceCents > 0)) return toast('Preencha nome, créditos e preço.', 'error')
    try { await saCreditos.savePackage({ ...f, credits: n(f.credits), bonus: n(f.bonus), priceCents, sort: n(f.sort) }); toast('Pacote salvo.'); onSaved() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <Modal open onClose={onClose} title={p.id ? 'Editar pacote' : 'Novo pacote'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={salvar}>Salvar</button></>}>
      <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Descrição (aparece para o cliente)"><input className="input" placeholder="Ex.: ~1.500 atendimentos" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="Créditos"><input className="input" inputMode="numeric" value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Bônus (créditos)"><input className="input" inputMode="numeric" value={f.bonus} onChange={(e) => setF({ ...f, bonus: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Preço (R$)"><input className="input" inputMode="decimal" placeholder="300,00" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
      </div>
      <Field label="Link da oferta na Vórtex Pay" hint="Crie a oferta com o mesmo preço no produto Créditos de IA (aba Ofertas) e cole o link. Sem link, a compra tenta criar a oferta pela API, que só aceita a partir de R$ 997.">
        <input className="input" placeholder="https://pay.seu-dominio.com.br/c/creditos-ia/..." value={f.checkoutUrl || ''} onChange={(e) => setF({ ...f, checkoutUrl: e.target.value.trim() })} />
      </Field>
      <Field label="Ordem"><input className="input w-24" inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value.replace(/\D/g, '') })} /></Field>
      <Toggle checked={!!f.active} onChange={(v) => setF({ ...f, active: v })} label="À venda" />
      <Toggle checked={!!f.highlight} onChange={(v) => setF({ ...f, highlight: v })} label="Destaque (Mais escolhido)" />
    </Modal>
  )
}

/* ---------- Preços ---------- */

function Precos({ cfg, onSaved }) {
  const [edit, setEdit] = useState(null)
  const salvar = async () => {
    try { await saCreditos.savePrice({ ...edit, usd: Number(String(edit.usd).replace(',', '.')) }); toast('Preço salvo.'); setEdit(null); onSaved() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">Preço em dólar que o provedor cobra. O modelo do gateway (ex.: google/gemini-2.5-flash) usa o nome sem o prefixo; versões novas usam o preço do nome que for começo delas; o resto usa o "*".</p>
        <button className="btn-primary shrink-0" onClick={() => setEdit({ provider: '', model: '', unit: 'input_mtok', usd: '', source: '' })}><Plus size={14} /> Preço</button>
      </div>
      <Table rows={cfg.prices} columns={[
        { key: 'model', label: 'Modelo', render: (p) => <span className="text-text-primary">{p.model}<span className="block text-xs text-text-muted">{p.provider}</span></span> },
        { key: 'unit', label: 'Unidade', render: (p) => UNIDADES[p.unit] || p.unit },
        { key: 'usd', label: 'US$', render: (p) => n(p.usd).toLocaleString('pt-BR', { maximumFractionDigits: 6 }) },
        { key: 'source', label: 'Fonte', render: (p) => <span className="text-xs">{p.source}</span> },
        { key: 'a', label: '', render: (p) => <span className="flex gap-1"><button className="btn-ghost p-1.5" onClick={() => setEdit({ ...p })}><Pencil size={13} /></button>{p.model !== '*' && <button className="btn-ghost p-1.5 text-red-400" onClick={async () => { try { await saCreditos.deletePrice(p.id); onSaved() } catch (e) { toast(e.message, 'error') } }}><Trash2 size={13} /></button>}</span> },
      ]} />
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Editar preço' : 'Novo preço'} footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancelar</button><button className="btn-primary" onClick={salvar}>Salvar</button></>}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Provedor"><input className="input" placeholder="google, elevenlabs…" value={edit.provider} onChange={(e) => setEdit({ ...edit, provider: e.target.value })} /></Field>
            <Field label="Modelo"><input className="input" placeholder="gemini-2.5-flash" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} /></Field>
          </div>
          <Field label="Unidade"><Select value={edit.unit} onChange={(v) => setEdit({ ...edit, unit: v })} options={Object.entries(UNIDADES).map(([value, label]) => ({ value, label }))} /></Field>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="US$"><input className="input" inputMode="decimal" value={edit.usd} onChange={(e) => setEdit({ ...edit, usd: e.target.value })} /></Field>
            <Field label="Fonte"><input className="input" placeholder="página de preços e data" value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  )
}

/* ---------- Pagamentos ---------- */

function Pagamentos() {
  const p = useCarga(() => saCreditos.payments(), [])
  const [vinculo, setVinculo] = useState(null)
  const reprocessar = async (ev) => { try { const r = await saCreditos.reprocess(ev.id); toast(`Resultado: ${r.status || 'ok'}${r.reason ? ` (${r.reason})` : ''}`); p.reload() } catch (e) { toast(e.message, 'error') } }
  if (p.erro) return <div className="card p-5 text-sm text-red-400">{p.erro}</div>
  if (!p.data) return <div className="card p-5 text-sm text-text-muted">Carregando…</div>
  const abertas = p.data.recharges.filter((r) => ['pendente', 'em_analise', 'cancelada'].includes(r.status))
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-semibold">Avisos da Vórtex Pay</p>
        <Table empty="Nenhum aviso recebido ainda." rows={p.data.events} columns={[
          { key: 'receivedAt', label: 'Recebido', render: (e) => <span className="whitespace-nowrap text-xs">{fmtDate(e.receivedAt)}</span> },
          { key: 'eventType', label: 'Evento', render: (e) => <span className="text-xs">{e.eventType || '—'}<span className="block text-text-muted">{e.orderId || ''}</span></span> },
          { key: 'email', label: 'Comprador', render: (e) => <span className="text-xs">{e.email || '—'}</span> },
          { key: 'status', label: 'Situação', render: (e) => <span className={EVENTO[e.status] || 'badge-muted'}>{e.status}</span> },
          { key: 'reason', label: 'Motivo', render: (e) => <span className="text-xs">{e.signatureOk ? e.reason : 'sem assinatura válida'}</span> },
          { key: 'a', label: '', render: (e) => e.signatureOk && ['em_analise', 'sem_vinculo', 'erro', 'recebido'].includes(e.status) && (
            <span className="flex gap-1">
              <button className="btn-ghost p-1.5" title="Processar de novo" onClick={() => reprocessar(e)}><RefreshCw size={13} /></button>
              {['em_analise', 'sem_vinculo'].includes(e.status) && <button className="btn-ghost p-1.5" title="Vincular a uma recarga" onClick={() => setVinculo(e)}><Link2 size={13} /></button>}
            </span>
          ) },
        ]} />
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">Recargas</p>
        <Table empty="Nenhuma recarga ainda." rows={p.data.recharges} columns={[
          { key: 'createdAt', label: 'Pedido em', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.createdAt)}</span> },
          { key: 'companyName', label: 'Empresa', render: (r) => <span className="text-text-primary">{r.companyName}<span className="block text-xs text-text-muted">{r.buyerEmail}</span></span> },
          { key: 'packageName', label: 'Pacote', render: (r) => <span className="text-xs">{r.packageName}<span className="block text-text-muted">{r.ref}</span></span> },
          { key: 'priceCents', label: 'Valor', render: (r) => reais(r.priceCents) },
          { key: 'status', label: 'Situação', render: (r) => <span title={r.note} className={RECHARGE[r.status]?.[0]}>{RECHARGE[r.status]?.[1] || r.status}</span> },
          { key: 'orderId', label: 'Pedido', render: (r) => <span className="text-xs">{r.orderId || '—'}</span> },
        ]} />
      </div>
      {vinculo && (
        <VinculoModal ev={vinculo} abertas={abertas} onClose={() => setVinculo(null)} onSaved={() => { setVinculo(null); p.reload() }} />
      )}
    </div>
  )
}

function VinculoModal({ ev, abertas, onClose, onSaved }) {
  const [r, setR] = useState('')
  const salvar = async () => { try { await saCreditos.linkPayment(ev.id, r); toast('Pagamento vinculado e créditos liberados.'); onSaved() } catch (e) { toast(e.message, 'error') } }
  return (
    <Modal open onClose={onClose} title="Vincular pagamento a uma recarga" subtitle={`Pedido ${ev.orderId} · ${ev.email || 'sem e-mail'}. Confira na Vórtex Pay que o pedido está pago e com o valor da recarga antes de vincular.`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!r} onClick={salvar}>Vincular e creditar</button></>}>
      <Field label="Recarga">
        <Select value={r} onChange={setR} placeholder="Escolha a recarga" options={abertas.map((x) => ({ value: x.id, label: `${x.companyName} · ${x.packageName} · ${reais(x.priceCents)} · ${x.ref} (${RECHARGE[x.status]?.[1] || x.status})` }))} />
      </Field>
    </Modal>
  )
}

/* ---------- Configuração ---------- */

function Config({ cfg, onSaved }) {
  const s = cfg.settings
  const [f, setF] = useState({ creditBrl: s.creditBrl, multiplier: s.multiplier, usdBrl: s.usdBrl, surchargePct: s.surchargePct, alertCredits: s.alertCredits, reserveMinutes: s.reserveMinutes, vortexpayProductId: s.vortexpayProductId || '' })
  const num = (k) => ({ value: String(f[k]), onChange: (e) => setF({ ...f, [k]: e.target.value.replace(',', '.') }) })
  const salvar = async () => {
    try {
      await saCreditos.saveSettings({ ...f, creditBrl: n(f.creditBrl), multiplier: n(f.multiplier), usdBrl: n(f.usdBrl), surchargePct: n(f.surchargePct), alertCredits: n(f.alertCredits), reserveMinutes: Math.round(n(f.reserveMinutes)) })
      toast('Configuração salva. Vale para as próximas operações.'); onSaved()
    } catch (e) { toast(e.message, 'error') }
  }
  const exemplo = 0.02 * n(f.multiplier) / n(f.creditBrl)
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="card p-5">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Valor de 1 crédito (R$)" hint="Referência: R$ 0,01"><input className="input" inputMode="decimal" {...num('creditBrl')} /></Field>
          <Field label="Multiplicador padrão" hint="Preço = custo × multiplicador (cada empresa pode ter o seu)"><input className="input" inputMode="decimal" {...num('multiplier')} /></Field>
          <Field label="Câmbio US$ → R$" hint="PTAX de 16/10/2026: 5,0826"><input className="input" inputMode="decimal" {...num('usdBrl')} /></Field>
          <Field label="Acréscimo sobre o custo (%)" hint="IOF do cartão internacional (3,5%) + taxa do gateway de IA"><input className="input" inputMode="decimal" {...num('surchargePct')} /></Field>
          <Field label="Aviso de saldo baixo padrão (créditos)"><input className="input" inputMode="numeric" {...num('alertCredits')} /></Field>
          <Field label="Reserva expira em (minutos)" hint="Reserva sem desconto depois disso é devolvida"><input className="input" inputMode="numeric" {...num('reserveMinutes')} /></Field>
        </div>
        <Field label="Produto da Vórtex Pay para as recargas" hint="O id do produto 'Créditos de IA' na Vórtex Pay. Sem ele, o botão Comprar fica desligado.">
          <input className="input" placeholder="ex.: cmv8ic2hw0000l504nhm4tmhh" value={f.vortexpayProductId} onChange={(e) => setF({ ...f, vortexpayProductId: e.target.value.trim() })} />
        </Field>
        <button className="btn-primary" onClick={salvar}>Salvar</button>
      </div>
      <div className="space-y-4">
        <div className="card p-4 text-sm">
          <p className="font-semibold">Exemplo</p>
          <p className="mt-1 text-text-secondary">Uma operação que nos custa R$ 0,02 desconta <b className="text-text-primary">{fmtCred(exemplo)} créditos</b> ({brl4(exemplo * n(f.creditBrl))}) do saldo do cliente.</p>
        </div>
        <div className="card p-4 text-sm">
          <p className="font-semibold">Webhook da Vórtex Pay</p>
          <p className="mt-1 text-xs text-text-muted">Cadastre na Vórtex Pay com o evento de compra (aprovada, reembolsada e chargeback) e use o Secret HMAC no segredo VORTEXPAY_WEBHOOK_SECRET do Supabase.</p>
          <div className="mt-2 flex items-center gap-2 rounded-[12px] border border-border px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs">{WEBHOOK}</code>
            <button className="btn-ghost p-1.5" onClick={() => navigator.clipboard.writeText(WEBHOOK).then(() => toast('Copiado!'))}><Copy size={13} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
