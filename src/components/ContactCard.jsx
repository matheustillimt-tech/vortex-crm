import { Columns3, ExternalLink, Mail, MessageCircle, Phone, Tag, Users } from 'lucide-react'
import { useDB } from '../lib/store'
import { fmtDate } from '../lib/utils'
import { Avatar, Modal } from './ui'
import { ChannelIcon, ChannelIcons, contactChannels, igHandle, igProfileUrl } from './Channel'
import { FunilLinhaDoTempo } from './FunilPessoa'

// Card completo do contato: foto, nome, @ com link para o perfil, WhatsApp, e-mail, etiquetas, quadros do Kanban.
// Abre ao clicar no nome (ou na foto) da pessoa no Chat ao vivo e no Kanban.
export default function ContactCard({ contact, onClose }) {
  const db = useDB()
  if (!contact) return null
  const p = contact.instagramProfile || {}
  const igUrl = igProfileUrl(contact.instagramUsername)
  const digits = String(contact.phone || '').replace(/\D/g, '')
  const labels = (contact.labels || []).map((id) => db.labels.find((l) => l.id === id)).filter(Boolean)
  const cards = db.kanbans.flatMap((k) => (k.cards || []).filter((c) => c.contactId === contact.id).map((c) => ({ ...c, board: k.name, col: k.columns.find((x) => x.id === c.columnId)?.name })))
  const segue = p.isFollower === true ? 'Segue você' : p.isFollower === false ? 'Não segue você' : null

  return (
    <Modal open onClose={onClose} title="Contato" size="sm">
      <div className="flex flex-col items-center text-center">
        <Avatar name={contact.name} src={contact.avatarUrl} size={96} />
        <p className="mt-3 text-lg" style={{ fontWeight: 650, letterSpacing: '-0.02em' }}>{contact.name}</p>
        {contact.instagramUsername && (
          <a href={igUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:underline">
            <ChannelIcon channel="instagram" size={15} className="rounded-[4px]" /> {igHandle(contact.instagramUsername)}
          </a>
        )}
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          <ChannelIcons channels={contactChannels(contact)} size={18} />
          {segue && <span className={p.isFollower ? 'badge-success' : 'badge-muted'}>{segue}</span>}
          {p.isVerified && <span className="badge-info">Verificado</span>}
          {Number.isFinite(p.followerCount) && <span className="badge-muted">{p.followerCount.toLocaleString('pt-BR')} seguidores</span>}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {igUrl && (
          <a href={igUrl} target="_blank" rel="noreferrer" className="btn w-full justify-center bg-gradient-to-r from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white hover:opacity-90">
            <ExternalLink size={15} /> Abrir perfil no Instagram
          </a>
        )}
        {digits && (
          <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="btn-secondary w-full justify-center">
            <MessageCircle size={15} /> Abrir no WhatsApp
          </a>
        )}
      </div>

      <div className="mt-5 space-y-2 text-sm">
        {contact.phone && <p className="flex items-center gap-2 text-text-secondary"><Phone size={14} /> {contact.phone}</p>}
        {contact.email && <p className="flex items-center gap-2 truncate text-text-secondary"><Mail size={14} /> {contact.email}</p>}
        <p className="flex items-center gap-2 text-text-secondary"><Users size={14} /> Origem: <b className="text-text-primary">{contact.origin}</b> · desde {fmtDate(contact.createdAt)}</p>
      </div>

      {labels.length > 0 && (
        <>
          <p className="mb-2 mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase text-text-muted"><Tag size={12} /> Etiquetas</p>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => <span key={l.id} className="rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ background: l.color + '30', borderColor: l.color, color: l.color }}>{l.name}</span>)}
          </div>
        </>
      )}
      {cards.length > 0 && (
        <>
          <p className="mb-2 mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase text-text-muted"><Columns3 size={12} /> Kanban</p>
          {cards.map((c) => (
            <div key={c.id} className="mb-2 rounded-lg border border-border bg-surface-raised px-2.5 py-2 text-xs">
              <div className="flex items-center justify-between"><span className="font-semibold text-text-primary">{c.board}</span><span className="text-text-muted">{c.col}</span></div>
              {c.funil && <div className="mt-2.5"><FunilLinhaDoTempo card={c} /></div>}
            </div>
          ))}
        </>
      )}
    </Modal>
  )
}
