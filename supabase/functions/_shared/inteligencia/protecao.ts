// Proteções do "Melhorar agente". Puro (testado em supabase/tests/inteligencia.test.ts).
// - redigir: tira dados pessoais e segredos do texto das conversas antes de ir para a IA e antes de entrar no agente.
// - classificar: uma alteração que mexe em preço, desconto, condição comercial, garantia, reembolso, credenciais,
//   links/pagamento ou em regra essencial ("nunca", "não pode"...) não é aplicada sozinha: vira proposta para aprovação.
// - pareceInjecao: texto que tenta dar ordens ao sistema não entra no agente.
// - tamanho e regras essenciais da versão candidata.

export const CAMPOS_TEXTO = ['prompt', 'examples', 'rules', 'tone', 'does', 'audience'] as const
export const CAMPOS_AUTOMATICOS = new Set<string>([...CAMPOS_TEXTO, 'knowledge'])
export const LIMITE_INSTRUCOES = 12_000 // caracteres somados dos campos de instrução
export const LIMITE_CONHECIMENTO = 30_000 // acima disso o agente passa a consultar por busca (KNOWLEDGE_INLINE do motor)

/* ---------- dados pessoais e segredos ---------- */

const RE = {
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  pixCopiaCola: /000201\S{30,}/g,
  segredo: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]+|\b[a-f0-9]{32,}\b/gi,
  cartao: /\b(?:\d[ -]?){13,19}\b/g,
  cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  cnpj: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
  telefone: /(?:\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g,
}

export function redigir(texto: string): string {
  return String(texto || '')
    .replace(RE.pixCopiaCola, '[código pix]')
    .replace(RE.segredo, '[segredo]')
    .replace(RE.email, '[email]')
    .replace(RE.cnpj, '[cnpj]')
    .replace(RE.telefone, (m) => (m.replace(/\D/g, '').length >= 10 ? '[telefone]' : m))
    .replace(RE.cpf, '[cpf]')
    .replace(RE.cartao, (m) => (m.replace(/\D/g, '').length >= 13 ? '[cartão]' : m))
}

export function temDadoPessoal(texto: string) {
  return redigir(texto) !== String(texto || '')
}

/* ---------- injeção ---------- */

const INJECAO = [
  /ignor[ea]\s+(?:as\s+|todas\s+as\s+)?(?:instru|regras|orienta)/i, /desconsider[ea]\s+(?:as\s+)?(?:instru|regras)/i,
  /\bsystem\s*prompt\b|\bprompt do sistema\b/i, /voc[eê] agora [eé](?=\s|$)/i, /\bact as\b|\bignore (?:all |previous )/i,
  /revel[ea]\s+(?:suas?|as)\s+(?:instru|regras|senha|chave)/i, /\bmodo desenvolvedor\b|\bjailbreak\b/i,
]
export const pareceInjecao = (texto: string) => INJECAO.some((re) => re.test(String(texto || '')))

/* ---------- frases e áreas protegidas ---------- */

const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9%$ ]+/g, ' ').replace(/\s+/g, ' ').trim()

export function frases(texto: string): string[] {
  return String(texto || '').split(/(?<=[.!?])\s+|\n+/).map((f) => f.trim()).filter((f) => norm(f).length > 2)
}

const AREAS: [string, RegExp][] = [
  ['preco', /r\$|\breais\b|\bpreco|\bvalor (?:do|da|de)\b|\bcusta\b|\bmensalidade|\binvestimento\b/],
  ['desconto', /\bdesconto|\bcupom|\bpromo(?:cao|cional)|% ?off\b|\bbonus\b|\bgratis\b|\bgratuit/],
  ['condicao_comercial', /\bparcel|\bjuros\b|\bfrete\b|\bboleto\b|\bvencimento\b|\bprazo de pagamento|\bcondic(?:ao|oes) de pagamento/],
  ['garantia', /\bgarantia/],
  ['reembolso', /\breembols|\bestorno|\bdevolu|\bcancelamento|\bchargeback|\bdinheiro de volta/],
  ['credenciais', /\bsenha|\btoken\b|\bchave de api|\blogin\b|\bacesso administrativo/],
  ['financeiro', /\bchave pix|\bpix copia|\bconta bancaria|\bagencia\b|\btransferencia bancaria|\bdados bancarios/],
  ['link', /https?:\/\/|\bwww\./],
]

export function areaDe(texto: string): string | null {
  const t = norm(texto)
  const cru = String(texto || '').toLowerCase()
  for (const [area, re] of AREAS) if (re.test(area === 'link' ? cru : t)) return area
  return null
}

// valores que mudam o negócio: dinheiro, porcentagem e números ao lado de "dias", "x", "parcelas"
const valores = (texto: string) => new Set(
  [...String(texto || '').toLowerCase().matchAll(/r\$\s*[\d.,]+|\d+(?:[.,]\d+)?\s*%|\d+\s*(?:x\b|dias|horas|parcelas|meses)/g)].map((m) => m[0].replace(/\s+/g, '')),
)

const ESSENCIAL = /\b(?:nunca|jamais|nao pode|nao deve|proibid|obrigatori|sempre|em hipotese alguma|nao (?:fale|diga|ofereca|prometa|envie|passe|informe|de))\b/

export function regrasEssenciais(texto: string): string[] {
  return frases(texto).filter((f) => ESSENCIAL.test(norm(f)))
}

// regra essencial do "antes" que sumiu do "depois" (comparação pelas palavras principais da frase)
export function regrasPerdidas(antes: string, depois: string): string[] {
  const alvo = norm(depois)
  return regrasEssenciais(antes).filter((r) => {
    const palavras = norm(r).split(' ').filter((w) => w.length >= 4)
    if (!palavras.length) return false
    const presentes = palavras.filter((w) => alvo.includes(w)).length
    return presentes / palavras.length < 0.8
  })
}

export type Classificacao = { protegida: boolean; area: string | null; motivo: string; bloqueada?: boolean }

// Diferença de frases entre antes e depois de um campo de texto (ou do conteúdo de um conhecimento)
export function classificarTexto(antes: string, depois: string): Classificacao {
  if (pareceInjecao(depois) && !pareceInjecao(antes)) return { protegida: true, bloqueada: true, area: 'seguranca', motivo: 'o texto novo parece uma instrução para burlar as regras' }
  if (temDadoPessoal(depois) && redigir(antes) === antes) return { protegida: true, bloqueada: true, area: 'dados_pessoais', motivo: 'o texto novo traz dado pessoal ou segredo' }
  const fa = new Set(frases(antes).map(norm))
  const fd = new Set(frases(depois).map(norm))
  const novas = frases(depois).filter((f) => !fa.has(norm(f)))
  const saiu = frases(antes).filter((f) => !fd.has(norm(f)))
  const va = valores(antes), vd = valores(depois)
  const mudouValor = va.size !== vd.size || [...va].some((v) => !vd.has(v))
  if (mudouValor) return { protegida: true, area: areaDe([...novas, ...saiu].join(' ')) || 'preco', motivo: 'muda valor, porcentagem, prazo ou parcelamento' }
  for (const f of novas) { const a = areaDe(f); if (a) return { protegida: true, area: a, motivo: `acrescenta texto sobre ${NOME_AREA[a] || a}` } }
  for (const f of saiu) { const a = areaDe(f); if (a) return { protegida: true, area: a, motivo: `remove texto sobre ${NOME_AREA[a] || a}` } }
  const perdidas = regrasPerdidas(antes, depois)
  if (perdidas.length) return { protegida: true, area: 'regra_essencial', motivo: `remove regra essencial: "${perdidas[0].slice(0, 120)}"` }
  return { protegida: false, area: null, motivo: '' }
}

export const NOME_AREA: Record<string, string> = {
  preco: 'preço', desconto: 'desconto ou promoção', condicao_comercial: 'condição comercial', garantia: 'garantia', reembolso: 'reembolso ou cancelamento',
  credenciais: 'credenciais', financeiro: 'dados financeiros', link: 'links', regra_essencial: 'regra essencial', configuracao: 'configuração do agente',
  integracao: 'integrações e ferramentas', modelo: 'modelo e custo da IA', fluxo_externo: 'ações com efeito externo', seguranca: 'segurança', dados_pessoais: 'dados pessoais',
}

/* ---------- versão candidata ---------- */

export type Conhecimento = { id: string; title: string; content: string }
export type Conteudo = { prompt: string; examples: string; rules: string; tone: string; does: string; audience: string; knowledge: Conhecimento[] }

export function conteudoDe(extra: any): Conteudo {
  const x = extra || {}
  return {
    prompt: String(x.prompt || ''), examples: String(x.examples || ''), rules: String(x.rules || ''), tone: String(x.tone || ''),
    does: String(x.does || ''), audience: String(x.audience || ''),
    knowledge: (Array.isArray(x.knowledge) ? x.knowledge : []).map((k: any) => ({ ...k, id: String(k?.id || ''), title: String(k?.title || ''), content: String(k?.content || '') })),
  }
}

export const tamanhoInstrucoes = (c: Conteudo) => CAMPOS_TEXTO.reduce((n, k) => n + c[k].length, 0)
export const tamanhoConhecimento = (c: Conteudo) => c.knowledge.reduce((n, k) => n + k.title.length + k.content.length, 0)

// A candidata não pode crescer sem limite: até 15% + 1.500 caracteres a mais nas instruções (e o teto do motor), e o
// conhecimento até 20% + 3.000 a mais (e o teto em que o motor ainda manda tudo no contexto).
export function conferirTamanho(antes: Conteudo, depois: Conteudo): string | null {
  const ia = tamanhoInstrucoes(antes), id = tamanhoInstrucoes(depois)
  if (id > Math.max(ia * 1.15 + 1500, 0) || (id > LIMITE_INSTRUCOES && id > ia)) return `as instruções passariam de ${ia} para ${id} caracteres`
  const ka = tamanhoConhecimento(antes), kd = tamanhoConhecimento(depois)
  if (kd > ka * 1.2 + 3000 || (kd > LIMITE_CONHECIMENTO && ka <= LIMITE_CONHECIMENTO)) return `o conhecimento passaria de ${ka} para ${kd} caracteres`
  return null
}
