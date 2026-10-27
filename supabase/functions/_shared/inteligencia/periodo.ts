// Períodos do Vórtex Inteligência no fuso da empresa. A IA escolhe uma palavra ("semana_passada", "este_mes"...) ou datas;
// as datas exatas saem daqui (determinístico e testado), nunca do modelo. Intervalo sempre [de, ate): "ate" exclusivo.

export const PERIODOS = ['hoje', 'ontem', 'esta_semana', 'semana_passada', 'ultimos_7_dias', 'ultimos_30_dias', 'ultimos_90_dias',
  'este_mes', 'mes_passado', 'este_ano', 'personalizado'] as const
export type ChavePeriodo = (typeof PERIODOS)[number]
export const COMPARACOES = ['nenhum', 'periodo_anterior', 'mes_anterior', 'ano_anterior'] as const
export type Comparacao = (typeof COMPARACOES)[number]
export type Gran = 'dia' | 'semana' | 'mes'

export type Periodo = { chave: string; de: string; ate: string; rotulo: string; fuso: string; gran: Gran }

type Partes = { y: number; m: number; d: number }

// Diferença (min) entre o horário local do fuso e o UTC naquele instante
function deslocamento(t: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return (local - Math.floor(t / 1000) * 1000) / 60000
}

// Meia-noite local de um dia, como instante (ms)
export function meiaNoite({ y, m, d }: Partes, tz: string) {
  const guess = Date.UTC(y, m - 1, d)
  let t = guess - deslocamento(guess, tz) * 60000
  t = guess - deslocamento(t, tz) * 60000
  return t
}

export function hojeLocal(agora: Date, tz: string): Partes {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day }
}

// soma dias/meses no calendário (sem fuso: é aritmética de data)
const somaDias = (p: Partes, n: number): Partes => { const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() } }
const fimDoMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const somaMeses = (p: Partes, n: number): Partes => { const t = new Date(Date.UTC(p.y, p.m - 1 + n, 1)); const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1; return { y, m, d: Math.min(p.d, fimDoMes(y, m)) } }
const diaDaSemana = (p: Partes) => (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7 // segunda = 0

export function lerData(s: unknown): Partes | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim()) || null
  if (m) return { y: +m[1], m: +m[2], d: +m[3] }
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim())
  return br ? { y: +br[3], m: +br[2], d: +br[1] } : null
}

const fmt = (p: Partes) => `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}`
const fmtAno = (p: Partes) => `${fmt(p)}/${p.y}`
const iso = (t: number) => new Date(t).toISOString()

export function granularidade(dias: number): Gran {
  return dias <= 62 ? 'dia' : dias <= 200 ? 'semana' : 'mes'
}

// Dias do calendário [ini, fim] (inclusive) → período
function montar(chave: string, ini: Partes, fimIncl: Partes, tz: string, nome: string, ateAgora?: number): Periodo {
  const de = meiaNoite(ini, tz)
  const fimExcl = meiaNoite(somaDias(fimIncl, 1), tz)
  const ate = ateAgora ? Math.min(ateAgora, fimExcl) : fimExcl
  const dias = Math.round((fimExcl - de) / 86400000)
  const datas = ini.y === fimIncl.y && ini.m === fimIncl.m && ini.d === fimIncl.d ? fmtAno(ini) : `${fmt(ini)} a ${fmtAno(fimIncl)}`
  return { chave, de: iso(de), ate: iso(ate), rotulo: `${nome} (${datas})`, fuso: tz, gran: granularidade(dias) }
}

export function resolverPeriodo(arg: { periodo?: string; de?: string; ate?: string }, tz: string, agora = new Date()): Periodo {
  const hoje = hojeLocal(agora, tz)
  const now = agora.getTime()
  const chave = String(arg.periodo || 'ultimos_7_dias')
  switch (chave) {
    case 'hoje': return montar(chave, hoje, hoje, tz, 'Hoje', now)
    case 'ontem': { const o = somaDias(hoje, -1); return montar(chave, o, o, tz, 'Ontem') }
    case 'esta_semana': return montar(chave, somaDias(hoje, -diaDaSemana(hoje)), hoje, tz, 'Esta semana', now)
    case 'semana_passada': { const seg = somaDias(hoje, -diaDaSemana(hoje) - 7); return montar(chave, seg, somaDias(seg, 6), tz, 'Semana passada') }
    case 'ultimos_30_dias': return montar(chave, somaDias(hoje, -29), hoje, tz, 'Últimos 30 dias', now)
    case 'ultimos_90_dias': return montar(chave, somaDias(hoje, -89), hoje, tz, 'Últimos 90 dias', now)
    case 'este_mes': return montar(chave, { ...hoje, d: 1 }, hoje, tz, 'Este mês', now)
    case 'mes_passado': { const p = somaMeses({ ...hoje, d: 1 }, -1); return montar(chave, p, { ...p, d: fimDoMes(p.y, p.m) }, tz, 'Mês passado') }
    case 'este_ano': return montar(chave, { y: hoje.y, m: 1, d: 1 }, hoje, tz, 'Este ano', now)
    case 'personalizado': {
      const a = lerData(arg.de), b = lerData(arg.ate) || a
      if (!a || !b) throw new Error('Período personalizado precisa de datas no formato AAAA-MM-DD.')
      const [ini, fim] = meiaNoite(a, tz) <= meiaNoite(b, tz) ? [a, b] : [b, a]
      if (meiaNoite(fim, tz) - meiaNoite(ini, tz) > 400 * 86400000) throw new Error('Período maior que 400 dias.')
      return montar(chave, ini, fim, tz, 'Período', now)
    }
    default: return montar('ultimos_7_dias', somaDias(hoje, -6), hoje, tz, 'Últimos 7 dias', now)
  }
}

// Período de comparação. "periodo_anterior": a mesma duração logo antes; "mes_anterior"/"ano_anterior": as mesmas
// datas um mês/um ano antes (este mês até hoje compara com o mês passado até o mesmo dia).
export function periodoComparacao(p: Periodo, modo: string, tz: string): Periodo | null {
  if (!modo || modo === 'nenhum') return null
  const de = Date.parse(p.de), ate = Date.parse(p.ate)
  if (modo === 'periodo_anterior') {
    const dur = ate - de
    const ini = hojeLocal(new Date(de - dur), tz)
    const fim = hojeLocal(new Date(de - 1), tz)
    const r = montar('anterior', ini, fim, tz, 'Período anterior')
    return { ...r, de: new Date(de - dur).toISOString(), ate: new Date(de).toISOString(), gran: p.gran }
  }
  const meses = modo === 'mes_anterior' ? -1 : modo === 'ano_anterior' ? -12 : 0
  if (!meses) return null
  const ini = somaMeses(hojeLocal(new Date(de), tz), meses)
  const fimP = hojeLocal(new Date(ate - 1), tz)
  const fim = somaMeses(fimP, meses)
  const r = montar(modo, ini, fim, tz, modo === 'mes_anterior' ? 'Mesmo período do mês anterior' : 'Mesmo período do ano anterior')
  // se o período atual vai só até agora (parcial), o anterior vai até a mesma hora
  const parcial = ate < meiaNoite(somaDias(fimP, 1), tz)
  if (parcial) r.ate = new Date(Date.parse(r.ate) - (meiaNoite(somaDias(fimP, 1), tz) - ate)).toISOString()
  return { ...r, gran: p.gran }
}
