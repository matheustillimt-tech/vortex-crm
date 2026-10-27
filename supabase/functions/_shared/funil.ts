// Funil no Kanban: cada etapa é uma coluna do quadro (tabela funis). O card do contato só anda para a frente:
// um aviso de uma etapa anterior à que o card já está só registra a data, sem voltar o card.
// Quem avisa: a DM da automação de comentário e o clique no link (Zernio), a isca (cadastro), o Vórtex Grupo (entrou),
// o Vórtex Webinar (ficou 15 min), o checkout e a área de membros (comprou). Ver supabase/functions/funil.
import { onlyDigits, phoneVariants } from './whatsapp.ts'

// A ordem é a do funil: o card só anda para a direita. Cartão recusado vem antes do Pix: quem teve o cartão recusado e
// gerou o Pix anda; quem gerou o Pix e depois tentou cartão fica no Pix.
export const ETAPAS = ['comentou', 'clicou', 'cadastrou', 'grupo', 'aula', 'pitch', 'oferta', 'recusado', 'pix', 'comprou'] as const
export type Etapa = (typeof ETAPAS)[number]
export const ROTULOS: Record<Etapa, string> = {
  comentou: 'Comentou e recebeu a DM', clicou: 'Clicou na isca', cadastrou: 'Cadastrou na isca',
  grupo: 'Entrou no grupo', aula: 'Participou da aula', pitch: 'Chegou no pitch', oferta: 'Clicou na oferta',
  recusado: 'Cartão recusado', pix: 'Pix gerado', comprou: 'Comprou',
}
export const ORIGEM: Record<string, string> = { isca: 'Isca', grupo: 'Vórtex Grupo', webinar: 'Vórtex Webinar', plataforma: 'Área de membros', checkout: 'Vórtex Pay', zernio: 'Instagram' }

export type Funil = { id: string; company_id: string; kanban_id: string; colunas: Partial<Record<Etapa, string>>; ativo: boolean }

export async function funilDaEmpresa(admin: any, companyId: string): Promise<Funil | null> {
  const { data } = await admin.from('funis').select('*').eq('company_id', companyId).eq('ativo', true).limit(1)
  return data?.[0] ?? null
}

/** Índice da etapa de uma coluna (-1 se a coluna não é de etapa nenhuma: o card foi arrastado para fora do funil). */
export const etapaDaColuna = (funil: Funil, columnId: string) => ETAPAS.findIndex((e) => funil.colunas[e] === columnId)

/** Decide o que fazer com o card: criar, mover para a frente ou só anotar a data. Pura (testada). */
export function decidir(funil: Funil, card: { column_id: string } | null, etapa: Etapa): 'criar' | 'mover' | 'manter' {
  if (!card) return 'criar'
  const atual = etapaDaColuna(funil, card.column_id)
  if (atual === -1) return 'manter' // a equipe tirou o card do funil: não mexe
  return ETAPAS.indexOf(etapa) > atual ? 'mover' : 'manter'
}

/** Para ilike comparar texto exato (sem _ e % virarem curinga). */
export const semCuringa = (s: string) => String(s || '').replace(/[\\%_]/g, (c) => '\\' + c)

export const tituloDo = (c: any) => c?.name || (c?.instagram_username ? `@${c.instagram_username}` : '') || c?.phone || 'Contato'

// `detalhe`: o que se sabe da etapa (isca, comentário, grupo, tempo de aula, pedido). Fica no card, em extra.detalhes.
export async function avancar(admin: any, funil: Funil, contact: any, etapa: Etapa, quando = new Date().toISOString(), detalhe: Record<string, unknown> | null = null, _tentativa = false): Promise<string> {
  const coluna = funil.colunas[etapa]
  if (!coluna || !contact?.id) return 'sem-coluna'
  const { data: cards } = await admin.from('kanban_cards').select('id, column_id, extra').eq('kanban_id', funil.kanban_id).eq('contact_id', contact.id).limit(1)
  const card = cards?.[0] ?? null
  const acao = decidir(funil, card, etapa)
  // vale o horário mais antigo de cada etapa (um aviso atrasado ou repetido não empurra a data para frente)
  const antesData = ((card?.extra || {}).funil || {})[etapa]
  const historico = { ...((card?.extra || {}).funil || {}), [etapa]: antesData && antesData < quando ? antesData : quando }
  const antes = (card?.extra || {}).detalhes || {}
  const detalhes = detalhe ? { ...antes, [etapa]: { ...(antes[etapa] || {}), ...limpo(detalhe) } } : antes
  if (acao === 'criar') {
    const { error } = await admin.from('kanban_cards').insert({
      company_id: funil.company_id, kanban_id: funil.kanban_id, column_id: coluna, contact_id: contact.id,
      title: tituloDo(contact), value: 0, labels: [], notes: '', extra: { funil: historico, detalhes },
    })
    // outro aviso da mesma pessoa criou o card ao mesmo tempo (um card por pessoa: índice único): atualiza esse
    if (error?.code === '23505' && !_tentativa) return avancar(admin, funil, contact, etapa, quando, detalhe, true)
    if (error) throw error
    return 'criado'
  }
  const patch: Record<string, unknown> = { extra: { ...(card.extra || {}), funil: historico, detalhes } }
  if (acao === 'mover') Object.assign(patch, { column_id: coluna, updated_at: quando })
  const { error } = await admin.from('kanban_cards').update(patch).eq('id', card.id)
  if (error) throw error
  return acao === 'mover' ? 'movido' : 'mantido'
}

// sem campos vazios e com texto curto (o card vai inteiro para o navegador)
const limpo = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]))

/** Registra o aviso (a chave barra repetição). false = já tinha sido registrado. */
export async function registrar(admin: any, funil: Funil, fonte: string, chave: string, campos: Record<string, unknown> = {}) {
  const { error } = await admin.from('funil_eventos').insert({ funil_id: funil.id, company_id: funil.company_id, fonte, chave: chave.slice(0, 300), ...campos })
  if (error) {
    if (error.code === '23505') return false
    throw error
  }
  return true
}
export const anotar = (admin: any, funil: Funil, fonte: string, chave: string, campos: Record<string, unknown>) =>
  admin.from('funil_eventos').update(campos).eq('funil_id', funil.id).eq('fonte', fonte).eq('chave', chave.slice(0, 300))

/* ---------- Achar (ou criar) o contato ---------- */

/** Pelo WhatsApp (com e sem o 9) e, sem telefone, pelo e-mail. Cria se não achar. */
export async function contatoPorTelefoneOuEmail(admin: any, companyId: string, p: { telefone?: string | null; email?: string | null; nome?: string | null; origem: string }) {
  const digits = onlyDigits(p.telefone || '')
  const email = String(p.email || '').trim().toLowerCase()
  let contact: any = null
  if (digits.length >= 10) {
    const br = digits.length <= 11 ? '55' + digits : digits
    const { data } = await admin.from('contacts').select('*').eq('company_id', companyId).in('phone_digits', phoneVariants(br)).order('created_at').limit(1)
    contact = data?.[0] ?? null
  }
  if (!contact && email) {
    const { data } = await admin.from('contacts').select('*').eq('company_id', companyId).ilike('email', semCuringa(email)).order('created_at').limit(1)
    contact = data?.[0] ?? null
  }
  if (contact) {
    // completa o que faltava (sem trocar o que já tinha)
    const patch: Record<string, unknown> = {}
    if (!contact.email && email) patch.email = email
    if (!onlyDigits(contact.phone) && digits.length >= 10) patch.phone = `+${digits.length <= 11 ? '55' + digits : digits}`
    if (Object.keys(patch).length) await admin.from('contacts').update(patch).eq('id', contact.id)
    return { ...contact, ...patch }
  }
  if (digits.length < 10 && !email) return null
  const { data, error } = await admin.from('contacts').insert({
    company_id: companyId, name: String(p.nome || '').trim() || (digits ? `+${digits}` : email), phone: digits.length >= 10 ? `+${digits.length <= 11 ? '55' + digits : digits}` : '',
    email, status: 'lead', origin: p.origem,
  }).select('*').single()
  if (error) throw error
  return data
}

/** Pelo Instagram: @ primeiro (o id do comentário pode não ser o mesmo do Direct), depois o id. Cria se não achar. */
export async function contatoInstagram(admin: any, companyId: string, p: { username?: string | null; id?: string | null; nome?: string | null; connectionId?: string | null }) {
  const user = String(p.username || '').replace(/^@/, '').trim()
  let contact: any = null
  if (user) contact = (await admin.from('contacts').select('*').eq('company_id', companyId).ilike('instagram_username', semCuringa(user)).limit(1)).data?.[0] ?? null
  if (!contact && p.id) contact = (await admin.from('contacts').select('*').eq('company_id', companyId).eq('instagram_id', String(p.id)).limit(1)).data?.[0] ?? null
  if (contact) return contact
  if (!user) return null
  // sem instagram_id: o id do comentário pode ser outro; o do Direct entra quando a pessoa escrever (inbound.ts acha pelo @)
  const { data, error } = await admin.from('contacts').insert({
    company_id: companyId, name: String(p.nome || '').trim() || `@${user}`, phone: '', status: 'lead', origin: 'Instagram',
    instagram_username: user, connection_id: p.connectionId || null, fields: p.id ? { instagramComentarioId: String(p.id) } : {},
  }).select('*').single()
  if (error) throw error
  return data
}
