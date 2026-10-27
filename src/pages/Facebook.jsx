import { useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Facebook as FbIcon, Plus, Crosshair, UserCircle2, BarChart3, Trash2, Pencil } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { brl, cx } from '../lib/utils'
import { Confirm, EmptyState, Field, Modal, PageHeader, Select, Table, Toggle } from '../components/ui'

const TABS = [
  { id: 'campaigns', label: 'Gerenciador', icon: BarChart3 },
  { id: 'pixel', label: 'Pixel', icon: Crosshair },
  { id: 'profiles', label: 'Perfis e contas', icon: UserCircle2 },
]

export default function Facebook() {
  const { tab = 'campaigns' } = useParams()
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={FbIcon} title="Facebook" subtitle="Meta Ads, pixel e perfis conectados" />
      <div className="no-scrollbar mb-5 flex max-w-xl gap-1 overflow-x-auto rounded-[16px] border border-border p-1" style={{ background: 'var(--material-control)', boxShadow: 'var(--shadow-inset)' }}>
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/facebook/${t.id}`} style={{ fontWeight: 650 }} className={({ isActive }) => cx('flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-[12px] px-4 py-2 text-[13px] transition', isActive ? 'is-selected' : 'text-text-secondary hover:text-text-primary')}>
            <t.icon size={15} /> {t.label}
          </NavLink>
        ))}
      </div>
      {tab === 'campaigns' && <Campaigns />}
      {tab === 'pixel' && <Pixels />}
      {tab === 'profiles' && <Profiles />}
    </div>
  )
}

function Campaigns() {
  const db = useDB()
  const accounts = db.metaProfiles.flatMap((p) => p.accounts.filter((a) => a.enabled))
  if (!accounts.length)
    return (
      <EmptyState icon={FbIcon} title="Faça login na Meta e autorize o acesso para ver os dados aqui." hint="Depois do login, você escolhe em Facebook → Perfis e contas quais contas entram no painel. Nada é ativado automaticamente."
        action={<NavLink to="/facebook/profiles" className="btn-primary">Perfis e contas</NavLink>} />
    )
  const camps = accounts.flatMap((a, i) => [
    { id: a.id + '1', account: a.name, name: 'Conversão | Kit | Aberto', status: 'Ativa', spend: 842.5 + i * 100, results: 61, revenue: 3940 },
    { id: a.id + '2', account: a.name, name: 'Remarketing 7d', status: 'Ativa', spend: 213.9, results: 22, revenue: 1580 },
    { id: a.id + '3', account: a.name, name: 'Teste criativo vídeo', status: 'Pausada', spend: 96.0, results: 4, revenue: 197 },
  ])
  const total = camps.reduce((a, c) => ({ spend: a.spend + c.spend, results: a.results + c.results, revenue: a.revenue + c.revenue }), { spend: 0, results: 0, revenue: 0 })
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Gasto', brl(total.spend)], ['Resultados', total.results], ['Custo por resultado', brl(total.spend / total.results)], ['ROAS', (total.revenue / total.spend).toFixed(2)]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs text-text-muted">{l}</p><p className="mt-1 text-xl font-bold">{v}</p></div>
        ))}
      </div>
      <Table rows={camps} columns={[
        { key: 'name', label: 'Campanha', render: (c) => <span className="font-medium text-text-primary">{c.name}</span> },
        { key: 'account', label: 'Conta' },
        { key: 'status', label: 'Status', render: (c) => <span className={c.status === 'Ativa' ? 'badge-success' : 'badge-warning'}>{c.status}</span> },
        { key: 'spend', label: 'Gasto', render: (c) => brl(c.spend) },
        { key: 'results', label: 'Resultados' },
        { key: 'cpa', label: 'CPA', render: (c) => brl(c.spend / c.results) },
        { key: 'roas', label: 'ROAS', render: (c) => <b className={c.revenue / c.spend >= 2 ? 'text-green-400' : 'text-amber-400'}>{(c.revenue / c.spend).toFixed(2)}</b> },
      ]} />
      <p className="mt-2 text-xs text-text-muted">Dados de exemplo — com backend, vêm da Marketing API da Meta.</p>
    </>
  )
}

function Pixels() {
  const db = useDB()
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><p className="font-semibold">Pixels</p><p className="text-sm text-text-muted">Configure seus pixels para rastrear eventos e conversões em diferentes plataformas de anúncios.</p></div>
        <button className="btn-primary shrink-0" onClick={() => setEdit({})}><Plus size={15} /> Novo Pixel</button>
      </div>
      {db.pixels.length === 0 ? (
        <EmptyState icon={Crosshair} title="Nenhum pixel encontrado" hint="Crie sua primeira configuração de pixel para começar" action={<button className="btn-primary" onClick={() => setEdit({})}>Criar Pixel</button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {db.pixels.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div><p className="font-semibold">{p.name}</p><p className="font-mono text-xs text-text-muted">{p.platform} · {p.pixelId}</p></div>
                <div className="flex"><button className="btn-ghost p-1.5" onClick={() => setEdit(p)}><Pencil size={14} /></button><button className="btn-ghost p-1.5 text-red-400" onClick={() => setDel(p)}><Trash2 size={14} /></button></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">{p.events.map((e) => <span key={e} className="badge-primary">{e}</span>)}</div>
            </div>
          ))}
        </div>
      )}
      {edit && <PixelModal pixel={edit} onClose={() => setEdit(null)} />}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir pixel" message={`Excluir "${del?.name}"?`} onConfirm={() => db.remove('pixels', del.id)} />
    </>
  )
}

const EVENTS = ['Lead', 'Purchase', 'InitiateCheckout', 'AddToCart', 'Contact', 'CompleteRegistration']

function PixelModal({ pixel, onClose }) {
  const db = useDB()
  const [f, setF] = useState({ name: '', platform: 'Meta', pixelId: '', token: '', events: ['Lead', 'Purchase'], ...pixel })
  const save = () => {
    if (!f.name || !f.pixelId) return toast('Nome e ID do pixel são obrigatórios.', 'error')
    pixel.id ? db.update('pixels', pixel.id, f) : db.add('pixels', f)
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={pixel.id ? 'Editar Pixel' : 'Novo Pixel'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Salvar</button></>}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Plataforma"><Select value={f.platform} onChange={(v) => setF({ ...f, platform: v })} options={['Meta', 'Google Ads', 'TikTok']} /></Field>
        <Field label="ID do pixel"><input className="input font-mono" value={f.pixelId} onChange={(e) => setF({ ...f, pixelId: e.target.value })} /></Field>
        <Field label="Token da API de Conversões"><input className="input font-mono" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
      </div>
      <Field label="Eventos">
        <div className="flex flex-wrap gap-1.5">{EVENTS.map((e) => { const on = f.events.includes(e); return <button key={e} onClick={() => setF({ ...f, events: on ? f.events.filter((x) => x !== e) : [...f.events, e] })} className={cx('rounded-full border px-2.5 py-1 text-xs', on ? 'chip-on' : 'border-border text-text-muted')}>{e}</button> })}</div>
      </Field>
    </Modal>
  )
}

function Profiles() {
  const db = useDB()
  const connect = () => {
    db.add('metaProfiles', { name: 'Perfil Meta ' + (db.metaProfiles.length + 1), accounts: [{ id: 'act_' + Math.floor(Math.random() * 1e9), name: 'Conta de anúncios principal', enabled: false }, { id: 'act_' + Math.floor(Math.random() * 1e9), name: 'Conta de anúncios 2', enabled: false }] })
    toast('Perfil conectado (simulado). Escolha as contas que entram no painel.')
  }
  const toggle = (p, accId, v) => db.update('metaProfiles', p.id, { accounts: p.accounts.map((a) => (a.id === accId ? { ...a, enabled: v } : a)) })
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-semibold">Meta (Facebook/Instagram)</p>
        <button className="btn-primary shrink-0" onClick={connect}><Plus size={15} /> Conectar novo perfil</button>
      </div>
      {db.metaProfiles.length === 0 ? (
        <EmptyState icon={UserCircle2} title="Nenhum perfil Meta conectado" hint="Faça login com sua conta Meta para listar suas contas de anúncios." action={<button className="btn-primary" onClick={connect}>Conectar novo perfil</button>} />
      ) : (
        db.metaProfiles.map((p) => (
          <div key={p.id} className="card mb-3 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-2 font-semibold"><FbIcon size={16} className="text-blue-400" /> {p.name}</p>
              <button className="btn-ghost p-1.5 text-red-400" onClick={() => db.remove('metaProfiles', p.id)}><Trash2 size={14} /></button>
            </div>
            {p.accounts.map((a) => (
              <div key={a.id} className="border-t border-border">
                <Toggle checked={a.enabled} onChange={(v) => toggle(p, a.id, v)} label={a.name} description={a.id} />
              </div>
            ))}
          </div>
        ))
      )}
    </>
  )
}
