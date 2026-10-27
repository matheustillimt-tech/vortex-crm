// Módulos liberados para a empresa (definidos pelo superadmin em public.company_access).
// As funções do servidor usam a service role, que ignora o RLS — por isso conferem aqui também.
import { json } from './whatsapp.ts'

export const MODULE_NAMES: Record<string, string> = {
  conexoes: 'Conexões', contatos: 'Contatos', chat: 'Chat ao vivo', kanban: 'Kanban', fluxos: 'Fluxos de automação',
  agentes: 'Agentes de IA', webhooks: 'Webhooks de entrada', disparos: 'Disparos em massa', facebook: 'Facebook', instagram: 'Instagram',
  inteligencia: 'Vórtex Inteligência',
}

export async function companyModules(admin: any, companyId: string): Promise<Set<string>> {
  const { data } = await admin.from('company_access').select('effective').eq('company_id', companyId).maybeSingle()
  return new Set<string>(data?.effective ?? [])
}

// Resposta 403 quando falta algum módulo; null quando está tudo liberado.
export function missing(mods: Set<string>, ...needed: string[]) {
  const off = needed.filter((m) => !mods.has(m))
  if (!off.length) return null
  return json({ error: `Módulo não liberado para sua empresa: ${off.map((m) => MODULE_NAMES[m] || m).join(', ')}.`, code: 'module_disabled', modules: off }, 403)
}
