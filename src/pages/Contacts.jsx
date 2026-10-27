import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Plus, Download, Upload, Trash2, MessageCircle, ArrowDownUp, Tag } from 'lucide-react'
import { useDB, useHasModule, toast } from '../lib/store'
import { cx, downloadCsv, fmtDate, hasAnyLabel } from '../lib/utils'
import { Avatar, Confirm, EmptyState, Field, LabelPicker, Modal, PageHeader, SearchInput, Select, Table } from '../components/ui'
import StartFlowButton from '../components/fluxos/StartFlowButton'
import { ChannelIcon, ChannelIcons, contactChannels, igHandle } from '../components/Channel'

const ORIGINS = ['WhatsApp', 'Instagram', 'Anúncio Meta', 'Webhook', 'Importação', 'Manual']

export default function Contacts() {
  const db = useDB()
  const nav = useNavigate()
  const fileRef = useRef()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [origin, setOrigin] = useState('')
  const [labels, setLabels] = useState([])
  const [showLabels, setShowLabels] = useState(false)
  const [sort, setSort] = useState('recent')
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)

  const rows = useMemo(() => {
    const r = db.contacts.filter(
      (c) => (c.name + c.phone + c.email + (c.instagramUsername ? '@' + c.instagramUsername : '')).toLowerCase().includes(q.toLowerCase()) && (!status || c.status === status) && (!origin || c.origin === origin) && hasAnyLabel(c, labels),
    )
    return r.sort((a, b) => (sort === 'recent' ? b.createdAt.localeCompare(a.createdAt) : a.name.localeCompare(b.name)))
  }, [db.contacts, q, status, origin, labels, sort])

  const ativos = db.contacts.filter((c) => c.status === 'ativo').length

  const importCsv = (file) => {
    const reader = new FileReader()
    reader.onload = () => {
      const lines = String(reader.result).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean)
      const sep = lines[0].includes(';') ? ';' : ','
      const head = lines[0].split(sep).map((h) => h.replace(/"/g, '').trim().toLowerCase())
      let n = 0
      lines.slice(1).forEach((l) => {
        const cols = l.split(sep).map((x) => x.replace(/^"|"$/g, '').trim())
        const get = (k) => cols[head.findIndex((h) => h.includes(k))] || ''
        const name = get('nome') || get('name')
        const phone = get('telefone') || get('phone') || get('whats')
        if (!name && !phone) return
        db.add('contacts', { name: name || phone, phone, email: get('mail'), status: 'lead', origin: 'Importação', state: '', labels: [], connectionId: db.connections[0]?.id, createdAt: new Date().toISOString(), fields: {} })
        n++
      })
      toast(`${n} contato(s) importado(s).`)
    }
    reader.readAsText(file)
  }

  const hasChat = useHasModule('chat')
  const openChat = (c) => {
    let chat = db.chats.find((x) => x.contactId === c.id)
    // No Instagram é o cliente quem começa: sem conversa, não dá para abrir uma
    if (!chat && !contactChannels(c).includes('whatsapp')) return toast('No Instagram é o cliente quem começa a conversa. Ela aparece aqui quando ele mandar Direct.', 'info')
    if (!chat) {
      chat = db.add('chats', { contactId: c.id, connectionId: c.connectionId, status: 'attending', unread: 0, answered: true, assignedTo: db.memberId, lastMessageAt: new Date().toISOString(), botActive: false })
      db.setKey('messages', (m) => ({ ...m, [chat.id]: [] }))
    }
    nav(`/chats?chat=${chat.id}`)
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        icon={Users}
        title="Contatos"
        subtitle={db.truncated?.contacts
          ? `Mostrando os ${db.contacts.length.toLocaleString('pt-BR')} contatos mais recentes de ${db.truncated.contacts.toLocaleString('pt-BR')}`
          : `${db.contacts.length} contatos • ${ativos} ativos • ${db.contacts.length - ativos} leads`}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setSort(sort === 'recent' ? 'name' : 'recent')}><ArrowDownUp size={15} /> {sort === 'recent' ? 'Recentes' : 'A-Z'}</button>
            <button className="btn-secondary" onClick={() => downloadCsv('contatos.csv', rows.map((c) => ({ nome: c.name, telefone: c.phone, email: c.email, status: c.status, origem: c.origin, criado: fmtDate(c.createdAt) })))}><Download size={15} /> Exportar CSV</button>
            <button className="btn-secondary" onClick={() => fileRef.current.click()}><Upload size={15} /> Importar CSV</button>
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files[0] && importCsv(e.target.files[0])} />
            <button className="btn-primary" onClick={() => setEdit({})}><Plus size={15} /> Novo Contato</button>
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:flex-wrap">
        <SearchInput className="flex-1 md:min-w-[240px]" value={q} onChange={setQ} placeholder="Buscar contato..." />
        <Select className="md:w-48" value={status} onChange={setStatus} placeholder="Todos os status" options={[{ value: 'ativo', label: 'Ativo' }, { value: 'lead', label: 'Lead' }]} />
        <Select className="md:w-48" value={origin} onChange={setOrigin} placeholder="Todas as origens" options={ORIGINS} />
        <button className={cx('btn-secondary md:w-auto', (showLabels || labels.length > 0) && 'border-accent-primary')} onClick={() => setShowLabels((v) => !v)} aria-expanded={showLabels}>
          <Tag size={15} /> {labels.length ? `${labels.length} etiqueta${labels.length > 1 ? 's' : ''}` : 'Todas as etiquetas'}
        </button>
      </div>
      {showLabels && (
        <div className="card mb-4 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-text-muted">Etiquetas (qualquer uma): {rows.length} contato{rows.length === 1 ? '' : 's'}</span>
            {labels.length > 0 && <button className="btn-ghost text-xs" onClick={() => setLabels([])}>Limpar</button>}
          </div>
          <LabelPicker labels={db.labels} value={labels} onChange={setLabels} />
        </div>
      )}
      {db.contacts.length === 0 ? (
        <EmptyState icon={Users} title="Nenhum contato criado" hint="Crie seu primeiro contato para começar a gerenciar" action={<button className="btn-primary" onClick={() => setEdit({})}>Criar Primeiro Contato</button>} />
      ) : (
        <Table
          rows={rows}
          onRowClick={(c) => setEdit(c)}
          empty="Nenhum contato encontrado com esses filtros."
          columns={[
            { key: 'name', label: 'Contato', render: (c) => <div className="flex items-center gap-3"><Avatar name={c.name} src={c.avatarUrl} size={32} /><div><p className="font-medium text-text-primary">{c.name}</p><p className="text-xs text-text-muted">{c.email || igHandle(c.instagramUsername)}</p></div></div> },
            { key: 'channels', label: 'Canais', render: (c) => <ChannelIcons channels={contactChannels(c)} size={18} /> },
            { key: 'phone', label: 'Telefone / @', render: (c) => <span className="whitespace-nowrap">{c.phone || igHandle(c.instagramUsername) || '—'}</span> },
            { key: 'status', label: 'Status', render: (c) => <span className={c.status === 'ativo' ? 'badge-success' : 'badge-info'}>{c.status === 'ativo' ? 'Ativo' : 'Lead'}</span> },
            { key: 'origin', label: 'Origem', render: (c) => <span className="badge-muted">{c.origin}</span> },
            { key: 'labels', label: 'Etiquetas', render: (c) => <div className="flex flex-wrap gap-1">{c.labels.map((id) => { const l = db.labels.find((x) => x.id === id); return l && <span key={id} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: l.color + '25', color: l.color }}>{l.name}</span> })}</div> },
            { key: 'createdAt', label: 'Criado em', render: (c) => <span className="whitespace-nowrap text-xs">{fmtDate(c.createdAt)}</span> },
            { key: 'a', label: 'Ações', render: (c) => (
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                {hasChat && <button className="btn-ghost p-1.5" title="Abrir chat" onClick={() => openChat(c)}><MessageCircle size={14} /></button>}
                <StartFlowButton where="contact" contactId={c.id} className="btn-ghost" compact />
                <button className="btn-ghost p-1.5 text-red-400" title="Excluir" onClick={() => setDel(c)}><Trash2 size={14} /></button>
              </div>
            ) },
          ]}
        />
      )}
      {edit && <ContactModal contact={edit} onClose={() => setEdit(null)} />}
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir contato" message={`Excluir "${del?.name}"?`} onConfirm={() => { db.remove('contacts', del.id); toast('Contato excluído.') }} />
    </div>
  )
}

function ContactModal({ contact, onClose }) {
  const db = useDB()
  const isNew = !contact.id
  const [f, setF] = useState({ name: '', phone: '', email: '', status: 'lead', origin: 'Manual', state: '', labels: [], connectionId: db.connections[0]?.id, fields: {}, ...contact })
  const b = (k) => ({ value: f[k] || '', onChange: (e) => setF({ ...f, [k]: e.target.value }) })
  const save = () => {
    // contato do Instagram não precisa de telefone (o Direct vai pela conversa)
    if (!f.name || (!f.phone && !f.instagramId)) return toast('Nome e telefone são obrigatórios.', 'error')
    if (isNew) db.add('contacts', { ...f, createdAt: new Date().toISOString() })
    else db.update('contacts', contact.id, f)
    toast(isNew ? 'Contato criado.' : 'Contato atualizado.')
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={isNew ? 'Novo Contato' : 'Editar contato'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Salvar</button></>}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Nome*"><input className="input" {...b('name')} /></Field>
        <Field label={f.instagramId ? 'Telefone (WhatsApp)' : 'Telefone (WhatsApp)*'}><input className="input" placeholder="+55 11 9XXXX-XXXX" {...b('phone')} /></Field>
        {f.instagramUsername && (
          <Field label="Instagram" hint="Vem do Direct. Não dá para editar.">
            <div className="input flex items-center gap-2 opacity-80"><ChannelIcon channel="instagram" size={16} /> {igHandle(f.instagramUsername)}</div>
          </Field>
        )}
        <Field label="E-mail"><input className="input" {...b('email')} /></Field>
        <Field label="Estado (UF)"><input className="input" maxLength={2} {...b('state')} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: 'lead', label: 'Lead' }, { value: 'ativo', label: 'Ativo' }]} /></Field>
        <Field label="Origem"><Select value={f.origin} onChange={(v) => setF({ ...f, origin: v })} options={ORIGINS} /></Field>
        <Field label="Conexão"><Select value={f.connectionId} onChange={(v) => setF({ ...f, connectionId: v })} options={db.connections.map((c) => ({ value: c.id, label: c.name }))} /></Field>
      </div>
      {db.customFields.length > 0 && (
        <>
          <p className="mb-2 mt-1 text-xs font-semibold uppercase text-text-muted">Campos personalizados</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {db.customFields.map((cf) => (
              <Field key={cf.id} label={cf.label}>
                <input className="input" type={cf.type === 'Data' ? 'date' : cf.type === 'Número' ? 'number' : 'text'} value={f.fields?.[cf.key] || ''} onChange={(e) => setF({ ...f, fields: { ...f.fields, [cf.key]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </>
      )}
      <Field label="Etiquetas">
        <div className="flex flex-wrap gap-1.5">
          {/* As automáticas (extra.automatica, gravadas por uma rotina do servidor) aparecem fixas, sem edição aqui. */}
          {db.labels.filter((l) => l.automatica && f.labels.includes(l.id)).map((l) => (
            <span key={l.id} className="rounded-full border px-2.5 py-1 text-xs" style={{ background: l.color + '30', borderColor: l.color, color: l.color }} title="Automática: atualizada sozinha pelo sistema">{l.name}</span>
          ))}
          {db.labels.filter((l) => !l.automatica).map((l) => {
            const on = f.labels.includes(l.id)
            return <button key={l.id} onClick={() => setF({ ...f, labels: on ? f.labels.filter((x) => x !== l.id) : [...f.labels, l.id] })} className="rounded-full border px-2.5 py-1 text-xs" style={on ? { background: l.color + '30', borderColor: l.color, color: l.color } : { borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>{l.name}</button>
          })}
        </div>
      </Field>
    </Modal>
  )
}
