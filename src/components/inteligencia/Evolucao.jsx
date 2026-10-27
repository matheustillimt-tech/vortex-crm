// Aba Evolução dos Agentes: botão "Melhorar agente" (estimativa → execução em segundo plano), progresso, relatório,
// alterações com evidências, pendências de aprovação, versões (com restauração), aprendizados e desempenho.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, History, Loader2, MessageCircle, PauseCircle, PlayCircle, RotateCcw, ShieldAlert, Sparkles, Wand2, XCircle } from 'lucide-react'
import { useDB, toast } from '../../lib/store'
import { CAMPO, ESTADO_ALTERACAO, ESTADO_JOB, ETAPAS, intel, NATUREZA, recarregarAgente, TIPO_APRENDIZADO } from '../../lib/inteligencia'
import { cx, fmtDate } from '../../lib/utils'
import { Confirm, EmptyState, Modal, Select, Tabs } from '../ui'
import { Blocos } from './Blocos'

const ATIVO = ['na_fila', 'em_andamento']
const n = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

export default function Evolucao({ pode, agenteInicial, abrirMelhorar, onMelhorarAberto }) {
  const cid = useDB((s) => s.company.id)
  const agentes = useDB((s) => s.agents)
  const padrao = agentes.filter((a) => (a.engine || 'padrao') === 'padrao')
  const [agentId, setAgentId] = useState(agenteInicial || padrao.find((a) => a.active)?.id || padrao[0]?.id || '')
  const [ev, setEv] = useState(null)
  const [erro, setErro] = useState(null)
  const [estim, setEstim] = useState(null) // { carregando } | dados da estimativa
  const [aba, setAba] = useState('alteracoes')
  const ultimoStatus = useRef(null)

  useEffect(() => { if (agenteInicial) setAgentId(agenteInicial) }, [agenteInicial])
  const carregar = useCallback(async () => {
    if (!agentId) return
    try { setEv(await intel.evolucao(cid, agentId)); setErro(null) } catch (e) { setErro(e.message) }
  }, [cid, agentId])
  useEffect(() => { setEv(null); carregar() }, [carregar])

  const job = ev?.jobs?.[0]
  const ativo = job && ATIVO.includes(job.status)
  // acompanha a execução enquanto ela roda (dá para sair da tela: ela segue no servidor)
  useEffect(() => {
    if (!ativo) return
    const t = setInterval(carregar, 4000)
    return () => clearInterval(t)
  }, [ativo, carregar])
  useEffect(() => {
    const st = job?.status
    if (ultimoStatus.current && ATIVO.includes(ultimoStatus.current) && st && !ATIVO.includes(st)) {
      if (st === 'concluido') { toast('Melhoria concluída: nova versão do agente publicada.', 'success'); recarregarAgente(agentId) }
      else toast(`Melhoria terminou: ${ESTADO_JOB[st]?.[1] || st}.`, st === 'falhou' ? 'error' : 'info')
    }
    ultimoStatus.current = st
  }, [job?.status, agentId])

  const melhorar = async () => {
    if (!agentId) return toast('Escolha o agente.', 'error')
    setEstim({ carregando: true })
    try { setEstim(await intel.estimar(cid, agentId)) } catch (e) { setEstim(null); toast(e.message, 'error') }
  }
  useEffect(() => { if (abrirMelhorar) { onMelhorarAberto?.(); if (pode.melhorar) melhorar() } }, [abrirMelhorar]) // eslint-disable-line react-hooks/exhaustive-deps
  const iniciar = async () => {
    try {
      await intel.melhorar(cid, agentId)
      setEstim(null)
      toast('Análise iniciada. Pode continuar usando a plataforma; ela segue em segundo plano.', 'success')
      carregar()
    } catch (e) { toast(e.message, 'error') }
  }

  if (!padrao.length) return <EmptyState icon={Wand2} title="Nenhum agente de IA para melhorar" hint="Crie um agente em Agentes de IA. Agentes com motor próprio (agente de vendas) não são ajustados por aqui." />

  return (
    <div className="space-y-4">
      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text-muted">Agente</p>
          <Select className="mt-1 max-w-sm" value={agentId} onChange={setAgentId} options={agentes.map((a) => ({ value: a.id, label: `${a.name}${(a.engine || 'padrao') !== 'padrao' ? ' (motor próprio)' : ''}${a.active ? '' : ' · pausado'}` }))} />
        </div>
        <button className="btn-primary px-5 py-3 text-[15px]" disabled={!pode.melhorar || ativo || !padrao.some((a) => a.id === agentId)} onClick={melhorar}
          title={!pode.melhorar ? 'Sem permissão para iniciar melhorias' : ativo ? 'Já existe uma melhoria em andamento' : ''}>
          <Wand2 size={18} /> Melhorar agente
        </button>
      </div>

      {erro && <p className="text-sm text-red-400">{erro}</p>}
      {!ev && !erro && <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando…</p>}
      {job && <Execucao job={job} pode={pode} onAtualizar={carregar} />}

      {ev && (
        <>
          <Tabs value={aba} onChange={setAba} tabs={[
            { id: 'alteracoes', label: 'Alterações' }, { id: 'pendentes', label: 'Pendentes', count: ev.alteracoes.filter((c) => ['pendente_aprovacao', 'revisao', 'bloqueada'].includes(c.estado)).length || null },
            { id: 'versoes', label: 'Versões' }, { id: 'aprendizados', label: 'Aprendizados' }, { id: 'validacao', label: 'Validação' }, { id: 'desempenho', label: 'Desempenho' }]} />
          {aba === 'alteracoes' && <Alteracoes lista={ev.alteracoes.filter((c) => ['aplicada', 'aprovada'].includes(c.estado))} vazio="Nenhuma alteração aplicada ainda." />}
          {aba === 'pendentes' && <Alteracoes lista={ev.alteracoes.filter((c) => ['pendente_aprovacao', 'revisao', 'bloqueada'].includes(c.estado))} vazio="Nada pendente." pode={pode} onDecidido={carregar} />}
          {aba === 'versoes' && <Versoes versoes={ev.versoes} pode={pode} onRestaurado={carregar} agentId={agentId} />}
          {aba === 'aprendizados' && <Aprendizados lista={ev.aprendizados} />}
          {aba === 'validacao' && <Validacao lista={ev.validacao} />}
          {aba === 'desempenho' && <Desempenho d={ev.desempenho} />}
          {ev.jobs.length > 1 && <Historico jobs={ev.jobs.slice(1)} />}
        </>
      )}

      <Modal open={!!estim} onClose={() => setEstim(null)} title="Melhorar agente" subtitle={agentes.find((a) => a.id === agentId)?.name}
        footer={<><button className="btn-secondary" onClick={() => setEstim(null)}>Cancelar</button>
          <button className="btn-primary" disabled={!estim || estim.carregando || !!estim.bloqueio} onClick={iniciar}><Sparkles size={15} /> Iniciar análise e melhoria</button></>}>
        {estim?.carregando ? <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Levantando o histórico e estimando o consumo…</p> : estim && <Estimativa e={estim} />}
      </Modal>
    </div>
  )
}

function Estimativa({ e }) {
  const c = e.conversas || {}
  return (
    <div className="space-y-4 text-sm">
      {e.bloqueio && <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-300"><AlertTriangle size={16} className="shrink-0" />{e.bloqueio}</div>}
      <div className="grid grid-cols-2 gap-2">
        <Info rotulo="Conversas do agente no histórico" valor={n(c.historico)} />
        <Info rotulo="Já analisadas (reaproveitadas)" valor={n(c.reaproveitadas)} />
        <Info rotulo="Serão analisadas agora" valor={n(c.nestaExecucao)} ajuda={c.foraDoLimite ? `${n(c.foraDoLimite)} ficam para a próxima execução (limite por execução)` : 'Novas ou com mensagens depois da última análise'} />
        <Info rotulo="Consumo estimado" valor={e.estimativa ? `~${n(e.estimativa.creditos)} créditos` : '—'} ajuda={e.estimativa ? `Estimativa: entre ${n(e.estimativa.faixa?.[0])} e ${n(e.estimativa.faixa?.[1])}. O consumo real aparece no fim.${e.fonte === 'empresa' ? ' Com a chave própria da empresa, o custo vai para o provedor.' : ''}` : ''} />
        <Info rotulo="Orçamento máximo desta execução" valor={`${n(e.orcamento?.creditos)} créditos`} ajuda="Se acabar, a execução pausa sem publicar e continua de onde parou" />
        {e.saldo != null && <Info rotulo="Saldo de Créditos de IA" valor={n(e.saldo)} />}
      </div>
      {e.parcial && !e.bloqueio && <p className="text-xs text-amber-400">A análise pode ser parcial (limite de conversas ou orçamento). A cobertura feita aparece no relatório, e dá para continuar depois.</p>}
      <div className="rounded-xl border border-border p-3 text-xs text-text-secondary">
        <p className="mb-1 font-semibold text-text-primary">O que acontece ao iniciar</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>As conversas (sem dados pessoais) são analisadas em lotes, em segundo plano: você pode sair desta tela.</li>
          <li>Os problemas encontrados entram numa base consolidada; uma parte das conversas fica separada só para testar.</li>
          <li>Uma versão candidata é montada e testada contra a atual (falhas anteriores e regras essenciais).</li>
          <li>Só é publicado o que tiver evidência e passar nos testes. A versão atual fica guardada e pode ser restaurada.</li>
          <li><b>Nunca mudam sozinhos:</b> preços, descontos, condições comerciais, garantias, reembolsos, credenciais, integrações, ferramentas, modelo e limites de gasto. Isso vira proposta para sua aprovação.</li>
        </ul>
        <p className="mt-2 text-text-muted">É ajuste de instruções e conhecimento, não treinamento do modelo. Nem toda execução encontra uma melhoria confiável.</p>
      </div>
    </div>
  )
}

const Info = ({ rotulo, valor, ajuda }) => (
  <div className="rounded-xl border border-border-subtle p-3">
    <p className="text-[11px] text-text-muted">{rotulo}</p>
    <p className="mt-0.5 text-base font-semibold text-text-primary">{valor}</p>
    {ajuda && <p className="mt-0.5 text-[11px] text-text-muted">{ajuda}</p>}
  </div>
)

function Execucao({ job, pode, onAtualizar }) {
  const cid = useDB((s) => s.company.id)
  const [st, rot] = ESTADO_JOB[job.status] || ['badge-muted', job.status]
  const ativo = ATIVO.includes(job.status)
  const etapaIdx = ETAPAS.findIndex(([k]) => k === job.etapa)
  const p = job.progresso || {}
  const r = job.relatorio || {}
  const cob = r.conversas || job.cobertura || {}
  const v = r.validacao
  const acao = async (fn, ok) => { try { await fn(); toast(ok, 'success'); onAtualizar() } catch (e) { toast(e.message, 'error') } }
  return (
    <div className="card space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={st}>{rot}</span>
        <span className="text-xs text-text-muted">Iniciada em {fmtDate(job.created_at)}{job.finished_at ? ` · terminou em ${fmtDate(job.finished_at)}` : ''}</span>
        <div className="ml-auto flex gap-2">
          {ativo && pode.melhorar && <button className="btn-ghost px-2 py-1 text-xs text-red-400" onClick={() => acao(() => intel.cancelar(job.id), 'Execução cancelada.')}><XCircle size={13} /> Cancelar</button>}
          {['pausado', 'falhou'].includes(job.status) && pode.melhorar && <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => acao(() => intel.continuar(cid, job.id), 'Execução retomada de onde parou.')}><PlayCircle size={13} /> Continuar de onde parou</button>}
        </div>
      </div>
      {ativo && (
        <>
          <ol className="flex flex-wrap gap-1.5">
            {ETAPAS.map(([k, nome], i) => <li key={k} className={cx('rounded-full px-2.5 py-1 text-[11px]', i < etapaIdx ? 'bg-green-500/15 text-green-400' : i === etapaIdx ? 'chip-on' : 'bg-surface-interactive text-text-muted')}>{i + 1}. {nome}</li>)}
          </ol>
          <div>
            <div className="mb-1 flex justify-between text-xs text-text-secondary"><span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />{p.mensagem || 'Na fila…'}</span>{p.total ? <span>{p.feitos || 0} de {p.total}</span> : null}</div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-interactive"><div className="h-full rounded-full transition-all" style={{ width: `${p.total ? Math.round(((p.feitos || 0) / p.total) * 100) : job.status === 'na_fila' ? 3 : 15}%`, background: 'var(--material-primary)' }} /></div>
            <p className="mt-1.5 text-[11px] text-text-muted">A análise roda no servidor: pode sair desta tela e voltar depois.</p>
          </div>
        </>
      )}
      {(job.status === 'pausado' || job.status === 'falhou') && <p className="flex gap-2 text-sm text-amber-300"><PauseCircle size={16} className="shrink-0" />{job.motivo_pausa || job.erro || 'Parada.'}</p>}
      {!ativo && r.conclusao && <p className="text-sm text-text-primary">{r.conclusao}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Info rotulo="Conversas analisadas" valor={`${n(cob.analisadas)}${cob.nestaExecucao ? ` de ${n(cob.nestaExecucao)}` : ''}`} ajuda={`${n(cob.historico)} no histórico · ${n(cob.reaproveitadas)} reaproveitadas${cob.foraDoLimite ? ` · ${n(cob.foraDoLimite)} para a próxima` : ''}${cob.falhas ? ` · ${n(cob.falhas)} sem análise` : ''}`} />
        <Info rotulo="Problemas em aberto" valor={n(r.aprendizadosAbertos)} ajuda={r.problemas ? Object.entries(r.problemas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, x]) => `${TIPO_APRENDIZADO[k] || k}: ${x}`).join(' · ') : ''} />
        <Info rotulo="Melhorias aplicadas" valor={n(r.aplicadas)} ajuda={`${n(r.pendentes)} pendente(s)${r.consolidadas ? ` · ${n(r.consolidadas)} consolidada(s)` : ''}${r.removidas ? ` · ${n(r.removidas)} removida(s)` : ''}`} />
        <Info rotulo="Custo" valor={r.custo ? `${n(r.custo.creditos)} créditos` : `~US$ ${Number(job.gasto_usd || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}`} ajuda={r.custo ? `${n(r.custo.tokensEntrada)} tokens de entrada · US$ ${Number(r.custo.usd || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 })} estimados` : 'parcial'} />
      </div>
      {v && (
        <div className="rounded-xl border border-border-subtle p-3 text-xs text-text-secondary">
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-text-primary">{v.aprovada ? <CheckCircle2 size={14} className="text-green-400" /> : <ShieldAlert size={14} className="text-amber-400" />} Validação: {v.aprovada ? 'aprovada' : `não aprovada (${v.motivo})`}</p>
          <p>{v.casos} casos · melhor em {v.melhor} · igual em {v.igual} · pior em {v.pior}{v.erros ? ` · ${v.erros} sem avaliação` : ''} · regras essenciais {v.regrasRespeitadas ? 'respeitadas' : 'com regressão'}</p>
          <p>Pontuação média: atual {n(v.pontosAtual)} · candidata {n(v.pontosCandidata)} · tokens de entrada por resposta: {n(v.tokensEntradaAtual)} → {n(v.tokensEntradaCandidata)} · tempo: {n(v.msAtual)} ms → {n(v.msCandidata)} ms</p>
        </div>
      )}
      {r.versaoAtiva != null && <p className="text-xs text-text-muted">Versão ativa: <b className="text-text-primary">v{r.versaoAtiva}</b></p>}
    </div>
  )
}

function Alteracoes({ lista, vazio, pode = {}, onDecidido }) {
  if (!lista.length) return <p className="py-6 text-center text-sm text-text-muted">{vazio}</p>
  return <div className="space-y-2">{lista.map((c) => <Alteracao key={c.id} c={c} pode={pode} onDecidido={onDecidido} />)}</div>
}

function textoDepois(c) {
  if (c.campo !== 'knowledge' || !c.depois) return c.depois
  try { const k = JSON.parse(c.depois); return `${k.title}\n${k.content}` } catch { return c.depois }
}

function Alteracao({ c, pode, onDecidido }) {
  const nav = useNavigate()
  const [aberto, setAberto] = useState(false)
  const [st, rot] = ESTADO_ALTERACAO[c.estado] || ['badge-muted', c.estado]
  const decidir = async (aprovar) => {
    try {
      const r = await intel.decidir(c.id, aprovar)
      toast(aprovar ? (r?.manual ? 'Aprovação registrada. Faça a mudança no editor do agente.' : 'Alteração aplicada numa nova versão.') : 'Alteração rejeitada.', 'success')
      onDecidido?.()
    } catch (e) { toast(e.message, 'error') }
  }
  const pendente = ['pendente_aprovacao', 'revisao', 'bloqueada'].includes(c.estado)
  return (
    <div className="card p-3">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setAberto(!aberto)}>
        {c.protegida ? <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-400" /> : <Sparkles size={15} className="mt-0.5 shrink-0 text-[color:var(--accent-text)]" />}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-text-primary">{c.motivo || 'Alteração'}</p>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            <span className={st}>{rot}</span>
            <span className="badge-muted">{CAMPO[c.campo] || c.area || c.campo} · {c.operacao}</span>
            {c.bloqueio && <span className="text-text-muted">{c.bloqueio}</span>}
          </div>
        </div>
        <ChevronDown size={15} className={cx('mt-0.5 shrink-0 text-text-muted transition', aberto && 'rotate-180')} />
      </button>
      {aberto && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3 text-xs">
          {(c.antes || c.depois) && c.operacao !== 'proposta' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div><p className="mb-1 text-text-muted">Antes</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-red-500/5 p-2 font-sans text-text-secondary">{c.antes || '(vazio)'}</pre></div>
              <div><p className="mb-1 text-text-muted">Depois</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-green-500/5 p-2 font-sans text-text-secondary">{c.operacao === 'remover' ? '(removido)' : textoDepois(c) || '(vazio)'}</pre></div>
            </div>
          )}
          {c.aprendizados?.length > 0 && <p className="text-text-muted">Baseado em: {c.aprendizados.join(', ')}</p>}
          {c.evidencias?.length > 0 && (
            <div className="space-y-1">
              <p className="text-text-muted">Evidências</p>
              {c.evidencias.map((e, i) => (
                <button key={i} disabled={!e.conversaId} onClick={() => e.conversaId && nav(`/chats?chat=${e.conversaId}`)} className="flex w-full gap-2 rounded-lg border border-border-subtle p-2 text-left hover:bg-surface-interactive">
                  <MessageCircle size={12} className="mt-0.5 shrink-0 text-text-muted" /><span className="text-text-secondary">{e.trecho || 'Abrir a conversa'}</span>
                </button>
              ))}
            </div>
          )}
          {pendente && pode.aprovar && (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => decidir(true)}><CheckCircle2 size={13} /> {c.operacao === 'proposta' ? 'Aprovar (faço no editor)' : 'Aprovar e aplicar'}</button>
              <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => decidir(false)}>Rejeitar</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Versoes({ versoes, pode, onRestaurado, agentId }) {
  const [ver, setVer] = useState(null)
  const [restaurar, setRestaurar] = useState(null)
  const ativa = versoes.find((v) => v.publicadaEm)
  if (!versoes.length) return <p className="py-6 text-center text-sm text-text-muted">Nenhuma versão guardada ainda. A primeira é salva antes da primeira melhoria.</p>
  return (
    <div className="space-y-2">
      {versoes.map((v) => (
        <div key={v.id} className="card flex flex-wrap items-center gap-2 p-3 text-xs">
          <History size={14} className="text-text-muted" />
          <b className="text-text-primary">v{v.numero}</b>
          {v.id === ativa?.id && <span className="badge-success">Ativa</span>}
          <span className="badge-muted">{{ copia: 'Cópia de segurança', melhoria: 'Melhoria', aprovacao: 'Aprovação', restauracao: 'Restauração' }[v.origem] || v.origem}</span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">{v.resumo}</span>
          <span className="text-text-muted">{fmtDate(v.criadoEm)}</span>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setVer(v)}>Ver</button>
          {pode.restaurar && v.id !== ativa?.id && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setRestaurar(v)}><RotateCcw size={12} /> Restaurar</button>}
        </div>
      ))}
      <Modal open={!!ver} onClose={() => setVer(null)} title={`Versão ${ver?.numero}`} subtitle={ver?.resumo} size="lg">
        {ver && <ConteudoVersao c={ver.conteudo} />}
      </Modal>
      <Confirm open={!!restaurar} onClose={() => setRestaurar(null)} danger={false} confirmLabel="Restaurar" title={`Restaurar a versão ${restaurar?.numero}?`}
        message="As instruções e o conhecimento voltam para os dessa versão. A versão atual fica guardada e pode ser restaurada depois."
        onConfirm={async () => { try { await intel.restaurar(restaurar.id); toast('Versão restaurada.', 'success'); recarregarAgente(agentId); onRestaurado() } catch (e) { toast(e.message, 'error') } }} />
    </div>
  )
}

function ConteudoVersao({ c = {} }) {
  const campos = ['prompt', 'does', 'audience', 'tone', 'examples', 'rules'].filter((k) => c[k])
  return (
    <div className="space-y-3 text-xs">
      {campos.map((k) => <div key={k}><p className="mb-1 font-semibold text-text-primary">{CAMPO[k]}</p><pre className="whitespace-pre-wrap rounded-lg bg-surface-interactive p-2 font-sans text-text-secondary">{c[k]}</pre></div>)}
      <p className="font-semibold text-text-primary">Conhecimento ({(c.knowledge || []).length})</p>
      {(c.knowledge || []).map((k) => <div key={k.id} className="rounded-lg border border-border-subtle p-2"><p className="font-semibold text-text-secondary">{k.title}</p><p className="whitespace-pre-wrap text-text-muted">{k.content}</p></div>)}
    </div>
  )
}

function Aprendizados({ lista }) {
  const nav = useNavigate()
  if (!lista.length) return <p className="py-6 text-center text-sm text-text-muted">A base de aprendizados é montada na primeira execução do "Melhorar agente".</p>
  return (
    <div className="space-y-2">
      {lista.map((l) => (
        <div key={l.id} className="card p-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-text-primary">{l.titulo}</span>
            <span className="badge-muted">{TIPO_APRENDIZADO[l.tipo] || l.tipo}</span>
            <span className="badge-info">{l.frequencia} conversa{l.frequencia === 1 ? '' : 's'}</span>
            {NATUREZA[l.natureza] && <span className={NATUREZA[l.natureza][0]}>{NATUREZA[l.natureza][1]}</span>}
            <span className={l.estado === 'aplicado' ? 'badge-success' : l.estado === 'pendente' ? 'badge-warning' : 'badge-muted'}>{{ aberto: 'Em aberto', aplicado: 'Aplicado', pendente: 'Pendente' }[l.estado] || l.estado}</span>
            {l.area && <span className="badge-warning">área protegida</span>}
          </div>
          {l.detalhe && <p className="mt-1 text-text-secondary">{l.detalhe}</p>}
          {l.evidencias?.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{l.evidencias.slice(0, 4).map((e, i) => <button key={i} className="badge-info inline-flex items-center gap-1" title={e.trecho} onClick={() => e.chat && nav(`/chats?chat=${e.chat}`)}><MessageCircle size={10} /> conversa {i + 1}</button>)}</div>}
        </div>
      ))}
    </div>
  )
}

function Validacao({ lista }) {
  if (!lista.length) return <p className="py-6 text-center text-sm text-text-muted">Os testes aparecem aqui quando uma versão candidata é validada.</p>
  const cor = { melhor: 'badge-success', igual: 'badge-muted', pior: 'badge-danger', erro: 'badge-warning' }
  return (
    <div className="space-y-2">
      {lista.map((r, i) => (
        <details key={i} className="card p-3 text-xs">
          <summary className="flex cursor-pointer flex-wrap items-center gap-1.5">
            <span className={cor[r.veredito] || 'badge-muted'}>{{ melhor: 'Candidata melhor', igual: 'Igual', pior: 'Candidata pior', erro: 'Sem avaliação' }[r.veredito] || r.veredito}</span>
            <span className="badge-muted">{{ falha_anterior: 'Falha anterior', representativo: 'Representativo', regra_essencial: 'Regra essencial' }[r.tipo] || r.tipo}</span>
            <span className="text-text-secondary">{r.criterio}</span>
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[['Versão atual', r.atual, r.avaliacao?.atual], ['Candidata', r.candidata, r.avaliacao?.candidata]].map(([t, x, nota]) => (
              <div key={t} className="rounded-lg border border-border-subtle p-2">
                <p className="mb-1 font-semibold text-text-primary">{t}{nota ? ` · ${nota.correcao}/${nota.clareza}/${nota.transferencia}/${nota.concisao}${nota.regras === 'violou' ? ' · violou regra' : ''}` : ''}</p>
                {x?.resposta != null ? <p className="whitespace-pre-wrap text-text-secondary">{x.resposta || '(sem resposta)'}{x.transferiu ? ' [transferiu]' : ''}</p> : <p className="text-text-muted">Resposta visível só para quem pode ver conversas.</p>}
                <p className="mt-1 text-text-muted">{n(x?.tokens)} tokens · {n(x?.ms)} ms</p>
              </div>
            ))}
          </div>
          {r.avaliacao?.motivo && <p className="mt-2 text-text-muted">{r.avaliacao.motivo}</p>}
        </details>
      ))}
      <p className="text-[11px] text-text-muted">Notas: correção / clareza / transferência adequada / concisão (1 a 5). A avaliação é às cegas: o avaliador não sabe qual é a versão nova.</p>
    </div>
  )
}

function Desempenho({ d }) {
  const blocos = useMemo(() => {
    if (!d) return []
    const tx = (x) => (x?.taxaTransferencia == null ? null : Number(x.taxaTransferencia))
    return [{ tipo: 'comparacao', titulo: 'Antes e depois da última publicação (até 14 dias de cada lado)', periodos: { atual: 'Depois', anterior: 'Antes' }, itens: [
      { rotulo: 'Execuções', atual: d.depois?.execucoes ?? null, anterior: d.antes?.execucoes ?? null, formato: 'numero' },
      { rotulo: 'Taxa de transferência', atual: tx(d.depois), anterior: tx(d.antes), formato: 'pct' },
      { rotulo: 'A IA não resolveu', atual: d.depois?.iaNaoResolveu ?? null, anterior: d.antes?.iaNaoResolveu ?? null, formato: 'numero' },
      { rotulo: 'Tokens de entrada por execução', atual: d.depois?.tokensEntradaMedia ?? null, anterior: d.antes?.tokensEntradaMedia ?? null, formato: 'numero' },
      { rotulo: 'Tempo médio (ms)', atual: d.depois?.msMedia ?? null, anterior: d.antes?.msMedia ?? null, formato: 'numero' },
      { rotulo: 'Erros', atual: d.depois?.erros ?? null, anterior: d.antes?.erros ?? null, formato: 'numero' }] },
      { tipo: 'aviso', texto: 'Tráfego, oferta e perfil dos clientes também mudam esses números: a comparação mostra tendência, não prova que a versão nova causou a diferença.' }]
  }, [d])
  if (!d) return <p className="py-6 text-center text-sm text-text-muted">O acompanhamento começa depois da primeira versão publicada.</p>
  return <Blocos blocos={blocos} />
}

function Historico({ jobs }) {
  return (
    <details className="card p-3 text-xs">
      <summary className="cursor-pointer text-text-secondary">Execuções anteriores ({jobs.length})</summary>
      <ul className="mt-2 space-y-1.5">
        {jobs.map((j) => {
          const [st, rot] = ESTADO_JOB[j.status] || ['badge-muted', j.status]
          return <li key={j.id} className="flex flex-wrap items-center gap-2"><span className={st}>{rot}</span><span className="text-text-muted">{fmtDate(j.created_at)}</span><span className="text-text-secondary">{j.relatorio?.conclusao || j.erro || ''}</span></li>
        })}
      </ul>
    </details>
  )
}
