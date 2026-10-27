import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { buildPlatformSeed, buildSeed } from './seed'
import { uid } from './utils'
import { BACKEND, supabase } from './supabase'
import * as api from './backend'

// Texto da mensagem de mídia sem legenda (o mesmo que o servidor grava)
const MEDIA_LABEL = { image: '📷 Imagem', video: '🎥 Vídeo', audio: '🎤 Áudio' }

// Estado vazio de uma empresa (modo banco real, antes de carregar)
const emptyState = () => ({
  user: { id: null, name: '', email: '' },
  company: { id: null, name: '', description: '', slug: '', timezone: 'America/Sao_Paulo', emailNotifications: true, active: true },
  memberId: null,
  tokens: 0,
  billing: { status: 'trial', plan: 'Trial', recurrence: 'Mensal', nextDue: new Date().toISOString(), starter: { used: 0, total: 0 }, pro: { used: 0, total: 0 } },
  expenses: { fee: 0, fixed: 0 },
  webhookQuota: { used: 0, total: 30000 },
  dispatchQuota: { used: 0, total: 1000 },
  flowFolders: [], integrations: [], connectionFlowConfigs: {}, savedFilters: [], businessHours: [], systemFields: [], aiUsage: [], translations: [],
  messages: {},
  ...Object.fromEntries(Object.keys(api.TABLES).map((k) => [k, []])),
  access: { selected: [], effective: [], packageId: null, customized: false },
  subscription: null,
  isSuperadmin: false,
  // empresas das quais o usuário é membro (seletor do menu) e se ele ainda não tem nenhuma
  companies: [],
  noCompany: false,
  // tabelas que passaram do teto do carregamento (nome → total no banco) e paginação das mensagens por conversa
  truncated: {},
  messagePages: {},
})

// Modo demonstração: a empresa demo tem todos os módulos e o usuário demo vê o painel do superadmin.
// Trocar ou criar empresa na demonstração só muda o nome e o id (os dados de exemplo são os mesmos).
const demoState = () => {
  const seed = buildSeed()
  return {
    ...seed,
    memberId: 'u1',
    ...buildPlatformSeed(seed),
    companies: [
      { id: seed.company.id, name: seed.company.name, plan: 'Pro', role: 'Proprietário', current: true },
      { id: 'demo-empresa-2', name: 'Loja Bella Moda', plan: 'Starter', role: 'Admin', current: false },
    ],
    noCompany: false,
    demoInvites: [{ id: 'demo-convite-1', companyId: 'demo-empresa-3', companyName: 'Clínica Sorriso', role: 'Membro', department: 'Suporte', code: 'DEMO2026CONV', createdAt: new Date().toISOString() }],
  }
}

const demoEnter = (set, get, target) => {
  const companies = get().companies.some((c) => c.id === target.id) ? get().companies : [...get().companies, target]
  set({ companies: companies.map((c) => ({ ...c, current: c.id === target.id })), company: { ...get().company, id: target.id, name: target.name } })
}

const FRIENDLY = [
  [/agents_one_active_per_connection/, 'Já existe outro agente ativo neste número. Pause o outro agente antes de ativar este.'],
  [/rotators_slug_key/, 'Esse endereço de link já está em uso. Escolha outro.'],
]
const fail = (err) => toast(`Não foi possível salvar: ${FRIENDLY.find(([re]) => re.test(err.message))?.[1] || err.message}`, 'error')

const creator = (set, get) => ({
  ...(BACKEND ? emptyState() : demoState()),
  session: null,
  authChecked: !BACKEND,
  ready: !BACKEND,
  loadError: null,

  /* ---------- Autenticação ---------- */
  login: async (email, password) => {
    if (!BACKEND) {
      const u = get().user
      set({ session: { email, at: Date.now() }, user: { ...u, email: email || u.email } })
      return null
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return traduzirErro(error.message)
    startSession(data.session)
    return null
  },
  register: async ({ name, email, phone, company, password }) => {
    if (!BACKEND) {
      set({ session: { email, at: Date.now() }, user: { ...get().user, name, email } })
      if (company) set({ company: { ...get().company, name: company } })
      return { error: null, needsConfirm: false }
    }
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name, phone, company }, emailRedirectTo: location.origin + '/welcome' } })
    if (!error && data.session) startSession(data.session)
    return { error: error ? traduzirErro(error.message) : null, needsConfirm: !error && !data.session }
  },
  resendConfirmation: async (email) => {
    if (!BACKEND) return null
    const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: location.origin + '/welcome' } })
    return error ? traduzirErro(error.message) : null
  },
  resetPassword: async (email) => {
    if (!BACKEND) return null
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/reset-password' })
    return error ? traduzirErro(error.message) : null
  },
  updatePassword: async (password) => {
    if (!BACKEND) return null
    const { error } = await supabase.auth.updateUser({ password })
    return error ? traduzirErro(error.message) : null
  },
  logout: async () => {
    if (BACKEND) await supabase.auth.signOut()
    else set({ session: null })
  },

  /* ---------- CRUD genérico (mesma interface nos dois modos) ---------- */
  setKey: (key, value) => {
    const prev = get()[key]
    const next = typeof value === 'function' ? value(prev) : value
    set({ [key]: next })
    if (!BACKEND || key === 'messages') return
    let p
    if (key === 'company') p = api.saveCompany(next, get())
    else if (key === 'user') p = api.saveProfile(next)
    else if (api.SETTINGS_KEYS.includes(key)) p = api.saveSetting(get())
    p?.catch((e) => { fail(e); set({ [key]: prev }) })
  },
  add: (key, item) => {
    const it = { id: uid(), ...item }
    set({ [key]: [...get()[key], it] })
    if (BACKEND) api.insert(key, it, get().company.id).catch((e) => { fail(e); set({ [key]: get()[key].filter((x) => x.id !== it.id) }) })
    return it
  },
  update: (key, id, patch) => {
    const prev = get()[key].find((x) => x.id === id)
    if (!prev) return
    const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
    set({ [key]: get()[key].map((x) => (x.id === id ? next : x)) })
    if (BACKEND) api.update(key, prev, next, get().company.id).catch((e) => { fail(e); set({ [key]: get()[key].map((x) => (x.id === id ? prev : x)) }) })
  },
  remove: (key, id) => {
    const prev = get()[key]
    set({ [key]: prev.filter((x) => x.id !== id) })
    if (BACKEND) api.remove(key, id).catch((e) => { fail(e); set({ [key]: prev }) })
  },

  // `file` (opcional): foto, vídeo, áudio ou documento; `text` vira a legenda. Até o servidor gravar, o painel mostra o
  // arquivo direto do computador.
  sendMessage: (chatId, text, from = 'agent', file = null) => {
    const kind = file && (/^(image|video|audio)\//.exec(file.type)?.[1] || 'document')
    const msg = {
      id: uid(), from, at: new Date().toISOString(), delivery: BACKEND ? 'sending' : 'sent',
      text: file ? text || MEDIA_LABEL[kind] || `📎 ${file.name}` : text,
      ...(file && { type: kind, mediaLink: URL.createObjectURL(file) }),
    }
    set({
      messages: { ...get().messages, [chatId]: [...(get().messages[chatId] || []), msg] },
      chats: get().chats.map((c) =>
        c.id === chatId
          ? { ...c, lastMessageAt: msg.at, answered: from !== 'contact', unread: from === 'contact' ? c.unread + 1 : 0, status: c.status === 'waiting' && from === 'agent' ? 'attending' : c.status, assignedTo: c.status === 'waiting' && from === 'agent' ? get().memberId : c.assignedTo }
          : c,
      ),
    })
    if (BACKEND) {
      const sent = file
        ? api.uploadChatMedia(chatId, file).then((media) => api.sendMessage(chatId, { id: msg.id, text, media }))
        : api.sendMessage(chatId, msg)
      sent.catch((e) => {
        toast(`${file ? 'Arquivo' : 'Mensagem'} não enviad${file ? 'o' : 'a'}: ${e.message}`, 'error')
        setDelivery(chatId, msg.id, 'failed')
      })
    }
  },

  resetDemo: () => !BACKEND && set({ ...demoState(), session: get().session }),

  /* ---------- Várias empresas ---------- */
  // Estas ações só falam com o banco; depois a tela navega e chama enterCompany() para carregar a empresa nova.
  refreshCompanies: async () => {
    if (!BACKEND) return get().companies
    const companies = await api.listCompanies()
    set({ companies })
    return companies
  },
  switchCompany: async (id) => {
    if (!BACKEND) return demoEnter(set, get, get().companies.find((c) => c.id === id))
    await api.switchCompany(id)
  },
  createCompany: async (f) => {
    if (!BACKEND) return demoEnter(set, get, { id: uid(), name: f.name.trim(), plan: 'Trial', role: 'Proprietário' })
    await api.createCompany(f)
  },
  listInvitations: async () => (BACKEND ? api.listInvitations() : get().demoInvites || []),
  acceptInvitation: async ({ id, code }) => {
    if (BACKEND) return api.acceptInvitation({ id, code })
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const inv = (get().demoInvites || []).find((i) => (id ? i.id === id : norm(i.code) === norm(code)))
    if (!inv) throw new Error('Convite inválido ou já utilizado. Confira o código com quem convidou você.')
    set({ demoInvites: get().demoInvites.filter((i) => i.id !== inv.id) })
    demoEnter(set, get, { id: inv.companyId, name: inv.companyName, plan: 'Starter', role: inv.role })
  },
  // Mensagens de uma conversa: as 100 mais recentes ao abrir e, com older, as 100 anteriores às já carregadas
  loadChatMessages: async (chatId, older = false) => {
    if (!BACKEND) return
    const page = get().messagePages[chatId]
    if (page?.loading || (older && page?.complete)) return
    const current = get().messages[chatId] || []
    const before = older ? current[0]?.at : undefined
    set({ messagePages: { ...get().messagePages, [chatId]: { ...page, loading: true } } })
    try {
      const got = await api.loadChatMessages(chatId, get().company.id, before)
      const byId = new Map((get().messages[chatId] || []).map((m) => [m.id, m]))
      for (const m of got) byId.set(m.id, { ...m, ...byId.get(m.id) })
      const list = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
      set({
        messages: { ...get().messages, [chatId]: list },
        messagePages: { ...get().messagePages, [chatId]: { loading: false, loaded: true, complete: (page?.complete && !older) || got.length < api.CHAT_PAGE } },
      })
    } catch (e) {
      set({ messagePages: { ...get().messagePages, [chatId]: { ...page, loading: false } } })
      toast(`Não foi possível carregar as mensagens: ${e.message}`, 'error')
    }
  },
  // Foto/logo da empresa atual (null remove): aparece no menu, no seletor e na tela de empresas
  setCompanyLogo: async (image) => {
    const { company } = get()
    let url = null
    if (BACKEND) url = await api.setCompanyLogo(company.id, image, company.logoUrl)
    else if (image) url = await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(image.blob) })
    set({
      company: { ...get().company, logoUrl: url },
      companies: get().companies.map((c) => (String(c.id) === String(company.id) ? { ...c, logoUrl: url } : c)),
    })
    return url
  },
  // Recarrega tudo a partir da empresa ativa do perfil (some o que era da empresa anterior)
  enterCompany: () => (BACKEND ? reopen() : null),
})

const setDelivery = (chatId, id, delivery) => {
  const s = useDB.getState()
  useDB.setState({ messages: { ...s.messages, [chatId]: (s.messages[chatId] || []).map((m) => (m.id === id ? { ...m, delivery } : m)) } })
}

export const useDB = create(BACKEND ? creator : persist(creator, { name: 'vortex-crm-db', version: 1 }))

/* ---------- Inicialização do modo banco real ---------- */

let unsubscribe = null
let booting = false

async function bootstrap(session) {
  if (booting) return
  booting = true
  try {
    const data = await api.loadAll(session.user.id)
    // parte do estado vazio: nada da empresa anterior sobra ao trocar de empresa
    useDB.setState({ ...emptyState(), ...data, session, ready: true, loadError: null })
    unsubscribe?.()
    unsubscribe = data.company?.id ? api.subscribe(data.company.id, onRealtime) : null
  } catch (e) {
    useDB.setState({ loadError: e.message, session })
  } finally {
    booting = false
  }
}

// Login aceito: a sessão entra no app na hora e a empresa começa a carregar. Esperar o onAuthStateChange (que roda
// depois, num setTimeout) deixava a tela ir para o painel com a sessão ainda vazia e voltar para o login.
function startSession(session) {
  if (!session) return
  useDB.setState({ session })
  if (!useDB.getState().ready) bootstrap(session)
}

function upsertById(list, item) {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [...list, item]
  const copy = list.slice()
  copy[i] = { ...copy[i], ...item }
  return copy
}

function onRealtime(table, p) {
  const s = useDB.getState()
  const isDelete = p.eventType === 'DELETE'
  if (table === 'messages') {
    if (isDelete) return
    const m = api.msgFromRow(p.new)
    useDB.setState({ messages: { ...s.messages, [p.new.chat_id]: upsertById(s.messages[p.new.chat_id] || [], m) } })
  } else if (table === 'kanban_cards') {
    const kid = isDelete ? null : p.new.kanban_id
    useDB.setState({
      kanbans: s.kanbans.map((k) => {
        const without = isDelete ? k.cards.filter((c) => c.id !== p.old.id) : k.cards
        return !isDelete && k.id === kid ? { ...k, cards: upsertById(without, api.fromRow(p.new)) } : { ...k, cards: without }
      }),
    })
  } else if (table === 'company_access') {
    // o superadmin mudou os módulos: recarrega tudo (o que voltou a ser liberado precisa vir do banco)
    if (!isDelete) useDB.setState({ access: api.accessFromRow(p.new) })
    reloadData()
  } else if (table === 'company_subscriptions') {
    if (isDelete) return
    const subscription = api.fromRow(p.new)
    useDB.setState({ subscription, billing: api.withSubscription(s.billing, subscription) })
  } else {
    const key = { chats: 'chats', contacts: 'contacts', connections: 'connections' }[table]
    if (!key) return
    useDB.setState({ [key]: isDelete ? s[key].filter((x) => x.id !== p.old.id) : upsertById(s[key], api.fromRow(p.new)) })
    // Contato com etiqueta que esta tela ainda não conhece (uma rotina do servidor pode criar etiquetas novas).
    if (table === 'contacts' && !isDelete && (p.new.labels || []).some((id) => !s.labels.some((l) => l.id === id))) reloadLabels()
  }
}

let labelsLoading = null
function reloadLabels() {
  const cid = useDB.getState().company?.id
  if (!cid || labelsLoading) return
  labelsLoading = api.fetchRows('labels', cid)
    .then(({ rows }) => useDB.setState({ labels: rows.map(api.fromRow) }))
    .catch(() => {})
    .finally(() => { labelsLoading = null })
}

export async function initBackend() {
  if (!BACKEND) return
  const { data } = await supabase.auth.getSession()
  useDB.setState({ session: data.session, authChecked: true })
  if (data.session) bootstrap(data.session)
  supabase.auth.onAuthStateChange((event, session) => {
    // não chamar o supabase direto dentro do callback (recomendação da lib) — agenda para depois
    setTimeout(() => {
      if (event === 'SIGNED_IN') startSession(session)
      else if (event === 'SIGNED_OUT') {
        unsubscribe?.()
        unsubscribe = null
        useDB.setState({ ...emptyState(), session: null, ready: false, authChecked: true })
      } else if (session) useDB.setState({ session })
    }, 0)
  })
}

export const reloadData = () => {
  const s = useDB.getState().session
  if (s) bootstrap(s)
}

// Troca de empresa: fecha o tempo real da anterior, mostra o carregamento e abre a empresa ativa do perfil
async function reopen() {
  const s = useDB.getState().session
  if (!s) return
  unsubscribe?.()
  unsubscribe = null
  useDB.setState({ ready: false, loadError: null })
  await bootstrap(s)
}

// Módulos liberados para a empresa atual
export const useModules = () => useDB((s) => s.access?.effective || EMPTY)
export const useHasModule = (key) => useDB((s) => !key || !!s.access?.effective?.includes(key))
const EMPTY = []

function traduzirErro(msg) {
  const map = {
    'Invalid login credentials': 'E-mail ou senha incorretos.',
    'Email not confirmed': 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).',
    'User already registered': 'Já existe uma conta com este e-mail.',
  }
  return map[msg] || msg
}

/* ---------- Toasts e tema ---------- */

export const useToast = create((set, get) => ({
  toasts: [],
  push: (message, type = 'success') => {
    const id = uid()
    set({ toasts: [...get().toasts, { id, message, type }] })
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 3500)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = (m, t) => useToast.getState().push(m, t)

const readLS = (k, fallback, allowed) => {
  try {
    const v = localStorage.getItem(k)
    return allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}
const writeLS = (k, v) => {
  try { localStorage.setItem(k, v) } catch {}
}
// Modo claro/escuro (a identidade visual é uma só)
export const useTheme = create((set, get) => ({
  theme: readLS('theme', 'dark', ['light', 'dark']),
  toggle: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    writeLS('theme', theme)
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme)
    set({ theme })
  },
}))
