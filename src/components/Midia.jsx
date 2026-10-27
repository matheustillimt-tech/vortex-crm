import { useEffect, useState } from 'react'
import { FileDown } from 'lucide-react'
import { BACKEND, supabase } from '../lib/supabase'
import { cx } from '../lib/utils'

// Mídia de uma mensagem, no Chat ao Vivo e no simulador de vendas: imagem (abre grande no clique), áudio e vídeo com
// player, outros arquivos como link. Vem de dois jeitos:
//  - `path`: arquivo guardado no Vórtex CRM (bucket privado whatsapp-media, ou "agent-files:<caminho>" para arquivo do
//    agente), aberto por um link temporário de 1 hora;
//  - `url`: link público que a IA mandou (aula da aba Tutoriais, vídeo de como o cliente agenda).
export default function Midia({ path, url, type, mine }) {
  const externo = url || (path && /^https?:/.test(path) ? path : null)
  const guardado = BACKEND && !externo && !!path
  const [assinado, setAssinado] = useState(null)
  useEffect(() => {
    if (!guardado) return
    let alive = true
    const [bucket, file] = path.startsWith('agent-files:') ? ['agent-files', path.slice('agent-files:'.length)] : ['whatsapp-media', path]
    supabase.storage.from(bucket).createSignedUrl(file, 3600).then(({ data }) => alive && setAssinado(data?.signedUrl || null))
    return () => { alive = false }
  }, [path, guardado])
  const src = externo || assinado
  if (!src) return null
  if (type === 'image' || type === 'sticker') {
    return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" className="mb-1 max-h-64 rounded-lg" loading="lazy" /></a>
  }
  if (type === 'audio') return <audio controls src={src} className="mb-1 max-w-full" />
  if (type === 'video') return <video controls preload="metadata" src={src} className="mb-1 max-h-72 max-w-full rounded-lg" />
  return (
    <a href={src} target="_blank" rel="noreferrer" className={cx('mb-1 inline-flex items-center gap-1 text-xs font-semibold underline', mine ? 'text-white' : 'text-violet-400')}>
      <FileDown size={13} /> Abrir anexo
    </a>
  )
}
