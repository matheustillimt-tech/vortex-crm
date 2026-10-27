// Dados de demonstração para o app parecer "vivo" na primeira abertura.
const DAY = 86400000
const now = Date.now()
const ago = (ms) => new Date(now - ms).toISOString()

const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Heitor', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Olívia', 'Paula', 'Renato', 'Sabrina', 'Tiago', 'Vanessa', 'William']
const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Lima', 'Costa', 'Pereira', 'Almeida', 'Ferreira', 'Rodrigues']
const UF = ['SP', 'RJ', 'MG', 'BA', 'PR', 'RS', 'PE', 'CE', 'GO', 'SC']

let seed = 42
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const pick = (a) => a[Math.floor(rnd() * a.length)]

export const LABEL_COLORS = ['#7fee64', '#22C55E', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6']

export function buildSeed() {
  seed = 42
  const labels = [
    { id: 'l1', name: 'Quente', color: '#EF4444' },
    { id: 'l2', name: 'Comprou', color: '#22C55E' },
    { id: 'l3', name: 'Aguardando Pix', color: '#F59E0B' },
    { id: 'l4', name: 'Anúncio Meta', color: '#3B82F6' },
    { id: 'l5', name: 'Recompra', color: '#8B5CF6' },
  ]

  const departments = [
    { id: 'd1', name: 'Vendas', color: '#8B5CF6' },
    { id: 'd2', name: 'Suporte', color: '#3B82F6' },
    { id: 'd3', name: 'Financeiro', color: '#22C55E' },
  ]

  const connections = [
    { id: 'c1', name: 'Vendas Principal', number: '+55 11 4000-1001', provider: 'web', plan: 'pro', status: 'connected', createdAt: ago(40 * DAY) },
    { id: 'c2', name: 'Suporte', number: '+55 11 4000-2002', provider: 'oficial', plan: 'starter', status: 'connected', createdAt: ago(25 * DAY) },
    { id: 'c3', name: 'Remarketing', number: '+55 21 4000-3003', provider: 'web', plan: 'starter', status: 'disconnected', createdAt: ago(10 * DAY) },
  ]

  const products = [
    { id: 'p1', name: 'Kit Completo', price: 197, min: 147, max: 247, currency: 'BRL' },
    { id: 'p2', name: 'Curso Online', price: 497, min: 397, max: 597, currency: 'BRL' },
    { id: 'p3', name: 'Mentoria VIP', price: 1497, min: 997, max: 1997, currency: 'BRL' },
    { id: 'p4', name: 'E-book', price: 47, min: 27, max: 67, currency: 'BRL' },
  ]

  const contacts = Array.from({ length: 36 }, (_, i) => {
    const name = `${pick(FIRST)} ${pick(LAST)}`
    return {
      id: 'ct' + (i + 1),
      name,
      phone: `+55 ${10 + Math.floor(rnd() * 89)} 9${Math.floor(1000 + rnd() * 8999)}-${Math.floor(1000 + rnd() * 8999)}`,
      email: name.toLowerCase().replace(/[^a-z]/g, '.').replace(/\.+/g, '.') + '@email.com',
      status: rnd() > 0.45 ? 'ativo' : 'lead',
      origin: pick(['WhatsApp', 'Anúncio Meta', 'Webhook', 'Importação', 'Manual']),
      state: pick(UF),
      labels: rnd() > 0.5 ? [pick(labels).id] : [],
      connectionId: pick(connections).id,
      createdAt: ago(Math.floor(rnd() * 60) * DAY + Math.floor(rnd() * DAY)),
      fields: {},
    }
  })

  const TEXTS_IN = ['Oi, vi o anúncio de vocês', 'Quanto custa o kit?', 'Tem frete grátis?', 'Aceita Pix?', 'Quero comprar!', 'Me manda o link', 'Ainda está na promoção?', 'Qual o prazo de entrega?', 'Já fiz o pagamento', 'Pode me ajudar?']
  const TEXTS_OUT = ['Oi! Tudo bem? Que bom que você chegou 😊', 'O kit sai por R$ 197 com frete grátis.', 'Aceitamos Pix, cartão e boleto.', 'Te mando o link agora mesmo!', 'Pagamento confirmado, obrigado!', 'O prazo é de 3 a 7 dias úteis.']

  const chats = []
  const messages = {}
  contacts.slice(0, 18).forEach((c, i) => {
    const id = 'ch' + (i + 1)
    const status = i < 5 ? 'waiting' : i < 12 ? 'attending' : 'resolved'
    const last = now - Math.floor(rnd() * 3 * DAY)
    const msgs = []
    const n = 3 + Math.floor(rnd() * 6)
    for (let k = 0; k < n; k++) {
      const fromContact = k % 2 === 0
      msgs.push({
        id: id + 'm' + k,
        from: fromContact ? 'contact' : k === 1 ? 'bot' : 'agent',
        text: fromContact ? pick(TEXTS_IN) : pick(TEXTS_OUT),
        at: new Date(last - (n - k) * 6 * 60000).toISOString(),
      })
    }
    messages[id] = msgs
    chats.push({
      id,
      contactId: c.id,
      connectionId: c.connectionId,
      status,
      unread: status === 'waiting' ? 1 + Math.floor(rnd() * 4) : 0,
      answered: msgs[msgs.length - 1].from !== 'contact',
      assignedTo: status === 'attending' ? 'u1' : null,
      departmentId: pick(departments).id,
      lastMessageAt: msgs[msgs.length - 1].at,
      botActive: rnd() > 0.5,
    })
  })

  // Instagram (Direct pela Zernio): uma conta conectada e três conversas, uma em cada situação da janela de resposta
  // (dentro das 24 h, só humano até 7 dias, e fechada). Sem rnd() para não mudar os outros dados de exemplo.
  connections.push({ id: 'c4', name: 'Instagram da loja', number: '@vortex.demo', provider: 'instagram', plan: 'starter', status: 'connected', igName: 'Vórtex Demo', keyHint: '••••d3m0', createdAt: ago(3 * DAY) })
  const IG = [
    { id: 'ig1', name: 'Júlia Martins', user: 'juliamartins.fit', follower: true, followers: 1840, last: 25 * 60000, status: 'waiting', unread: 2,
      msgs: [['contact', 'Oi! Vi o reels do kit, ainda tem?'], ['contact', 'Quanto fica com frete pra BH?']] },
    { id: 'ig2', name: 'Pedro Alves', user: 'pedro.alvess', follower: false, followers: 312, last: 30 * 3600000, status: 'attending', unread: 0,
      msgs: [['contact', 'Vocês parcelam no cartão?'], ['agent', 'Oi Pedro! Parcelamos em até 12x. Quer o link?'], ['contact', 'Vou ver e te falo']] },
    { id: 'ig3', name: 'Camila Rocha', user: 'camilarocha', follower: null, followers: null, last: 9 * DAY, status: 'resolved', unread: 0,
      msgs: [['contact', 'Chegou certinho, obrigada!'], ['agent', 'Que bom, Camila! Qualquer coisa é só chamar 💜']] },
  ]
  IG.forEach((g, i) => {
    contacts.push({
      id: 'ct-' + g.id, name: g.name, phone: '', email: '', status: 'lead', origin: 'Instagram', state: '', labels: i === 0 ? ['l1'] : [],
      connectionId: 'c4', createdAt: ago(g.last + 3600000), fields: {}, instagramId: 'igsid-' + g.id, instagramUsername: g.user,
      instagramProfile: { isFollower: g.follower, followerCount: g.followers, isVerified: false },
    })
    const lastAt = now - g.last
    // a última mensagem do cliente é a que conta para a janela
    const lastContact = g.msgs.map((m) => m[0]).lastIndexOf('contact')
    messages['ch-' + g.id] = g.msgs.map(([from, text], k) => ({
      id: `ch-${g.id}m${k}`, from, text, at: new Date(lastAt - (lastContact - k) * 4 * 60000).toISOString(),
    }))
    const ms = messages['ch-' + g.id]
    chats.push({
      id: 'ch-' + g.id, contactId: 'ct-' + g.id, connectionId: 'c4', externalId: 'conv-' + g.id, status: g.status, unread: g.unread,
      answered: ms[ms.length - 1].from !== 'contact', assignedTo: g.status === 'attending' ? 'u1' : null, departmentId: 'd1',
      lastMessageAt: ms[ms.length - 1].at, botActive: false,
    })
  })

  const sales = Array.from({ length: 70 }, (_, i) => {
    const p = pick(products)
    const c = pick(contacts)
    const t = now - Math.floor(rnd() * 30) * DAY - Math.floor(rnd() * 14 * 3600000)
    return {
      id: 's' + (i + 1),
      connectionId: c.connectionId,
      contactId: c.id,
      productId: p.id,
      value: p.price,
      currency: 'BRL',
      state: c.state,
      sourceId: rnd() > 0.5 ? '1202' + Math.floor(rnd() * 99999999) : '',
      at: new Date(t).toISOString(),
    }
  })

  const kanbans = [
    {
      id: 'k1',
      name: 'Funil de Vendas',
      color: '#8B5CF6',
      columns: [
        { id: 'col1', name: 'Novo lead', color: '#3B82F6' },
        { id: 'col2', name: 'Em negociação', color: '#F59E0B' },
        { id: 'col3', name: 'Aguardando Pix', color: '#EC4899' },
        { id: 'col4', name: 'Comprou', color: '#22C55E', conversion: true },
        { id: 'col5', name: 'Perdido', color: '#EF4444' },
      ],
      cards: contacts.slice(0, 16).map((c, i) => ({
        id: 'cd' + (i + 1),
        columnId: ['col1', 'col1', 'col2', 'col2', 'col3', 'col4', 'col4', 'col5'][i % 8],
        contactId: c.id,
        title: c.name,
        value: pick(products).price,
        labels: c.labels,
        assignee: 'u1',
        updatedAt: ago(Math.floor(rnd() * 10) * DAY),
      })),
    },
    {
      id: 'k2',
      name: 'Pós-venda',
      color: '#22C55E',
      columns: [
        { id: 'pc1', name: 'Entregue', color: '#3B82F6' },
        { id: 'pc2', name: 'Pediu suporte', color: '#F59E0B' },
        { id: 'pc3', name: 'Recompra', color: '#22C55E', conversion: true },
      ],
      cards: contacts.slice(20, 26).map((c, i) => ({
        id: 'pcd' + (i + 1),
        columnId: ['pc1', 'pc2', 'pc3'][i % 3],
        contactId: c.id,
        title: c.name,
        value: 197,
        labels: [],
        assignee: 'u1',
        updatedAt: ago(i * DAY),
      })),
    },
  ]

  kanbans[0].cards.push({ id: 'cd-ig1', columnId: 'col1', contactId: 'ct-ig1', title: 'Júlia Martins', value: 197, labels: ['l1'], assignee: 'u1', updatedAt: ago(0) })

  // Funil do Instagram até a compra do produto (modo demonstração): no banco real ele anda sozinho (funis + função funil)
  const FUNIL = [['fc1', 'Comentou e recebeu a DM', '#8B5CF6'], ['fc2', 'Clicou na isca', '#3B82F6'], ['fc3', 'Cadastrou na isca', '#14B8A6'],
    ['fc4', 'Entrou no grupo', '#22C55E'], ['fc5', 'Participou da aula', '#F59E0B'], ['fc7', 'Chegou no pitch', '#F97316'], ['fc8', 'Clicou na oferta', '#EAB308'],
    ['fc9', 'Cartão recusado', '#DC2626'], ['fc10', 'Pix gerado', '#06B6D4'], ['fc6', 'Comprou', '#EF4444']]
  const funilCards = [['ct-ig1', 'fc2'], ['ct-ig2', 'fc1'], ['ct-ig3', 'fc1'], [contacts[3].id, 'fc3'], [contacts[4].id, 'fc4'], [contacts[5].id, 'fc4'], [contacts[6].id, 'fc5'], [contacts[8].id, 'fc7'], [contacts[9].id, 'fc8'], [contacts[10].id, 'fc9'], [contacts[11].id, 'fc10'], [contacts[7].id, 'fc6']]
  kanbans.push({
    id: 'k-funil', name: 'Funil Instagram → Compra', color: '#E1306C',
    columns: FUNIL.map(([id, name, color]) => ({ id, name, color, ...(id === 'fc6' ? { conversion: true } : {}) })),
    cards: funilCards.map(([cid, col], i) => {
      // caminho até a coluna do card (datas e detalhes de exemplo; no banco real vêm de cada sistema)
      const ordem = ['fc1', 'fc2', 'fc3', 'fc4', 'fc5', 'fc7', 'fc8', 'fc9', 'fc10', 'fc6']
      const ETAPA = { fc1: 'comentou', fc2: 'clicou', fc3: 'cadastrou', fc4: 'grupo', fc5: 'aula', fc7: 'pitch', fc8: 'oferta', fc9: 'recusado', fc10: 'pix', fc6: 'comprou' }
      const ig = String(cid).startsWith('ct-ig')
      const ate = ordem.indexOf(col)
      const passos = ordem.slice(ig ? 0 : 2, ate + 1).filter((c) => !(c === 'fc9' && col === 'fc6'))
      const funil = Object.fromEntries(passos.map((c, k) => [ETAPA[c], ago((passos.length - k) * 5 * 3600000 + i * 600000)]))
      const DET = {
        comentou: { comentario: 'GUIA', automacao: 'GUIA - Guia gratuito de vendas no WhatsApp', palavra: 'GUIA', isca: 'guia', link: 'https://iscas.exemplo.com.br/guia/lead', por: 'comentário' },
        clicou: { isca: 'guia', link: 'https://iscas.exemplo.com.br/guia/lead', cliques: 2 }, cadastrou: { isca: 'guia', tema: 'Guia gratuito de vendas no WhatsApp' },
        grupo: { campanha: 'Aula ao vivo', grupo: 'AULA AO VIVO #12' }, aula: { webinar: 'Aula: vendas com IA no WhatsApp', minutos: 42 },
        pitch: { webinar: 'Aula: vendas com IA no WhatsApp' }, oferta: { webinar: 'Aula: vendas com IA no WhatsApp' },
        recusado: { produto: 'Curso Online', pedido: 'PED0001', valor: 1997, pagamento: 'credit_card' }, pix: { produto: 'Curso Online', pedido: 'PED0002', valor: 1997, pagamento: 'pix' },
        comprou: { produto: 'Curso Online', pedido: 'PED0003', valor: 1997, pagamento: 'pix' },
      }
      const detalhes = Object.fromEntries(Object.keys(funil).map((e) => [e, DET[e]]))
      return { id: 'fcd' + i, columnId: col, contactId: cid, title: contacts.find((c) => c.id === cid).name, value: col === 'fc6' ? 1997 : 0, labels: [], assignee: 'u1', updatedAt: ago(i * 3600000), funil, detalhes }
    }),
  })
  // fotos de exemplo (no banco real vêm do WhatsApp/Instagram)
  ;[['ct-ig1', 47], ['ct-ig2', 12], [contacts[0].id, 32], [contacts[1].id, 5], [contacts[3].id, 15], [contacts[4].id, 26], [contacts[6].id, 44]].forEach(([cid, n]) => {
    const c = contacts.find((x) => x.id === cid)
    if (c) c.avatarUrl = `https://i.pravatar.cc/160?img=${n}`
  })

  const flows = [
    {
      id: 'f1',
      name: 'Boas-vindas do anúncio',
      folder: 'Vendas',
      status: 'active',
      updatedAt: ago(2 * DAY),
      nodes: [
        { id: 'start', type: 'start', position: { x: 60, y: 160 }, data: { label: 'Início', keywords: ['oi', 'quero'] } },
        { id: 'n1', type: 'block', position: { x: 340, y: 120 }, data: { kind: 'message', config: { text: 'Oi {{nome}}! Que bom te ver por aqui 😊' } } },
        { id: 'n2', type: 'block', position: { x: 640, y: 120 }, data: { kind: 'interactive_menu', config: { text: 'Como posso te ajudar?', options: ['Quero comprar', 'Tirar dúvida'] } } },
        { id: 'n3', type: 'block', position: { x: 960, y: 40 }, data: { kind: 'pix', config: { text: 'Segue o Pix para pagamento', amount: 197 } } },
        { id: 'n4', type: 'block', position: { x: 960, y: 260 }, data: { kind: 'ai_agent', config: { agentId: 'a1', mode: 'enter' } } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'n1', sourceHandle: 'out-0' },
        { id: 'e2', source: 'n1', target: 'n2', sourceHandle: 'out-0' },
        { id: 'e3', source: 'n2', target: 'n3', sourceHandle: 'out-0' },
        { id: 'e4', source: 'n2', target: 'n4', sourceHandle: 'out-1' },
      ],
    },
    {
      id: 'f2',
      name: 'Recuperação de Pix',
      folder: 'Vendas',
      status: 'active',
      updatedAt: ago(5 * DAY),
      nodes: [
        { id: 'start', type: 'start', position: { x: 60, y: 160 }, data: { label: 'Início' } },
        { id: 'n1', type: 'block', position: { x: 340, y: 160 }, data: { kind: 'smart_interval', config: { amount: 30, unit: 'minutos' } } },
        { id: 'n2', type: 'block', position: { x: 640, y: 160 }, data: { kind: 'message', config: { text: 'Vi que o Pix ainda não caiu. Posso ajudar?' } } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'n1', sourceHandle: 'out-0' },
        { id: 'e2', source: 'n1', target: 'n2', sourceHandle: 'out-0' },
      ],
    },
    {
      id: 'f3',
      name: 'Pesquisa de satisfação',
      folder: null,
      status: 'paused',
      updatedAt: ago(12 * DAY),
      nodes: [{ id: 'start', type: 'start', position: { x: 60, y: 160 }, data: { label: 'Início' } }],
      edges: [],
    },
  ]

  const agents = [
    {
      id: 'a1',
      name: 'Leo',
      avatar: '🦁',
      active: true,
      role: 'Closer do kit',
      does: 'Tira dúvida do anúncio e leva quem topar pagar pro fluxo',
      objective: 'Vender',
      audience: 'Mulher de 25 a 40 que viu o anúncio',
      tone: 'Vendedor',
      examples: 'Oi, vi que você se interessou.\nO kit sai 197 com frete grátis.\nQuer que eu te mande o Pix?',
      rules: 'Frete grátis acima de 197. Sem desconto fora do fluxo.',
      forbidden: 'Política, concorrente, promessa de resultado',
      emojis: 'moderado',
      prompt: '',
      skills: [{ id: 'sk1', when: 'Cliente quer pagar', action: 'Disparar fluxo "Boas-vindas do anúncio"' }],
      fields: [
        { id: 'fd1', desc: 'Nome do cliente', field: 'nome' },
        { id: 'fd2', desc: 'Cidade', field: 'cidade' },
        { id: 'fd3', desc: 'Produto de interesse', field: 'produto' },
        { id: 'fd4', desc: 'E-mail', field: 'email' },
      ],
      files: [],
      knowledge: [],
      settings: { buffer: 5, split: true, audio: false, voice: 'padrao', audioRule: '', hearAudio: true, seeImage: true, businessHours: false, stopOnHuman: true, stopNoProgress: true, sign: false },
      updatedAt: ago(DAY),
    },
  ]

  return {
    user: { id: 'u1', name: 'Usuário Demo', email: 'demo@exemplo.com', role: 'owner' },
    company: { id: 19557, name: 'Minha Empresa', description: '', slug: 'minha-empresa', timezone: 'America/Sao_Paulo', emailNotifications: true, active: true },
    tokens: 1250,
    billing: { status: 'active', plan: 'Pro', recurrence: 'Mensal', nextDue: new Date(now + 18 * DAY).toISOString(), starter: { used: 2, total: 3 }, pro: { used: 1, total: 2 } },
    invoices: [
      { id: 'INV-0012', date: ago(12 * DAY), amount: 397, status: 'paga' },
      { id: 'INV-0011', date: ago(42 * DAY), amount: 397, status: 'paga' },
      { id: 'INV-0010', date: ago(72 * DAY), amount: 297, status: 'paga' },
    ],
    labels,
    departments,
    connections,
    products,
    contacts,
    chats,
    messages,
    sales,
    kanbans,
    flows,
    flowFolders: ['Vendas', 'Suporte'],
    agents,
    voices: [{ id: 'padrao', name: 'Padrão da plataforma' }],
    webhooks: [
      { id: 'w1', name: 'Checkout Hotmart', connectionId: 'c1', flowId: 'f1', token: 'wh_' + Math.random().toString(36).slice(2, 14), active: true, calls: 1284, mapping: [{ from: 'buyer.name', to: 'nome' }, { from: 'buyer.phone', to: 'telefone' }] },
    ],
    webhookQuota: { used: 1284, total: 30000 },
    dispatches: [
      { id: 'md1', name: 'Black Friday', flowId: 'f1', connectionId: 'c1', total: 120, sent: 120, status: 'concluido', createdAt: ago(9 * DAY), interval: 15 },
      { id: 'md2', name: 'Recompra outubro', flowId: 'f2', connectionId: 'c1', total: 80, sent: 34, status: 'andamento', createdAt: ago(DAY), interval: 20 },
    ],
    dispatchQuota: { total: 1000, used: 154 },
    pixels: [{ id: 'px1', name: 'Pixel Loja', platform: 'Meta', pixelId: '123456789012345', events: ['Lead', 'Purchase'] }],
    metaProfiles: [],
    team: [
      { id: 'u1', name: 'Usuário Demo', email: 'demo@exemplo.com', role: 'Proprietário', departmentId: null },
      { id: 'u2', name: 'Camila Rocha', email: 'camila@empresa.com', role: 'Admin', departmentId: 'd1' },
      { id: 'u3', name: 'Pedro Alves', email: 'pedro@empresa.com', role: 'Membro', departmentId: 'd2' },
    ],
    invitations: [],
    platformInvites: [],
    quickReplies: [
      { id: 'q1', shortcut: '/pix', type: 'texto', content: 'Nossa chave Pix é: contato@empresa.com' },
      { id: 'q2', shortcut: '/frete', type: 'texto', content: 'Frete grátis para todo o Brasil acima de R$ 197.' },
    ],
    globalVars: [{ id: 'gv1', name: 'link_checkout', value: 'https://pay.exemplo.com/kit', description: 'Link do checkout do kit' }],
    customFields: [
      { id: 'cf1', key: 'cidade', label: 'Cidade', type: 'Texto' },
      { id: 'cf2', key: 'data_nascimento', label: 'Data de nascimento', type: 'Data' },
    ],
    systemFields: [
      { key: 'ctwa_clid', label: 'Anúncio: CTWA Click ID', type: 'Texto' },
      { key: 'media_url', label: 'Anúncio: Media URL', type: 'Texto' },
      { key: 'source_id', label: 'Anúncio: Source ID', type: 'Texto' },
      { key: 'source_url', label: 'Anúncio: Source URL', type: 'Texto' },
      { key: 'thumbnail_url', label: 'Anúncio: Thumbnail URL', type: 'Texto' },
    ],
    businessHours: [
      { day: 'Segunda', open: true, from: '08:00', to: '18:00' },
      { day: 'Terça', open: true, from: '08:00', to: '18:00' },
      { day: 'Quarta', open: true, from: '08:00', to: '18:00' },
      { day: 'Quinta', open: true, from: '08:00', to: '18:00' },
      { day: 'Sexta', open: true, from: '08:00', to: '18:00' },
      { day: 'Sábado', open: true, from: '09:00', to: '13:00' },
      { day: 'Domingo', open: false, from: '09:00', to: '13:00' },
    ],
    connectionFlowConfigs: { c1: { welcome: 'f1', away: null }, c2: { welcome: null, away: null } },
    integrations: ['openai'],
    mcpCredentials: [],
    rotators: [
      { id: 'rot1', name: 'Aluno me chamou', slug: 'aluno-me-chamou', connectionIds: ['c1', 'c2', 'c3'], mode: 'clique', message: 'Olá! Vim pela área de membros e preciso de ajuda.', agentId: null, active: true, turn: 41, clicks: 41, counts: { c1: 15, c2: 14, c3: 12 }, misses: 0, lastClickAt: ago(2 * 3600e3), createdAt: ago(9 * DAY) },
    ],
    whatsappTemplates: [],
    expenses: { fee: 4.99, fixed: 0 },
    savedFilters: [],
    aiUsage: [],
    translations: [],
  }
}

// Painel do superadmin no modo demonstração: a empresa demo + alguns clientes de exemplo.
// Mudar os módulos da empresa demo no painel muda o acesso do próprio app (para testar os bloqueios).
const ALL = ['conexoes', 'contatos', 'chat', 'kanban', 'fluxos', 'agentes', 'webhooks', 'disparos', 'facebook', 'instagram', 'inteligencia']
const ahead = (ms) => new Date(now + ms).toISOString()

export function buildPlatformSeed(s) {
  const packages = [
    { id: 'pkg-completo', name: 'Completo', description: 'Todos os módulos da plataforma', modules: ALL, isDefault: true, updatedAt: ago(30 * DAY) },
    { id: 'pkg-atendimento', name: 'Atendimento', description: 'Chat ao vivo com o WhatsApp conectado', modules: ['chat'], isDefault: false, updatedAt: ago(20 * DAY) },
    { id: 'pkg-vendas-ia', name: 'Vendas com IA', description: 'Agentes de IA, fluxos e Kanban', modules: ['agentes', 'fluxos', 'kanban'], isDefault: false, updatedAt: ago(10 * DAY) },
  ]
  const company = (c) => ({ members: 1, source: 'manual', notes: '', trialEndsAt: null, renewsAt: null, canceledAt: null, customized: false, ...c })
  const companies = [
    company({ id: s.company.id, publicId: s.company.id, name: s.company.name, ownerName: s.user.name, ownerEmail: s.user.email, members: s.team.length, createdAt: ago(120 * DAY), plan: 'Pro', status: 'active', renewsAt: ahead(18 * DAY), selected: ALL, packageId: 'pkg-completo' }),
    company({ id: 'demo-2', publicId: 10021, name: 'Clínica Sorriso', ownerName: 'Marina Lopes', ownerEmail: 'marina@exemplo.com', members: 3, createdAt: ago(5 * DAY), plan: 'Starter', status: 'trial', trialEndsAt: ahead(2 * DAY), selected: ['chat'], packageId: 'pkg-atendimento' }),
    company({ id: 'demo-3', publicId: 10022, name: 'Loja Bella Moda', ownerName: 'Renato Souza', ownerEmail: 'renato@exemplo.com', members: 5, createdAt: ago(64 * DAY), plan: 'Pro', status: 'active', renewsAt: ahead(9 * DAY), selected: ['agentes', 'fluxos', 'kanban', 'facebook'], packageId: 'pkg-vendas-ia', customized: true }),
    company({ id: 'demo-4', publicId: 10023, name: 'Auto Peças Silva', ownerName: 'Paulo Silva', ownerEmail: 'paulo@exemplo.com', members: 2, createdAt: ago(93 * DAY), plan: 'Starter', status: 'past_due', renewsAt: ago(3 * DAY), selected: ['chat', 'kanban'], packageId: null }),
    company({ id: 'demo-5', publicId: 10024, name: 'Studio Fit', ownerName: 'Ana Ribeiro', ownerEmail: 'ana@exemplo.com', members: 1, createdAt: ago(150 * DAY), plan: 'Starter', status: 'canceled', canceledAt: ago(10 * DAY), selected: ['contatos'], packageId: null }),
  ]
  return {
    access: { selected: ALL, effective: ALL, packageId: 'pkg-completo', customized: false },
    subscription: { plan: 'Pro', status: 'active', source: 'manual', renewsAt: ahead(18 * DAY) },
    isSuperadmin: true,
    platform: {
      companies,
      packages,
      admins: [{ userId: s.user.id, email: s.user.email, createdAt: ago(120 * DAY), addedByEmail: null }],
      audit: [],
    },
  }
}
