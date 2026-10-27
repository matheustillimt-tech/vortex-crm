// Conversão entre Créditos de IA e dólar (custo dos provedores), com o câmbio, o acréscimo e o multiplicador da
// carteira: os limites do módulo são configurados em créditos (o que o cliente entende) e conferidos em dólar.

export async function creditosPorDolar(admin: any, companyId: string): Promise<number> {
  const [{ data: s }, { data: w }] = await Promise.all([
    admin.from('ai_billing_settings').select('credit_brl, multiplier, usd_brl, surcharge_pct').eq('id', true).single(),
    admin.from('ai_wallets').select('multiplier').eq('company_id', companyId).maybeSingle(),
  ])
  const credito = Number(s?.credit_brl) || 0.01
  const mult = Number(w?.multiplier ?? s?.multiplier) || 2
  return (Number(s?.usd_brl) || 5) * (1 + (Number(s?.surcharge_pct) || 0) / 100) * mult / credito
}

export const creditosParaUsd = async (admin: any, companyId: string, creditos: number) => creditos / (await creditosPorDolar(admin, companyId))
export const usdParaCreditos = async (admin: any, companyId: string, usd: number) => usd * (await creditosPorDolar(admin, companyId))
