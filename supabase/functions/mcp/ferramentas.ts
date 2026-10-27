// Ferramentas do servidor MCP do Vórtex CRM. Tudo fica preso à empresa da chave (chave.companyId): cada consulta
// filtra por company_id, porque o servidor usa a service role (que ignora o RLS). As de envio exigem chave "envio".
// Pensado para disparo: conversa aberta por aqui nasce com a automação desligada (sem fluxo e sem agente de IA nas
// respostas), e numa conversa que já existia a IA pausa como quando um atendente responde pelo painel.
// Grupos (listar_grupos, enviar_mensagem_grupo): só nas conexões por QR Code (Zapbot). Mensagem de grupo não vira
// contato nem conversa no painel, porque as de grupo que chegam também ficam de fora (inbound.ts).
import { companyModules, MODULE_NAMES } from '../_shared/access.ts'
import { pauseForHuman } from '../_shared/agent-core.ts'
import { connectionSecret } from '../_shared/secrets.ts'
import { mediaKind, MEDIA_MAX_MB, onlyDigits, outgoingKind, phoneVariants, sendMedia, sendText, type Creds, type MediaKind, type Provider } from '../_shared/whatsapp.ts'
import { instanceCall, type ZapCreds } from '../_shared/zapbot.ts'

export type Chave = { id: string; companyId: string; nome: string; escopo: 'leitura' | 'envio' }
type Resultado = { content: { type: 'text'; text: string }[]; isError?: boolean }
type Args = Record<string, any>

export type Ferramenta = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown>
  envio: boolean
  modulos: string[]
  executar: (admin: any, chave: Chave, a: Args) => Promise<Resultado>
}

const BUCKET = 'whatsapp-media'
const POR_PAGINA = 50
const UUID = { type: 'string', format: 'uuid' } as const
const PAGINA = { type: 'integer', minimum: 1, description: 'Página (50 itens por página). Padrão 1.' } as const
const LABEL: Record<string, string> = { image: '📷 Imagem', video: '🎥 Vídeo', audio: '🎤 Áudio' }
const TIPOS: Record<string, MediaKind> = { imagem: 'image', video: 'video', audio: 'audio', documento: 'document' }
const MIME_PADRAO: Record<MediaKind, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', document: 'application/pdf' }
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
}

const texto = (dados: unknown): Resultado => ({ content: [{ type: 'text', text: JSON.stringify(dados, null, 2) }] })
const erro = (mensagem: string): Resultado => ({ content: [{ type: 'text', text: mensagem }], isError: true })
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const ehUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const pagina = (v: unknown) => Math.max(1, Math.floor(Number(v) || 1))
const faixa = (p: number) => [(p - 1) * POR_PAGINA, p * POR_PAGINA - 1] as const
const extensao = (nome: string) => (nome.split('?')[0].split('.').pop() || '').toLowerCase()
const nomeSeguro = (n: string) => (n || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80)
// Texto de busca sem os caracteres que quebram o filtro "or" do PostgREST.
const limpaBusca = (s: string) => s.replace(/[,()%*\\]/g, ' ').trim()

// Número de WhatsApp: só dígitos; com 10 ou 11 dígitos (DDD + número) entra o 55 do Brasil.
function numeroWhatsapp(v: unknown): string | null {
  let d = onlyDigits(String(v ?? ''))
  if (d.length === 10 || d.length === 11) d = '55' + d
  return d.length >= 12 && d.length <= 15 ? d : null
}

const conexaoPublica = (c: any) => ({ id: c.id, nome: c.name, numero: c.number, tipo: c.provider, status: c.status })
const contatoPublico = (c: any, etiquetas: Map<string, string>) => ({
  id: c.id, nome: c.name, telefone: c.phone, email: c.email || null, status: c.status, origem: c.origin,
  etiquetas: (c.labels || []).map((id: string) => etiquetas.get(id) || id), campos: c.fields || {}, criado_em: c.created_at,
})

async function mapaEtiquetas(admin: any, companyId: string) {
  const { data } = await admin.from('labels').select('id, name').eq('company_id', companyId)
  return new Map<string, string>((data || []).map((l: any) => [l.id, l.name]))
}

async function contatoPorTelefone(admin: any, companyId: string, digitos: string) {
  const { data } = await admin.from('contacts').select('*').eq('company_id', companyId).in('phone_digits', phoneVariants(digitos)).order('created_at').limit(1).maybeSingle()
  return data
}

/* ---------- Leitura ---------- */

const listarConexoes: Ferramenta = {
  name: 'listar_conexoes', title: 'Listar conexões', envio: false, modulos: ['conexoes'],
  description: 'Lista os números de WhatsApp conectados na empresa (id, nome, número, tipo e status). Use o id em enviar_mensagem quando houver mais de um.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async executar(admin, chave) {
    const { data } = await admin.from('connections').select('id, name, number, provider, status').eq('company_id', chave.companyId).order('created_at')
    return texto({ conexoes: (data || []).map(conexaoPublica) })
  },
}

const listarEtiquetas: Ferramenta = {
  name: 'listar_etiquetas', title: 'Listar etiquetas', envio: false, modulos: ['contatos'],
  description: 'Lista as etiquetas da empresa (para filtrar contatos ou marcar em salvar_contato).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async executar(admin, chave) {
    const { data } = await admin.from('labels').select('id, name, color').eq('company_id', chave.companyId).order('name')
    return texto({ etiquetas: (data || []).map((l: any) => ({ id: l.id, nome: l.name, cor: l.color })) })
  },
}

const buscarContatos: Ferramenta = {
  name: 'buscar_contatos', title: 'Buscar contatos', envio: false, modulos: ['contatos'],
  description: 'Busca contatos por nome, telefone ou e-mail e/ou por etiqueta. Sem filtro, lista os mais recentes. 50 por página.',
  inputSchema: {
    type: 'object',
    properties: {
      busca: { type: 'string', description: 'Parte do nome, do telefone (só dígitos também vale) ou do e-mail.' },
      etiqueta: { type: 'string', description: 'Nome (ou id) de uma etiqueta.' },
      pagina: PAGINA,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async executar(admin, chave, a) {
    const etiquetas = await mapaEtiquetas(admin, chave.companyId)
    const p = pagina(a.pagina)
    let q = admin.from('contacts').select('*', { count: 'exact' }).eq('company_id', chave.companyId)
    const busca = limpaBusca(str(a.busca))
    if (busca) {
      const dig = onlyDigits(busca)
      q = q.or([`name.ilike.%${busca}%`, `email.ilike.%${busca}%`, ...(dig.length >= 4 ? [`phone_digits.like.%${dig}%`] : [])].join(','))
    }
    const et = str(a.etiqueta)
    if (et) {
      const id = ehUuid(et) ? et : [...etiquetas].find(([, n]) => n.toLowerCase() === et.toLowerCase())?.[0]
      if (!id) return erro(`Etiqueta não encontrada: ${et}. Veja listar_etiquetas.`)
      q = q.contains('labels', [id])
    }
    const { data, count } = await q.order('created_at', { ascending: false }).range(...faixa(p))
    return texto({ total: count ?? 0, pagina: p, contatos: (data || []).map((c: any) => contatoPublico(c, etiquetas)) })
  },
}

const verContato: Ferramenta = {
  name: 'ver_contato', title: 'Ver contato', envio: false, modulos: ['contatos'],
  description: 'Mostra um contato (pelo id ou pelo telefone) com as conversas dele em cada conexão.',
  inputSchema: { type: 'object', properties: { contato_id: UUID, telefone: { type: 'string', description: 'Com DDD; o 55 é opcional.' } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async executar(admin, chave, a) {
    let contato: any = null
    if (ehUuid(a.contato_id)) contato = (await admin.from('contacts').select('*').eq('company_id', chave.companyId).eq('id', a.contato_id).maybeSingle()).data
    else if (a.telefone) {
      const d = numeroWhatsapp(a.telefone)
      if (!d) return erro('Telefone inválido: use DDD + número (o 55 é opcional).')
      contato = await contatoPorTelefone(admin, chave.companyId, d)
    } else return erro('Informe contato_id ou telefone.')
    if (!contato) return erro('Contato não encontrado.')
    const [etiquetas, { data: chats }] = await Promise.all([
      mapaEtiquetas(admin, chave.companyId),
      admin.from('chats').select('id, connection_id, status, unread, last_message_at, bot_active').eq('company_id', chave.companyId).eq('contact_id', contato.id).order('last_message_at', { ascending: false }),
    ])
    return texto({
      ...contatoPublico(contato, etiquetas),
      conversas: (chats || []).map((c: any) => ({ id: c.id, conexao_id: c.connection_id, status: c.status, nao_lidas: c.unread, ultima_mensagem_em: c.last_message_at, automacao_ligada: c.bot_active })),
    })
  },
}

const listarConversas: Ferramenta = {
  name: 'listar_conversas', title: 'Listar conversas', envio: false, modulos: ['chat'],
  description: 'Lista as conversas mais recentes (com o contato e a última mensagem). Use nao_lidas para ver quem respondeu. 50 por página.',
  inputSchema: {
    type: 'object',
    properties: {
      conexao_id: UUID,
      status: { type: 'string', enum: ['waiting', 'attending', 'resolved'], description: 'waiting = aguardando, attending = em atendimento, resolved = resolvida.' },
      nao_lidas: { type: 'boolean', description: 'Só conversas com mensagem não lida.' },
      desde: { type: 'string', description: 'Só conversas com mensagem depois desta data/hora (ISO 8601; sem fuso, vale Brasília).' },
      pagina: PAGINA,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async executar(admin, chave, a) {
    const p = pagina(a.pagina)
    let q = admin.from('chats').select('id, contact_id, connection_id, status, unread, answered, last_message_at, bot_active', { count: 'exact' }).eq('company_id', chave.companyId)
    if (ehUuid(a.conexao_id)) q = q.eq('connection_id', a.conexao_id)
    if (['waiting', 'attending', 'resolved'].includes(a.status)) q = q.eq('status', a.status)
    if (a.nao_lidas === true) q = q.gt('unread', 0)
    if (str(a.desde)) {
      const s = str(a.desde)
      const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + '-03:00')
      if (isNaN(+d)) return erro('desde: data inválida.')
      q = q.gte('last_message_at', d.toISOString())
    }
    const { data: chats, count } = await q.order('last_message_at', { ascending: false }).range(...faixa(p))
    const lista = chats || []
    const ids = lista.map((c: any) => c.id)
    const [{ data: contatos }, { data: msgs }] = await Promise.all([
      admin.from('contacts').select('id, name, phone').eq('company_id', chave.companyId).in('id', lista.map((c: any) => c.contact_id)),
      ids.length ? admin.from('messages').select('chat_id, sender, text, at').eq('company_id', chave.companyId).in('chat_id', ids).neq('sender', 'sys').order('at', { ascending: false }).limit(1000) : { data: [] },
    ])
    const contato = new Map((contatos || []).map((c: any) => [c.id, c]))
    const ultima = new Map<string, any>()
    for (const m of msgs || []) if (!ultima.has(m.chat_id)) ultima.set(m.chat_id, m)
    return texto({
      total: count ?? 0, pagina: p,
      conversas: lista.map((c: any) => {
        const ct: any = contato.get(c.contact_id)
        const u = ultima.get(c.id)
        return {
          id: c.id, contato: ct ? { id: ct.id, nome: ct.name, telefone: ct.phone } : null, conexao_id: c.connection_id,
          status: c.status, nao_lidas: c.unread, respondida: c.answered, ultima_mensagem_em: c.last_message_at,
          ultima_mensagem: u ? { de: u.sender === 'contact' ? 'contato' : 'empresa', texto: String(u.text).slice(0, 200) } : null,
        }
      }),
    })
  },
}

const lerConversa: Ferramenta = {
  name: 'ler_conversa', title: 'Ler conversa', envio: false, modulos: ['chat'],
  description: 'Lê as últimas mensagens de uma conversa (pelo id ou pelo telefone do contato), da mais antiga para a mais nova. Não marca como lida.',
  inputSchema: {
    type: 'object',
    properties: {
      conversa_id: UUID,
      telefone: { type: 'string', description: 'Telefone do contato (pega a conversa mais recente dele).' },
      conexao_id: { ...UUID, description: 'Com telefone: a conversa nesta conexão.' },
      limite: { type: 'integer', minimum: 1, maximum: 100, description: 'Quantas mensagens (padrão 30, máximo 100).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async executar(admin, chave, a) {
    let chat: any = null
    if (ehUuid(a.conversa_id)) chat = (await admin.from('chats').select('*').eq('company_id', chave.companyId).eq('id', a.conversa_id).maybeSingle()).data
    else if (a.telefone) {
      const d = numeroWhatsapp(a.telefone)
      if (!d) return erro('Telefone inválido: use DDD + número (o 55 é opcional).')
      const c = await contatoPorTelefone(admin, chave.companyId, d)
      if (c) {
        let q = admin.from('chats').select('*').eq('company_id', chave.companyId).eq('contact_id', c.id)
        if (ehUuid(a.conexao_id)) q = q.eq('connection_id', a.conexao_id)
        chat = (await q.order('last_message_at', { ascending: false }).limit(1).maybeSingle()).data
      }
    } else return erro('Informe conversa_id ou telefone.')
    if (!chat) return erro('Conversa não encontrada.')
    const limite = Math.min(100, Math.max(1, Math.floor(Number(a.limite) || 30)))
    const [{ data: contato }, { data: msgs }] = await Promise.all([
      admin.from('contacts').select('id, name, phone').eq('id', chat.contact_id).maybeSingle(),
      admin.from('messages').select('sender, text, type, media_url, delivery, at, extra').eq('chat_id', chat.id).eq('company_id', chave.companyId).order('at', { ascending: false }).limit(limite),
    ])
    const DE: Record<string, string> = { contact: 'contato', agent: 'atendente', bot: 'automação', sys: 'sistema' }
    const mensagens = await Promise.all((msgs || []).reverse().map(async (m: any) => {
      let midia: string | null = null
      if (m.media_url) midia = (await admin.storage.from(BUCKET).createSignedUrl(m.media_url, 3600)).data?.signedUrl ?? null
      return { de: DE[m.sender] || m.sender, texto: m.text, tipo: m.type, em: m.at, entrega: m.delivery, ...(midia && { midia_link_1h: midia }), ...(m.extra?.via === 'mcp' && { via_mcp: true }) }
    }))
    return texto({ conversa_id: chat.id, conexao_id: chat.connection_id, status: chat.status, contato: contato && { id: contato.id, nome: contato.name, telefone: contato.phone }, mensagens })
  },
}

/* ---------- Escrita (chave "envio") ---------- */

const salvarContato: Ferramenta = {
  name: 'salvar_contato', title: 'Criar ou editar contato', envio: true, modulos: ['contatos'],
  description: 'Cria um contato (sem contato_id; se o telefone já existir, edita esse) ou edita um existente. Etiquetas por nome: as que não existem são criadas. Campos personalizados entram somados aos atuais.',
  inputSchema: {
    type: 'object',
    properties: {
      contato_id: UUID,
      nome: { type: 'string' },
      telefone: { type: 'string', description: 'Com DDD; o 55 é opcional.' },
      email: { type: 'string' },
      etiquetas: { type: 'array', items: { type: 'string' }, description: 'Nomes das etiquetas (substitui as atuais).' },
      adicionar_etiquetas: { type: 'array', items: { type: 'string' }, description: 'Nomes de etiquetas a somar às atuais.' },
      campos: { type: 'object', description: 'Campos personalizados (chave: valor).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  async executar(admin, chave, a) {
    const cid = chave.companyId
    let contato: any = null
    const digitos = a.telefone !== undefined ? numeroWhatsapp(a.telefone) : null
    if (a.telefone !== undefined && !digitos) return erro('Telefone inválido: use DDD + número (o 55 é opcional).')
    if (a.contato_id !== undefined) {
      if (!ehUuid(a.contato_id)) return erro('contato_id inválido.')
      contato = (await admin.from('contacts').select('*').eq('company_id', cid).eq('id', a.contato_id).maybeSingle()).data
      if (!contato) return erro('Contato não encontrado.')
    } else if (digitos) contato = await contatoPorTelefone(admin, cid, digitos)
    if (!contato && !digitos) return erro('Para criar um contato, informe o telefone.')

    const etiquetas = await mapaEtiquetas(admin, cid)
    const idsDe = async (nomes: unknown): Promise<string[]> => {
      const out: string[] = []
      for (const n of Array.isArray(nomes) ? nomes : []) {
        const nome = str(n)
        if (!nome) continue
        let id = ehUuid(nome) && etiquetas.has(nome) ? nome : [...etiquetas].find(([, x]) => x.toLowerCase() === nome.toLowerCase())?.[0]
        if (!id) {
          const { data, error } = await admin.from('labels').insert({ company_id: cid, name: nome.slice(0, 60) }).select('id, name').single()
          if (error) throw error
          id = data.id
          etiquetas.set(data.id, data.name)
        }
        if (!out.includes(id!)) out.push(id!)
      }
      return out
    }

    const patch: Record<string, unknown> = {}
    if (str(a.nome)) patch.name = str(a.nome).slice(0, 120)
    if (digitos) patch.phone = `+${digitos}`
    if (a.email !== undefined) patch.email = str(a.email)
    if (a.etiquetas !== undefined) patch.labels = await idsDe(a.etiquetas)
    if (a.adicionar_etiquetas !== undefined) patch.labels = [...new Set([...((patch.labels as string[]) ?? contato?.labels ?? []), ...(await idsDe(a.adicionar_etiquetas))])]
    if (a.campos && typeof a.campos === 'object' && !Array.isArray(a.campos)) patch.fields = { ...(contato?.fields || {}), ...a.campos }

    let salvo: any
    if (contato) {
      if (!Object.keys(patch).length) return erro('Nada para alterar.')
      const { data, error } = await admin.from('contacts').update(patch).eq('id', contato.id).eq('company_id', cid).select('*').single()
      if (error) return erro(`Não foi possível salvar: ${error.message}`)
      salvo = data
    } else {
      const { data, error } = await admin.from('contacts').insert({ company_id: cid, name: patch.name || `+${digitos}`, status: 'lead', origin: 'MCP', ...patch }).select('*').single()
      if (error) return erro(`Não foi possível criar: ${error.message}`)
      salvo = data
    }
    return texto({ mensagem: contato ? 'Contato atualizado.' : 'Contato criado.', contato: contatoPublico(salvo, etiquetas) })
  },
}

type Arquivo = { url: string; mime: string; nome: string; tamanho: number; path: string | null }

// como_documento: a mídia vai como arquivo (o WhatsApp não comprime foto nem vídeo). Sem ele, decide pelo tipo e tamanho.
const COMO_DOCUMENTO = { type: 'boolean', description: 'Manda a imagem, o vídeo ou o áudio como documento, sem a compressão do WhatsApp (ex.: foto em qualidade original).' } as const
const tipoDeEnvio = (provider: Provider, arquivo: Arquivo | null, a: Args): MediaKind | null =>
  !arquivo ? null : a.como_documento === true ? 'document' : outgoingKind(provider, arquivo.mime, arquivo.tamanho)

// Arquivo de preparar_upload (a.arquivo) ou link público (a.midia_url) → o que o provedor baixa.
// null = sem arquivo; texto = erro para devolver a quem chamou.
async function lerArquivo(admin: any, cid: string, a: Args): Promise<Arquivo | null | string> {
  if (str(a.arquivo)) {
    const path = str(a.arquivo)
    const pasta = `${cid}/mcp`
    const nome = path.slice(pasta.length + 1)
    if (!path.startsWith(pasta + '/') || !nome || nome.includes('/')) return 'arquivo inválido: use o caminho devolvido por preparar_upload.'
    const { data: achados } = await admin.storage.from(BUCKET).list(pasta, { search: nome, limit: 5 })
    const obj = achados?.find((o: any) => o.name === nome)
    if (!obj) return 'O arquivo não chegou ao servidor. Faça o PUT no upload_url de preparar_upload antes.'
    const { data: link } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600)
    if (!link?.signedUrl) return 'Não foi possível ler o arquivo.'
    const nomeVisivel = str(a.nome_arquivo) || nome.replace(/^\d+-[0-9a-f]{8}-/, '')
    return { url: link.signedUrl, mime: obj.metadata?.mimetype || MIME[extensao(nome)] || 'application/octet-stream', nome: nomeVisivel, tamanho: Number(obj.metadata?.size) || 0, path }
  }
  if (str(a.midia_url)) {
    const url = str(a.midia_url)
    if (!/^https:\/\//i.test(url)) return 'midia_url precisa ser um link https.'
    const nome = str(a.nome_arquivo) || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arquivo')
    // tipo_midia manda quando a extensão do link não bate com ele (ou não existe)
    const forcado = TIPOS[str(a.tipo_midia)]
    let mime = MIME[extensao(url)] || MIME[extensao(nome)] || ''
    if (forcado && (!mime || mediaKind(mime) !== forcado)) mime = MIME_PADRAO[forcado]
    return { url, mime: mime || 'application/octet-stream', nome, tamanho: 0, path: null }
  }
  return null
}

const prepararUpload: Ferramenta = {
  name: 'preparar_upload', title: 'Preparar envio de arquivo', envio: true, modulos: ['chat', 'conexoes'],
  description: `Gera um link para subir um arquivo do computador (vale 2 horas). Faça PUT do arquivo no upload_url (ex.: curl -X PUT -H "Content-Type: <tipo>" --data-binary @arquivo "<upload_url>") e passe o "arquivo" devolvido em enviar_mensagem ou enviar_mensagem_grupo. Limite ${MEDIA_MAX_MB.document} MB.`,
  inputSchema: {
    type: 'object',
    properties: { nome_arquivo: { type: 'string', description: 'Nome com extensão (ex.: proposta.pdf).' }, tamanho_bytes: { type: 'integer', minimum: 1 } },
    required: ['nome_arquivo'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  async executar(admin, chave, a) {
    const nome = nomeSeguro(str(a.nome_arquivo))
    if (Number(a.tamanho_bytes) > MEDIA_MAX_MB.document * 1024 * 1024) return erro(`Arquivo grande demais: o limite é ${MEDIA_MAX_MB.document} MB.`)
    const path = `${chave.companyId}/mcp/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${nome}`
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error || !data) return erro('Não foi possível preparar o envio do arquivo.')
    return texto({ upload_url: data.signedUrl, metodo: 'PUT', content_type: MIME[extensao(nome)] || 'application/octet-stream', arquivo: path })
  },
}

const enviarMensagem: Ferramenta = {
  name: 'enviar_mensagem', title: 'Enviar mensagem no WhatsApp', envio: true, modulos: ['chat', 'conexoes'],
  description:
    'Manda uma mensagem REAL pelo WhatsApp da empresa: texto e/ou um arquivo (de preparar_upload) ou link de mídia. Destino: telefone (cria o contato e a conversa se não existirem), contato_id ou conversa_id. ' +
    'Conversa nova aberta por aqui fica com a automação desligada (sem fluxo nem IA nas respostas). Confirme destinatário e texto com o usuário antes. Um destinatário por chamada.',
  inputSchema: {
    type: 'object',
    properties: {
      telefone: { type: 'string', description: 'Com DDD; o 55 é opcional.' },
      contato_id: UUID,
      conversa_id: UUID,
      nome: { type: 'string', description: 'Nome do contato, se ele ainda não existir.' },
      conexao_id: { ...UUID, description: 'Número que envia. Sem ele: o da conversa, ou o único conectado da empresa.' },
      texto: { type: 'string', description: 'Mensagem (até 4096 caracteres; com arquivo vira a legenda, até 1024).' },
      arquivo: { type: 'string', description: 'Caminho devolvido por preparar_upload.' },
      midia_url: { type: 'string', description: 'Ou um link público (https) da mídia.' },
      tipo_midia: { type: 'string', enum: ['imagem', 'video', 'audio', 'documento'], description: 'Com midia_url: o tipo, se a extensão do link não deixar claro.' },
      nome_arquivo: { type: 'string', description: 'Nome que o contato vê no documento.' },
      como_documento: COMO_DOCUMENTO,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async executar(admin, chave, a) {
    const cid = chave.companyId
    const msg = str(a.texto)
    const temArquivo = !!(str(a.arquivo) || str(a.midia_url))
    if (!msg && !temArquivo) return erro('Informe texto e/ou arquivo (ou midia_url).')
    if (str(a.arquivo) && str(a.midia_url)) return erro('Use arquivo OU midia_url, não os dois.')
    if (msg.length > (temArquivo ? 1024 : 4096)) return erro(temArquivo ? 'Legenda muito longa (máx. 1024).' : 'Mensagem muito longa (máx. 4096).')

    // 1) Conversa e contato de destino
    let chat: any = null
    let contato: any = null
    if (a.conversa_id !== undefined) {
      if (!ehUuid(a.conversa_id)) return erro('conversa_id inválido.')
      chat = (await admin.from('chats').select('*').eq('company_id', cid).eq('id', a.conversa_id).maybeSingle()).data
      if (!chat) return erro('Conversa não encontrada.')
      contato = (await admin.from('contacts').select('*').eq('id', chat.contact_id).single()).data
    } else if (a.contato_id !== undefined) {
      if (!ehUuid(a.contato_id)) return erro('contato_id inválido.')
      contato = (await admin.from('contacts').select('*').eq('company_id', cid).eq('id', a.contato_id).maybeSingle()).data
      if (!contato) return erro('Contato não encontrado.')
    } else if (a.telefone !== undefined) {
      const d = numeroWhatsapp(a.telefone)
      if (!d) return erro('Telefone inválido: use DDD + número (o 55 é opcional).')
      contato = await contatoPorTelefone(admin, cid, d)
      if (!contato) {
        const { data, error } = await admin.from('contacts').insert({ company_id: cid, name: str(a.nome).slice(0, 120) || `+${d}`, phone: `+${d}`, status: 'lead', origin: 'MCP' }).select('*').single()
        if (error) return erro(`Não foi possível criar o contato: ${error.message}`)
        contato = data
      }
    } else return erro('Informe telefone, contato_id ou conversa_id.')
    if (!onlyDigits(contato?.phone || '')) return erro('O contato não tem telefone.')

    // 2) Conexão que envia
    const { data: conexoes } = await admin.from('connections').select('id, name, number, provider, status').eq('company_id', cid)
    let conexao: any = null
    if (a.conexao_id !== undefined) {
      conexao = (conexoes || []).find((c: any) => c.id === a.conexao_id)
      if (!conexao) return erro('Conexão não encontrada. Veja listar_conexoes.')
      if (chat && chat.connection_id !== conexao.id) return erro('Essa conversa é de outra conexão. Mande pelo telefone ou contato_id para usar esta conexão.')
    } else if (chat?.connection_id) conexao = (conexoes || []).find((c: any) => c.id === chat.connection_id)
    else {
      const ativas = (conexoes || []).filter((c: any) => c.status === 'connected')
      if (ativas.length === 1) conexao = ativas[0]
      else if (!ativas.length) return erro('Nenhuma conexão de WhatsApp conectada na empresa.')
      else return erro(`Mais de uma conexão conectada: informe conexao_id. ${JSON.stringify(ativas.map(conexaoPublica))}`)
    }
    if (!conexao) return erro('A conversa não tem conexão. Informe conexao_id.')
    const segredo = await connectionSecret(admin, conexao.id)
    if (!segredo) return erro(`A conexão "${conexao.name}" não está configurada para enviar.`)
    const provider = segredo.provider as Provider

    // 3) Arquivo
    const lido = await lerArquivo(admin, cid, a)
    if (typeof lido === 'string') return erro(lido)
    const arquivo = lido
    const kind = tipoDeEnvio(provider, arquivo, a)

    // 4) Conversa (nova: automação desligada, para as respostas não caírem em fluxo nem em agente de IA)
    let conversaNova = false
    if (!chat) {
      chat = (await admin.from('chats').select('*').eq('company_id', cid).eq('contact_id', contato.id).eq('connection_id', conexao.id).order('last_message_at', { ascending: false }).limit(1).maybeSingle()).data
      if (!chat) {
        const { data, error } = await admin.from('chats').insert({ company_id: cid, contact_id: contato.id, connection_id: conexao.id, status: 'waiting', bot_active: false, answered: true, last_message_at: new Date().toISOString() }).select('*').single()
        if (error) return erro(`Não foi possível abrir a conversa: ${error.message}`)
        chat = data
        conversaNova = true
      }
    }

    // 5) Envio pelo provedor
    let telefone = onlyDigits(contato.phone)
    let numeroCerto: string | null = null
    const certo = (n: string) => { numeroCerto = n }
    let waId: string | null = null
    let entrega = 'sent'
    let falhou = ''
    let comoLink = false
    try {
      if (arquivo && kind) {
        const legenda = kind !== 'audio' && msg ? msg : undefined
        try {
          waId = await sendMedia(provider, segredo.credentials, telefone, { kind, url: arquivo.url, mime: arquivo.mime, fileName: arquivo.nome, caption: legenda }, certo)
        } catch (e) {
          if (kind !== 'document') throw e
          // provedor sem envio de documento: manda o link, como o painel faz
          let link = arquivo.url
          if (arquivo.path) link = (await admin.storage.from(BUCKET).createSignedUrl(arquivo.path, 7 * 86400)).data?.signedUrl || link
          waId = await sendText(provider, segredo.credentials, telefone, `${msg ? msg + '\n' : ''}📎 ${arquivo.nome}: ${link}`, certo)
          comoLink = true
        }
        if (numeroCerto) telefone = numeroCerto
        if (kind === 'audio' && msg) await sendText(provider, segredo.credentials, telefone, msg)
      } else {
        waId = await sendText(provider, segredo.credentials, telefone, msg, certo)
      }
      if (numeroCerto) await admin.from('contacts').update({ phone: `+${numeroCerto}` }).eq('id', contato.id)
    } catch (e) {
      entrega = 'failed'
      falhou = String((e as Error)?.message || e).slice(0, 300)
      console.error('mcp: falha no provedor', e)
    }

    // 6) Registro no painel (aparece no Chat ao Vivo como enviada por atendente, marcada como via MCP)
    const agora = new Date().toISOString()
    const { error: insErr } = await admin.from('messages').insert({
      company_id: cid, chat_id: chat.id, sender: 'agent', wa_id: waId, delivery: entrega, at: agora,
      text: arquivo && kind ? msg || LABEL[kind] || `📎 ${arquivo.nome}` : msg,
      ...(arquivo && kind && { type: kind, media_url: arquivo.path }),
      extra: { via: 'mcp', chave: chave.nome, ...(arquivo && { file: arquivo.nome }), ...(arquivo && !arquivo.path && { url: arquivo.url }), ...(comoLink && { asLink: true }) },
    })
    if (insErr && insErr.code !== '23505') console.error('mcp: registro da mensagem', insErr.message)
    if (entrega === 'sent') {
      await admin.from('chats').update({ last_message_at: agora, answered: true }).eq('id', chat.id)
      if (!conversaNova) {
        const { data: depois } = await admin.from('chats').select('*').eq('id', chat.id).single()
        if (depois) await pauseForHuman(admin, depois, '👤 Mensagem enviada pelo assistente (MCP). IA pausada nesta conversa.').catch((e: unknown) => console.error('mcp: pausa da IA', e))
      }
    }

    const resumo = { conversa_id: chat.id, contato: { id: contato.id, nome: contato.name, telefone: `+${telefone}` }, conexao: conexaoPublica(conexao), conversa_nova: conversaNova }
    if (entrega === 'failed') return erro(`O WhatsApp recusou o envio${falhou ? `: ${falhou}` : ''}. Confira a conexão e o número. ${JSON.stringify(resumo)}`)
    return texto({ enviado: true, ...resumo, ...(kind && { midia: kind }), ...(comoLink && { observacao: 'O documento foi como link.' }) })
  },
}

/* ---------- Grupos (só conexão por QR Code) ---------- */

// grupo_id: o JID (120363…@g.us) ou só os dígitos dele. Grupo antigo tem a forma <número>-<data>@g.us.
function grupoJid(v: unknown): string | null {
  const s = str(v).toLowerCase().replace(/@g\.us$/, '')
  return /^\d{6,30}(-\d{6,15})?$/.test(s) ? `${s}@g.us` : null
}
const semAcento = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const grupoPublico = (g: any) => ({
  grupo_id: g.groupId, nome: g.name || '', participantes: g.participantCount ?? null, sou_admin: !!g.amAdmin, so_admins_mandam: !!g.announce,
  ...(g.communityId && { comunidade_id: g.communityId }), ...(g.isCommunity && { eh_comunidade: true }), ...(g.isAnnouncementGroup && { avisos_da_comunidade: true }),
})

// Conexão que fala com os grupos: a informada ou a única conectada da empresa. Precisa ser QR Code (Zapbot):
// a API oficial da Meta não manda em grupo comum de WhatsApp.
async function conexaoDeGrupos(admin: any, cid: string, conexaoId: unknown): Promise<{ conexao: any; provider: Provider; creds: Creds } | string> {
  const { data: conexoes } = await admin.from('connections').select('id, name, number, provider, status').eq('company_id', cid)
  let conexao: any = null
  if (conexaoId !== undefined) {
    conexao = (conexoes || []).find((c: any) => c.id === conexaoId)
    if (!conexao) return 'Conexão não encontrada. Veja listar_conexoes.'
  } else {
    const ativas = (conexoes || []).filter((c: any) => c.status === 'connected')
    if (ativas.length === 1) conexao = ativas[0]
    else if (!ativas.length) return 'Nenhuma conexão de WhatsApp conectada na empresa.'
    else return `Mais de uma conexão conectada: informe conexao_id. ${JSON.stringify(ativas.map(conexaoPublica))}`
  }
  const segredo = await connectionSecret(admin, conexao.id)
  if (!segredo) return `A conexão "${conexao.name}" não está configurada para enviar.`
  if (segredo.provider !== 'zapbot')
    return `Grupos só funcionam em conexão por QR Code. "${conexao.name}" é ${segredo.provider === 'meta' ? 'da API oficial da Meta, que não manda em grupo' : `do tipo ${segredo.provider}`}.`
  return { conexao, provider: segredo.provider as Provider, creds: segredo.credentials }
}

// Grupos do número. Na prática o Zapbot devolve a lista pura ([...]), não { groups: [...] } como diz a doc
// (conferido em 23/10/2026, 592 grupos em ~3 s): aceita os dois.
async function gruposDoNumero(creds: Creds): Promise<any[]> {
  const r = await instanceCall(creds as unknown as ZapCreds, 'GET', 'groups')
  if (r.status !== 200) throw new Error(String(r.json?.error || `HTTP ${r.status}`))
  const j: unknown = r.json
  return Array.isArray(j) ? j : Array.isArray(r.json?.groups) ? r.json.groups : []
}
const falhaGrupos = (e: unknown) => erro(`Não deu para ler os grupos do WhatsApp (${String((e as Error)?.message || e).slice(0, 200)}). Confira se o número está conectado.`)

const listarGrupos: Ferramenta = {
  name: 'listar_grupos', title: 'Listar grupos do WhatsApp', envio: false, modulos: ['conexoes'],
  description:
    'Lista os grupos de que o número conectado por QR Code participa: grupo_id, nome, participantes, se o número é admin e se só admins mandam mensagem. ' +
    'Use o grupo_id em enviar_mensagem_grupo. Em ordem de nome, 50 por página.',
  inputSchema: {
    type: 'object',
    properties: {
      busca: { type: 'string', description: 'Parte do nome do grupo (acento e maiúscula não importam).' },
      conexao_id: { ...UUID, description: 'Número cujos grupos listar. Sem ele: o único conectado da empresa.' },
      pagina: PAGINA,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async executar(admin, chave, a) {
    const c = await conexaoDeGrupos(admin, chave.companyId, a.conexao_id)
    if (typeof c === 'string') return erro(c)
    let grupos: any[]
    try {
      grupos = await gruposDoNumero(c.creds)
    } catch (e) {
      return falhaGrupos(e)
    }
    const busca = semAcento(str(a.busca))
    const achados = grupos.filter((g) => !busca || semAcento(g.name).includes(busca)).sort((x, y) => semAcento(x.name).localeCompare(semAcento(y.name)))
    const p = pagina(a.pagina)
    const [de, ate] = faixa(p)
    return texto({ conexao: conexaoPublica(c.conexao), total: achados.length, pagina: p, grupos: achados.slice(de, ate + 1).map(grupoPublico) })
  },
}

const enviarMensagemGrupo: Ferramenta = {
  name: 'enviar_mensagem_grupo', title: 'Enviar mensagem em grupo do WhatsApp', envio: true, modulos: ['conexoes'],
  description:
    'Manda uma mensagem REAL num grupo de WhatsApp do número conectado por QR Code: texto e/ou um arquivo (de preparar_upload) ou link de mídia. Pegue o grupo_id em listar_grupos. ' +
    'Todo mundo do grupo recebe: confirme com o usuário o grupo (nome e tamanho) e o texto antes. Um grupo por chamada. ' +
    'A mesma mensagem em muitos grupos seguidos é o que mais derruba número: espace os envios (1 a 2 minutos entre um grupo e outro).',
  inputSchema: {
    type: 'object',
    properties: {
      grupo_id: { type: 'string', description: 'O grupo_id de listar_grupos (ex.: 120363000000000000@g.us).' },
      conexao_id: { ...UUID, description: 'Número que envia. Sem ele: o único conectado da empresa.' },
      texto: { type: 'string', description: 'Mensagem (até 4096 caracteres; com arquivo vira a legenda, até 1024).' },
      arquivo: { type: 'string', description: 'Caminho devolvido por preparar_upload.' },
      midia_url: { type: 'string', description: 'Ou um link público (https) da mídia.' },
      tipo_midia: { type: 'string', enum: ['imagem', 'video', 'audio', 'documento'], description: 'Com midia_url: o tipo, se a extensão do link não deixar claro.' },
      nome_arquivo: { type: 'string', description: 'Nome que aparece no documento.' },
      como_documento: COMO_DOCUMENTO,
    },
    required: ['grupo_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async executar(admin, chave, a) {
    const msg = str(a.texto)
    const temArquivo = !!(str(a.arquivo) || str(a.midia_url))
    if (!msg && !temArquivo) return erro('Informe texto e/ou arquivo (ou midia_url).')
    if (str(a.arquivo) && str(a.midia_url)) return erro('Use arquivo OU midia_url, não os dois.')
    if (msg.length > (temArquivo ? 1024 : 4096)) return erro(temArquivo ? 'Legenda muito longa (máx. 1024).' : 'Mensagem muito longa (máx. 4096).')
    const jid = grupoJid(a.grupo_id)
    if (!jid) return erro('grupo_id inválido: use o que vem em listar_grupos (ex.: 120363000000000000@g.us).')

    const c = await conexaoDeGrupos(admin, chave.companyId, a.conexao_id)
    if (typeof c === 'string') return erro(c)
    // Só manda em grupo de que o número participa e onde ele pode falar: um ID errado não vai parar em outro lugar.
    let grupos: any[]
    try {
      grupos = await gruposDoNumero(c.creds)
    } catch (e) {
      return falhaGrupos(e)
    }
    const g = grupos.find((x) => String(x.groupId || '').toLowerCase() === jid)
    if (!g) return erro('Esse grupo não está entre os grupos do número conectado. Veja listar_grupos.')
    if (g.isCommunity) return erro('Esse ID é a comunidade em si, que não recebe mensagem. Mande no grupo de avisos dela (veja listar_grupos).')
    if (g.announce && !g.amAdmin) return erro(`Em "${g.name}" só administradores mandam mensagem, e o número conectado não é admin.`)

    const lido = await lerArquivo(admin, chave.companyId, a)
    if (typeof lido === 'string') return erro(lido)
    const arquivo = lido
    const kind = tipoDeEnvio(c.provider, arquivo, a)

    let waId: string | null = null
    let comoLink = false
    try {
      if (arquivo && kind) {
        const legenda = kind !== 'audio' && msg ? msg : undefined
        try {
          waId = await sendMedia(c.provider, c.creds, jid, { kind, url: arquivo.url, mime: arquivo.mime, fileName: arquivo.nome, caption: legenda })
        } catch (e) {
          if (kind !== 'document') throw e
          // provedor sem envio de documento: manda o link, como em enviar_mensagem
          let link = arquivo.url
          if (arquivo.path) link = (await admin.storage.from(BUCKET).createSignedUrl(arquivo.path, 7 * 86400)).data?.signedUrl || link
          waId = await sendText(c.provider, c.creds, jid, `${msg ? msg + '\n' : ''}📎 ${arquivo.nome}: ${link}`)
          comoLink = true
        }
        if (kind === 'audio' && msg) await sendText(c.provider, c.creds, jid, msg)
      } else {
        waId = await sendText(c.provider, c.creds, jid, msg)
      }
    } catch (e) {
      console.error('mcp: falha no envio ao grupo', e)
      return erro(`O WhatsApp recusou o envio: ${String((e as Error)?.message || e).slice(0, 300)}. ${JSON.stringify({ grupo: grupoPublico(g) })}`)
    }
    // Grupo não vira conversa no painel: o rastro fica no log da função (sem o texto).
    console.log('mcp: enviado ao grupo', JSON.stringify({ chave: chave.id, conexao: c.conexao.id, grupo: jid, wa_id: waId, midia: kind }))
    return texto({ enviado: true, grupo: grupoPublico(g), conexao: conexaoPublica(c.conexao), mensagem_id: waId, ...(kind && { midia: kind }), ...(comoLink && { observacao: 'O documento foi como link.' }) })
  },
}

/* ---------- Registro ---------- */

const FERRAMENTAS: Ferramenta[] = [
  listarConexoes, buscarContatos, verContato, listarEtiquetas, listarConversas, lerConversa, listarGrupos,
  salvarContato, prepararUpload, enviarMensagem, enviarMensagemGrupo,
]

export const acharFerramenta = (nome: string) => FERRAMENTAS.find((f) => f.name === nome)

export const listaDeFerramentas = () =>
  FERRAMENTAS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))

export async function chamarFerramenta(admin: any, f: Ferramenta, chave: Chave, args: Args): Promise<Resultado> {
  if (f.envio && chave.escopo !== 'envio') return erro('Esta chave só tem permissão de leitura.')
  const mods = await companyModules(admin, chave.companyId)
  const faltam = f.modulos.filter((m) => !mods.has(m))
  if (faltam.length) return erro(`Módulo não liberado para a empresa: ${faltam.map((m) => MODULE_NAMES[m] || m).join(', ')}.`)
  return f.executar(admin, chave, args)
}
