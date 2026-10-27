// "Entrar com o Facebook": WhatsApp Embedded Signup (v4) com o SDK JavaScript da Meta.
// O App ID e o Configuration ID vêm do servidor (connection-setup → meta-config), que guarda o App Secret.
// O navegador só abre a janela da Meta e repassa ao servidor o código de autorização (vale 30 s) e os IDs escolhidos.
import { useEffect, useState } from 'react'
import { BACKEND } from './supabase'
import { callFn } from './backend'

let configPromise = null
export function metaConfig() {
  if (!configPromise) configPromise = callFn('connection-setup', { action: 'meta-config' }).catch((e) => { configPromise = null; throw e })
  return configPromise
}

let sdkPromise = null
export function loadFacebookSdk(appId, version) {
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    const fail = (msg) => { sdkPromise = null; reject(new Error(msg)) }
    const init = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version })
      resolve(window.FB)
    }
    if (window.FB) return init()
    const timer = setTimeout(() => fail('O login da Meta demorou para carregar. Confira a internet ou se algum bloqueador está ativo e tente de novo.'), 20_000)
    window.fbAsyncInit = () => { clearTimeout(timer); init() }
    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/pt_BR/sdk.js'
    s.async = true
    s.defer = true
    s.crossOrigin = 'anonymous'
    s.onerror = () => { clearTimeout(timer); s.remove(); fail('Não foi possível carregar o login da Meta. Se algum bloqueador de anúncios estiver ativo, libere este site e tente de novo.') }
    document.body.appendChild(s)
  })
  return sdkPromise
}

// Estado do botão: loading | ready | off (a plataforma ainda não configurou o app da Meta) | error (com retry)
export function useMetaSdk(enabled = true) {
  const [s, setS] = useState(() => (BACKEND ? { state: 'loading' } : { state: 'ready', demo: true, config: { configId: 'demo' } }))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled || !BACKEND) return
    let alive = true
    setS({ state: 'loading' })
    ;(async () => {
      try {
        const config = await metaConfig()
        if (!config.ready) return alive && setS({ state: 'off', missing: config.missing || [] })
        await loadFacebookSdk(config.appId, config.graphVersion)
        if (alive) setS({ state: 'ready', config })
      } catch (e) {
        if (alive) setS({ state: 'error', error: e.message })
      }
    })()
    return () => { alive = false }
  }, [enabled, attempt])
  return { ...s, retry: () => setAttempt((n) => n + 1) }
}

const isFacebookOrigin = (origin) => {
  try {
    const u = new URL(origin)
    return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com'))
  } catch {
    return false
  }
}

const FLOW_EVENTS = /^(FINISH|CANCEL|ERROR)/

// Abre a janela do Embedded Signup. Chame direto no clique: o navegador bloqueia janelas abertas depois de um await.
// `login` resolve com a resposta do FB.login (o código vem em authResponse.code);
// `finished` resolve com o evento WA_EMBEDDED_SIGNUP (FINISH*, CANCEL ou ERROR, com os IDs escolhidos).
export function startEmbeddedSignup(configId) {
  let settle
  const finished = new Promise((r) => { settle = r })
  const onMessage = (event) => {
    if (!isFacebookOrigin(event.origin)) return
    let data = event.data
    if (typeof data === 'string') {
      try { data = JSON.parse(data) } catch { return }
    }
    if (data?.type === 'WA_EMBEDDED_SIGNUP' && FLOW_EVENTS.test(String(data.event || ''))) settle(data)
  }
  window.addEventListener('message', onMessage)
  const login = new Promise((resolve) => {
    window.FB.login((response) => resolve(response), {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    })
  })
  return { login, finished, cleanup: () => window.removeEventListener('message', onMessage), taken: false }
}

// Modo demonstração (sem servidor): simula a janela da Meta concluída
export function demoEmbeddedSignup() {
  const data = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '100000000000001', phone_number_id: '200000000000002', business_id: '300000000000003' } }
  const wait = new Promise((r) => setTimeout(r, 1800))
  return { login: wait.then(() => ({ authResponse: { code: 'demo' } })), finished: wait.then(() => data), cleanup: () => {}, taken: false }
}
