// Chamadas de IA do Vórtex Inteligência. Reaproveita ai.ts (mesmo formato para todos os provedores; a chave da
// plataforma já desconta os Créditos de IA pela carteira, sem débito duplicado aqui) e soma o consumo de cada consulta ou
// execução: tokens, custo estimado em dólar e um registro em intel_usage (inclusive com a chave própria da empresa).
// O orçamento é conferido antes de cada chamada, pela estimativa: a que passaria do limite não começa.
import { chat, pickChatCred, type AiCred, type ChatMsg, type ChatResult, type Creds, type ToolDef } from '../ai.ts'
import { custoUsd, estimarEntrada, precos } from '../carteira.ts'

export class OrcamentoEsgotado extends Error {
  constructor(readonly gastoUsd: number, readonly limiteUsd: number) {
    super('O orçamento desta execução acabou')
  }
}

export type Gastos = { usd: number; entrada: number; saida: number; chamadas: number; ms: number }
type Origem = 'inteligencia' | 'melhoria' | 'validacao'

// Modelo por complexidade: "leve" (análise de cada conversa, em lote) e "forte" (consolidar, propor, avaliar, responder).
// Com a chave da plataforma dá para escolher (INTEL_MODELO e INTEL_MODELO_LEVE nos segredos; sem eles, o Gemini Flash e
// o Flash-Lite). Com a chave da empresa vale o modelo que ela configurou (não dá para supor quais ela tem).
export function credPara(creds: Creds, nivel: 'leve' | 'forte', preferido?: string): AiCred | null {
  const base = pickChatCred(creds, preferido)
  if (!base || base.source !== 'plataforma') return base
  const env = Deno.env.get(nivel === 'leve' ? 'INTEL_MODELO_LEVE' : 'INTEL_MODELO')
  if (env) return { ...base, model: env }
  if (nivel === 'leve' && /gemini-2\.5-flash$/.test(base.model)) return { ...base, model: `${base.model}-lite` }
  return base
}

export function medidorIntel(admin: any, companyId: string, o: { origem: Origem; ref: string; agentId?: string | null; limiteUsd?: number | null; gastoInicialUsd?: number }) {
  const g: Gastos = { usd: o.gastoInicialUsd || 0, entrada: 0, saida: 0, chamadas: 0, ms: 0 }
  const registrar = async (cred: { provider: string; source?: string }, modelo: string, entrada: number, saida: number, usd: number, ms: number, origem: Origem = o.origem) => {
    g.usd += usd; g.entrada += entrada; g.saida += saida; g.chamadas++; g.ms += ms
    const { error } = await admin.from('intel_usage').insert({
      company_id: companyId, origem, ref: o.ref, agent_id: o.agentId ?? null, provider: cred.provider, model: String(modelo || '').slice(0, 80),
      source: cred.source === 'plataforma' ? 'plataforma' : 'empresa', input_tokens: entrada, output_tokens: saida, cost_usd: usd, ms,
    })
    if (error) console.error('intel_usage', error.message)
  }
  return {
    gastos: g,
    restanteUsd: () => (o.limiteUsd == null ? Infinity : o.limiteUsd - g.usd),
    // custo estimado de uma chamada (para conferir o orçamento antes)
    async estimar(cred: AiCred, req: { messages: ChatMsg[]; tools?: ToolDef[] }, saida = 2000) {
      return custoUsd(await precos(admin), cred.model, { entrada: estimarEntrada(req.messages, req.tools), saida }).usd
    },
    async chamar(cred: AiCred, req: { messages: ChatMsg[]; tools?: ToolDef[] }, saidaEstimada = 2000): Promise<ChatResult> {
      if (o.limiteUsd != null) {
        const est = await this.estimar(cred, req, saidaEstimada)
        if (g.usd + est > o.limiteUsd) throw new OrcamentoEsgotado(g.usd, o.limiteUsd)
      }
      const t0 = Date.now()
      const r = await chat(cred, req)
      const usd = r.usage.cost ?? custoUsd(await precos(admin), r.model || cred.model, { entrada: r.usage.input, cache: r.usage.cached, saida: r.usage.output }).usd
      await registrar(cred, r.model || cred.model, r.usage.input, r.usage.output, usd, Date.now() - t0)
      return r
    },
    // consumo de uma chamada feita por outro caminho (a simulação do agente na validação)
    async somar(cred: { provider: string; source?: string }, modelo: string, entrada: number, saida: number, ms: number, origem?: Origem) {
      const usd = custoUsd(await precos(admin), modelo, { entrada, saida }).usd
      await registrar(cred, modelo, entrada, saida, usd, ms, origem)
      return usd
    },
  }
}
export type MedidorIntel = ReturnType<typeof medidorIntel>

// Primeiro objeto (ou lista) JSON do texto do modelo (às vezes vem entre ```json ... ```). null se não houver.
export function lerJson<T = any>(texto: string): T | null {
  const s = String(texto || '').replace(/^﻿/, '')
  const bloco = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const alvo = bloco ? bloco[1] : s
  const ini = alvo.search(/[\[{]/)
  if (ini < 0) return null
  const abre = alvo[ini]
  const fecha = abre === '{' ? '}' : ']'
  let nivel = 0
  let str = false
  let esc = false
  for (let i = ini; i < alvo.length; i++) {
    const ch = alvo[i]
    if (str) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') str = false
      continue
    }
    if (ch === '"') str = true
    else if (ch === abre) nivel++
    else if (ch === fecha && --nivel === 0) {
      try { return JSON.parse(alvo.slice(ini, i + 1)) } catch { return null }
    }
  }
  return null
}
