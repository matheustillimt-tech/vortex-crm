import { ExternalLink, FileText, Phone, Reply } from 'lucide-react'

// Como o template aparece no WhatsApp do cliente: cabeçalho (texto ou mídia), corpo, rodapé e botões.
// `params` preenche {{1}}, {{2}}… do corpo (o que faltar continua aparecendo como {{n}}).
export default function TemplatePreview({ header, body, footer, buttons = [], params = [] }) {
  const text = String(body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[n - 1] || m)
  const fmt = header?.format
  const icon = { QUICK_REPLY: Reply, URL: ExternalLink, PHONE_NUMBER: Phone }
  return (
    <div className="rounded-2xl bg-[#0b141a] p-3">
      <div className="max-w-[280px] overflow-hidden rounded-xl rounded-tl-sm bg-[#1f2c34] text-[13px] text-[#e9edef] shadow">
        {fmt === 'IMAGE' && (header.mediaUrl
          ? <img src={header.mediaUrl} alt="" className="max-h-44 w-full object-cover" />
          : <div className="flex h-28 items-center justify-center bg-black/30 text-[11px] text-white/50">imagem do cabeçalho</div>)}
        {fmt === 'VIDEO' && (header.mediaUrl
          ? <video src={header.mediaUrl} className="max-h-44 w-full bg-black" muted controls />
          : <div className="flex h-28 items-center justify-center bg-black/30 text-[11px] text-white/50">vídeo do cabeçalho</div>)}
        {fmt === 'DOCUMENT' && (
          <div className="m-1.5 flex items-center gap-2 rounded-lg bg-black/25 p-2.5 text-[12px]">
            <FileText size={18} className="text-red-300" />
            <span className="truncate">{header.mediaUrl ? decodeURIComponent(header.mediaUrl.split('/').pop()).replace(/^\d+-/, '') : 'documento.pdf'}</span>
          </div>
        )}
        <div className="px-2.5 pb-1.5 pt-2">
          {fmt === 'TEXT' && header.text && <p className="mb-1 font-semibold">{header.text}</p>}
          <p className="whitespace-pre-wrap break-words">{text || <span className="text-white/40">Texto do template</span>}</p>
          {footer && <p className="mt-1 text-[11px] text-white/45">{footer}</p>}
        </div>
        {buttons.map((b, i) => {
          const Icon = icon[b.type] || Reply
          return (
            <div key={i} className="flex items-center justify-center gap-1.5 border-t border-white/10 py-2 text-[13px] text-[#53bdeb]">
              <Icon size={14} /> {b.text || 'Botão'}
            </div>
          )
        })}
      </div>
    </div>
  )
}
