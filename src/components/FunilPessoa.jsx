import { CheckCircle2, Circle, ExternalLink, Mail, MessageCircle, Phone, Users } from 'lucide-react'
import { fmtDate } from '../lib/utils'
import { Avatar } from './ui'
import { ChannelIcon, ChannelIcons, contactChannels, igHandle, igProfileUrl } from './Channel'

// Etapas do funil (mesma ordem e nomes do servidor: supabase/functions/_shared/funil.ts)
export const ETAPAS_FUNIL = [
  ['comentou', 'Comentou e recebeu a DM'], ['clicou', 'Clicou na isca'], ['cadastrou', 'Cadastrou na isca'],
  ['grupo', 'Entrou no grupo'], ['aula', 'Participou da aula'], ['pitch', 'Chegou no pitch'], ['oferta', 'Clicou na oferta'],
  ['recusado', 'Cartão recusado'], ['pix', 'Pix gerado'], ['comprou', 'Comprou'],
]

const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const quando = (iso) => (iso ? fmtDate(iso) : '') // fmtDate já traz a hora

// Uma ou duas linhas sobre a etapa, a partir do que o servidor guardou (card.detalhes)
function descricao(etapa, d = {}) {
  const isca = d.isca ? `isca ${String(d.isca).toUpperCase()}` : ''
  switch (etapa) {
    case 'comentou': return [
      d.comentario && `${d.por === 'Direct' ? 'Mandou' : 'Comentou'} “${d.comentario}”${d.por && d.por !== 'comentário' ? ` (${d.por})` : ''}`,
      [d.automacao && `Automação ${d.automacao}`, d.palavra && !String(d.automacao || '').includes(d.palavra) && `palavra ${d.palavra}`].filter(Boolean).join(' · '),
    ]
    case 'clicou': return [[isca && `Clicou no link da ${isca}`, d.cliques > 1 && `${d.cliques} cliques`].filter(Boolean).join(' · ')]
    case 'cadastrou': return [[isca && `Cadastrou na ${isca}`, d.tema].filter(Boolean).join(' · '), d.utm && `Origem: ${d.utm}`]
    case 'grupo': return [[d.campanha, d.grupo].filter(Boolean).join(' · ')]
    case 'aula': case 'pitch': case 'oferta': return [[d.webinar, d.minutos && `${d.minutos} min assistidos`].filter(Boolean).join(' · ')]
    default: return [[d.produto, d.pedido && `pedido ${d.pedido}`, d.valor && brl(d.valor), d.pagamento && { pix: 'Pix', credit_card: 'cartão', boleto: 'boleto' }[d.pagamento]].filter(Boolean).join(' · ')]
  }
}

// Linha do tempo do card: as etapas que a pessoa já passou (com data e detalhe) e as que faltam
export function FunilLinhaDoTempo({ card }) {
  const datas = card?.funil || {}
  const detalhes = card?.detalhes || {}
  if (!Object.keys(datas).length) return null
  return (
    <ol className="space-y-0">
      {ETAPAS_FUNIL.map(([id, nome], i) => {
        const feito = !!datas[id]
        const linhas = feito ? descricao(id, detalhes[id]).filter(Boolean) : []
        return (
          <li key={id} className="relative flex gap-3 pb-3">
            {i < ETAPAS_FUNIL.length - 1 && <span className="absolute left-[8px] top-5 h-full w-px bg-border" />}
            {feito ? <CheckCircle2 size={17} className="relative z-10 mt-0.5 shrink-0 bg-surface-overlay text-green-400" /> : <Circle size={17} className="relative z-10 mt-0.5 shrink-0 bg-surface-overlay text-text-muted/40" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <p className={feito ? 'text-sm font-semibold text-text-primary' : 'text-sm text-text-muted/60'}>{nome}</p>
                {feito && <span className="text-[11px] text-text-muted">{quando(datas[id])}</span>}
              </div>
              {linhas.map((l, k) => <p key={k} className="break-words text-xs text-text-secondary">{l}</p>)}
              {feito && detalhes[id]?.link && (
                <a href={detalhes[id].link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:underline">Abrir a isca <ExternalLink size={11} /></a>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// Cabeçalho com a pessoa: foto, nome, @ com link para o perfil, WhatsApp, e-mail e origem
export function PessoaResumo({ contact, compacto = false }) {
  if (!contact) return null
  const p = contact.instagramProfile || {}
  const igUrl = igProfileUrl(contact.instagramUsername)
  const digits = String(contact.phone || '').replace(/\D/g, '')
  const segue = p.isFollower === true ? 'Segue você' : p.isFollower === false ? 'Não segue você' : null
  return (
    <div className={compacto ? 'flex items-center gap-3' : 'flex flex-col items-center text-center'}>
      <Avatar name={contact.name} src={contact.avatarUrl} size={compacto ? 56 : 96} />
      <div className={compacto ? 'min-w-0 flex-1' : 'mt-3'}>
        <p className="truncate text-base" style={{ fontWeight: 650, letterSpacing: '-0.02em' }}>{contact.name}</p>
        {contact.instagramUsername && (
          <a href={igUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:underline">
            <ChannelIcon channel="instagram" size={14} className="rounded-[4px]" /> {igHandle(contact.instagramUsername)} <ExternalLink size={11} />
          </a>
        )}
        <div className={`mt-1.5 flex flex-wrap gap-1.5 ${compacto ? '' : 'justify-center'}`}>
          <ChannelIcons channels={contactChannels(contact)} size={16} />
          {segue && <span className={p.isFollower ? 'badge-success' : 'badge-muted'}>{segue}</span>}
          {Number.isFinite(p.followerCount) && <span className="badge-muted">{p.followerCount.toLocaleString('pt-BR')} seguidores</span>}
        </div>
        <div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary ${compacto ? '' : 'justify-center'}`}>
          {contact.phone && <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline"><Phone size={12} /> {contact.phone}</a>}
          {contact.email && <span className="inline-flex items-center gap-1"><Mail size={12} /> {contact.email}</span>}
          <span className="inline-flex items-center gap-1"><Users size={12} /> {contact.origin} · desde {fmtDate(contact.createdAt)}</span>
        </div>
      </div>
      {compacto && digits && (
        <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="btn-ghost p-2" title="Abrir no WhatsApp"><MessageCircle size={16} /></a>
      )}
    </div>
  )
}
