// Rotacionador (Conexões → Rotacionador): um link público que reveza quem clica entre os números conectados.
// A roda de verdade gira no servidor (função rotacionador + rotator_hit no banco); aqui fica o que a tela mostra,
// com as mesmas regras de supabase/functions/_shared/rotacionador.ts.
import { channelOf } from '../components/Channel'

// Endereço público dos links: VITE_SITE_URL (o domínio do painel) ou, sem ela, o endereço onde o painel está aberto
export const ROTATOR_SITE = String(import.meta.env.VITE_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '')
export const rotatorUrl = (slug) => `${ROTATOR_SITE}/r/${slug}`
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/
export const DEFAULT_MESSAGE = 'Olá! Vim pela área de membros e preciso de ajuda.'

// Endereço enquanto a pessoa digita: minúsculo, sem acento, espaço vira hífen (o hífen do fim fica até o próximo caractere)
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-/, '').slice(0, 60)

const digits = (s) => String(s || '').replace(/\D/g, '')
// Pode entrar na roda: número de WhatsApp (Instagram não tem wa.me)
export const canRotate = (c) => channelOf(c) === 'whatsapp'
// Está na roda agora: conectado e com número de verdade
export const isLive = (c) => c?.status === 'connected' && canRotate(c) && digits(c.number).length >= 10

export const rotatorNumbers = (rot, connections) => (rot.connectionIds || []).map((id) => connections.find((c) => c.id === id)).filter(Boolean)
export const liveNumbers = (rot, connections) => rotatorNumbers(rot, connections).filter(isLive)

// Quem recebe o próximo clique (a cada clique) ou os cliques desta hora, com o que o painel sabe da roda
export function nextNumber(rot, connections) {
  const live = liveNumbers(rot, connections)
  if (!live.length) return null
  const k = rot.mode === 'hora' ? Math.floor(Date.now() / 3600e3) : Number(rot.turn) || 0
  return live[k % live.length]
}

export const rotatorsWith = (connectionId, rotators) => rotators.filter((r) => (r.connectionIds || []).includes(connectionId))

// Quem atende as conversas deste número (a mesma regra de resolveAgent no servidor): o agente ativo dele ou, sem
// agente ativo, o agente do primeiro rotacionador ativo que tem o número.
export function agentFor(connectionId, agents, rotators) {
  const own = agents.filter((a) => a.connectionId === connectionId)
  const active = own.find((a) => a.active)
  if (active) return { agent: active, via: 'numero' }
  const rot = rotatorsWith(connectionId, rotators).filter((r) => r.active && r.agentId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0]
  const viaRot = rot && agents.find((a) => a.id === rot.agentId)
  if (viaRot) return { agent: viaRot, via: 'rotacionador', rotator: rot }
  return { agent: own[0] || null, via: own[0] ? 'numero' : null }
}
