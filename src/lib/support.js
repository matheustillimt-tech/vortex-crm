// Suporte da plataforma: conversa entre quem usa o painel e a equipe Vórtex CRM (botão flutuante "Suporte" + Central de suporte).
// Não é o Chat Ao Vivo (WhatsApp dos clientes): tabelas support_*, funções support_* e canais de tempo real próprios.
// Banco real: as políticas do banco decidem o que chega (usuário: só os próprios atendimentos; superadmin: todos).
// Modo demonstração: mesmos formatos, guardados no navegador.
import { useEffect } from 'react'
import { create } from 'zustand'
import { BACKEND, supabase } from './supabase'
import { useDB, toast } from './store'
import { uid } from './utils'

export const SUPPORT_STATUS = {
  open: { label: 'Aberto', badge: 'badge-warning' },
  in_progress: { label: 'Em atendimento', badge: 'badge-info' },
  resolved: { label: 'Resolvido', badge: 'badge-success' },
}
export const MAX_BODY = 4000

// Aguardando a equipe: a última mensagem é do usuário e o atendimento não foi resolvido
export const isPending = (t) => t.status !== 'resolved' && t.lastSender === 'user'

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camelize = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [camel(k), v]))
const byLast = (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
const byCreated = (a, b) => new Date(a.createdAt) - new Date(b.createdAt)

function upsert(list, item, sort) {
  const i = list.findIndex((x) => x.id === item.id)
  const next = i < 0 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x))
  return sort ? next.sort(sort) : next
}

/* ---------- Estado ---------- */

export const useSupport = create(() => ({
  // janela do botão Suporte: closed | open | minimized; tela: home | new | chat
  ui: 'closed',
  view: 'home',
  activeId: null,
  drafts: {},
  // atendimentos do usuário logado (empresa atual) e, para o superadmin, os de todas as contas
  mine: [],
  all: [],
  loadedMine: false,
  loadedAll: false,
  messages: {},
  msgLoaded: {},
  // conversa aberta na Central de suporte (para marcar como lida quando chega mensagem)
  adminActiveId: null,
}))
const S = () => useSupport.getState()
const setS = (patch) => useSupport.setState(typeof patch === 'function' ? patch(S()) : patch)
const me = () => useDB.getState()

/* ---------- Banco real ---------- */

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}
const rows = ({ data, error }) => {
  if (error) throw new Error(error.message)
  return data.map(camelize)
}

const real = {
  mine: async (userId, companyId) =>
    rows(await supabase.from('support_tickets').select('*').eq('user_id', userId).eq('company_id', companyId).order('last_message_at', { ascending: false }).limit(100)),
  all: async () => rows(await supabase.from('support_tickets').select('*').order('last_message_at', { ascending: false }).limit(500)),
  messages: async (ticketId) => rows(await supabase.from('support_messages').select('*').eq('ticket_id', ticketId).order('created_at').limit(2000)),
  open: async (companyId, body, id) => camelize(await rpc('support_open', { p_company: companyId, p_body: body, p_id: id })),
  send: async (ticketId, body, asAdmin, id) => camelize(await rpc('support_send', { p_ticket: ticketId, p_body: body, p_as_admin: asAdmin, p_id: id })),
  markRead: (ticketId, asAdmin) => rpc('support_mark_read', { p_ticket: ticketId, p_as_admin: asAdmin }),
  setStatus: async (ticketId, status) => camelize(await rpc('support_set_status', { p_ticket: ticketId, p_status: status })),
}

/* ---------- Modo demonstração (mesmas regras das funções do banco) ---------- */

const DEMO_KEY = 'vortex-crm-suporte'
const readDemo = () => {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY)) || { tickets: [], messages: [], seq: 0 }
  } catch {
    return { tickets: [], messages: [], seq: 0 }
  }
}
const writeDemo = (d) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)) } catch {}
}
const preview = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140)
const cleanBody = (body) => {
  const b = (body || '').trim()
  if (!b) throw new Error('Escreva a mensagem antes de enviar')
  if (b.length > MAX_BODY) throw new Error(`Mensagem muito longa (máximo de ${MAX_BODY} caracteres)`)
  return b
}
function demoTicket(d, id, patch) {
  d.tickets = d.tickets.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t))
  return d.tickets.find((t) => t.id === id)
}
const demo = {
  mine: async (userId, companyId) => readDemo().tickets.filter((t) => t.userId === userId && String(t.companyId) === String(companyId)).sort(byLast),
  all: async () => readDemo().tickets.sort(byLast),
  messages: async (ticketId) => readDemo().messages.filter((m) => m.ticketId === ticketId).sort(byCreated),
  async open(companyId, body, id) {
    const b = cleanBody(body)
    const d = readDemo()
    const { user, company } = me()
    if (d.tickets.filter((t) => t.userId === user.id && t.status !== 'resolved').length >= 10) throw new Error('Você já tem 10 atendimentos em andamento. Continue um deles ou aguarde a resolução.')
    const now = new Date().toISOString()
    const t = {
      id: uid(), number: ++d.seq, companyId, userId: user.id, userName: user.name, userEmail: user.email, companyName: company.name,
      subject: preview(b).slice(0, 80), status: 'open', lastMessageAt: now, lastMessagePreview: preview(b), lastSender: 'user',
      userUnread: 0, adminUnread: 1, assignedTo: null, assignedName: '', resolvedAt: null, createdAt: now, updatedAt: now,
    }
    const m = { id: id || uid(), ticketId: t.id, companyId, ticketUserId: user.id, senderId: user.id, senderRole: 'user', senderName: user.name, body: b, createdAt: now }
    d.tickets.push(t)
    d.messages.push(m)
    writeDemo(d)
    setTimeout(() => { onTicket(t); onMessage(m) })
    return t
  },
  async send(ticketId, body, asAdmin, id) {
    const b = cleanBody(body)
    const d = readDemo()
    const t = d.tickets.find((x) => x.id === ticketId)
    if (!t) throw new Error('Atendimento não encontrado')
    const { user } = me()
    if (!asAdmin && t.status === 'resolved') throw new Error('Este atendimento foi resolvido. Inicie um novo atendimento para continuar.')
    const now = new Date().toISOString()
    const m = { id: id || uid(), ticketId, companyId: t.companyId, ticketUserId: t.userId, senderId: user.id, senderRole: asAdmin ? 'admin' : 'user', senderName: user.name, body: b, createdAt: now }
    d.messages.push(m)
    const next = asAdmin
      ? demoTicket(d, ticketId, { status: 'in_progress', resolvedAt: null, assignedTo: t.assignedTo || user.id, assignedName: t.assignedTo ? t.assignedName : user.name, lastMessageAt: now, lastMessagePreview: preview(b), lastSender: 'admin', userUnread: t.userUnread + 1, adminUnread: 0 })
      : demoTicket(d, ticketId, { lastMessageAt: now, lastMessagePreview: preview(b), lastSender: 'user', adminUnread: t.adminUnread + 1, userUnread: 0 })
    writeDemo(d)
    setTimeout(() => { onMessage(m); onTicket(next) })
    return m
  },
  async markRead(ticketId, asAdmin) {
    const d = readDemo()
    const next = demoTicket(d, ticketId, asAdmin ? { adminUnread: 0 } : { userUnread: 0 })
    writeDemo(d)
    if (next) setTimeout(() => onTicket(next))
  },
  async setStatus(ticketId, status) {
    const d = readDemo()
    const t = d.tickets.find((x) => x.id === ticketId)
    if (!t) throw new Error('Atendimento não encontrado')
    if (t.status === status) return t
    const { user } = me()
    const body = status === 'resolved' ? 'Atendimento marcado como resolvido' : t.status === 'resolved' ? 'Atendimento reaberto' : status === 'in_progress' ? 'A equipe Vórtex CRM começou a cuidar deste atendimento' : 'Atendimento voltou para a fila'
    const m = { id: uid(), ticketId, companyId: t.companyId, ticketUserId: t.userId, senderId: user.id, senderRole: 'system', senderName: user.name, body, createdAt: new Date().toISOString() }
    d.messages.push(m)
    const take = status === 'in_progress' && !t.assignedTo
    const next = demoTicket(d, ticketId, { status, resolvedAt: status === 'resolved' ? new Date().toISOString() : null, ...(take && { assignedTo: user.id, assignedName: user.name }) })
    writeDemo(d)
    setTimeout(() => onMessage(m))
    return next
  },
}

const api = BACKEND ? real : demo

/* ---------- Eventos (tempo real no banco; chamadas diretas no modo demonstração) ---------- */

let adminOn = false
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
const viewingAsUser = (id) => S().ui === 'open' && S().view === 'chat' && S().activeId === id && visible()
const viewingAsAdmin = (id) => S().adminActiveId === id && visible()

function onTicket(t, { quiet = false } = {}) {
  const { user, company } = me()
  const prev = S().mine.find((x) => x.id === t.id)
  const prevAll = S().all.find((x) => x.id === t.id)
  const isMine = t.userId === user.id && String(t.companyId) === String(company.id)
  setS((s) => ({
    mine: isMine ? upsert(s.mine, t, byLast) : s.mine,
    all: adminOn ? upsert(s.all, t, byLast) : s.all,
  }))
  if (isMine && t.userUnread > 0) {
    if (viewingAsUser(t.id)) markRead(t.id, false)
    else if (!quiet && prev && t.userUnread > prev.userUnread) toast('Nova resposta da equipe Vórtex CRM no suporte.', 'info')
  }
  if (adminOn && t.adminUnread > 0) {
    if (viewingAsAdmin(t.id)) markRead(t.id, true)
    // aviso só para quem está no painel do superadmin (nas outras telas fica o contador do menu)
    else if (!quiet && location.pathname.startsWith('/superadmin') && t.adminUnread > (prevAll?.adminUnread || 0)) {
      toast(prevAll ? `Nova mensagem de ${t.userName || t.userEmail} (${t.companyName}) no suporte.` : `Novo atendimento #${t.number} de ${t.userName || t.userEmail} (${t.companyName}).`, 'info')
    }
  }
}

function onMessage(m) {
  if (!S().msgLoaded[m.ticketId]) return // a conversa ainda não foi aberta: carrega inteira quando abrir
  setS((s) => ({ messages: { ...s.messages, [m.ticketId]: upsert(s.messages[m.ticketId] || [], { ...m, state: undefined }, byCreated) } }))
  // novos avisos do admin chegam junto com a linha do atendimento (onTicket), que também marca como lida
}

/* ---------- Ações ---------- */

export async function loadMine() {
  const { user, company } = me()
  if (!user.id || company.id == null) return
  try {
    const list = await api.mine(user.id, company.id)
    setS({ mine: list, loadedMine: true })
  } catch (e) {
    setS({ loadedMine: true })
    console.warn('suporte:', e.message)
  }
}

export async function loadAll() {
  try {
    const list = await api.all()
    setS({ all: list, loadedAll: true })
  } catch (e) {
    setS({ loadedAll: true })
    console.warn('suporte (central):', e.message)
  }
}

export async function loadMessages(ticketId) {
  if (!ticketId) return
  try {
    const list = await api.messages(ticketId)
    setS((s) => {
      // mensagens ainda sendo enviadas (ou que falharam) continuam na tela
      const local = (s.messages[ticketId] || []).filter((m) => m.state && !list.some((x) => x.id === m.id))
      return { messages: { ...s.messages, [ticketId]: [...list, ...local].sort(byCreated) }, msgLoaded: { ...s.msgLoaded, [ticketId]: true } }
    })
  } catch (e) {
    toast(`Não foi possível carregar a conversa: ${e.message}`, 'error')
  }
}

export function markRead(ticketId, asAdmin) {
  const list = asAdmin ? S().all : S().mine
  const t = list.find((x) => x.id === ticketId)
  if (!t || (asAdmin ? !t.adminUnread : !t.userUnread)) return
  const patch = asAdmin ? { adminUnread: 0 } : { userUnread: 0 }
  setS((s) => ({
    mine: s.mine.map((x) => (x.id === ticketId ? { ...x, ...patch } : x)),
    all: s.all.map((x) => (x.id === ticketId ? { ...x, ...patch } : x)),
  }))
  api.markRead(ticketId, asAdmin).catch((e) => console.warn('suporte:', e.message))
}

const localMsg = (ticketId, body, role) => {
  const { user } = me()
  return { id: uid(), ticketId, senderId: user.id, senderRole: role, senderName: user.name, body, createdAt: new Date().toISOString(), state: 'sending' }
}
const putLocal = (m) =>
  setS((s) => ({ messages: { ...s.messages, [m.ticketId]: upsert(s.messages[m.ticketId] || [], m, byCreated) } }))
const markFailed = (m) =>
  setS((s) => ({ messages: { ...s.messages, [m.ticketId]: (s.messages[m.ticketId] || []).map((x) => (x.id === m.id ? { ...x, state: 'failed' } : x)) } }))

// Usuário: a primeira mensagem abre o atendimento
export async function openTicket(body) {
  const { company } = me()
  const id = uid()
  const t = await api.open(company.id, body, id)
  const { user } = me()
  const first = { id, ticketId: t.id, senderId: user.id, senderRole: 'user', senderName: t.userName, body: body.trim(), createdAt: t.createdAt }
  setS((s) => ({
    mine: upsert(s.mine, t, byLast),
    all: adminOn ? upsert(s.all, t, byLast) : s.all,
    messages: { ...s.messages, [t.id]: upsert(s.messages[t.id] || [], first, byCreated) },
    msgLoaded: { ...s.msgLoaded, [t.id]: true },
    view: 'chat',
    activeId: t.id,
  }))
  return t
}

// Envia com o id já conhecido: a mensagem aparece na hora e o tempo real só confirma
export async function sendSupport(ticketId, body, { asAdmin = false, retry } = {}) {
  const m = retry ? { ...retry, state: 'sending' } : localMsg(ticketId, body.trim(), asAdmin ? 'admin' : 'user')
  putLocal(m)
  try {
    const saved = await api.send(ticketId, m.body, asAdmin, m.id)
    putLocal({ ...saved, state: undefined })
    return true
  } catch (e) {
    // a tentativa anterior chegou ao banco e só a resposta se perdeu: a mensagem já está salva
    if (retry && /duplicate key/i.test(e.message)) {
      putLocal({ ...m, state: undefined })
      return true
    }
    markFailed(m)
    toast(`Mensagem não enviada: ${e.message}`, 'error')
    if (/resolvido/i.test(e.message)) refresh()
    return false
  }
}

export async function setSupportStatus(ticketId, status) {
  try {
    const t = await api.setStatus(ticketId, status)
    onTicket(t, { quiet: true })
    if (!BACKEND) loadMessages(ticketId)
    toast(`Atendimento marcado como "${SUPPORT_STATUS[status].label}".`)
  } catch (e) {
    toast(`Não foi possível mudar o status: ${e.message}`, 'error')
  }
}

// Janela do botão Suporte
export const openSupport = (ticketId) => {
  setS(ticketId ? { ui: 'open', view: 'chat', activeId: ticketId } : { ui: 'open' })
  if (ticketId) showTicket(ticketId)
  // reabriu (ou restaurou da barrinha) já na conversa: o que chegou enquanto estava fechada conta como lido
  else if (S().view === 'chat' && S().activeId) markRead(S().activeId, false)
}
export const minimizeSupport = () => setS({ ui: 'minimized' })
export const closeSupport = () => setS({ ui: 'closed' })
export const supportHome = () => setS({ view: 'home', activeId: null })
export const newSupport = () => setS({ view: 'new', activeId: null })
export function showTicket(id) {
  setS({ view: 'chat', activeId: id })
  if (!S().msgLoaded[id]) loadMessages(id)
  markRead(id, false)
}
export const setDraft = (key, text) => setS((s) => ({ drafts: { ...s.drafts, [key]: text } }))

// Central do superadmin: qual conversa está aberta
export function setAdminActive(id) {
  setS({ adminActiveId: id || null })
  if (!id) return
  if (!S().msgLoaded[id]) loadMessages(id)
  markRead(id, true)
}

function refresh() {
  loadMine()
  if (adminOn) loadAll()
  const ids = new Set([S().activeId, S().adminActiveId].filter(Boolean))
  ids.forEach((id) => S().msgLoaded[id] && loadMessages(id))
}

/* ---------- Sincronização (montada uma vez no App) ---------- */

const fromRow = (r) => camelize(r)

function channel(name, filters) {
  let poll = null
  const startPoll = () => { if (!poll) poll = setInterval(refresh, 15000) }
  const stopPoll = () => { clearInterval(poll); poll = null }
  const ch = supabase.channel(name)
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'support_tickets', ...(filters.tickets && { filter: filters.tickets }) }, (p) => p.new?.id && onTicket(fromRow(p.new)))
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages', ...(filters.messages && { filter: filters.messages }) }, (p) => onMessage(fromRow(p.new)))
  let first = true
  ch.subscribe((status) => {
    // sem tempo real (rede bloqueando WebSocket, por exemplo): consulta a cada 15 s até voltar
    if (status === 'SUBSCRIBED') {
      stopPoll()
      if (!first) refresh() // voltou depois de cair: busca o que chegou no meio
      first = false
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') startPoll()
  })
  return () => { stopPoll(); supabase.removeChannel(ch) }
}

export function useSupportSync() {
  const ready = useDB((s) => s.ready && (!BACKEND || !!s.session))
  const userId = useDB((s) => s.user.id)
  const companyId = useDB((s) => s.company.id)
  const isSuperadmin = useDB((s) => s.isSuperadmin)

  // usuário: os próprios atendimentos da empresa atual
  useEffect(() => {
    if (!ready || !userId || companyId == null) return
    loadMine()
    const stop = BACKEND ? channel('suporte-usuario-' + userId, { tickets: `user_id=eq.${userId}`, messages: `ticket_user_id=eq.${userId}` }) : null
    return () => {
      stop?.()
      setS({ mine: [], loadedMine: false, ui: 'closed', view: 'home', activeId: null })
    }
  }, [ready, userId, companyId])

  // superadmin: todos os atendimentos (o banco recusa para os demais)
  useEffect(() => {
    if (!ready || !isSuperadmin) return
    adminOn = true
    loadAll()
    const stop = BACKEND ? channel('suporte-equipe-' + userId, {}) : null
    return () => {
      adminOn = false
      stop?.()
      setS({ all: [], loadedAll: false, adminActiveId: null })
    }
  }, [ready, isSuperadmin, userId])

  // ao voltar para a aba: confere se algo mudou enquanto ela estava em segundo plano
  useEffect(() => {
    if (!ready) return
    const h = () => {
      if (!visible()) return
      refresh()
      const { activeId, adminActiveId } = S()
      if (viewingAsUser(activeId)) markRead(activeId, false)
      if (adminActiveId) markRead(adminActiveId, true)
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [ready])
}

/* ---------- Seletores ---------- */

export const useMyTickets = () => {
  const companyId = useDB((s) => s.company.id)
  const mine = useSupport((s) => s.mine)
  return mine.filter((t) => String(t.companyId) === String(companyId))
}
export const useMyUnread = () => useMyTickets().reduce((n, t) => n + (t.userUnread || 0), 0)
// Central: atendimentos que pedem atenção (mensagem nova do usuário ou aguardando resposta)
export const useAdminAttention = () => useSupport((s) => s.all.filter((t) => t.adminUnread > 0 || isPending(t)).length)
