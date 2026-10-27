import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// Versão do app que está aberto (commit da Vercel no build; vite.config.js) e a que está no ar (/version.json, gerado
// no mesmo build). Aba aberta antes de uma publicação continua com o código antigo até recarregar: ao detectar versão
// nova, o app recarrega na próxima troca de tela (não no meio de um formulário) ou na hora, se uma tela quebrar.
export const VERSAO = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
const DEV = VERSAO === 'dev'
const CHAVE = 'versao-recarregada'
let novaNoAr = null

export async function versaoNoAr() {
  if (DEV) return null
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return null
    const v = (await r.json())?.version
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** Recarrega uma vez por versão nova (se o navegador ainda entregar a antiga, não entra em laço). */
export function recarregarParaVersao(v) {
  try {
    if (sessionStorage.getItem(CHAVE) === v) return false
    sessionStorage.setItem(CHAVE, v)
  } catch { /* sem sessionStorage: recarrega mesmo assim */ }
  window.location.reload()
  return true
}

async function conferir() {
  const v = await versaoNoAr()
  if (v && v !== VERSAO) novaNoAr = v
}

/** Confere a versão no ar a cada 5 min e quando a aba volta a ficar visível; recarrega na próxima troca de tela. */
export function useAtualizacaoAutomatica() {
  const { pathname } = useLocation()
  useEffect(() => {
    if (DEV) return
    conferir()
    const t = setInterval(conferir, 5 * 60_000)
    const aoVoltar = () => { if (document.visibilityState === 'visible') conferir() }
    document.addEventListener('visibilitychange', aoVoltar)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', aoVoltar)
    }
  }, [])
  useEffect(() => {
    if (novaNoAr) recarregarParaVersao(novaNoAr)
  }, [pathname])
}
