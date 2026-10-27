import {
  MessageSquare, FileText, Tag, QrCode, ListOrdered, List, GalleryHorizontal, Hourglass, MessagesSquare, Bell, GitBranch, Shuffle,
  Link2, Crosshair, Timer, Building2, Globe, Sparkles, Bot, Columns3, PenLine, BadgeDollarSign, CreditCard, Wallet, PhoneCall, Wand2, HandCoins,
} from 'lucide-react'
import { BRAND } from './brand'
import { brl } from './utils'

// Catálogo de blocos do editor de fluxos.
// fields: o que aparece no painel de configuração do bloco.
// outputs: saídas fixas do bloco (cada uma vira uma "alça" para conectar). Sem outputs = 1 saída padrão.
export const BLOCKS = [
  { kind: 'message', label: 'Mensagem', desc: 'Enviar mensagem de texto', icon: MessageSquare, color: '#3B82F6',
    fields: [{ key: 'text', label: 'Mensagem', type: 'textarea', placeholder: 'Oi {{nome}}! Use variáveis entre chaves duplas.' }, { key: 'typing', label: 'Simular "digitando..." (segundos)', type: 'number', default: 2 }] },
  { kind: 'whatsapp_template', label: 'Template WhatsApp', desc: 'Enviar template oficial aprovado pela Meta', icon: FileText, color: '#2563EB',
    // tipo 'template': escolhe entre os templates sincronizados (Configurações → Templates WhatsApp) e preenche as
    // variáveis {{1}}, {{2}}… (config: template, language, params)
    fields: [{ key: 'template', label: 'Template', type: 'template' }] },
  { kind: 'tags', label: 'Etiquetas', desc: 'Adicionar etiquetas ao cliente e aos negócios dele no Kanban', icon: Tag, color: '#8B5CF6',
    fields: [{ key: 'action', label: 'Ação', type: 'select', options: ['Adicionar', 'Remover'] }, { key: 'labels', label: 'Etiquetas', type: 'multi', source: 'labels' }] },
  { kind: 'pix', label: 'Botão PIX', desc: 'Enviar botão de pagamento PIX', icon: QrCode, color: '#14B8A6',
    fields: [{ key: 'text', label: 'Texto', type: 'textarea' }, { key: 'key', label: 'Chave Pix', type: 'text' }, { key: 'amount', label: 'Valor (R$)', type: 'number' }] },
  { kind: 'menu', label: 'Menu (legado)', desc: 'Menu clássico. Será descontinuado. Enviar menu com lista de opções para o cliente escolher', icon: ListOrdered, color: '#A855F7',
    fields: [{ key: 'text', label: 'Pergunta', type: 'textarea' }, { key: 'options', label: 'Opções', type: 'list' }], dynamicOutputs: 'options' },
  { kind: 'interactive_menu', label: 'Menu', desc: 'Menu recomendado para novos fluxos, com melhor desempenho e estabilidade.', icon: List, color: '#A855F7',
    fields: [{ key: 'text', label: 'Pergunta', type: 'textarea' }, { key: 'options', label: 'Botões / opções', type: 'list' }], dynamicOutputs: 'options' },
  { kind: 'carousel', label: 'Carrossel', desc: 'Enviar carrossel do WhatsApp com gatilhos REPLY persistentes', icon: GalleryHorizontal, color: '#0EA5E9',
    fields: [{ key: 'text', label: 'Texto', type: 'textarea' }, { key: 'options', label: 'Cards (título de cada card)', type: 'list' }], dynamicOutputs: 'options' },
  { kind: 'wait_response', label: 'Aguarda Resposta', desc: 'Aguardar resposta do cliente com timeout configurável', icon: Hourglass, color: '#F97316',
    fields: [{ key: 'variable', label: 'Salvar resposta na variável', type: 'text', placeholder: 'resposta' }, { key: 'timeout', label: 'Timeout (minutos)', type: 'number', default: 60 }],
    outputs: ['Respondeu', 'Sem resposta'] },
  { kind: 'chat_controller', label: 'Controlador de Chat', desc: 'Alterar estado do chat', icon: MessagesSquare, color: '#64748B',
    fields: [{ key: 'status', label: 'Novo estado', type: 'select', options: ['Aguardando', 'Atendendo', 'Resolvido'] }] },
  { kind: 'notification', label: 'Notificação', desc: 'Enviar notificação via WhatsApp', icon: Bell, color: '#EAB308',
    fields: [{ key: 'phone', label: 'Número que recebe', type: 'text' }, { key: 'text', label: 'Mensagem', type: 'textarea', placeholder: 'Novo lead: {{nome}}' }] },
  { kind: 'condition', label: 'Condicional', desc: 'Avaliar condições e direcionar o fluxo', icon: GitBranch, color: '#F59E0B',
    fields: [{ key: 'variable', label: 'Variável / campo', type: 'text', placeholder: 'resposta' }, { key: 'operator', label: 'Operador', type: 'select', options: ['contém', 'é igual a', 'não contém', 'existe'] }, { key: 'value', label: 'Valor', type: 'text' }],
    outputs: ['Verdadeiro', 'Falso'] },
  { kind: 'distributor', label: 'Distribuidor', desc: 'Distribuir contatos igualmente entre múltiplas saídas', icon: Shuffle, color: '#EC4899',
    fields: [{ key: 'count', label: 'Número de saídas', type: 'number', default: 2 }], dynamicOutputs: 'count' },
  { kind: 'connection_flow', label: 'Conexão de Fluxo', desc: 'Redirecionar para outro fluxo', icon: Link2, color: '#6366F1',
    fields: [{ key: 'flowId', label: 'Fluxo de destino', type: 'select', source: 'flows' }], terminal: true },
  { kind: 'pixel', label: 'Pixel', desc: 'Disparar eventos em ferramentas de anúncios (Facebook Ads, etc)', icon: Crosshair, color: '#1D4ED8',
    fields: [{ key: 'pixelId', label: 'Pixel', type: 'select', source: 'pixels' }, { key: 'event', label: 'Evento', type: 'select', options: ['Lead', 'Purchase', 'InitiateCheckout', 'AddToCart', 'Contact'] }] },
  { kind: 'smart_interval', label: 'Intervalo Inteligente', desc: 'Pausar o fluxo e continuar após um intervalo ou data específica', icon: Timer, color: '#10B981',
    fields: [{ key: 'amount', label: 'Aguardar', type: 'number', default: 5 }, { key: 'unit', label: 'Unidade', type: 'select', options: ['segundos', 'minutos', 'horas', 'dias'] }] },
  { kind: 'department', label: 'Departamento', desc: 'Atribuir departamento ao chat', icon: Building2, color: '#0891B2',
    fields: [{ key: 'departmentId', label: 'Departamento', type: 'select', source: 'departments' }] },
  { kind: 'integration', label: 'Integração', desc: 'Fazer requisições HTTP (POST/PUT/GET) para APIs externas', icon: Globe, color: '#7C3AED',
    fields: [{ key: 'method', label: 'Método', type: 'select', options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] }, { key: 'url', label: 'URL', type: 'text', placeholder: 'https://api.exemplo.com/leads' }, { key: 'body', label: 'Corpo (JSON)', type: 'textarea', placeholder: '{"nome": "{{nome}}"}' }],
    outputs: ['Sucesso', 'Falha'] },
  { kind: 'ai', label: 'Bloco de IA', desc: 'Integração com GPT e Gemini para respostas inteligentes', icon: Sparkles, color: '#D946EF',
    fields: [{ key: 'provider', label: 'Modelo', type: 'select', options: ['OpenAI GPT', 'Google Gemini', 'Claude'] }, { key: 'prompt', label: 'Prompt', type: 'textarea' }, { key: 'variable', label: 'Salvar resposta em', type: 'text', placeholder: 'resposta_ia' }],
    outputs: ['Sucesso', 'Falha'] },
  { kind: 'ai_agent', label: 'Agente de IA', desc: 'Passa a conversa pra um agente ou devolve pro fluxo', icon: Bot, color: '#8B5CF6',
    fields: [{ key: 'mode', label: 'Ação', type: 'select', options: ['Entregar ao agente', 'Remover agente do chat'] }, { key: 'agentId', label: 'Agente', type: 'select', source: 'agents' }] },
  // tipo 'column': escolhe entre as colunas do Kanban do campo `kanban` e grava o nome (o servidor procura a coluna pelo
  // nome; vazio ou não achado = primeira coluna). reset: trocar o Kanban limpa a coluna escolhida.
  { kind: 'kanban', label: 'Kanban', desc: 'Criar ou mover negócio no Kanban selecionado', icon: Columns3, color: '#22C55E',
    fields: [{ key: 'action', label: 'Ação', type: 'select', options: [{ value: 'Criar/mover card', label: 'Criar/mover negócio' }, { value: 'Criar card', label: 'Criar negócio (se ainda não existir)' }, { value: 'Remover card', label: 'Remover negócio' }, { value: 'Anotar no negócio', label: 'Só anotar no negócio (sem mover de coluna)' }] }, { key: 'crmId', label: 'Kanban', type: 'select', source: 'kanbans', reset: { column: '' } }, { key: 'column', label: 'Coluna', type: 'column', kanban: 'crmId' },{ key: 'assignee', label: 'Responsável (opcional)', type: 'select', source: 'team' }, { key: 'notes', label: 'Anotação do card (opcional)', type: 'textarea', placeholder: 'Reunião: {{evento.sessao.inicio_texto}}' }, { key: 'notesMode', label: 'Anotação', type: 'select', options: [{ value: '', label: 'Trocar a anotação do card' }, { value: 'acrescentar', label: 'Acrescentar no fim da anotação' }] }] },
  { kind: 'manipulator', label: 'Manipulador', desc: 'Atualizar a data de criação do contato na base ou gravar um campo personalizado', icon: PenLine, color: '#F43F5E',
    fields: [{ key: 'field', label: 'Campo', type: 'text', placeholder: 'cidade' }, { key: 'value', label: 'Valor', type: 'text', placeholder: '{{resposta}}' }] },
  // tipo 'product': escolhe da lista de produtos ou cria um ali mesmo (nome, valor e moeda)
  { kind: 'approved_sale', label: 'Venda aprovada', desc: 'Registra venda no painel com produto e valor/moeda (use após comprovante pela IA)', icon: BadgeDollarSign, color: '#16A34A',
    // crmId (opcional): põe também o valor e o produto no negócio do contato nesse Kanban (o que o bloco Kanban criou/moveu)
    fields: [{ key: 'productId', label: 'Produto', type: 'product' }, { key: 'amount', label: 'Valor (número ou variável, ex.: {{evento.venda.valor}})', type: 'text', placeholder: '1997 ou {{evento.venda.valor}}' }, { key: 'currency', label: 'Moeda', type: 'select', options: ['BRL', 'USD', 'EUR', 'MXN'] }, { key: 'crmId', label: 'Pôr o valor no negócio do Kanban (opcional)', type: 'select', source: 'kanbans' }] },
  // Possível venda (carrinho abandonado, Pix gerado…): põe o produto e o valor no negócio do contato no Kanban escolhido;
  // sem negócio nesse Kanban, cria na primeira coluna (o bloco Kanban leva para a coluna certa).
  { kind: 'possible_sale', label: 'Possível venda', desc: 'Põe o produto e o valor no negócio do Kanban (carrinho abandonado, Pix gerado…)', icon: HandCoins, color: '#EAB308',
    fields: [{ key: 'productId', label: 'Produto', type: 'product' }, { key: 'amount', label: 'Valor (vazio = valor do produto; aceita variável)', type: 'text', placeholder: '{{evento.venda.valor}}' }, { key: 'crmId', label: 'Kanban do negócio', type: 'select', source: 'kanbans' }] },
  { kind: 'payment', label: 'Pagamento', desc: 'Gere uma cobrança e continue o fluxo', icon: CreditCard, color: '#0D9488',
    fields: [{ key: 'gateway', label: 'Gateway', type: 'select', options: ['Mercado Pago', 'Asaas', 'Stripe', 'XPag'] }, { key: 'amount', label: 'Valor (R$)', type: 'number' }],
    outputs: ['Cobrança gerada', 'Pagamento aprovado', 'Erro'] },
  { kind: 'vortexpay', label: BRAND.payName, desc: `Cobrança só do ${BRAND.payName}, com as mesmas saídas do pagamento`, icon: Wallet, color: '#7C3AED',
    fields: [{ key: 'amount', label: 'Valor (R$)', type: 'number' }],
    outputs: ['Cobrança gerada', 'Pagamento aprovado', 'Erro'] },
  { kind: 'make_call', label: 'Ligar', desc: 'Faz uma ligação WhatsApp pro lead. Toque 1–15s; com áudio, soma a duração do arquivo', icon: PhoneCall, color: '#22C55E',
    fields: [{ key: 'duration', label: 'Duração do toque (s)', type: 'number', default: 10 }] },
  { kind: 'kieai_integration', label: 'Integração Kie.ai', desc: 'Gerar áudio, imagem, música e vídeo via Kie.ai com a chave API do cliente', icon: Wand2, color: '#E11D48',
    fields: [{ key: 'generationType', label: 'Tipo', type: 'select', options: ['Imagem', 'Áudio', 'Música', 'Vídeo'] }, { key: 'prompt', label: 'Prompt', type: 'textarea' }],
    outputs: ['Sucesso', 'Falha'] },
]

export const blockByKind = (k) => BLOCKS.find((b) => b.kind === k) || BLOCKS[0]

export const outputsOf = (kind, config = {}) => {
  const b = blockByKind(kind)
  if (b.terminal) return []
  if (b.outputs) return b.outputs
  if (b.dynamicOutputs === 'options') return (config.options || []).length ? config.options : ['Opção 1']
  if (b.dynamicOutputs === 'count') return Array.from({ length: Math.max(2, +config.count || 2) }, (_, i) => `Saída ${i + 1}`)
  return [null]
}

export const summaryOf = (kind, c = {}, db) => {
  switch (kind) {
    case 'message':
    case 'pix':
    case 'notification':
      return c.text || 'Clique para configurar'
    case 'interactive_menu':
    case 'menu':
    case 'carousel':
      return c.text || 'Pergunta do menu'
    case 'smart_interval':
      return `Aguardar ${c.amount || 5} ${c.unit || 'segundos'}`
    case 'condition':
      return c.variable ? `{{${c.variable}}} ${c.operator || 'contém'} "${c.value || ''}"` : 'Defina a condição'
    case 'integration':
      return `${c.method || 'POST'} ${c.url || 'URL não definida'}`
    case 'ai_agent':
      return `${c.mode || 'Entregar ao agente'}: ${db?.agents.find((a) => a.id === c.agentId)?.name || '—'}`
    case 'connection_flow':
      return `Ir para: ${db?.flows.find((f) => f.id === c.flowId)?.name || '—'}`
    case 'tags':
      return `${c.action || 'Adicionar'}: ${(c.labels || []).map((id) => db?.labels.find((l) => l.id === id)?.name).filter(Boolean).join(', ') || '—'}`
    case 'wait_response':
      return `Salvar em {{${c.variable || 'resposta'}}} · timeout ${c.timeout || 60} min`
    case 'department':
      return db?.departments.find((d) => d.id === c.departmentId)?.name || 'Escolha o departamento'
    case 'chat_controller':
      return `Mover para: ${c.status || 'Atendendo'}`
    case 'ai':
      return c.prompt || `${c.provider || 'OpenAI GPT'}: defina o prompt`
    case 'whatsapp_template':
      return c.template ? `${c.template} · ${c.language || 'pt_BR'}` : 'Escolha o template'
    case 'kanban': {
      const k = db?.kanbans.find((x) => x.id === c.crmId)
      if (!k) return 'Escolha o Kanban e a coluna'
      return c.action === 'Remover card' ? `Remover negócio de: ${k.name}` : `${k.name} → ${c.column || k.columns?.[0]?.name || 'primeira coluna'}`
    }
    case 'approved_sale':
    case 'possible_sale': {
      const p = db?.products.find((x) => x.id === c.productId)
      const variavel = /\{\{/.test(c.amount || '')
      if (!p && !variavel) return 'Escolha o produto'
      const preco = variavel ? c.amount : brl(+c.amount || p.price, (kind === 'approved_sale' && c.currency) || p?.currency || 'BRL')
      const valor = p ? `${p.name} · ${preco}` : preco
      const k = db?.kanbans.find((x) => x.id === c.crmId)
      if (kind === 'approved_sale') return k ? `${valor} → ${k.name}` : valor
      return k ? `${valor} → ${k.name}` : `${valor} · escolha o Kanban`
    }
    default:
      return blockByKind(kind).desc
  }
}
