// Tutoriais em vídeo (aba Tutoriais). Banco real: a política da tabela já devolve só os tutoriais dos módulos
// da empresa atual; o filtro daqui repete a regra (superadmin vê tudo pelo banco, mas a aba mostra o da empresa).
// Junto com os do banco vêm os tutoriais prontos do Grupo Vórtex (tutorials-padrao.js), que também aparecem no modo
// demonstração. Para escondê-los: VITE_TUTORIAIS_PADRAO=off.
import { useEffect, useState } from 'react'
import { BACKEND, supabase } from './supabase'
import { useDB, useModules } from './store'
import { juntarTutoriais } from './tutorials-padrao'

const url = (path) => (path ? supabase.storage.from('tutorials').getPublicUrl(path).data.publicUrl : null)

const fromRow = (r) => ({
  id: r.id, slug: r.slug, title: r.title, modules: r.modules || [],
  video: url(r.video_path), cover: url(r.cover_path), duration: r.duration_s, sort: r.sort,
})

export function useTutorials() {
  const companyId = useDB((s) => s.company?.id)
  const modules = useModules()
  const [state, setState] = useState({ loading: BACKEND, list: [], error: null })

  useEffect(() => {
    if (!BACKEND) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    supabase.from('tutorials').select('*').eq('published', true).order('sort').order('created_at')
      .then(({ data, error }) => alive && setState({ loading: false, list: (data || []).map(fromRow), error }))
    return () => { alive = false }
  }, [companyId])

  const list = juntarTutoriais(state.list).filter((t) => t.modules.every((m) => modules.includes(m)))
  return { ...state, list }
}

export const fmtDuration = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '')
