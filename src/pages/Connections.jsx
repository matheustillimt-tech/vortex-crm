import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plug, Plus, Smartphone, Wifi, WifiOff, QrCode, Trash2, UserCog, RefreshCw, Power, ShieldCheck, Webhook, Bot, AlertTriangle, ExternalLink, Shuffle } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import { callFn } from '../lib/backend'
import { demoEmbeddedSignup, startEmbeddedSignup, useMetaSdk } from '../lib/meta'
import { MetaManualSetup, WebSetup, WebhookInfo } from './ConnectionSetup'
import { FacebookButton, MetaIntro, MetaSdkNotice, MetaSetup } from './MetaSignup'
import { InstagramIntro, InstagramKeySetup } from './InstagramSetup'
import { ChannelIcon, channelOf } from '../components/Channel'
import RotatorsModal from '../components/Rotacionador'
import { agentFor, rotatorsWith } from '../lib/rotacionador'
import { cx, fmtDate } from '../lib/utils'
import { Confirm, EmptyState, Field, Modal, PageHeader, SearchInput, Select, Tabs, Toggle } from '../components/ui'

// QR ilustrativo do modo demonstração (sem servidor), como imagem SVG
function fakeQrImage(seed) {
  let s = [...seed].reduce((a, c) => a + c.charCodeAt(0), 7)
  const finder = (x, y) => (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17)
  let rects = ''
  for (let i = 0; i < 25 * 25; i++) {
    const on = ((s = (s * 9301 + 49297) % 233280) / 233280) > 0.5
    const x = i % 25
    const y = Math.floor(i / 25)
    if (on && !finder(x, y)) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`
  }
  for (const [x, y] of [[0, 0], [18, 0], [0, 18]]) {
    rects += `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`
  }
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges" fill="#111">${rects}</svg>`)
}

// Modo demonstração: responde como o servidor (QR ilustrativo que muda a cada 20 s e código fictício)
const demoCall = async (action) => {
  await new Promise((r) => setTimeout(r, 500))
  if (action === 'zapbot-qr') return { connected: false, image: fakeQrImage(String(Math.floor(Date.now() / 20000))), expiresInMs: 20000 }
  if (action === 'zapbot-code') return { connected: false, code: 'K7QW-2MZD' }
  if (action === 'status') return { state: 'close' }
  return { ok: true, connected: false }
}

export default function Connections() {
  const db = useDB()
  const nav = useNavigate()
  const hasAgents = useDB((s) => !!s.access?.effective?.includes('agentes'))
  const hasInstagram = useDB((s) => !!s.access?.effective?.includes('instagram'))
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [modal, setModal] = useState(null)
  const [del, setDel] = useState(null)
  const [form, setForm] = useState({ name: '', provider: 'web', plan: 'starter' })
  // SDK da Meta carregado só quando a API Oficial é escolhida (o botão precisa dele pronto antes do clique)
  const sdk = useMetaSdk(modal === 'new' && form.provider === 'oficial')

  const list = db.connections.filter((c) => (c.name + c.number).toLowerCase().includes(q.toLowerCase()) && (!status || c.status === status))
  const connected = db.connections.filter((c) => c.status === 'connected').length

  const disconnect = async (c) => {
    if (!BACKEND) {
      db.update('connections', c.id, { status: 'disconnected' })
      return toast('Instância desconectada.', 'warning')
    }
    try {
      await callFn('connection-setup', { action: 'disconnect', connectionId: c.id })
      toast('Instância desconectada.', 'warning')
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  // No banco, a exclusão passa pelo servidor: ele também apaga a conexão no provedor (libera a vaga)
  const removeConnection = async (c) => {
    if (BACKEND) {
      try {
        await callFn('connection-setup', { action: 'remove', connectionId: c.id })
      } catch (e) {
        return toast(e.message, 'error')
      }
    }
    db.remove('connections', c.id)
    toast('Conexão excluída.')
  }

  // O servidor já gravou o status; aqui só atualiza a lista na hora (o tempo real confirma em seguida)
  const markConnected = (c, phone) => useDB.setState((s) => ({
    connections: s.connections.map((x) => (x.id === c.id ? { ...x, status: 'connected', number: phone ? `+${phone}` : x.number } : x)),
  }))

  const connectDemo = (c) => {
    const number = c.number || '+55 11 9' + Math.floor(1000 + Math.random() * 8999) + '-' + Math.floor(1000 + Math.random() * 8999)
    db.update('connections', c.id, { status: 'connected', number })
    return number
  }

  const create = () => {
    if (!form.name) return toast('Dê um nome para a conexão.', 'error')
    const c = db.add('connections', { ...form, number: '', status: 'disconnected', createdAt: new Date().toISOString() })
    setModal(form.provider === 'web' ? { qr: c } : { meta: c })
    setForm({ name: '', provider: 'web', plan: 'starter' })
  }

  // API Oficial: abre a janela da Meta no próprio clique (antes de qualquer espera, senão o navegador bloqueia o pop-up)
  // e só depois cria a conexão; a tela de conexão acompanha a janela já aberta.
  const createOfficial = () => {
    if (!form.name.trim()) return toast('Dê um nome para a conexão.', 'error')
    if (sdk.state !== 'ready') return
    const flow = sdk.demo ? demoEmbeddedSignup() : startEmbeddedSignup(sdk.config.configId)
    const c = db.add('connections', { ...form, name: form.name.trim(), number: '', status: 'disconnected', createdAt: new Date().toISOString() })
    setModal({ meta: c, flow })
    setForm({ name: '', provider: 'web', plan: 'starter' })
  }

  // Instagram: cria a conexão e abre a tela da chave da Zernio (o login no Instagram é feito só na Zernio)
  const createInstagram = () => {
    if (!form.name.trim()) return toast('Dê um nome para a conexão.', 'error')
    const c = db.add('connections', { ...form, name: form.name.trim(), provider: 'instagram', number: '', status: 'disconnected', createdAt: new Date().toISOString() })
    setForm({ name: '', provider: 'web', plan: 'starter' })
    setModal({ instagram: c })
  }
  const openConnect = (c) => setModal(c.provider === 'instagram' ? { instagram: c } : c.provider === 'web' ? { qr: c } : { meta: c })

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={Plug} title="Conexões" subtitle={hasInstagram ? 'Seus números de WhatsApp e contas do Instagram' : 'Seus números de WhatsApp conectados'} actions={<>
        <button className="btn-secondary" onClick={() => setModal('rotator')}><Shuffle size={15} /> Rotacionador{db.rotators.length ? ` (${db.rotators.length})` : ''}</button>
        <button className="btn-primary" onClick={() => setModal('new')}><Plus size={15} /> Nova Conexão</button>
      </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:max-w-md">
        <button onClick={() => setStatus(status === 'connected' ? '' : 'connected')} className={cx('card flex items-center gap-3 p-4 text-left', status === 'connected' && 'border-green-500')}>
          <Wifi className="text-green-400" size={20} /><div><p className="text-xs text-text-muted">Conectadas</p><p className="text-xl font-bold">{connected}</p></div>
        </button>
        <button onClick={() => setStatus(status === 'disconnected' ? '' : 'disconnected')} className={cx('card flex items-center gap-3 p-4 text-left', status === 'disconnected' && 'border-red-500')}>
          <WifiOff className="text-red-400" size={20} /><div><p className="text-xs text-text-muted">Desconectadas</p><p className="text-xl font-bold">{db.connections.length - connected}</p></div>
        </button>
      </div>
      <div className="mb-4 flex flex-col gap-2 md:flex-row">
        <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Busca por nome ou número da instância" />
        <Select className="md:w-52" value={status} onChange={setStatus} placeholder="Todos os status" options={[{ value: 'connected', label: 'Conectadas' }, { value: 'disconnected', label: 'Desconectadas' }]} />
      </div>
      {db.connections.length === 0 ? (
        <EmptyState icon={Plug} title="Nenhuma conexão criada" hint="Crie sua primeira conexão para começar" action={<button className="btn-primary" onClick={() => setModal('new')}>Criar Primeira Conexão</button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => (
            <div key={c.id} className="card p-5">
              <div className="mb-4 flex items-start gap-3">
                {c.provider === 'instagram'
                  ? <div className="relative">{c.igPicture ? <img src={c.igPicture} alt="" className="h-11 w-11 rounded-[13px] object-cover" /> : <ChannelIcon channel="instagram" size={44} className="rounded-[13px]" />}<span className={cx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg-card', c.status === 'connected' ? 'bg-green-400' : 'bg-red-400')} /></div>
                  : <div className={cx('flex h-11 w-11 items-center justify-center rounded-[13px]', c.status === 'connected' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400')}><Smartphone size={20} /></div>}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="text-sm text-text-muted">{c.number || (c.provider === 'instagram' ? 'Sem conta vinculada' : 'Sem número vinculado')}</p>
                  {c.provider === 'instagram' && (c.igName || c.keyHint) && <p className="truncate text-xs text-text-muted">{[c.igName, c.keyHint && `Zernio ${c.keyHint}`].filter(Boolean).join(' · ')}</p>}
                  {c.provider === 'oficial' && c.meta?.verifiedName && (
                    <p className="truncate text-xs text-text-muted">{c.meta.verifiedName}{c.meta.wabaName && c.meta.wabaName !== c.meta.verifiedName ? ` · ${c.meta.wabaName}` : ''}</p>
                  )}
                </div>
                <span className={c.status === 'connected' ? 'badge-success' : 'badge-danger'}>{c.status === 'connected' ? 'Conectada' : 'Desconectada'}</span>
              </div>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {c.provider === 'instagram'
                  ? <span className="badge-info inline-flex items-center gap-1"><ChannelIcon channel="instagram" size={13} className="rounded-[4px]" /> Instagram · API oficial</span>
                  : <span className={c.provider === 'oficial' ? 'badge-info' : 'badge-primary'}>{c.provider === 'oficial' ? 'API Oficial (Meta)' : 'API Web (QR Code)'}</span>}
                <span className="badge-muted">Canal {c.plan === 'pro' ? 'Pro' : 'Starter'}</span>
                {rotatorsWith(c.id, db.rotators).map((r) => (
                  <button key={r.id} onClick={() => setModal('rotator')} title={c.status === 'connected' ? 'Na roda deste rotacionador' : 'Fora da roda enquanto estiver desconectada'}
                    className={cx('inline-flex items-center gap-1', r.active && c.status === 'connected' ? 'badge-primary' : 'badge-muted')}><Shuffle size={11} /> {r.name}</button>
                ))}
                {c.provider === 'oficial' && QUALITY[c.meta?.quality] && <span className={QUALITY[c.meta.quality][1]}>Qualidade {QUALITY[c.meta.quality][0]}</span>}
              </div>
              {c.provider === 'instagram' && c.alert && (
                <p className="mb-3 flex gap-2 rounded-xl bg-red-500/10 p-2.5 text-xs text-red-400"><AlertTriangle size={14} className="mt-px shrink-0" />{c.alert}</p>
              )}
              {c.provider === 'oficial' && c.meta?.alert && (
                <p className="mb-3 flex gap-2 rounded-xl bg-red-500/10 p-2.5 text-xs text-red-400"><AlertTriangle size={14} className="mt-px shrink-0" />{c.meta.alert}</p>
              )}
              {c.provider === 'oficial' && c.status === 'connected' && c.meta?.payment === 'pending' && (
                <a href={c.meta.paymentUrl} target="_blank" rel="noreferrer" className="mb-3 flex items-center gap-2 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-400 hover:underline">
                  <AlertTriangle size={14} className="shrink-0" /><span className="flex-1">Falta a forma de pagamento na Meta (ela cobra as mensagens)</span><ExternalLink size={13} />
                </a>
              )}
              {c.provider === 'oficial' && c.status !== 'connected' && ['authorized', 'needs_pin'].includes(c.meta?.status) && (
                <p className="mb-3 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-400">A Meta já autorizou esta conta. Clique em Conectar para concluir.</p>
              )}
              {hasAgents && channelOf(c) === 'whatsapp' && (() => {
                // agente de IA deste número (no máximo um ativo) ou, sem agente ativo, o do rotacionador em que ele está
                const { agent: shown, via } = agentFor(c.id, db.agents, db.rotators)
                const active = shown?.active
                return (
                  <button onClick={() => nav(shown ? '/agentes/' + shown.id : '/agentes')} className="mb-4 flex w-full items-center gap-2 rounded-[12px] border border-border px-3 py-2 text-left text-xs transition hover:border-border-hover">
                    <Bot size={14} className={active ? 'text-violet-300' : 'text-text-muted'} />
                    <span className="min-w-0 flex-1 truncate">{shown ? <>Agente de IA: <b className="text-text-primary">{shown.name}</b>{via === 'rotacionador' && ' · pelo rotacionador'}</> : 'Sem agente de IA'}</span>
                    <span className={active ? 'badge-success' : 'badge-muted'}>{active ? 'Atendendo' : shown ? 'Pausado' : 'Vincular'}</span>
                  </button>
                )
              })()}
              <p className="mb-4 text-xs text-text-muted">Criada em {fmtDate(c.createdAt)}</p>
              <div className="flex flex-wrap gap-2">
                {c.status === 'connected' ? (
                  <button className="btn-secondary flex-1 text-xs" onClick={() => disconnect(c)}><Power size={14} /> Desconectar</button>
                ) : (
                  <button className="btn-primary flex-1 text-xs" onClick={() => openConnect(c)}>{c.provider === 'web' ? <QrCode size={14} /> : c.provider === 'instagram' ? <ChannelIcon channel="instagram" size={14} className="rounded-[4px]" /> : <ShieldCheck size={14} />} Conectar</button>
                )}
                {/* só a conexão manual (token colado) precisa da URL do webhook; a feita pelo Facebook recebe sozinha */}
                {BACKEND && c.provider === 'oficial' && c.status === 'connected' && !c.meta && <button className="btn-secondary text-xs" title="URL do webhook para colar na Meta" onClick={() => setModal({ hook: c })}><Webhook size={14} /></button>}
                {c.provider !== 'instagram' && <button className="btn-secondary text-xs" onClick={() => setModal({ profile: c })}><UserCog size={14} /> Perfil</button>}
                <button className="btn-ghost p-2 text-red-400" onClick={() => setDel(c)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={modal === 'new'} onClose={() => setModal(null)} title="Nova Conexão" subtitle="Cada conexão ocupa um slot do seu plano"
        footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancelar</button>{form.provider === 'web' && <button className="btn-primary" onClick={create}>Criar conexão</button>}</>}>
        <Field label="Nome da conexão"><input className="input" autoFocus placeholder="Ex.: Vendas Principal" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Tipo de API">
          <div className={cx('grid gap-2', hasInstagram ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            {[['web', 'API Web', 'Conecta pelo WhatsApp do celular, com QR Code ou código de pareamento.', QrCode], ['oficial', 'API Oficial (Meta)', 'Oficial da Meta: entre com o Facebook, sem copiar tokens.', ShieldCheck],
              ...(hasInstagram ? [['instagram', 'Instagram (Direct)', 'Direct da sua conta profissional, pela API oficial da Meta.', null]] : [])].map(([id, t, d, I]) => (
              <button key={id} onClick={() => setForm({ ...form, provider: id })} className={cx('rounded-[16px] border p-3 text-left', form.provider === id ? 'choice-on' : 'border-border')}>
                {I ? <I size={18} className="mb-1 text-violet-400" /> : <ChannelIcon channel="instagram" size={18} className="mb-1" />}<p className="text-sm font-semibold">{t}</p><p className="text-xs text-text-muted">{d}</p>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Slot do plano"><Select value={form.plan} onChange={(v) => setForm({ ...form, plan: v })} options={[{ value: 'starter', label: `Canal Starter (${db.billing.starter.used}/${db.billing.starter.total} em uso)` }, { value: 'pro', label: `Canal Pro (${db.billing.pro.used}/${db.billing.pro.total} em uso)` }]} /></Field>
        {form.provider === 'instagram' && (
          <div className="border-t border-border-subtle pt-4">
            <InstagramIntro />
            <button className="btn-primary w-full" onClick={createInstagram} disabled={!form.name.trim()}><ChannelIcon channel="instagram" size={16} className="rounded-[4px]" /> Continuar com a chave da Zernio</button>
            {!form.name.trim() && <p className="mt-2 text-center text-xs text-text-muted">Dê um nome para a conexão para continuar.</p>}
          </div>
        )}
        {form.provider === 'oficial' && (
          <div className="border-t border-border-subtle pt-4">
            <MetaIntro />
            <MetaSdkNotice sdk={sdk} />
            <FacebookButton onClick={createOfficial} disabled={sdk.state !== 'ready' || !form.name.trim()} loading={sdk.state === 'loading'} />
            {!form.name.trim() && <p className="mt-2 text-center text-xs text-text-muted">Dê um nome para a conexão para continuar.</p>}
          </div>
        )}
      </Modal>

      {modal?.qr && (BACKEND
        ? <WebSetup connection={modal.qr} onClose={() => setModal(null)} onConnected={(phone) => markConnected(modal.qr, phone)} />
        : <WebSetup connection={modal.qr} onClose={() => setModal(null)} call={demoCall} onDemoConnect={() => connectDemo(modal.qr)} />)}
      {modal?.meta && <MetaSetup connection={modal.meta} flow={modal.flow} onClose={() => setModal(null)} onManual={() => setModal({ manual: modal.meta })} />}
      {modal?.manual && BACKEND && <MetaManualSetup connection={modal.manual} onClose={() => setModal(null)} />}
      {modal?.hook && <WebhookInfo connection={modal.hook} onClose={() => setModal(null)} />}
      {modal?.profile && <ProfileModal connection={modal.profile} onClose={() => setModal(null)} />}
      {modal?.instagram && <InstagramKeySetup connection={modal.instagram} onClose={() => setModal(null)} />}
      {modal === 'rotator' && <RotatorsModal onClose={() => setModal(null)} onNewConnection={() => setModal('new')} />}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir conexão" message={`Excluir a conexão "${del?.name}"? Os chats dessa instância deixam de receber mensagens.`} onConfirm={() => removeConnection(del)} />
    </div>
  )
}

// quality_rating da Meta → texto e cor do selo
const QUALITY = { GREEN: ['alta', 'badge-success'], YELLOW: ['média', 'badge-warning'], RED: ['baixa', 'badge-danger'] }

function ProfileModal({ connection, onClose }) {
  const db = useDB()
  const [tab, setTab] = useState('conn')
  const [f, setF] = useState({ name: connection.name, profileName: connection.profileName || '', about: connection.about || '', description: connection.description || '', address: connection.address || '', email: connection.email || '', website: connection.website || '', readReceipts: true, lastSeen: 'todos' })
  const isMeta = connection.provider === 'oficial'
  const save = () => { db.update('connections', connection.id, f); toast('Perfil atualizado com sucesso!'); onClose() }
  return (
    <Modal open onClose={onClose} title="Configurações da conexão" size="lg" footer={<><button className="btn-secondary" onClick={() => toast('Perfil sincronizado com o WhatsApp!', 'info')}><RefreshCw size={14} /> Sincronizar</button><button className="btn-primary" onClick={save}>Salvar perfil</button></>}>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'conn', label: 'Conexão' }, { id: 'profile', label: 'Perfil' }, { id: 'business', label: 'Comercial' }, { id: 'privacy', label: 'Privacidade' }]} />
      {tab === 'conn' && <Field label="Nome interno da conexão"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
      {tab === 'profile' && (
        <>
          <Field label="Nome do perfil WhatsApp" hint={isMeta ? 'Não editável na API Oficial. Altere o nome de exibição no WhatsApp Business Manager.' : undefined}>
            <input className="input" disabled={isMeta} placeholder="Ex: Minha Empresa - Atendimento" value={f.profileName} onChange={(e) => setF({ ...f, profileName: e.target.value })} />
          </Field>
          <Field label="Sobre (about)"><input className="input" value={f.about} onChange={(e) => setF({ ...f, about: e.target.value })} /></Field>
        </>
      )}
      {tab === 'business' && (
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Descrição" className="sm:col-span-2"><textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Endereço"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="E-mail"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Site(s)" className="sm:col-span-2"><input className="input" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
        </div>
      )}
      {tab === 'privacy' && (
        <>
          <Toggle checked={f.readReceipts} onChange={(v) => setF({ ...f, readReceipts: v })} label="Confirmação de leitura" description="Mostrar os dois tiques azuis" />
          <Field label="Visto por último"><Select value={f.lastSeen} onChange={(v) => setF({ ...f, lastSeen: v })} options={[{ value: 'todos', label: 'Todos' }, { value: 'contatos', label: 'Meus contatos' }, { value: 'ninguem', label: 'Ninguém' }]} /></Field>
        </>
      )}
    </Modal>
  )
}
