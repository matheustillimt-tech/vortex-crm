import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Bot, Plus, Sparkles, LayoutTemplate, Mic, ArrowLeft, Pencil, PlayCircle, Save, Image, FileText, Zap, BookOpen, Database, Settings, Trash2, X, Send, Upload,
  Smartphone, AlertTriangle, Loader2, Paperclip, KeyRound, FlaskConical, Shuffle,
} from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import * as api from '../lib/backend'
import { cx, fmtDate, uid } from '../lib/utils'
import { Avatar, Confirm, EmptyState, Field, Modal, PageHeader, Select, Tabs, Toggle } from '../components/ui'

const EMOJI_AVATARS = ['🦁', '🤖', '🐯', '🦊', '🐼', '🦉', '👩‍💼', '👨‍💼', '🧠', '⚡']

// Agente novo nasce pausado e sem número: só atende depois de vinculado e ativado.
// O id já vem pronto para os arquivos poderem ser enviados antes do primeiro "Salvar".
export const blankAgent = () => ({
  id: uid(), name: 'Leo', avatar: '🦁', photoUrl: '', active: false, connectionId: null, role: '', does: '', objective: 'Vender', audience: '', tone: 'Vendedor', examples: '', rules: '', forbidden: '', emojis: 'moderado', prompt: '',
  skills: [], fields: [
    { id: uid(), desc: 'Coletar nome do lead', field: 'nome' }, { id: uid(), desc: 'Cidade', field: 'cidade' }, { id: uid(), desc: 'Produto de interesse', field: 'produto' }, { id: uid(), desc: 'E-mail', field: 'email' }, { id: uid(), desc: 'Quer recomprar?', field: 'recompra' },
  ],
  files: [], knowledge: [],
  settings: { buffer: 5, split: true, audio: false, voice: 'padrao', audioRule: '', hearAudio: true, seeImage: true, businessHours: false, stopOnHuman: true, stopNoProgress: true, sign: false, testNumbers: '', aiProvider: '' },
})

const TEMPLATES = [
  { name: 'Closer de vendas', avatar: '🦁', objective: 'Vender', tone: 'Vendedor', does: 'Tira dúvida do anúncio e leva quem topar pagar pro Pix', examples: 'Oi! Vi que você se interessou 😊\nO kit sai 197 com frete grátis.\nQuer que eu te mande o Pix?' },
  { name: 'Agendador', avatar: '🦉', objective: 'Agendar', tone: 'Consultivo', does: 'Entende a necessidade e agenda uma reunião/consulta', examples: 'Oi! Me conta rapidinho o que você precisa?\nPerfeito. Tenho horário amanhã às 10h ou 15h.\nQual fica melhor?' },
  { name: 'Suporte', avatar: '🤖', objective: 'Tirar dúvida', tone: 'Suporte', does: 'Resolve dúvidas de pedido, prazo e troca', examples: 'Oi! Me passa o número do pedido?\nAchei aqui: sai pra entrega amanhã.\nPosso ajudar em algo mais?' },
  { name: 'Qualificador', avatar: '🦊', objective: 'Qualificar', tone: 'Descontraído', does: 'Faz perguntas rápidas e separa leads quentes', examples: 'Opa! Bora ver se faz sentido pra você?\nVocê já vende online hoje?\nShow, quanto fatura por mês mais ou menos?' },
]

const buildPrompt = (a) =>
  [
    `Você é ${a.name}${a.role ? `, ${a.role}` : ''}.`,
    a.does && `Sua função: ${a.does}.`,
    `Objetivo principal: ${a.objective}.`,
    a.audience && `Quem é o cliente: ${a.audience}.`,
    `Tom de voz: ${a.tone}.`,
    a.examples && `Escreva no mesmo jeito destes exemplos:\n${a.examples}`,
    a.rules && `Regras do negócio: ${a.rules}`,
    a.forbidden && `Nunca fale sobre: ${a.forbidden}.`,
    `Emojis: ${a.emojis === 'nenhum' ? 'não use' : a.emojis === 'livre' ? 'use à vontade' : 'com moderação, no máximo um por mensagem'}.`,
    a.fields?.length && `Anote quando aparecer: ${a.fields.map((f) => `${f.desc} → {{${f.field}}}`).join('; ')}.`,
    a.skills?.length && `Habilidades: ${a.skills.map((s) => `quando "${s.when}" → ${s.action}`).join('; ')}.`,
  ].filter(Boolean).join('\n')

const CHAT_AI = { openai: 'OpenAI', gemini: 'Google Gemini', compat: 'Compatível com OpenAI' }

// Chaves de IA conectadas na empresa (Configurações → Integrações). A chave em si nunca chega ao navegador.
function useAiCredentials() {
  const companyId = useDB((s) => s.company.id)
  const [state, setState] = useState({ loaded: !BACKEND, list: [] })
  useEffect(() => {
    if (!BACKEND || !companyId) return
    let alive = true
    api.aiCredentialList(companyId).then((list) => alive && setState({ loaded: true, list })).catch(() => alive && setState({ loaded: true, list: [] }))
    return () => { alive = false }
  }, [companyId])
  const chat = state.list.filter((c) => CHAT_AI[c.provider])
  const audio = state.list.some((c) => c.provider === 'elevenlabs' || c.provider === 'openai')
  return { ...state, chat, audio }
}

// Rotacionadores ligados em que este agente atende os números da roda (Conexões → Rotacionador)
const rotatorsOf = (rotators, agentId) => rotators.filter((r) => r.active && r.agentId === agentId)

// Dois agentes não podem estar ativos no mesmo número (o banco também recusa).
function activationProblem(agents, agent) {
  if (!agent.active || !agent.connectionId) return null
  const other = agents.find((x) => x.id !== agent.id && x.active && x.connectionId === agent.connectionId)
  return other ? `O agente "${other.name}" já está ativo neste número. Pause-o antes de ativar este.` : null
}

function NoKeyBanner() {
  const nav = useNavigate()
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-[16px] border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center">
      <KeyRound size={18} className="shrink-0 text-amber-400" />
      <p className="flex-1 text-text-secondary"><b className="text-text-primary">Nenhuma IA conectada.</b> Os agentes só respondem no WhatsApp depois que você conectar um provedor (OpenAI, Google Gemini ou outro compatível) em Configurações → Integrações.</p>
      <button className="btn-secondary shrink-0 text-xs" onClick={() => nav('/settings?tab=integrations')}>Conectar IA</button>
    </div>
  )
}

export function AgentList() {
  const db = useDB()
  const nav = useNavigate()
  const creds = useAiCredentials()
  const [tab, setTab] = useState('agents')
  const [modal, setModal] = useState(null)
  const [del, setDel] = useState(null)
  const [aiText, setAiText] = useState('')
  const [voice, setVoice] = useState({ name: '', elevenVoiceId: '' })

  const fromTemplate = (t) => {
    const a = db.add('agents', { ...blankAgent(), ...t, updatedAt: new Date().toISOString() })
    setModal(null)
    nav('/agentes/' + a.id)
  }

  const createWithAi = () => {
    const lower = aiText.toLowerCase()
    const objective = /agend|consult|reuni/.test(lower) ? 'Agendar' : /suporte|dúvida|duvida|pedido/.test(lower) ? 'Tirar dúvida' : /qualific/.test(lower) ? 'Qualificar' : 'Vender'
    fromTemplate({ name: 'Agente IA', avatar: '🧠', objective, does: aiText, tone: objective === 'Vender' ? 'Vendedor' : 'Consultivo' })
    toast('Agente criado a partir da descrição!')
  }

  const toggleActive = (a) => {
    const next = { ...a, active: !a.active }
    const problem = activationProblem(db.agents, next)
    if (problem) return toast(problem, 'error')
    db.update('agents', a.id, { active: next.active, updatedAt: new Date().toISOString() })
    toast(next.active ? `${a.name} ativado.` : `${a.name} pausado.`)
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        icon={Bot}
        title="Agentes de IA"
        subtitle="Atendente no WhatsApp que tira dúvida e dispara o fluxo"
        actions={
          <>
            <button className="btn-secondary" onClick={() => setModal('templates')}><LayoutTemplate size={15} /> Modelos</button>
            <button className="btn-secondary" onClick={() => setModal('ai')}><Sparkles size={15} /> Criar com IA</button>
            <button className="btn-primary" onClick={() => nav('/agentes/novo')}><Plus size={15} /> Novo agente</button>
          </>
        }
      />
      {BACKEND && creds.loaded && !creds.chat.length && <NoKeyBanner />}
      <Tabs className="mb-4 max-w-xs" value={tab} onChange={setTab} tabs={[{ id: 'agents', label: 'Agentes', icon: Bot }, { id: 'voices', label: 'Vozes', icon: Mic }]} />
      {tab === 'agents' ? (
        db.agents.length === 0 ? (
          <EmptyState icon={Bot} title="Nenhum agente ainda" hint="Cria o primeiro pra começar." action={<button className="btn-primary" onClick={() => nav('/agentes/novo')}>Criar o primeiro agente</button>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {db.agents.map((a) => {
              const conn = db.connections.find((c) => c.id === a.connectionId)
              const rots = rotatorsOf(db.rotators, a.id)
              return (
                <div key={a.id} onClick={() => nav('/agentes/' + a.id)} className="card group cursor-pointer p-5 transition hover:border-border-hover hover:shadow-glow">
                  <div className="flex items-start gap-3">
                    <Avatar name={a.name} emoji={a.photoUrl ? undefined : a.avatar} src={a.photoUrl || undefined} size={48} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{a.name}</p>
                      <p className="truncate text-xs text-text-muted">{a.role || a.does || 'Sem descrição'}</p>
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Toggle checked={!!a.active} onChange={() => toggleActive(a)} />
                    </div>
                  </div>
                  <p className={cx('mt-3 flex items-center gap-1.5 text-xs', conn ? 'text-text-secondary' : 'text-text-muted')}>
                    <Smartphone size={13} />
                    {conn ? <span className="truncate">{conn.name}{conn.number ? ` · ${conn.number}` : ''}</span> : rots.length ? 'Sem número próprio' : 'Sem número vinculado'}
                  </p>
                  {rots.length > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                      <Shuffle size={13} /><span className="truncate">Rotacionador {rots.map((r) => r.name).join(', ')}</span>
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className={!a.active ? 'badge-muted' : conn || rots.length ? 'badge-success' : 'badge-warning'}>{!a.active ? 'Pausado' : conn || rots.length ? 'Atendendo' : 'Ativo sem número'}</span>
                    {a.settings?.testNumbers?.trim() && <span className="badge-warning"><FlaskConical size={10} /> Modo de teste</span>}
                    {a.objective && <span className="badge-primary">{a.objective}</span>}
                    <span className="badge-muted">{(a.skills || []).length} habilidades</span>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-text-muted">
                    <span>Atualizado {fmtDate(a.updatedAt)}</span>
                    <button className="btn-ghost p-1.5 text-red-400 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); setDel(a) }}><Trash2 size={14} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div className="card grid gap-2 p-3 md:grid-cols-[1fr_1fr_auto]">
            <input className="input" placeholder="Nome da nova voz (ex.: Voz da Ana)" value={voice.name} onChange={(e) => setVoice({ ...voice, name: e.target.value })} />
            <input className="input font-mono text-xs" placeholder="ID da voz na ElevenLabs (opcional)" value={voice.elevenVoiceId} onChange={(e) => setVoice({ ...voice, elevenVoiceId: e.target.value.trim() })} />
            <button className="btn-primary shrink-0" onClick={() => { if (!voice.name) return; db.add('voices', { name: voice.name, elevenVoiceId: voice.elevenVoiceId }); setVoice({ name: '', elevenVoiceId: '' }); toast('Voz criada!') }}><Plus size={15} /> Nova voz</button>
          </div>
          <p className="px-1 text-xs text-text-muted">Com a ElevenLabs conectada em Integrações, cole aqui o ID de uma voz da sua conta (inclusive clonada). Sem ID, o agente usa a primeira voz da conta; sem ElevenLabs, usa a voz da OpenAI.</p>
          {db.voices.map((v) => (
            <div key={v.id} className="card flex flex-wrap items-center gap-3 p-4">
              <div className="icon-tile h-10 w-10"><Mic size={18} /></div>
              <p className="flex-1 font-medium">{v.name}</p>
              <input className="input w-64 font-mono text-xs" placeholder="ID da voz na ElevenLabs" defaultValue={v.elevenVoiceId || ''} onBlur={(e) => e.target.value.trim() !== (v.elevenVoiceId || '') && db.update('voices', v.id, { elevenVoiceId: e.target.value.trim() })} />
              <button className="btn-secondary text-xs" onClick={() => { try { speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance('Oi! Essa é uma prévia da voz do seu agente.'), { lang: 'pt-BR' })) } catch { toast('Prévia indisponível neste navegador.', 'info') } }}><PlayCircle size={14} /> Ouvir</button>
              {v.id !== 'padrao' && <button className="btn-ghost p-1.5 text-red-400" onClick={() => db.remove('voices', v.id)}><Trash2 size={14} /></button>}
            </div>
          ))}
        </div>
      )}

      <Modal open={modal === 'templates'} onClose={() => setModal(null)} title="Modelos de agente" subtitle="Comece de um modelo pronto e ajuste" size="lg">
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button key={t.name} onClick={() => fromTemplate(t)} className="panel-soft p-4 text-left transition hover:border-accent-primary">
              <div className="mb-2 flex items-center gap-2"><span className="text-2xl">{t.avatar}</span><span className="font-semibold">{t.name}</span></div>
              <p className="text-xs text-text-muted">{t.does}</p>
              <div className="mt-2 flex gap-1"><span className="badge-primary">{t.objective}</span><span className="badge-info">{t.tone}</span></div>
            </button>
          ))}
        </div>
      </Modal>
      <Modal open={modal === 'ai'} onClose={() => setModal(null)} title="Criar com IA" subtitle="Descreva o agente e a gente monta a primeira versão"
        footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button><button className="btn-primary" onClick={createWithAi} disabled={!aiText}><Sparkles size={14} /> Criar agente</button></>}>
        <textarea className="input" rows={5} value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder="Ex.: Atendente que vende meu curso de confeitaria, responde dúvidas sobre acesso e manda o link de pagamento quando a pessoa quiser comprar." />
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir agente" message={`Excluir o agente "${del?.name}"?`} onConfirm={() => db.remove('agents', del.id)} />
    </div>
  )
}

const TABS = [
  { id: 'photo', label: 'Foto', icon: Image },
  { id: 'instructions', label: 'Instruções', icon: FileText },
  { id: 'skills', label: 'Habilidades', icon: Zap },
  { id: 'knowledge', label: 'Conhecimento', icon: BookOpen },
  { id: 'data', label: 'Coleta de dados', icon: Database },
  { id: 'settings', label: 'Configurações', icon: Settings },
]

const TONES = [
  { id: 'Vendedor', desc: 'Pergunta curto, cria urgência leve, leva sempre pra próxima pergunta' },
  { id: 'Suporte', desc: 'Resolve rápido, toma o problema, evita enrolação' },
  { id: 'Consultivo', desc: 'Pergunta antes de oferecer, explica com calma' },
  { id: 'Descontraído', desc: 'Informal, gírias leves, frases curtas' },
]

const ACTIONS = ['Disparar fluxo', 'Transferir pra humano', 'Adicionar etiqueta', 'Mover no Kanban', 'Enviar arquivo', 'Registrar venda', 'Agendar no Vórtex Call']
const kindOf = (action) => (/^Disparar fluxo/.test(action || '') ? 'Disparar fluxo' : action)
const MAX_FILE = 64 * 1024 * 1024
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function AgentEditor() {
  const { id } = useParams()
  const db = useDB()
  const nav = useNavigate()
  const creds = useAiCredentials()
  const isNew = id === 'novo'
  const existing = db.agents.find((a) => a.id === id)
  const [a, setA] = useState(() => (isNew ? blankAgent() : existing ? { ...blankAgent(), ...JSON.parse(JSON.stringify(existing)), settings: { ...blankAgent().settings, ...existing.settings } } : null))
  const [tab, setTab] = useState('photo')
  const [dirty, setDirty] = useState(isNew)
  const [editName, setEditName] = useState(false)
  const [test, setTest] = useState(false)
  const [uploading, setUploading] = useState(null)
  const fileRef = useRef()
  const photoRef = useRef()
  const fileTarget = useRef(null)

  if (!a) return <EmptyState icon={Bot} title="Agente não encontrado" action={<button className="btn-primary" onClick={() => nav('/agentes')}>Voltar</button>} />

  const set = (patch) => { setA((x) => ({ ...x, ...patch })); setDirty(true) }
  const setS = (patch) => set({ settings: { ...a.settings, ...patch } })
  const setSkill = (i, patch) => set({ skills: a.skills.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const setFile = (fid, patch) => setA((x) => ({ ...x, files: x.files.map((f) => (f.id === fid ? { ...f, ...patch } : f)) }))
  const conn = db.connections.find((c) => c.id === a.connectionId)

  const save = () => {
    const problem = activationProblem(db.agents, a)
    if (problem) return toast(problem, 'error')
    const data = { ...a, prompt: a.prompt || '', updatedAt: new Date().toISOString() }
    if (isNew || !existing) {
      const created = db.add('agents', data)
      nav('/agentes/' + created.id, { replace: true })
    } else {
      // arquivos tirados da lista saem também do armazenamento
      const kept = new Set(a.files.map((f) => f.path).filter(Boolean))
      if (BACKEND) existing.files?.filter((f) => f.path && !kept.has(f.path)).forEach((f) => api.removeAgentFile(f.path))
      db.update('agents', id, data)
    }
    setDirty(false)
    toast(a.active && !conn && !rotatorsOf(db.rotators, a.id).length ? 'Agente salvo. Ele está ativo, mas sem número: só atende quando um fluxo entregar a conversa.' : 'Agente salvo!')
  }

  const pickPhoto = async (file) => {
    if (!file) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Use JPEG, PNG ou WebP.', 'error')
    if (file.size > 5 * 1024 * 1024) return toast('A foto passa de 5 MB.', 'error')
    if (!BACKEND) return set({ photoUrl: URL.createObjectURL(file) })
    try {
      setUploading('photo')
      set({ photoUrl: await api.uploadAgentAvatar(db.company.id, file) })
    } catch (e) {
      toast(`Não foi possível enviar a foto: ${e.message}`, 'error')
    } finally {
      setUploading(null)
    }
  }

  const pickFile = async (file) => {
    const fid = fileTarget.current
    fileTarget.current = null
    if (!file || !fid) return
    if (file.size > MAX_FILE) return toast('O arquivo passa de 64 MB.', 'error')
    if (!BACKEND) { setFile(fid, { fileName: file.name, size: file.size, mime: file.type }); setDirty(true); return }
    try {
      setUploading(fid)
      const up = await api.uploadAgentFile(db.company.id, a.id, file)
      setFile(fid, up)
      setDirty(true)
    } catch (e) {
      toast(`Não foi possível enviar o arquivo: ${e.message}`, 'error')
    } finally {
      setUploading(null)
    }
  }
  const chooseFile = (fid) => { fileTarget.current = fid; fileRef.current.value = ''; fileRef.current.click() }
  const openFile = async (f) => {
    const url = BACKEND && f.path ? await api.agentFileLink(f.path) : null
    if (url) window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button className="btn-ghost p-2" onClick={() => nav('/agentes')}><ArrowLeft size={18} /></button>
        <Avatar name={a.name} emoji={a.photoUrl ? undefined : a.avatar} src={a.photoUrl || undefined} size={40} />
        {editName ? (
          <input autoFocus className="input w-48" value={a.name} onChange={(e) => set({ name: e.target.value })} onBlur={() => setEditName(false)} onKeyDown={(e) => e.key === 'Enter' && setEditName(false)} />
        ) : (
          <button className="flex items-center gap-2 text-[22px] font-[650]" style={{ letterSpacing: '-0.04em' }} onClick={() => setEditName(true)} title="Editar nome">{a.name} <Pencil size={14} className="text-text-muted" /></button>
        )}
        <span className={dirty ? 'badge-warning' : 'badge-success'}>{dirty ? 'Não salvo' : 'Salvo'}</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary" onClick={() => setTest(true)}><PlayCircle size={15} /> Teste ao vivo</button>
          <button className="btn-primary" onClick={save}><Save size={15} /> Salvar</button>
        </div>
      </div>
      {/* Vínculo com o número e atendimento ligado/pausado */}
      <div className="card mb-5 grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
        <div className="min-w-0 space-y-2">
          <Field label="Número em que este agente atende" className="mb-0 max-w-md">
            <Select value={a.connectionId || ''} onChange={(v) => set({ connectionId: v || null })} placeholder="Nenhum (só quando um fluxo entregar)"
              options={db.connections.map((c) => ({ value: c.id, label: `${c.name}${c.number ? ` · ${c.number}` : ''}${c.status !== 'connected' ? ' (desconectada)' : ''}` }))} />
          </Field>
          <LinkStatus agent={a} conn={conn} rots={rotatorsOf(db.rotators, a.id)} creds={creds} dirty={dirty} />
        </div>
        <div className="flex items-center gap-3 rounded-[14px] border border-border px-3 py-1">
          <Toggle checked={!!a.active} onChange={(v) => set({ active: v })} label={a.active ? 'Atendimento ativo' : 'Atendimento pausado'} description={a.active ? 'Responde no WhatsApp' : 'Não responde ninguém'} />
        </div>
      </div>

      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={TABS} />

      {tab === 'photo' && (
        <div className="card p-6">
          <p className="font-semibold">Foto</p>
          <p className="mb-4 text-sm text-text-muted">Escolhe um avatar ou manda uma foto. JPEG, PNG ou WebP. Até 5 MB. Aparece no painel e no Chat ao Vivo.</p>
          <div className="mb-5 flex flex-wrap gap-2">
            {EMOJI_AVATARS.map((e) => <button key={e} onClick={() => set({ avatar: e, photoUrl: '' })} className={cx('flex h-14 w-14 items-center justify-center rounded-[16px] border text-2xl transition', !a.photoUrl && a.avatar === e ? 'choice-on' : 'border-border bg-surface-overlay hover:border-border-hover')}>{e}</button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {a.photoUrl && <Avatar name={a.name} src={a.photoUrl} size={56} />}
            <button className="btn-secondary" disabled={uploading === 'photo'} onClick={() => photoRef.current.click()}>{uploading === 'photo' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Enviar foto</button>
            {a.photoUrl && <button className="btn-ghost text-xs text-red-400" onClick={() => set({ photoUrl: '' })}>Remover foto</button>}
          </div>
          <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
        </div>
      )}

      {tab === 'instructions' && (
        <div className="space-y-4">
          <div className="card p-5">
            <p className="mb-4 font-semibold">Identidade</p>
            <div className="grid gap-x-4 md:grid-cols-2">
              <Field label="Função (aparece só pra você)"><input className="input" placeholder="Ex.: closer do kit. Só você vê, o cliente não." value={a.role} onChange={(e) => set({ role: e.target.value })} /></Field>
              <Field label="Quem é o cliente"><input className="input" placeholder="Ex.: mulher de 25 a 40 que viu o anúncio" value={a.audience} onChange={(e) => set({ audience: e.target.value })} /></Field>
            </div>
            <Field label="O que ele faz"><textarea className="input" rows={2} placeholder="Ex.: tira dúvida do anúncio e leva quem topar pagar pro fluxo" value={a.does} onChange={(e) => set({ does: e.target.value })} /></Field>
            <Field label="Objetivo principal">
              <div className="flex flex-wrap gap-2">{['Vender', 'Agendar', 'Tirar dúvida', 'Qualificar'].map((o) => <button key={o} onClick={() => set({ objective: o })} className={cx('rounded-[13px] border px-4 py-2 text-sm', a.objective === o ? 'chip-on' : 'border-border text-text-secondary')}>{o}</button>)}</div>
            </Field>
            <Field label="Jeito de falar">
              <div className="grid gap-2 sm:grid-cols-2">
                {TONES.map((t) => (
                  <button key={t.id} onClick={() => set({ tone: t.id })} className={cx('rounded-[16px] border p-3 text-left', a.tone === t.id ? 'choice-on' : 'border-border hover:border-border-hover')}>
                    <p className="text-sm font-semibold">{t.id}</p><p className="text-xs text-text-muted">{t.desc}</p>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Escreve 3 mensagens do jeito que você falaria" hint="Ele copia o jeito. É o que mais muda a conversa."><textarea className="input" rows={4} placeholder={'Oi, vi que você se interessou.\nO kit sai 197 com frete grátis.\nQuer que eu te mande o Pix?'} value={a.examples} onChange={(e) => set({ examples: e.target.value })} /></Field>
          </div>
          <div className="card p-5">
            <p className="mb-4 font-semibold">Regras do seu negócio</p>
            <Field label="Regras"><textarea className="input" rows={3} placeholder="Ex.: frete grátis acima de 197. Sem desconto fora do fluxo." value={a.rules} onChange={(e) => set({ rules: e.target.value })} /></Field>
            <div className="grid gap-x-4 md:grid-cols-2">
              <Field label="Nunca falar sobre"><input className="input" placeholder="Ex.: política, concorrente, promessa de resultado" value={a.forbidden} onChange={(e) => set({ forbidden: e.target.value })} /></Field>
              <Field label="Usar emojis"><Select value={a.emojis} onChange={(v) => set({ emojis: v })} options={[{ value: 'moderado', label: 'Com moderação, no máximo um por mensagem' }, { value: 'nenhum', label: 'Nunca' }, { value: 'livre', label: 'À vontade' }]} /></Field>
            </div>
          </div>
          <div className="card p-5">
            <p className="mb-1 font-semibold">Prompt</p>
            <p className="mb-3 text-xs text-text-muted">Opcional. Se vazio, ele usa o que você preencheu acima. Conhecimento, habilidades, arquivos e dados para coletar entram sozinhos.</p>
            <textarea className="input font-mono text-xs" rows={8} value={a.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder={buildPrompt(a)} />
            <button className="btn-secondary mt-2 text-xs" onClick={() => set({ prompt: buildPrompt(a) })}><Sparkles size={13} /> Gerar a partir dos campos</button>
          </div>
        </div>
      )}

      {tab === 'skills' && (
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div><p className="font-semibold">Habilidades</p><p className="text-sm text-text-muted">Além de conversar: descreve a situação e escolhe o que ele faz. <b className="text-text-primary">{a.skills.length} ativas</b></p></div>
            <button className="btn-primary" onClick={() => set({ skills: [...a.skills, { id: uid(), when: '', action: 'Disparar fluxo' }] })}><Plus size={15} /> Nova habilidade</button>
          </div>
          {a.skills.map((s, i) => (
            <div key={s.id} className="mb-3 grid gap-2 panel-soft p-3 md:grid-cols-[1fr_190px_1fr_auto]">
              <input className="input" placeholder="Quando… (ex.: cliente quer pagar)" value={s.when} onChange={(e) => setSkill(i, { when: e.target.value })} />
              <Select value={kindOf(s.action)} onChange={(v) => setSkill(i, { action: v })} options={ACTIONS} />
              <SkillParams skill={s} agent={a} onChange={(patch) => setSkill(i, patch)} />
              <button className="btn-ghost p-2 text-red-400" onClick={() => set({ skills: a.skills.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>
          ))}
          <div className="mt-4 rounded-[16px] border border-[var(--border-accent)] bg-accent-soft p-4 text-sm">
            <p className="font-semibold text-violet-200">Como ele usa</p>
            <p className="text-text-secondary">A IA executa a ação no sistema quando a conversa bater com o "Quando…" e só confirma ao cliente depois que a ação deu certo. Todas ficam registradas na conversa, no Chat ao Vivo. No fluxo, o bloco "Agente de IA" entrega a conversa a ele ou tira dele.</p>
          </div>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="card p-5">
          <p className="font-semibold">Conhecimento</p>
          <p className="mb-4 text-sm text-text-muted">Textos e perguntas frequentes que o agente pode consultar para responder. O que não estiver aqui ou nas instruções, ele não inventa.</p>
          {a.knowledge.map((k, i) => (
            <div key={k.id} className="mb-3 panel-soft p-3">
              <div className="mb-2 flex gap-2">
                <input className="input" placeholder="Título (ex.: Política de troca)" value={k.title} onChange={(e) => set({ knowledge: a.knowledge.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                <button className="btn-ghost p-2 text-red-400" onClick={() => set({ knowledge: a.knowledge.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
              </div>
              <textarea className="input" rows={3} placeholder="Conteúdo" value={k.content} onChange={(e) => set({ knowledge: a.knowledge.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)) })} />
            </div>
          ))}
          <button className="btn-secondary" onClick={() => set({ knowledge: [...a.knowledge, { id: uid(), title: '', content: '' }] })}><Plus size={15} /> Adicionar conhecimento</button>
        </div>
      )}

      {tab === 'data' && (
        <div className="space-y-4">
          <div className="card p-5">
            <p className="font-semibold">O que o agente pode anotar</p>
            <p className="mb-4 text-sm text-text-muted">Descrição + nome do campo. Tarefa secundária: ele grava se o dado aparecer, sem virar formulário.</p>
            {a.fields.map((f, i) => (
              <div key={f.id} className="mb-2 grid items-center gap-2 md:grid-cols-[1fr_200px_auto]">
                <input className="input" placeholder="Coletar foto enviada pelo lead" value={f.desc} onChange={(e) => set({ fields: a.fields.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })} />
                <div>
                  <input className="input" placeholder="ex.: email, cidade, foto_1" value={f.field} onChange={(e) => set({ fields: a.fields.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} />
                  <p className="mt-0.5 text-[10px] text-text-muted">Guarda no contato em {'{{'}{f.field || 'campo'}{'}}'}</p>
                </div>
                <button className="btn-ghost p-2 text-red-400" onClick={() => set({ fields: a.fields.filter((_, j) => j !== i) })}><X size={15} /></button>
              </div>
            ))}
            <button className="btn-secondary mt-2" onClick={() => set({ fields: [...a.fields, { id: uid(), desc: '', field: '' }] })}><Plus size={15} /> Novo campo</button>
            <p className="mt-4 text-xs text-text-muted">Ele também lê o que já tem no contato: etiqueta e campos. Cliente antigo não responde de novo o que você já sabe. O nome e o e-mail informados atualizam o cadastro do contato; os outros campos ficam nos campos do contato e valem como variáveis nos fluxos.</p>
          </div>
          <div className="card p-5">
            <p className="font-semibold">Arquivos que ele pode enviar</p>
            <p className="mb-4 text-sm text-text-muted">O nome do que o arquivo é e quando enviar. Imagem, vídeo e áudio vão como mídia; os outros, como documento. Até 64 MB.</p>
            {a.files.map((f) => (
              <div key={f.id} className="mb-2 grid gap-2 panel-soft p-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-center">
                <input className="input" placeholder="O que é (ex.: tabela de preço)" value={f.name} onChange={(e) => set({ files: a.files.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)) })} />
                <input className="input" placeholder="Quando enviar (ex.: quando pedirem preço)" value={f.when || ''} onChange={(e) => set({ files: a.files.map((x) => (x.id === f.id ? { ...x, when: e.target.value } : x)) })} />
                {f.fileName ? (
                  <button className="flex min-w-0 max-w-[220px] items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary" onClick={() => openFile(f)} title={f.fileName}>
                    <Paperclip size={13} className="shrink-0" /> <span className="truncate">{f.fileName}</span> {f.size ? <span className="shrink-0 text-text-muted">· {fmtSize(f.size)}</span> : null}
                  </button>
                ) : (
                  <button className="btn-secondary text-xs" disabled={uploading === f.id} onClick={() => chooseFile(f.id)}>{uploading === f.id ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Escolher arquivo</button>
                )}
                <button className="btn-ghost p-2 text-red-400" onClick={() => set({ files: a.files.filter((x) => x.id !== f.id) })}><X size={15} /></button>
              </div>
            ))}
            <button className="btn-secondary" onClick={() => { const fid = uid(); set({ files: [...a.files, { id: fid, name: '', when: '' }] }); setTimeout(() => chooseFile(fid), 0) }}><Upload size={15} /> Enviar arquivo</button>
            <input ref={fileRef} type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="space-y-4">
          <div className="card p-5">
            <p className="font-semibold">Buffer de mensagens</p>
            <p className="mb-3 text-sm text-text-muted">Cliente manda a ideia picada em 3, 4 mensagens. O agente segura a resposta até ele parar de digitar e responde tudo de uma vez.</p>
            <div className="flex flex-wrap items-center gap-2">
              {[3, 5, 8, 12].map((s) => <button key={s} onClick={() => setS({ buffer: s })} className={cx('rounded-[13px] border px-4 py-2 text-sm font-semibold', a.settings.buffer === s ? 'chip-on' : 'border-border text-text-secondary')}>{s}s</button>)}
              <label className="flex items-center gap-1.5 text-xs text-text-muted">ou <input type="number" min={0} max={120} className="input w-20 py-1.5" value={a.settings.buffer} onChange={(e) => setS({ buffer: Math.max(0, Math.min(120, Math.round(+e.target.value || 0))) })} /> s</label>
            </div>
            <p className="mt-2 text-xs text-text-muted">Cada mensagem nova do cliente reinicia a contagem.</p>
            <div className="mt-3 border-t border-border pt-2">
              <Toggle checked={a.settings.split} onChange={(v) => setS({ split: v })} label="Quebrar em mensagens curtas" description='Divide a resposta em blocos, com "digitando..." no meio.' />
            </div>
          </div>
          <div className="card p-5">
            <p className="mb-2 font-semibold">Áudio e mídia</p>
            {BACKEND && creds.loaded && !creds.audio && (a.settings.audio || a.settings.hearAudio) && (
              <p className="mb-2 flex items-start gap-1.5 rounded-[12px] bg-amber-500/10 p-2.5 text-xs text-text-secondary"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" /> Para ouvir e responder em áudio, conecte a OpenAI ou a ElevenLabs em Configurações → Integrações. Sem elas, ele pede para o cliente escrever.</p>
            )}
            <Toggle checked={a.settings.audio} onChange={(v) => setS({ audio: v })} label="Deixar ele decidir se manda áudio" description="Ligado, ele segue a orientação abaixo. Preço, Pix, link e lista continuam em texto." />
            {a.settings.audio && (
              <div className="panel-soft my-3 space-y-3 p-3">
                <Field label="Voz do áudio" hint="A voz nova se cria na aba Vozes. Aqui você só escolhe qual este agente usa."><Select value={a.settings.voice} onChange={(v) => setS({ voice: v })} options={[{ value: 'padrao', label: 'Padrão da plataforma' }, ...db.voices.filter((v) => v.id !== 'padrao').map((v) => ({ value: v.id, label: v.name }))]} /></Field>
                <Field label="Orientação de quando usar áudio" hint="Áudio consome tokens, cerca de 18 tokens por áudio de 15s."><textarea className="input" rows={2} placeholder="Ex.: envia áudio se o lead mandar áudio" value={a.settings.audioRule} onChange={(e) => setS({ audioRule: e.target.value })} /></Field>
              </div>
            )}
            <Toggle checked={a.settings.hearAudio} onChange={(v) => setS({ hearAudio: v })} label="Ouvir áudio do cliente" description="Transcreve o áudio e manda no histórico. Desligado, ele só vê que chegou áudio." />
            <Toggle checked={a.settings.seeImage} onChange={(v) => setS({ seeImage: v })} label="Ver imagem do cliente" description="Lê a foto. Vídeo não entra." />
          </div>
          <div className="card p-5">
            <p className="mb-2 font-semibold">Limites</p>
            <Toggle checked={a.settings.businessHours} onChange={(v) => setS({ businessHours: v })} label="Só responder no horário comercial" description="Fora dele, avisa e deixa na fila. Os horários ficam em Configurações → Empresa." />
            <Toggle checked={a.settings.stopOnHuman} onChange={(v) => setS({ stopOnHuman: v })} label="Desligar quando um humano assumir" description="A IA para quando uma pessoa manda uma mensagem pelo painel ou pelo WhatsApp, ou clica em Atender. Só naquela conversa." />
            <Toggle checked={a.settings.stopNoProgress} onChange={(v) => setS({ stopNoProgress: v })} label="Parar depois de respostas sem avanço" description="Transfere pro humano em vez de ficar rodando em círculo." />
            <Toggle checked={a.settings.sign} onChange={(v) => setS({ sign: v })} label="Assinar o nome do agente" description="Nome no fim de cada mensagem." />
          </div>
          <div className="card p-5">
            <p className="mb-2 font-semibold">IA e testes</p>
            <Field label="Provedor de IA" hint="Os provedores aparecem aqui depois de conectados em Configurações → Integrações.">
              <Select value={a.settings.aiProvider || ''} onChange={(v) => setS({ aiProvider: v })}
                options={[{ value: '', label: 'Automático (o primeiro conectado)' }, ...creds.chat.map((c) => ({ value: c.provider, label: `${CHAT_AI[c.provider]}${c.model ? ` · ${c.model}` : ''}` }))]} />
            </Field>
            <Field label="Modo de teste: responder só a estes números" hint="Um por linha, com DDD (ex.: 55119XXXXXXXX). Vazio = responde a todos os contatos do número.">
              <textarea className="input font-mono text-xs" rows={2} placeholder="55119XXXXXXXX" value={a.settings.testNumbers || ''} onChange={(e) => setS({ testNumbers: e.target.value })} />
            </Field>
          </div>
        </div>
      )}

      {test && <LiveTest agent={a} onClose={() => setTest(false)} />}
    </div>
  )
}

// Situação do agente no número escolhido
function LinkStatus({ agent, conn, rots, creds, dirty }) {
  const tests = (agent.settings.testNumbers || '').split(/[,;\n]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 8)
  const viaRot = rots.length ? `os números do rotacionador ${rots.map((r) => r.name).join(', ')} (os que não têm agente próprio ativo)` : ''
  let tone = 'text-text-muted'
  let text
  if (!agent.active) text = 'Pausado: não responde ninguém.'
  else if (!conn && viaRot) { tone = 'text-green-400'; text = `Atendendo ${viaRot}.` }
  else if (!conn) { tone = 'text-amber-400'; text = 'Ativo sem número: só atende quando um fluxo entregar a conversa (bloco Agente de IA).' }
  else {
    tone = 'text-green-400'
    text = `Atendendo as conversas de ${conn.name}${conn.number ? ` (${conn.number})` : ''}${tests.length ? ` · modo de teste: só ${tests.length} número${tests.length > 1 ? 's' : ''}` : ''}.`
  }
  return (
    <div className="space-y-1 text-xs">
      <p className={cx('flex items-start gap-1.5', tone)}><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-current" /> {text}</p>
      {agent.active && conn && viaRot && <p className="flex items-start gap-1.5 text-text-secondary"><Shuffle size={12} className="mt-0.5 shrink-0" /> Também atende {viaRot}.</p>}
      {agent.active && conn && conn.status !== 'connected' && <p className="flex items-center gap-1.5 text-red-400"><AlertTriangle size={12} /> A conexão está desconectada: conecte o número em Conexões.</p>}
      {agent.active && BACKEND && creds.loaded && !creds.chat.length && <p className="flex items-center gap-1.5 text-amber-400"><KeyRound size={12} /> Sem IA conectada em Integrações: ele ainda não responde.</p>}
      {dirty && <p className="text-text-muted">Salve para valer.</p>}
    </div>
  )
}

// Parâmetros de cada habilidade (o que disparar, que etiqueta, para quem transferir...)
function SkillParams({ skill: s, agent, onChange }) {
  const db = useDB()
  const kind = kindOf(s.action)
  if (kind === 'Disparar fluxo') {
    const legacy = /^Disparar fluxo "(.+)"$/.exec(s.action || '')?.[1]
    const value = s.flowId || db.flows.find((f) => f.name === legacy)?.id || ''
    return <Select value={value} onChange={(v) => onChange({ action: 'Disparar fluxo', flowId: v })} placeholder="Escolha o fluxo" options={db.flows.map((f) => ({ value: f.id, label: `${f.name}${f.status !== 'active' ? ' (pausado)' : ''}` }))} />
  }
  if (kind === 'Transferir pra humano') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Select value={s.departmentId || ''} onChange={(v) => onChange({ departmentId: v || null })} placeholder="Fila geral" options={db.departments.map((d) => ({ value: d.id, label: d.name }))} />
        <Select value={s.memberId || ''} onChange={(v) => onChange({ memberId: v || null })} placeholder="Qualquer atendente" options={db.team.map((m) => ({ value: m.id, label: m.name }))} />
      </div>
    )
  }
  if (kind === 'Adicionar etiqueta') return <Select value={s.labelId || ''} onChange={(v) => onChange({ labelId: v })} placeholder="Escolha a etiqueta" options={db.labels.map((l) => ({ value: l.id, label: l.name }))} />
  if (kind === 'Mover no Kanban') {
    const k = db.kanbans.find((x) => x.id === s.kanbanId)
    return (
      <div className="grid grid-cols-2 gap-2">
        <Select value={s.kanbanId || ''} onChange={(v) => onChange({ kanbanId: v, column: '' })} placeholder="Quadro" options={db.kanbans.map((x) => ({ value: x.id, label: x.name }))} />
        <Select value={s.column || ''} onChange={(v) => onChange({ column: v })} placeholder="Primeira etapa" options={(k?.columns || []).map((c) => c.name)} />
      </div>
    )
  }
  if (kind === 'Enviar arquivo') {
    const files = agent.files.filter((f) => f.name)
    return <Select value={s.fileId || ''} onChange={(v) => onChange({ fileId: v })} placeholder={files.length ? 'Escolha o arquivo' : 'Envie arquivos em Coleta de dados'} options={files.map((f) => ({ value: f.id, label: f.name }))} />
  }
  // Agenda do Vórtex Call: a IA consulta os horários livres e agenda ela mesma (sem mandar link)
  if (kind === 'Agendar no Vórtex Call') return (
    <div className="grid gap-1.5">
      <input className="input font-mono text-xs" placeholder="Agenda (ex.: consultoria)" value={s.agenda || ''} onChange={(e) => onChange({ agenda: e.target.value.trim() })} />
      <input className="input font-mono text-xs" placeholder="Endereço do seu Vórtex Call (https://agenda.seu-dominio.com.br)" value={s.callUrl || ''} onChange={(e) => onChange({ callUrl: e.target.value.trim() })} />
    </div>
  )
  if (kind === 'Registrar venda') return <Select value={s.productId || ''} onChange={(v) => onChange({ productId: v || null })} placeholder="Sem produto (valor da conversa)" options={db.products.map((p) => ({ value: p.id, label: p.name }))} />
  return <span />
}

// Teste ao vivo: com o banco, o rascunho responde de verdade pela IA conectada (sem WhatsApp e sem executar ações).
function LiveTest({ agent, onClose }) {
  const companyId = useDB((s) => s.company.id)
  const [msgs, setMsgs] = useState(() => (BACKEND ? [] : [{ from: 'bot', text: (agent.examples || 'Oi! Como posso te ajudar?').split('\n')[0] }]))
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs.length, typing])
  const lines = (agent.examples || '').split('\n').filter(Boolean)
  const reply = (t) => {
    const l = t.toLowerCase()
    if (agent.forbidden && agent.forbidden.toLowerCase().split(/[,;]/).some((w) => w.trim() && l.includes(w.trim()))) return 'Sobre isso eu não consigo falar, mas posso te ajudar com o produto 😉'
    if (/pre[çc]o|quanto|valor|custa/.test(l)) return lines[1] || agent.rules || 'Te passo o valor agora mesmo!'
    if (/pix|pagar|comprar|quero/.test(l)) return lines[2] || 'Perfeito! Vou te mandar o link de pagamento.'
    if (/frete|entrega|prazo/.test(l)) return agent.rules || 'O prazo é de 3 a 7 dias úteis.'
    return lines[Math.floor(Math.random() * Math.max(lines.length, 1))] || 'Entendi! Me conta mais?'
  }
  const send = async () => {
    if (!text.trim() || typing) return
    const t = text.trim()
    const history = [...msgs.filter((m) => m.from !== 'sys'), { from: 'user', text: t }]
    setMsgs((m) => [...m, { from: 'user', text: t }])
    setText('')
    setTyping(true)
    if (!BACKEND) {
      setTimeout(() => {
        setTyping(false)
        let r = reply(t)
        if (agent.settings.sign) r += `\n— ${agent.name}`
        setMsgs((m) => [...m, { from: 'bot', text: r }])
      }, agent.settings.buffer * 150)
      return
    }
    try {
      const r = await api.agentTest(companyId, agent, history)
      setMsgs((m) => [
        ...m,
        ...r.actions.map((x) => ({ from: 'sys', text: `${x.ok ? '⚙️' : '⚠️'} ${x.tool}: ${x.detail}` })),
        ...(r.parts.length ? r.parts.map((p) => ({ from: 'bot', text: p })) : [{ from: 'sys', text: 'Sem resposta em texto nesta vez.' }]),
      ])
    } catch (e) {
      setMsgs((m) => [...m, { from: 'sys', text: `⚠️ ${e.message}` }])
    } finally {
      setTyping(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`Teste ao vivo · ${agent.name}`} subtitle={BACKEND ? 'Responde com a IA conectada e com o que está na tela (mesmo sem salvar). Nada vai para o WhatsApp e as ações só são simuladas.' : 'Simulação local — conecte um modelo de IA no backend para respostas reais.'}>
      <div className="h-80 space-y-2 overflow-y-auto rounded-[16px] border border-border-subtle bg-surface-base p-3">
        {!msgs.length && <p className="pt-24 text-center text-xs text-text-muted">Escreva como se fosse o cliente.</p>}
        {msgs.map((m, i) => (
          m.from === 'sys'
            ? <p key={i} className="text-center text-[11px] text-text-muted">{m.text}</p>
            : (
              <div key={i} className={cx('flex', m.from === 'user' ? 'justify-end' : 'justify-start')}>
                <p className={cx('max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm', m.from === 'user' ? 'bubble-mine' : 'border border-border-subtle bg-surface-overlay')}>{m.text}</p>
              </div>
            )
        ))}
        {typing && <p className="text-xs text-text-muted">{agent.name} está digitando…</p>}
        <div ref={endRef} />
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Escreva como se fosse o cliente…" />
        <button className="btn-primary" onClick={send} disabled={typing}><Send size={15} /></button>
      </div>
    </Modal>
  )
}
