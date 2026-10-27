import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useDB } from '../../lib/store'
import { Field, Select, Toggle } from '../ui'
import { DATE_SOURCES, ORIGINS, TIMEZONES, UNITS, WEEKDAYS, agentSkillsFor } from '../../lib/triggers'
import WebhookConfig from './WebhookConfig'
import { Chips, Note } from './parts'

// Configuração de cada tipo de gatilho do bloco "Início do fluxo". Textos curtos, para quem não é técnico.

function Words({ value = [], onChange }) {
  const [text, setText] = useState('')
  const add = () => {
    const parts = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    const next = [...value]
    for (const p of parts) if (!next.some((k) => k.toLowerCase() === p.toLowerCase())) next.push(p)
    onChange(next)
    setText('')
  }
  return (
    <>
      <div className="flex gap-2">
        <input className="input" value={text} placeholder="ex.: quero comprar, preço" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className="btn-secondary shrink-0" onClick={add} aria-label="Adicionar"><Plus size={14} /></button>
      </div>
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map((k) => (
            <span key={k} className="chip-on flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs">
              {k} <button type="button" onClick={() => onChange(value.filter((x) => x !== k))} aria-label={`Remover ${k}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

function Wait({ c, set, label }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input type="number" min={1} className="input w-24" value={c.amount ?? ''} onChange={(e) => set({ amount: Math.max(1, +e.target.value || 1) })} />
        <Select value={c.unit} onChange={(v) => set({ unit: v })} options={UNITS} />
      </div>
    </Field>
  )
}

const Connections = ({ c, set, db, hint }) => (
  <Field label="Conexões" hint={hint || 'Nenhuma marcada = todas as conexões.'}>
    <Chips options={db.connections.map((x) => ({ value: x.id, label: x.name }))} value={c.connections || []} onChange={(v) => set({ connections: v })} empty="Nenhuma conexão cadastrada." />
  </Field>
)

const SendVia = ({ c, set, db, label = 'Conexão para falar com o contato' }) => (
  <Field label={label} hint="Usada quando o contato ainda não tem conversa. Sem escolher, vale a conversa mais recente dele.">
    <Select value={c.connectionId || ''} onChange={(v) => set({ connectionId: v })} placeholder="Conversa mais recente do contato" options={db.connections.map((x) => ({ value: x.id, label: x.name }))} />
  </Field>
)

const Kanban = ({ c, set, db, label = 'Funil (Kanban)', placeholder = 'Qualquer funil', reset = {} }) => (
  <Field label={label}>
    <Select value={c.kanbanId || ''} onChange={(v) => set({ kanbanId: v, ...reset })} placeholder={placeholder} options={db.kanbans.map((k) => ({ value: k.id, label: k.name }))} />
  </Field>
)
const columnsOf = (db, kanbanId) => (db.kanbans.find((k) => k.id === kanbanId)?.columns || []).map((x) => ({ value: x.id, label: x.name }))

export const FIELD_OPTIONS = (db) => [
  { value: 'nome', label: 'Nome' }, { value: 'email', label: 'E-mail' }, { value: 'status', label: 'Status (lead/ativo)' }, { value: 'estado', label: 'Estado' },
  ...db.customFields.map((f) => ({ value: f.key, label: `${f.label} ({{${f.key}}})` })),
]
const OPS = [{ value: 'any', label: 'Qualquer mudança' }, { value: 'equals', label: 'Ficou igual a' }, { value: 'contains', label: 'Passou a conter' }, { value: 'filled', label: 'Foi preenchido' }, { value: 'empty', label: 'Ficou vazio' }]

export default function TriggerForm({ trigger, flow, onChange }) {
  const db = useDB()
  const c = trigger.config || {}
  const set = (patch) => onChange({ ...trigger, config: { ...c, ...patch } })

  switch (trigger.type) {
    case 'message':
      return (
        <>
          <Field label="Quando">
            <Select value={c.mode || 'keyword'} onChange={(v) => set({ mode: v })} options={[{ value: 'any', label: 'Qualquer mensagem' }, { value: 'keyword', label: 'Mensagem com palavra-chave' }]} />
          </Field>
          {c.mode !== 'any' && (
            <>
              <Field label="Palavras ou frases" hint="Separe por vírgula ou aperte Enter. Qualquer uma delas inicia o fluxo. Sem nenhuma = qualquer mensagem.">
                <Words value={c.keywords || []} onChange={(v) => set({ keywords: v })} />
              </Field>
              <Field label="A mensagem">
                <Select value={c.match || 'contains'} onChange={(v) => set({ match: v })} options={[{ value: 'contains', label: 'contém' }, { value: 'exact', label: 'é exatamente' }, { value: 'starts', label: 'começa com' }, { value: 'ends', label: 'termina com' }]} />
              </Field>
              <div className="mb-3 rounded-[13px] border border-border px-3 py-1">
                <Toggle label="Ignorar maiúsculas" checked={c.ignoreCase !== false} onChange={(v) => set({ ignoreCase: v })} />
                <Toggle label="Ignorar acentos" description="preço = preco" checked={!!c.ignoreAccents} onChange={(v) => set({ ignoreAccents: v })} />
                <Toggle label="Só palavra inteira" description={'"oi" não vale dentro de "oitenta"'} checked={!!c.wholeWord} onChange={(v) => set({ wholeWord: v })} />
              </div>
            </>
          )}
          <Connections c={c} set={set} db={db} />
          <Field label="Tipo de conversa">
            <Select value="individual" onChange={() => {}} options={[{ value: 'individual', label: 'Só conversas individuais' }]} />
          </Field>
          <Note>Mensagens de grupos não chegam ao Vórtex CRM pelas conexões atuais, então o fluxo só começa em conversas individuais. Se o contato estiver no meio de outro fluxo esperando resposta, a mensagem continua aquele fluxo.</Note>
        </>
      )

    case 'first_contact':
      return (
        <>
          <Note>Como o sistema identifica: é a primeira mensagem de uma pessoa que ainda não tinha nenhuma conversa com você <b>neste número</b>. Vale também para contatos já cadastrados (por importação, webhook ou à mão) que escrevem pela primeira vez.</Note>
          <Toggle label="Só contatos novos" description="Ignora quem já estava cadastrado antes da mensagem." checked={!!c.onlyNewContacts} onChange={(v) => set({ onlyNewContacts: v })} />
          <Connections c={c} set={set} db={db} />
        </>
      )

    case 'reopened':
      return (
        <>
          <Note>Dispara quando o cliente manda mensagem numa conversa que estava <b>Resolvida</b> (encerrada). A conversa volta para Aguardando e o fluxo começa.</Note>
          <Connections c={c} set={set} db={db} />
        </>
      )

    case 'no_team_reply':
      return (
        <>
          <Wait c={c} set={set} label="Esperar a equipe responder por" />
          <Toggle label="Respostas automáticas contam" description="Se ligado, uma resposta da IA ou de outro fluxo também cancela a espera." checked={!!c.countBot} onChange={(v) => set({ countBot: v })} />
          <Connections c={c} set={set} db={db} />
          <Note>A contagem começa na primeira mensagem do cliente sem resposta. Se alguém da equipe responder antes do prazo, o disparo é cancelado. Dispara no máximo uma vez a cada espera.</Note>
        </>
      )

    case 'no_client_reply':
      return (
        <>
          <Wait c={c} set={set} label="Esperar o cliente responder por" />
          <Toggle label="Só depois de mensagens da equipe" description="Ignora o que a IA e os fluxos mandam." checked={!!c.onlyTeam} onChange={(v) => set({ onlyTeam: v })} />
          <Connections c={c} set={set} db={db} />
          <Note>A contagem começa na última mensagem enviada ao cliente. Se ele responder antes do prazo, o disparo é cancelado. Dispara uma vez por silêncio: só volta a contar depois que o cliente responder.</Note>
        </>
      )

    case 'webhook':
      return <WebhookConfig trigger={trigger} flow={flow} onChange={onChange} />

    case 'contact_created':
      return (
        <>
          <Field label="Origem do contato" hint="Nenhuma marcada = qualquer origem.">
            <Chips options={ORIGINS} value={c.origins || []} onChange={(v) => set({ origins: v })} />
          </Field>
          <Connections c={c} set={set} db={db} hint="Conexão do contato. Nenhuma marcada = todas." />
          <Note>Vale para contatos criados pelo WhatsApp, por webhook, por importação ou à mão. Um contato que entra já com etiquetas também dispara o gatilho de etiqueta adicionada.</Note>
        </>
      )

    case 'tag':
      return (
        <>
          <Field label="Quando a etiqueta for">
            <Select value={c.action || 'added'} onChange={(v) => set({ action: v })} options={[{ value: 'added', label: 'Adicionada' }, { value: 'removed', label: 'Removida' }]} />
          </Field>
          <Field label="Etiquetas" hint="Qualquer uma delas. Nenhuma marcada = qualquer etiqueta.">
            <Chips options={db.labels.map((l) => ({ value: l.id, label: l.name }))} value={c.labels || []} onChange={(v) => set({ labels: v })} empty="Nenhuma etiqueta cadastrada." />
          </Field>
        </>
      )

    case 'field_updated':
      return (
        <>
          <Field label="Campo"><Select value={c.field || ''} onChange={(v) => set({ field: v })} placeholder="Escolha o campo" options={FIELD_OPTIONS(db)} /></Field>
          <Field label="Valor esperado (opcional)"><Select value={c.op || 'any'} onChange={(v) => set({ op: v })} options={OPS} /></Field>
          {['equals', 'contains'].includes(c.op) && <Field label="Valor"><input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value })} placeholder="ex.: São Paulo" /></Field>}
          <Note>Compara sem diferenciar maiúsculas e acentos. Campos novos aparecem em Configurações → Campos Personalizados.</Note>
        </>
      )

    case 'deal':
      return (
        <>
          <Field label="Quando">
            <Select value={c.event || 'any'} onChange={(v) => set({ event: v })} options={[{ value: 'any', label: 'Criado ou mudou de etapa' }, { value: 'created', label: 'Negócio criado' }, { value: 'moved', label: 'Mudou de etapa' }]} />
          </Field>
          <Kanban c={c} set={set} db={db} reset={{ toColumns: [], fromColumns: [] }} />
          {c.kanbanId && (
            <>
              <Field label="Etapa de destino" hint="Nenhuma marcada = qualquer etapa."><Chips options={columnsOf(db, c.kanbanId)} value={c.toColumns || []} onChange={(v) => set({ toColumns: v })} /></Field>
              {c.event !== 'created' && <Field label="Vindo da etapa (opcional)" hint="Nenhuma marcada = de qualquer etapa."><Chips options={columnsOf(db, c.kanbanId)} value={c.fromColumns || []} onChange={(v) => set({ fromColumns: v })} /></Field>}
            </>
          )}
          <Note>O negócio precisa ter um contato ligado a ele. Mudanças feitas por este mesmo fluxo não o disparam de novo.</Note>
        </>
      )

    case 'deal_result':
      return (
        <>
          <Field label="Quando o negócio for">
            <Select value={c.result || 'won'} onChange={(v) => set({ result: v })} options={[{ value: 'won', label: 'Ganho (etapa de conversão)' }, { value: 'lost', label: 'Perdido (etapa de perda)' }]} />
          </Field>
          <Kanban c={c} set={set} db={db} />
          <Note>No Kanban, use o menu da coluna para marcar a etapa como <b>conversão</b> (ganho) ou <b>perda</b>. O motivo da perda ainda não existe no Kanban, então não dá para filtrar por ele.</Note>
        </>
      )

    case 'assignee':
      return (
        <>
          <Field label="Responsável de">
            <Select value={c.scope || 'chat'} onChange={(v) => set({ scope: v })} options={[{ value: 'chat', label: 'Conversa' }, { value: 'deal', label: 'Negócio do Kanban' }, { value: 'any', label: 'Conversa ou negócio' }]} />
          </Field>
          <Field label="Novo responsável"><Select value={c.to || ''} onChange={(v) => set({ to: v })} placeholder="Qualquer pessoa" options={db.team.map((m) => ({ value: m.id, label: m.name }))} /></Field>
        </>
      )

    case 'stage_idle':
      return (
        <>
          <Kanban c={c} set={set} db={db} placeholder="Escolha o funil" reset={{ columnId: '' }} />
          {c.kanbanId && <Field label="Etapa"><Select value={c.columnId || ''} onChange={(v) => set({ columnId: v })} placeholder="Escolha a etapa" options={columnsOf(db, c.kanbanId)} /></Field>}
          <Wait c={c} set={set} label="Parado por" />
          <Note>A contagem começa quando o negócio entra na etapa. Antes de executar, o sistema confere de novo: se o negócio mudou de etapa, o disparo é cancelado.</Note>
        </>
      )

    case 'schedule':
      return (
        <>
          <Field label="Repetição">
            <Select value={c.mode || 'once'} onChange={(v) => set({ mode: v })} options={[{ value: 'once', label: 'Uma vez' }, { value: 'daily', label: 'Todo dia' }, { value: 'weekly', label: 'Toda semana' }, { value: 'monthly', label: 'Todo mês' }]} />
          </Field>
          {c.mode === 'once' && <Field label="Data"><input type="date" className="input" value={c.date || ''} onChange={(e) => set({ date: e.target.value })} /></Field>}
          {c.mode === 'weekly' && <Field label="Dias da semana"><Chips options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} value={c.weekdays || []} onChange={(v) => set({ weekdays: v })} /></Field>}
          {c.mode === 'monthly' && <Field label="Dia do mês" hint="Em meses mais curtos, vale o último dia."><input type="number" min={1} max={31} className="input w-24" value={c.monthDay || 1} onChange={(e) => set({ monthDay: Math.min(31, Math.max(1, +e.target.value || 1)) })} /></Field>}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Horário"><input type="time" className="input" value={c.time || '09:00'} onChange={(e) => set({ time: e.target.value })} /></Field>
            <Field label="Fuso"><Select value={c.tz} onChange={(v) => set({ tz: v })} options={TIMEZONES} /></Field>
          </div>
          <Field label="Público: contatos com a etiqueta" hint="Qualquer uma delas. Nenhuma marcada = todos os contatos.">
            <Chips options={db.labels.map((l) => ({ value: l.id, label: l.name }))} value={c.audience?.labelsAny || []} onChange={(v) => set({ audience: { ...(c.audience || {}), labelsAny: v } })} empty="Nenhuma etiqueta cadastrada." />
          </Field>
          <Field label="Menos quem tem a etiqueta">
            <Chips options={db.labels.map((l) => ({ value: l.id, label: l.name }))} value={c.audience?.labelsNone || []} onChange={(v) => set({ audience: { ...(c.audience || {}), labelsNone: v } })} empty="Nenhuma etiqueta cadastrada." />
          </Field>
          <SendVia c={c} set={set} db={db} />
          <Note>No horário, o público entra numa fila e o fluxo começa para cada contato aos poucos (cerca de 100 por minuto), até 5.000 contatos por vez. As regras de entrada do bloco também valem.</Note>
        </>
      )

    case 'date_field': {
      const dateFields = db.customFields.filter((f) => f.type === 'Data')
      return (
        <>
          <Field label="Data de referência"><Select value={c.source || 'field'} onChange={(v) => set({ source: v })} options={DATE_SOURCES} /></Field>
          {c.source === 'field' && (
            <Field label="Campo com a data" hint="Aceita 21/10/2026, 2026-10-21 e, para aniversário, 21/10.">
              <Select value={c.field || ''} onChange={(v) => set({ field: v })} placeholder="Escolha o campo"
                options={(dateFields.length ? dateFields : db.customFields).map((f) => ({ value: f.key, label: `${f.label} ({{${f.key}}})` }))} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Quando">
              <Select value={c.when || 'on'} onChange={(v) => set({ when: v })} options={[{ value: 'before', label: 'Antes da data' }, { value: 'on', label: 'No dia' }, { value: 'after', label: 'Depois da data' }]} />
            </Field>
            {c.when !== 'on' && <Field label="Quantos dias"><input type="number" min={1} className="input" value={c.days || 1} onChange={(e) => set({ days: Math.max(1, +e.target.value || 1) })} /></Field>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Horário"><input type="time" className="input" value={c.time || '09:00'} onChange={(e) => set({ time: e.target.value })} /></Field>
            <Field label="Fuso"><Select value={c.tz} onChange={(v) => set({ tz: v })} options={TIMEZONES} /></Field>
          </div>
          <Toggle label="Repetir todo ano" description="Só dia e mês contam (aniversário, renovação anual)." checked={!!c.yearly} onChange={(v) => set({ yearly: v })} />
          <SendVia c={c} set={set} db={db} />
          <Note>Antes de executar, o sistema confere a data de novo: se ela mudou, o disparo é cancelado. Cada contato entra uma vez por data.</Note>
        </>
      )
    }

    case 'manual':
      return (
        <>
          <Field label="Onde aparece o botão “Iniciar fluxo”">
            <Chips options={[{ value: 'contact', label: 'Contatos' }, { value: 'chat', label: 'Conversa' }, { value: 'deal', label: 'Negócio do Kanban' }]} value={c.where || []} onChange={(v) => set({ where: v })} />
          </Field>
          <SendVia c={c} set={set} db={db} />
          <Note>A pessoa da equipe escolhe este fluxo no contato, na conversa ou no negócio. A variável {'{{iniciado_por}}'} traz o nome de quem iniciou. Numa conversa com a automação desligada, iniciar o fluxo liga de novo.</Note>
        </>
      )

    case 'flow': {
      const from = db.flows.filter((f) => f.id !== flow?.id && f.nodes?.some((n) => n.data?.kind === 'connection_flow' && n.data?.config?.flowId === flow?.id))
      return (
        <>
          <Note>Outro fluxo chega neste pelo bloco <b>Conexão de Fluxo</b>. As variáveis que ele coletou (respostas, campos, {'{{fluxo_origem}}'}) continuam valendo aqui.</Note>
          <Field label="Fluxos que chegam aqui">
            {from.length ? <ul className="space-y-1 text-xs text-text-secondary">{from.map((f) => <li key={f.id}>↪ {f.name}</li>)}</ul> : <p className="text-xs text-text-muted">Nenhum fluxo usa a Conexão de Fluxo para este ainda.</p>}
          </Field>
          <Field label="Variáveis que este fluxo espera (anotação)" hint="Só para lembrar quem monta o outro fluxo. Separe por vírgula.">
            <input className="input" value={(c.vars || []).join(', ')} onChange={(e) => set({ vars: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="ex.: produto, valor" />
          </Field>
          <Note>Proteção: um fluxo que volta para ele mesmo sem pausa (sem menu ou espera) para em 60 blocos, com um aviso na conversa.</Note>
        </>
      )
    }

    case 'ai_agent': {
      const skills = agentSkillsFor(db, flow?.id)
      return (
        <>
          <Note>No agente de IA, crie uma habilidade <b>Disparar fluxo</b> e escolha este fluxo. Quando a situação descrita acontecer, o agente inicia o fluxo com o contato e os dados que coletou (campos do contato, {'{{agente}}'} e {'{{motivo}}'}).</Note>
          <Field label="Habilidades que iniciam este fluxo">
            {skills.length ? <ul className="space-y-1 text-xs text-text-secondary">{skills.map(({ agent, skill }) => <li key={skill.id || skill.when}>🤖 {agent.name}: quando “{skill.when || '—'}”</li>)}</ul> : <p className="text-xs text-text-muted">Nenhum agente tem uma habilidade apontando para este fluxo.</p>}
          </Field>
          <Field label="Aceitar só destes agentes" hint="Nenhum marcado = qualquer agente.">
            <Chips options={db.agents.map((a) => ({ value: a.id, label: a.name }))} value={c.agents || []} onChange={(v) => set({ agents: v })} empty="Nenhum agente cadastrado." />
          </Field>
        </>
      )
    }

    default:
      return <Note>Este gatilho não tem configuração.</Note>
  }
}
