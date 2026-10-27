import { useState } from 'react'
import { PlayCircle, Clock } from 'lucide-react'
import { useTutorials, fmtDuration } from '../lib/tutorials'
import { EmptyState, PageHeader } from '../components/ui'

// Aba Tutoriais: um vídeo curto por tarefa, só das ferramentas liberadas no plano da empresa.
export default function Tutorials() {
  const { loading, list } = useTutorials()
  const [open, setOpen] = useState(null)

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader icon={PlayCircle} title="Tutoriais" subtitle="Vídeos curtos que ensinam a usar as ferramentas do seu plano" />
      {loading ? (
        <p className="text-sm text-text-muted">Carregando tutoriais…</p>
      ) : !list.length ? (
        <EmptyState icon={PlayCircle} title="Nenhum tutorial por aqui ainda" hint="Os vídeos das ferramentas do seu plano aparecem nesta tela assim que forem publicados." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((t) => (
            <button key={t.id} onClick={() => setOpen(t)} className="card group overflow-hidden p-0 text-left transition hover:-translate-y-0.5">
              <div className="relative aspect-video w-full overflow-hidden bg-surface-interactive">
                {t.cover && <img src={t.cover} alt="" loading="lazy" className="h-full w-full object-cover" />}
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
                  <PlayCircle size={44} strokeWidth={1.5} className="text-white opacity-0 drop-shadow transition group-hover:opacity-100" />
                </span>
              </div>
              <div className="px-4 py-3">
                <p className="text-sm text-text-primary" style={{ fontWeight: 650 }}>{t.title}</p>
                {t.duration && <p className="mt-1 flex items-center gap-1 text-xs text-text-muted"><Clock size={12} /> {fmtDuration(t.duration)}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 backdrop-blur-sm" style={{ background: 'var(--scrim)' }} onMouseDown={() => setOpen(null)} role="dialog" aria-modal="true" aria-label={open.title}>
          <div className="flex w-full max-w-[420px] flex-col items-center gap-3" onMouseDown={(e) => e.stopPropagation()}>
            <video key={open.id} src={open.video} poster={open.cover || undefined} controls autoPlay playsInline className="max-h-[80vh] w-auto max-w-full rounded-[20px] bg-black" style={{ aspectRatio: '9 / 16' }} />
            <div className="flex w-full items-center justify-between gap-3">
              <p className="text-sm text-white" style={{ fontWeight: 650 }}>{open.title}</p>
              <button className="btn-secondary" onClick={() => setOpen(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
