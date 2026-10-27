// Banco de mentira com o pedaço do PostgREST que as sincronizações do agente de vendas usam (etiquetas e Kanban dos
// clientes) e o agente do rotacionador: select/eq/in/not/contains/order/limit/range, maybeSingle, insert (um ou vários), update e delete. `gravados` guarda cada escrita.
// Colunas geradas pelo banco (contacts.phone_digits) são preenchidas no insert.
const GERADAS: Record<string, (r: any) => Record<string, unknown>> = {
  contacts: (r) => ({ phone_digits: String(r.phone ?? '').replace(/\D/g, '') }),
}

export function bancoFalso(tabelas: Record<string, any[]>) {
  const gravados: { tabela: string; op: string; valor: any }[] = []
  let seq = 0
  const from = (tabela: string) => {
    const filtros: ((r: any) => boolean)[] = []
    let op = 'select'
    let valor: any = null
    let faixa: [number, number] | null = null
    let umSo = false
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => (filtros.push((r) => r[k] === v), q),
      in: (k: string, v: any[]) => (filtros.push((r) => v.includes(r[k])), q),
      not: (k: string, _o: string, _v: null) => (filtros.push((r) => r[k] != null), q),
      contains: (k: string, v: any[]) => (filtros.push((r) => v.every((x) => (r[k] ?? []).includes(x))), q),
      order: () => q,
      limit: () => q,
      range: (a: number, b: number) => ((faixa = [a, b]), q),
      insert: (v: any) => ((op = 'insert'), (valor = v), q),
      update: (v: any) => ((op = 'update'), (valor = v), q),
      delete: () => ((op = 'delete'), q),
      single: () => q,
      maybeSingle: () => ((umSo = true), q),
      then: (ok: any, erro: any) => Promise.resolve(executar()).then(ok, erro),
    }
    function executar() {
      const linhas = (tabelas[tabela] ??= [])
      if (op === 'insert') {
        const novas = (Array.isArray(valor) ? valor : [valor]).map((v) => ({ id: `novo${++seq}`, ...v, ...(GERADAS[tabela]?.(v) ?? {}) }))
        linhas.push(...novas)
        gravados.push({ tabela, op, valor })
        return { data: Array.isArray(valor) ? novas : novas[0], error: null }
      }
      const alvo = linhas.filter((r) => filtros.every((f) => f(r)))
      if (op === 'update') {
        for (const r of alvo) Object.assign(r, valor)
        gravados.push({ tabela, op, valor: { ids: alvo.map((r) => r.id), ...valor } })
        return { data: null, error: null }
      }
      if (op === 'delete') {
        tabelas[tabela] = linhas.filter((r) => !alvo.includes(r))
        gravados.push({ tabela, op, valor: { ids: alvo.map((r) => r.id) } })
        return { data: null, error: null }
      }
      const pagina = faixa ? alvo.slice(faixa[0], faixa[1] + 1) : alvo
      // select com "alias:facts->campo": a sincronização lê os fatos em colunas separadas.
      const data = pagina.map((r) => ({ ...r, ...(r.facts ?? {}) }))
      return { data: umSo ? data[0] ?? null : data, error: null }
    }
    return q
  }
  return { admin: { from }, gravados, tabelas }
}
