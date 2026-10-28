import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Building2, Users, MailPlus, ShieldCheck, Languages, Sparkles, Workflow, Zap, FileText, Variable, ListPlus, Tag, Plug, Package, Cpu, Send,
  Plus, Pencil, Trash2, Copy, Key, Clock, LogOut, Info, RefreshCw, Search, ImagePlus, Loader2,
} from 'lucide-react'
import { useDB, useModules, toast } from '../lib/store'
import { BACKEND, SUPABASE_URL, supabase } from '../lib/supabase'
import { aiCheck, aiCredentialList, aiCredentialRemove, aiCredentialSave, aiRuns, callFn, fromRow, invitationCode, TEMPLATE_MEDIA, uploadTemplateMedia } from '../lib/backend'
import TemplatePreview from '../components/TemplatePreview'
import { SETTINGS_TAB_MODULE } from '../lib/modules'
import { ModuleUnavailable } from '../components/Layout'
import { BRAND } from '../lib/brand'
import { brl, cx, fmtDate, uid } from '../lib/utils'
import { LABEL_COLORS } from '../lib/seed'
import { Avatar, Confirm, EmptyState, Field, Modal, SearchInput, Select, Table, Toggle } from '../components/ui'

const SECTIONS = [
  { group: 'Conta', items: [
    { id: 'accounts', label: 'Empresa', icon: Building2, desc: 'Dados da empresa selecionada no menu lateral.' },
    { id: 'team', label: 'Equipe', icon: Users, desc: 'Gerencie os membros, funções e permissões da sua equipe.' },
    { id: 'platform_invitations', label: 'Convites para Plataforma', icon: MailPlus, desc: `Convide pessoas para a plataforma ${BRAND.name}.` },
    { id: 'support_access', label: 'Acesso de suporte', icon: ShieldCheck, desc: 'Veja e revogue acessos temporários aprovados para a equipe de suporte.' },
    { id: 'flow_translator_history', label: 'Traduções de fluxo', icon: Languages, desc: 'Só o tradutor de fluxo: original, cópia, reservado, usado e devolvido.' },
    { id: 'ai_usage_history', label: `Uso da ${BRAND.aiName}`, icon: Sparkles, desc: 'Cada resposta dos agentes de IA: resultado, modelo, tokens e ações.' },
  ] },
  { group: 'Automação', items: [
    { id: 'connection_flow_configs', label: 'Fluxos Padrões', icon: Workflow, desc: 'Defina os fluxos padrões de cada conexão do WhatsApp.' },
    { id: 'mass_dispatches', label: 'Disparos em massa', icon: Send, to: '/mass-dispatches' },
    { id: 'quick_replies', label: 'Respostas Rápidas', icon: Zap, desc: 'Gerencie e organize as respostas rápidas da sua empresa.' },
    { id: 'whatsapp_templates', label: 'Templates WhatsApp', icon: FileText, desc: 'Gerencie templates oficiais Meta por WABA.' },
    { id: 'global_variables', label: 'Variáveis Globais', icon: Variable, desc: 'Gerencie as variáveis que podem ser usadas em todos os seus fluxos.' },
    { id: 'custom_fields', label: 'Campos Personalizados', icon: ListPlus, desc: 'Gerencie campos customizados e variáveis do sistema BOT para seus contatos.' },
    { id: 'tags', label: 'Etiquetas', icon: Tag, desc: 'Organize e classifique itens usando etiquetas.' },
  ] },
  { group: 'Integrações', items: [
    { id: 'integrations', label: 'Integrações', icon: Plug, desc: 'Conecte emissores de NF, rastreamento de vendas e outros serviços à sua conta.' },
    { id: 'products', label: 'Produtos', icon: Package, desc: 'Cadastre produtos com faixa de preço e valor padrão para vendas e integrações.' },
    { id: 'mcp_credentials', label: 'Ferramentas MCP', icon: Cpu, desc: 'Conecte o Claude e outros assistentes a esta empresa com uma chave.' },
  ] },
]
const ALL = SECTIONS.flatMap((s) => s.items)

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const tab = params.get('tab') || 'accounts'
  const sec = ALL.find((s) => s.id === tab) || ALL[0]
  const modules = useModules()
  const tabModule = SETTINGS_TAB_MODULE[tab]
  const tabBlocked = tabModule && !modules.includes(tabModule)
  const [filter, setFilter] = useState('')

  return (
    <div className="mx-auto max-w-[1400px]">
      <p className="eyebrow-label eyebrow-dot mb-1.5">Configurações</p>
      <div className="flex flex-col gap-5 lg:flex-row">
        <aside className="card h-fit shrink-0 p-3 lg:sticky lg:top-6 lg:w-64">
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input className="input py-1.5 pl-8 text-xs" placeholder="Buscar configuração" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {SECTIONS.map((g) => {
            const items = g.items.filter((i) => (!SETTINGS_TAB_MODULE[i.id] || modules.includes(SETTINGS_TAB_MODULE[i.id])) && i.label.toLowerCase().includes(filter.toLowerCase()))
            if (!items.length) return null
            return (
              <div key={g.group} className="mb-2">
                <p className="eyebrow-label mb-1 px-2">{g.group}</p>
                {items.map((i) => (
                  <button key={i.id} onClick={() => (i.to ? nav(i.to) : setParams({ tab: i.id }))} className={cx('flex min-h-9 w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left text-[13px] transition', tab === i.id ? 'nav-active font-[550]' : 'font-[550] text-text-secondary hover:bg-surface-interactive hover:text-text-primary')}>
                    <i.icon size={15} /> <span className="truncate">{i.label}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </aside>
        <section className="min-w-0 flex-1">{tabBlocked ? <ModuleUnavailable module={tabModule} /> : <>
          <div className="mb-5">
            <h1 className="page-heading flex items-center gap-3"><span className="icon-tile h-10 w-10 shrink-0"><sec.icon size={18} /></span> {sec.label}</h1>
            {sec.desc && <p className="text-sm text-text-muted">{sec.desc}</p>}
          </div>
          {tab === 'accounts' && <Company />}
          {tab === 'team' && <Team />}
          {tab === 'platform_invitations' && <PlatformInvites />}
          {tab === 'support_access' && <EmptyBox title="Nenhum suporte com acesso ativo." hint="Equipe de suporte com acesso temporário aprovado nesta conta." icon={ShieldCheck} />}
          {tab === 'flow_translator_history' && <EmptyBox title="Nenhuma tradução nesta conta." hint="Quando você traduzir um fluxo, o reservado, o usado e o devolvido aparecem aqui." icon={Languages} />}
          {tab === 'ai_usage_history' && <AiUsage />}
          {tab === 'connection_flow_configs' && <DefaultFlows />}
          {tab === 'quick_replies' && <QuickReplies />}
          {tab === 'whatsapp_templates' && <Templates />}
          {tab === 'global_variables' && <GlobalVars />}
          {tab === 'custom_fields' && <CustomFields />}
          {tab === 'tags' && <Labels />}
          {tab === 'integrations' && <Integrations />}
          {tab === 'products' && <Products />}
          {tab === 'mcp_credentials' && <Mcp />}
        </>}</section>
      </div>
    </div>
  )
}

function EmptyBox({ title, hint, icon }) {
  return <EmptyState icon={icon} title={title} hint={hint} />
}

/* ---------- CRUD genérico ---------- */

function Crud({ coll, fields, columns, newLabel, emptyTitle, emptyHint, searchKeys, icon, extraFilter }) {
  const db = useDB()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  const rows = db[coll].filter((r) => searchKeys.some((k) => String(r[k] || '').toLowerCase().includes(q.toLowerCase()))).filter(extraFilter || (() => true))
  const save = () => {
    const missing = fields.find((f) => f.required && !edit[f.key])
    if (missing) return toast(`${missing.label} é obrigatório.`, 'error')
    edit.id ? db.update(coll, edit.id, edit) : db.add(coll, edit)
    toast('Salvo com sucesso.')
    setEdit(null)
  }
  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Buscar..." />
        <button className="btn-primary" onClick={() => setEdit(Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])))}><Plus size={15} /> {newLabel}</button>
      </div>
      {db[coll].length === 0 ? (
        <EmptyState icon={icon} title={emptyTitle} hint={emptyHint} action={<button className="btn-primary" onClick={() => setEdit(Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])))}>{newLabel}</button>} />
      ) : (
        <Table rows={rows} columns={[...columns, { key: '_a', label: 'Ações', render: (r) => (
          <div className="flex gap-1">
            <button className="btn-ghost p-1.5" onClick={() => setEdit({ ...r })}><Pencil size={14} /></button>
            <button className="btn-ghost p-1.5 text-red-400" onClick={() => setDel(r)}><Trash2 size={14} /></button>
          </div>
        ) }]} />
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Editar' : newLabel} footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancelar</button><button className="btn-primary" onClick={save}>Salvar</button></>}>
        {edit && fields.map((f) => (
          <Field key={f.key} label={f.label + (f.required ? '*' : '')} hint={f.hint}>
            {f.type === 'textarea' ? <textarea className="input" rows={4} value={edit[f.key]} onChange={(e) => setEdit({ ...edit, [f.key]: e.target.value })} />
              : f.type === 'select' ? <Select value={edit[f.key]} onChange={(v) => setEdit({ ...edit, [f.key]: v })} options={f.options} />
              : f.type === 'color' ? <div className="flex gap-2">{LABEL_COLORS.map((c) => <button key={c} onClick={() => setEdit({ ...edit, [f.key]: c })} className={cx('h-7 w-7 rounded-full', edit[f.key] === c && 'ring-2 ring-white ring-offset-2 ring-offset-surface-raised')} style={{ background: c }} />)}</div>
              : <input className="input" type={f.type || 'text'} placeholder={f.placeholder} value={edit[f.key]} onChange={(e) => setEdit({ ...edit, [f.key]: f.type === 'number' ? +e.target.value : e.target.value })} />}
          </Field>
        ))}
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Excluir" message="Tem certeza? Esta ação não pode ser desfeita." onConfirm={() => db.remove(coll, del.id)} />
    </>
  )
}

/* ---------- Empresa ---------- */

function Company() {
  const db = useDB()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const sub = params.get('sub') || 'company'
  const [f, setF] = useState(db.company)
  const SUBS = [['company', 'Empresa'], ['corporate', 'Dados Corporativos'], ['departments', 'Departamentos'], ['hours', 'Horários de Trabalho'], ['new', 'Nova Conta']]
  return (
    <>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {SUBS.map(([id, l]) => <button key={id} onClick={() => setParams({ tab: 'accounts', sub: id })} className={cx('rounded-full border px-3 py-1.5 text-xs font-medium', sub === id ? 'chip-on' : 'border-border text-text-secondary')}>{l}</button>)}
      </div>
      {sub === 'company' && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2"><p className="font-semibold">Dados da Empresa</p><span className="badge-success">Ativa</span></div>
            <p className="mb-4 text-xs text-text-muted">Informações exibidas para seus clientes e relatórios</p>
            <CompanyLogo />
            <div className="grid gap-x-4 md:grid-cols-2">
              <Field label="Nome da empresa*"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Slug"><input className="input" placeholder="slug-da-conta (opcional)" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
              <Field label="Descrição" className="md:col-span-2"><input className="input" placeholder="Digite uma descrição para a conta (opcional)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
              <Field label="Fuso horário" hint="Define o fuso usado no dashboard, filtros, condicionais de fluxo, intervalo inteligente, horário comercial e variáveis de data/hora.">
                <Select value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} options={[{ value: 'America/Sao_Paulo', label: 'Brasília (America/Sao_Paulo)' }, { value: 'America/Manaus', label: 'Manaus (America/Manaus)' }, { value: 'America/Mexico_City', label: 'Cidade do México' }, { value: 'Europe/Lisbon', label: 'Lisboa' }]} />
              </Field>
            </div>
            <Toggle checked={f.emailNotifications} onChange={(v) => setF({ ...f, emailNotifications: v })} label="Notificações por e-mail de instâncias" description="Envia e-mail ao proprietário quando uma instância desconecta ou fica restrita (API Oficial)." />
            <button className="btn-primary mt-3" onClick={() => { db.setKey('company', (c) => ({ ...c, ...f, logoUrl: c.logoUrl })); toast('Empresa salva.') }}>Salvar empresa</button>
          </div>
          <div className="card flex items-center justify-between p-5">
            <div><p className="font-semibold">Membros da equipe</p><p className="text-sm text-text-muted">Convide ou crie usuários para a empresa atual.</p></div>
            <button className="btn-secondary" onClick={() => setParams({ tab: 'team' })}><Users size={15} /> Convidar membro</button>
          </div>
          <div className="card flex items-center justify-between border-red-500/30 p-5">
            <div><p className="font-semibold text-red-400">Sair da Empresa</p><p className="text-sm text-text-muted">Você perde o acesso a todos os dados desta empresa.</p></div>
            <button className="btn-danger" onClick={() => toast('Você é o proprietário — transfira a propriedade antes de sair.', 'warning')}><LogOut size={15} /> Sair da Empresa</button>
          </div>
        </div>
      )}
      {sub === 'corporate' && <Corporate />}
      {sub === 'departments' && (
        <Crud coll="departments" icon={Building2} newLabel="Novo departamento" emptyTitle="Nenhum departamento" searchKeys={['name']}
          fields={[{ key: 'name', label: 'Nome', required: true }, { key: 'color', label: 'Cor', type: 'color', default: '#7fee64' }]}
          columns={[{ key: 'name', label: 'Departamento', render: (d) => <span className="flex items-center gap-2 text-text-primary"><span className="h-3 w-3 rounded-full" style={{ background: d.color }} />{d.name}</span> }, { key: 'm', label: 'Membros', render: (d) => db.team.filter((u) => u.departmentId === d.id).length }]} />
      )}
      {sub === 'hours' && <BusinessHours />}
      {sub === 'new' && (
        <div className="card max-w-lg p-5">
          <p className="mb-1 font-semibold">Nova Conta</p>
          <p className="mb-4 text-sm text-text-muted">Crie outra empresa para operar separadamente (ex.: outra marca ou cliente). Ela tem contatos, conexões, automações e configurações próprios, e você troca de empresa pelo nome no topo do menu.</p>
          <button className="btn-primary" onClick={() => nav('/empresas?acao=criar')}><Plus size={15} /> Criar nova empresa</button>
        </div>
      )}
    </>
  )
}

// Foto/logo da empresa (aparece no lugar da letra no menu e no seletor). Reduz para até 256 px antes de enviar.
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
// lê a imagem: createImageBitmap e, se o navegador não conseguir, uma <img> comum
async function readImage(file) {
  try {
    return await createImageBitmap(file)
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}
async function shrinkImage(file, max = 256) {
  const bmp = await readImage(file)
  const w0 = bmp.naturalWidth || bmp.width
  const h0 = bmp.naturalHeight || bmp.height
  const scale = Math.min(1, max / Math.max(w0, h0))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w0 * scale))
  canvas.height = Math.max(1, Math.round(h0 * scale))
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  const as = (type, q) => new Promise((ok) => canvas.toBlob(ok, type, q))
  const webp = await as('image/webp', 0.9)
  if (webp?.type === 'image/webp') return { blob: webp, ext: 'webp' }
  return { blob: await as('image/png'), ext: 'png' }
}

function CompanyLogo() {
  const db = useDB()
  const [busy, setBusy] = useState(false)
  const canEdit = !BACKEND || ['Proprietário', 'Admin'].includes(db.user.role)
  const pick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!LOGO_TYPES.includes(file.type)) return toast('Envie uma imagem PNG, JPG ou WebP.', 'error')
    if (file.size > 10 * 1024 * 1024) return toast('Imagem muito grande. Envie uma de até 10 MB.', 'error')
    setBusy(true)
    try {
      await db.setCompanyLogo(await shrinkImage(file))
      toast('Foto da empresa atualizada.')
    } catch (err) {
      toast(`Não foi possível enviar a foto: ${err.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      await db.setCompanyLogo(null)
      toast('Foto removida. Voltou a letra.')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded-[16px] border border-border p-4">
      <Avatar name={db.company.name} size={64} letters={1} src={db.company.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">Foto da empresa</p>
        <p className="text-xs text-text-muted">{canEdit ? 'Aparece no lugar da letra, no menu e no seletor de empresas. PNG, JPG ou WebP.' : 'Só administradores da empresa podem trocar a foto.'}</p>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <label className={cx('btn-secondary cursor-pointer text-xs', busy && 'pointer-events-none opacity-60')}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {db.company.logoUrl ? 'Trocar foto' : 'Enviar foto'}
            <input type="file" accept={LOGO_TYPES.join(',')} className="sr-only" onChange={pick} disabled={busy} />
          </label>
          {db.company.logoUrl && <button className="btn-ghost text-xs text-red-400" disabled={busy} onClick={remove}><Trash2 size={14} /> Remover</button>}
        </div>
      )}
    </div>
  )
}

function Corporate() {
  const db = useDB()
  const [f, setF] = useState({ cnpj: '', razao: '', ie: '', phone: '', address: '', city: '', uf: '', cep: '', ...db.company.corporate })
  return (
    <div className="card p-5">
      <div className="grid gap-x-4 md:grid-cols-2">
        {[['razao', 'Razão social'], ['cnpj', 'CNPJ'], ['ie', 'Inscrição estadual'], ['phone', 'Telefone / WhatsApp'], ['cep', 'CEP'], ['address', 'Endereço'], ['city', 'Cidade'], ['uf', 'UF']].map(([k, l]) => (
          <Field key={k} label={l}><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
        ))}
      </div>
      <button className="btn-primary" onClick={() => { db.setKey('company', (c) => ({ ...c, corporate: f })); toast('Dados corporativos salvos.') }}>Salvar</button>
    </div>
  )
}

function BusinessHours() {
  const db = useDB()
  const [h, setH] = useState(db.businessHours)
  return (
    <div className="card p-5">
      <p className="mb-4 text-sm text-text-muted">Usado por fluxos, agentes de IA (só responder no horário) e mensagens de ausência.</p>
      {h.map((d, i) => (
        <div key={d.day} className="flex flex-wrap items-center gap-3 border-b border-border py-2.5 last:border-0">
          <span className="w-24 text-sm font-medium">{d.day}</span>
          <Toggle checked={d.open} onChange={(v) => setH(h.map((x, j) => (j === i ? { ...x, open: v } : x)))} />
          {d.open ? (
            <>
              <input type="time" className="input w-32" value={d.from} onChange={(e) => setH(h.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              <span className="text-text-muted">até</span>
              <input type="time" className="input w-32" value={d.to} onChange={(e) => setH(h.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
            </>
          ) : <span className="text-sm text-text-muted">Fechado</span>}
        </div>
      ))}
      <button className="btn-primary mt-4" onClick={() => { db.setKey('businessHours', h); toast('Horários salvos.') }}><Clock size={15} /> Salvar horários</button>
    </div>
  )
}

/* ---------- Equipe ---------- */

// Código do convite (gerado pelo banco): mostrado em grupos de 4 e copiado com um clique
const fmtCode = (c) => (c || '').replace(/(.{4})(?=.)/g, '$1-')
function InviteCode({ invite }) {
  const [code, setCode] = useState(invite.code || null)
  useEffect(() => {
    if (code || !BACKEND) return
    let alive = true
    invitationCode(invite.id).then((c) => alive && setCode(c)).catch(() => {})
    return () => { alive = false }
  }, [invite.id, code])
  if (!code) return null
  return (
    <button className="btn-ghost px-2 py-1 font-mono text-xs" title="Copiar código do convite" onClick={() => { navigator.clipboard?.writeText(fmtCode(code)); toast('Código do convite copiado.') }}>
      <Copy size={12} /> {fmtCode(code)}
    </button>
  )
}

function Team() {
  const db = useDB()
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [invite, setInvite] = useState(null)
  const canInvite = !BACKEND || ['Proprietário', 'Admin'].includes(db.user.role)
  const rows = db.team.filter((u) => (u.name + u.email + u.role).toLowerCase().includes(q.toLowerCase()) && (!role || u.role === role))
  return (
    <>
      <div className="mb-4 flex flex-col gap-2 md:flex-row">
        <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Buscar por nome, email ou perfil..." />
        <Select className="md:w-48" value={role} onChange={setRole} placeholder="Todas as funções" options={['Proprietário', 'Admin', 'Membro']} />
        {canInvite && <button className="btn-primary" onClick={() => setInvite({ email: '', role: 'Membro', departmentId: '' })}><Plus size={15} /> Convidar membro</button>}
      </div>
      <p className="mb-2 text-sm text-text-muted">{db.team.length} membros</p>
      <Table rows={rows} columns={[
        { key: 'name', label: 'Membro', render: (u) => <div className="flex items-center gap-3"><Avatar name={u.name} size={30} /><div><p className="text-text-primary">{u.name}</p><p className="text-xs text-text-muted">{u.email}</p></div></div> },
        { key: 'role', label: 'Função', render: (u) => u.role === 'Proprietário' ? <span className="badge-warning">{u.role}</span> : (
          <select className="input w-32 py-1 text-xs" value={u.role} onChange={(e) => db.update('team', u.id, { role: e.target.value })}><option>Admin</option><option>Membro</option></select>
        ) },
        { key: 'dep', label: 'Depto', render: (u) => (
          <select className="input w-40 py-1 text-xs" value={u.departmentId || ''} onChange={(e) => db.update('team', u.id, { departmentId: e.target.value || null })}>
            <option value="">Sem departamento</option>
            {db.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) },
        { key: 'a', label: 'Ações', render: (u) => u.role !== 'Proprietário' && <button className="btn-ghost p-1.5 text-red-400" onClick={() => { db.remove('team', u.id); toast('Membro removido.') }}><Trash2 size={14} /></button> },
      ]} />
      <div className="card mt-5 p-5">
        <p className="font-semibold">Convites pendentes</p>
        <p className="mb-3 text-sm text-text-muted">Quem já tem conta entra com o código do convite em "Adicionar empresa" (no seletor de empresas do menu). Quem ainda não tem, entra ao se cadastrar com o mesmo e-mail.</p>
        {db.invitations.length === 0 ? <p className="text-sm text-text-muted">Nenhum convite pendente</p> : db.invitations.map((i) => (
          <div key={i.id} className="flex items-center gap-3 border-t border-border py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{i.email}</span><span className="badge-muted">{i.role}</span>
            <InviteCode invite={i} />
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => toast('Convite reenviado.')}><RefreshCw size={12} /> Reenviar</button>
            {canInvite && <button className="btn-ghost px-2 py-1 text-xs text-red-400" onClick={() => db.remove('invitations', i.id)}>Cancelar</button>}
          </div>
        ))}
      </div>
      <Modal open={!!invite} onClose={() => setInvite(null)} title="Convidar membro" size="sm" footer={<><button className="btn-secondary" onClick={() => setInvite(null)}>Cancelar</button><button className="btn-primary" onClick={() => { if (!invite.email) return; db.add('invitations', { ...invite, at: new Date().toISOString() }); toast('Convite enviado (simulado).'); setInvite(null) }}>Enviar convite</button></>}>
        {invite && (
          <>
            <Field label="E-mail"><input className="input" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Função"><Select value={invite.role} onChange={(v) => setInvite({ ...invite, role: v })} options={['Admin', 'Membro']} /></Field>
            <Field label="Departamento"><Select value={invite.departmentId} onChange={(v) => setInvite({ ...invite, departmentId: v })} placeholder="Sem departamento" options={db.departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
          </>
        )}
      </Modal>
    </>
  )
}

function PlatformInvites() {
  const db = useDB()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('')
  const inv = db.platformInvites
  const count = (s) => inv.filter((i) => i.status === s).length
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[['Total', inv.length], ['Pendentes', count('pendente')], ['Aceitos', count('aceito')], ['Recusados', count('recusado')], ['Expirados', count('expirado')]].map(([l, v]) => <div key={l} className="card p-3 text-center"><p className="text-xl font-bold">{v}</p><p className="text-xs text-text-muted">{l}</p></div>)}
      </div>
      <div className="card mb-4 flex gap-2 p-3">
        <input className="input" type="email" placeholder="E-mail da pessoa" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn-primary shrink-0" onClick={() => { if (!email) return; db.add('platformInvites', { email, status: 'pendente', by: db.user.name, at: new Date().toISOString() }); setEmail(''); toast('Convite enviado!') }}>Convidar para Plataforma</button>
      </div>
      <Select className="mb-3 w-48" value={status} onChange={setStatus} placeholder="Todos" options={['pendente', 'aceito', 'recusado', 'expirado']} />
      <Table rows={inv.filter((i) => !status || i.status === status)} empty="Nenhum convite para plataforma enviado" columns={[
        { key: 'email', label: 'E-mail' }, { key: 'by', label: 'Convidado por' }, { key: 'status', label: 'Status', render: (i) => <span className="badge-warning">{i.status}</span> }, { key: 'at', label: 'Data', render: (i) => fmtDate(i.at) },
      ]} />
    </>
  )
}

/* ---------- Automação ---------- */

function DefaultFlows() {
  const db = useDB()
  if (!db.connections.length) return <EmptyState icon={Workflow} title="Nenhuma conexão encontrada" hint="Crie uma conexão do WhatsApp primeiro para configurar os fluxos padrões." />
  const set = (cid, k, v) => db.setKey('connectionFlowConfigs', (c) => ({ ...c, [cid]: { ...(c[cid] || {}), [k]: v } }))
  const flows = db.flows.map((f) => ({ value: f.id, label: f.name }))
  return (
    <div className="space-y-3">
      {db.connections.map((c) => (
        <div key={c.id} className="card p-5">
          <p className="mb-3 font-semibold">{c.name} <span className="text-sm font-normal text-text-muted">{c.number}</span></p>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="Fluxo de boas-vindas" hint="Dispara na primeira mensagem de um contato novo."><Select value={db.connectionFlowConfigs[c.id]?.welcome} onChange={(v) => set(c.id, 'welcome', v)} placeholder="Nenhum" options={flows} /></Field>
            <Field label="Fluxo fora do horário" hint="Usa os Horários de Trabalho da empresa."><Select value={db.connectionFlowConfigs[c.id]?.away} onChange={(v) => set(c.id, 'away', v)} placeholder="Nenhum" options={flows} /></Field>
            <Field label="Fluxo de reabertura" hint="Quando um chat resolvido recebe mensagem."><Select value={db.connectionFlowConfigs[c.id]?.reopen} onChange={(v) => set(c.id, 'reopen', v)} placeholder="Nenhum" options={flows} /></Field>
          </div>
        </div>
      ))}
    </div>
  )
}

function QuickReplies() {
  const [type, setType] = useState('')
  return (
    <>
      <Select className="mb-3 w-48" value={type} onChange={setType} placeholder="Todos os tipos" options={['texto', 'imagem', 'áudio', 'documento', 'contato']} />
      <Crud coll="quickReplies" icon={Zap} newLabel="Nova Resposta" emptyTitle="Nenhuma resposta rápida criada" emptyHint="Crie sua primeira resposta rápida para começar a usar no WhatsApp" searchKeys={['shortcut', 'content']}
        extraFilter={(r) => !type || r.type === type}
        fields={[{ key: 'shortcut', label: 'Atalho', required: true, placeholder: '/pix', hint: 'Digite o atalho no chat para inserir a resposta.' }, { key: 'type', label: 'Tipo', type: 'select', options: ['texto', 'imagem', 'áudio', 'documento', 'contato'], default: 'texto' }, { key: 'content', label: 'Conteúdo', type: 'textarea', required: true }]}
        columns={[{ key: 'shortcut', label: 'Atalho', render: (r) => <code className="text-violet-300">{r.shortcut}</code> }, { key: 'type', label: 'Tipo', render: (r) => <span className="badge-muted">{r.type}</span> }, { key: 'content', label: 'Conteúdo', render: (r) => <span className="line-clamp-1">{r.content}</span> }]} />
    </>
  )
}

// Variáveis {{1}}, {{2}}… do corpo do modelo (a mesma regra do servidor, em supabase/functions/_shared/templates.ts)
const templateVars = (body) => [...new Set([...String(body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
const TEMPLATE_STATUS_BADGE = { APROVADO: 'badge-success', REJEITADO: 'badge-danger', PAUSADO: 'badge-danger', DESATIVADO: 'badge-danger', EXCLUÍDO: 'badge-muted' }
const HEADER_OPTIONS = [{ value: 'NONE', label: 'Nenhum' }, { value: 'TEXT', label: 'Texto' }, { value: 'IMAGE', label: 'Imagem' }, { value: 'VIDEO', label: 'Vídeo' }, { value: 'DOCUMENT', label: 'Documento (PDF)' }]
const HEADER_LABEL = { TEXT: 'Texto', IMAGE: 'Imagem', VIDEO: 'Vídeo', DOCUMENT: 'PDF' }
const BUTTON_TYPES = [{ value: 'QUICK_REPLY', label: 'Resposta rápida' }, { value: 'URL', label: 'Abrir link' }, { value: 'PHONE_NUMBER', label: 'Ligar' }]
const NEW_TEMPLATE = { name: '', category: 'UTILITY', language: 'pt_BR', body: '', examples: {}, header: { format: 'NONE' }, footer: '', buttons: [] }

// Modelos de mensagem da API Oficial. Com o Supabase, criar e sincronizar falam com a Meta pelo servidor
// (connection-setup → meta-template-create / meta-templates); a análise da Meta chega pelo webhook.
function Templates() {
  const db = useDB()
  const meta = db.connections.filter((c) => c.provider === 'oficial')
  const [waba, setWaba] = useState(meta[0]?.id || '')
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState('')
  const [syncError, setSyncError] = useState('')
  const vars = templateVars(edit?.body)

  // troca os modelos desta conexão pelos que o servidor devolveu
  const keep = (rows) => useDB.setState((s) => ({ whatsappTemplates: [...s.whatsappTemplates.filter((t) => t.connectionId !== waba), ...rows.map(fromRow)] }))
  const sync = async (quiet) => {
    if (!BACKEND) return toast('Templates sincronizados com a Meta (simulado).')
    setBusy('sync')
    setSyncError('')
    try {
      const r = await callFn('connection-setup', { action: 'meta-templates', connectionId: waba })
      keep(r.templates || [])
      if (!quiet) toast(`Modelos sincronizados com a Meta: ${(r.templates || []).length}.`)
    } catch (err) {
      setSyncError(err.message)
      if (!quiet) toast(err.message, 'error')
    } finally {
      setBusy('')
    }
  }
  // ao abrir (e ao trocar de número), traz o que já existe na conta, inclusive o que foi criado no Gerenciador do WhatsApp
  useEffect(() => {
    if (BACKEND && waba) sync(true)
  }, [waba])

  // arquivo do cabeçalho: vai para a pasta da empresa e o link entra no modelo (no modo demonstração fica só na tela)
  const [uploading, setUploading] = useState(false)
  const pickMedia = async (file) => {
    if (!file) return
    const format = edit.header.format
    if (!BACKEND) return setEdit((e) => ({ ...e, header: { format, mediaUrl: URL.createObjectURL(file) } }))
    setUploading(true)
    try {
      const url = await uploadTemplateMedia(db.company.id, format, file)
      setEdit((e) => ({ ...e, header: { format, mediaUrl: url } }))
    } catch (err) {
      toast(`Não foi possível enviar o arquivo: ${err.message}`, 'error')
    } finally {
      setUploading(false)
    }
  }
  const setButton = (i, patch) => setEdit((e) => ({ ...e, buttons: e.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)) }))

  const create = async () => {
    const header = edit.header.format === 'NONE' ? null : edit.header
    const draft = {
      name: edit.name, category: edit.category, language: edit.language, body: edit.body, examples: vars.map((n) => edit.examples?.[n] || ''),
      header, footer: edit.footer, buttons: edit.buttons,
    }
    if (!BACKEND) {
      db.add('whatsappTemplates', { ...draft, connectionId: waba, status: 'EM ANÁLISE' })
      setEdit(null)
      return toast('Template enviado para aprovação da Meta (simulado).')
    }
    setBusy('create')
    try {
      const r = await callFn('connection-setup', { action: 'meta-template-create', connectionId: waba, template: draft })
      keep(r.templates || [])
      setEdit(null)
      toast(r.status === 'APROVADO' ? 'Modelo criado e já aprovado pela Meta.' : 'Modelo enviado para a Meta. O status muda sozinho quando a análise terminar.')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-56" value={waba} onChange={setWaba} placeholder="Nenhuma conexão Meta Cloud" options={meta.map((c) => ({ value: c.id, label: c.name }))} />
        <button className="btn-secondary" disabled={!waba || !!busy} onClick={() => sync(false)}><RefreshCw size={15} className={busy === 'sync' ? 'animate-spin' : ''} /> Sincronizar</button>
        <button className="btn-primary" disabled={!waba || !!busy} onClick={() => setEdit(NEW_TEMPLATE)}><Plus size={15} /> Criar</button>
      </div>
      {syncError && <p className="mb-3 text-sm text-amber-400">{syncError}</p>}
      {!meta.length ? <EmptyState icon={FileText} title="Nenhuma conexão Meta Cloud" hint="Crie uma conexão com API Oficial para gerenciar templates." /> : (
        <Table rows={db.whatsappTemplates.filter((t) => t.connectionId === waba)} empty="Nenhum template nesta WABA." columns={[
          { key: 'name', label: 'Nome', render: (t) => <code className="text-text-primary">{t.name}</code> }, { key: 'category', label: 'Categoria' }, { key: 'language', label: 'Idioma' },
          { key: 'body', label: 'Texto', render: (t) => (
            <span className="line-clamp-2 max-w-md text-text-secondary">
              {HEADER_LABEL[t.header?.format] && <span className="badge-muted mr-1.5">{HEADER_LABEL[t.header.format]}</span>}
              {t.buttons?.length ? <span className="badge-muted mr-1.5">{t.buttons.length} botão(ões)</span> : null}
              {t.body}
            </span>
          ) },
          { key: 'status', label: 'Status', render: (t) => <span className={TEMPLATE_STATUS_BADGE[t.status] || 'badge-warning'} title={t.rejectedReason ? `Motivo da Meta: ${t.rejectedReason}` : undefined}>{t.status}</span> },
        ]} />
      )}
      <Modal open={!!edit} size="lg" onClose={() => !busy && !uploading && setEdit(null)} title="Novo template"
        footer={<button className="btn-primary" disabled={busy === 'create' || uploading} onClick={create}>{busy === 'create' ? 'Enviando para a Meta…' : 'Enviar para aprovação'}</button>}>
        {edit && (
          <div className="grid gap-5 md:grid-cols-[1fr_300px]">
            <div className="min-w-0">
              <Field label="Nome (minúsculas e _)"><input className="input font-mono" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
              <div className="grid gap-x-4 sm:grid-cols-2">
                <Field label="Categoria" hint={edit.category === 'UTILITY' ? 'Avisos de pedido, agendamento e conta.' : 'Ofertas, promoções e novidades.'}>
                  <Select value={edit.category} onChange={(v) => setEdit({ ...edit, category: v })} options={[{ value: 'UTILITY', label: 'Utilidade' }, { value: 'MARKETING', label: 'Marketing' }]} />
                </Field>
                <Field label="Idioma"><Select value={edit.language} onChange={(v) => setEdit({ ...edit, language: v })} options={[{ value: 'pt_BR', label: 'Português (BR)' }, { value: 'en_US', label: 'Inglês (EUA)' }, { value: 'es_ES', label: 'Espanhol' }]} /></Field>
              </div>

              <Field label="Cabeçalho" hint="Opcional. Imagem JPG/PNG até 5 MB, vídeo MP4 até 16 MB ou PDF até 16 MB.">
                <Select value={edit.header.format} onChange={(v) => setEdit({ ...edit, header: { format: v } })} options={HEADER_OPTIONS} />
              </Field>
              {edit.header.format === 'TEXT' && (
                <Field label="Texto do cabeçalho" hint="Até 60 caracteres, sem variáveis.">
                  <input className="input" maxLength={60} value={edit.header.text || ''} onChange={(e) => setEdit({ ...edit, header: { format: 'TEXT', text: e.target.value } })} />
                </Field>
              )}
              {TEMPLATE_MEDIA[edit.header.format] && (
                <Field label={`Arquivo (${TEMPLATE_MEDIA[edit.header.format].label})`} hint="A Meta usa este arquivo para analisar o modelo e ele vai junto em cada envio.">
                  <label className={cx('btn-secondary w-full cursor-pointer justify-center', uploading && 'pointer-events-none opacity-60')}>
                    {uploading ? <><Loader2 size={15} className="animate-spin" /> Enviando arquivo…</> : <><ImagePlus size={15} /> {edit.header.mediaUrl ? 'Trocar arquivo' : 'Escolher arquivo'}</>}
                    <input type="file" className="hidden" accept={TEMPLATE_MEDIA[edit.header.format].accept} onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                </Field>
              )}

              <Field label="Corpo" hint="Use {{1}}, {{2}} para variáveis, sem começar nem terminar o texto com uma delas."><textarea className="input" rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
              {vars.map((n) => (
                <Field key={n} label={`Exemplo para {{${n}}}`} hint={n === vars[0] ? 'A Meta usa os exemplos para analisar o modelo.' : undefined}>
                  <input className="input" value={edit.examples?.[n] || ''} onChange={(e) => setEdit({ ...edit, examples: { ...edit.examples, [n]: e.target.value } })} />
                </Field>
              ))}

              <Field label="Rodapé" hint="Opcional. Até 60 caracteres, sem variáveis.">
                <input className="input" maxLength={60} value={edit.footer} onChange={(e) => setEdit({ ...edit, footer: e.target.value })} />
              </Field>

              <Field label="Botões" hint="Opcional. Até 10: respostas rápidas, até 2 links e 1 de ligação.">
                <div className="space-y-2">
                  {edit.buttons.map((b, i) => (
                    <div key={i} className="panel-soft space-y-1.5 p-2.5">
                      <div className="flex gap-1.5">
                        <Select className="w-40 py-1.5 text-xs" value={b.type} onChange={(v) => setButton(i, { type: v })} options={BUTTON_TYPES} />
                        <input className="input min-w-0 flex-1 py-1.5 text-xs" maxLength={25} placeholder="Texto do botão" value={b.text} onChange={(e) => setButton(i, { text: e.target.value })} />
                        <button className="btn-ghost p-1.5 text-red-400" onClick={() => setEdit({ ...edit, buttons: edit.buttons.filter((_, j) => j !== i) })} aria-label="Remover botão"><Trash2 size={14} /></button>
                      </div>
                      {b.type === 'URL' && <input className="input py-1.5 text-xs" placeholder="https://seusite.com.br" value={b.url || ''} onChange={(e) => setButton(i, { url: e.target.value })} />}
                      {b.type === 'PHONE_NUMBER' && <input className="input py-1.5 text-xs" placeholder="+55 11 9XXXX-XXXX" value={b.phone || ''} onChange={(e) => setButton(i, { phone: e.target.value })} />}
                    </div>
                  ))}
                  {edit.buttons.length < 10 && (
                    <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => setEdit({ ...edit, buttons: [...edit.buttons, { type: 'QUICK_REPLY', text: '' }] })}><Plus size={13} /> Adicionar botão</button>
                  )}
                </div>
              </Field>
            </div>
            <div className="md:sticky md:top-0 md:self-start">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Prévia no WhatsApp</p>
              <TemplatePreview header={edit.header} body={edit.body} footer={edit.footer} buttons={edit.buttons} params={vars.map((n) => edit.examples?.[n] || '')} />
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

function GlobalVars() {
  return (
    <Crud coll="globalVars" icon={Variable} newLabel="Nova Variável" emptyTitle="Nenhuma variável encontrada" emptyHint="Crie sua primeira variável para começar" searchKeys={['name', 'description']}
      fields={[{ key: 'name', label: 'Nome', required: true, placeholder: 'link_checkout', hint: 'Use nos fluxos como {{link_checkout}}' }, { key: 'value', label: 'Valor', required: true }, { key: 'description', label: 'Descrição' }]}
      columns={[{ key: 'name', label: 'Variável', render: (r) => <code className="text-violet-300">{`{{${r.name}}}`}</code> }, { key: 'value', label: 'Valor', render: (r) => <span className="line-clamp-1">{r.value}</span> }, { key: 'description', label: 'Descrição' }]} />
  )
}

function CustomFields() {
  const db = useDB()
  const [tab, setTab] = useState('custom')
  return (
    <>
      <div className="mb-4 flex gap-1.5">
        {[['custom', 'Customizados'], ['system', 'Sistema (BOT)']].map(([id, l]) => <button key={id} onClick={() => setTab(id)} className={cx('rounded-full border px-3 py-1.5 text-xs font-medium', tab === id ? 'chip-on' : 'border-border text-text-secondary')}>{l}</button>)}
      </div>
      {tab === 'custom' ? (
        <>
          <p className="mb-3 text-sm text-text-muted">Defina campos adicionais para registrar detalhes customizados em seus leads</p>
          <Crud coll="customFields" icon={ListPlus} newLabel="Novo Campo" emptyTitle="Nenhum campo personalizado" searchKeys={['key', 'label']}
            fields={[{ key: 'label', label: 'Nome de exibição', required: true }, { key: 'key', label: 'Chave', required: true, placeholder: 'cidade', hint: 'Usada nos fluxos como {{chave}}' }, { key: 'type', label: 'Tipo', type: 'select', options: ['Texto', 'Número', 'Data', 'Sim/Não', 'Lista'], default: 'Texto' }]}
            columns={[{ key: 'key', label: 'Chave', render: (r) => <code className="text-violet-300">{r.key}</code> }, { key: 'label', label: 'Nome' }, { key: 'type', label: 'Tipo', render: (r) => <span className="badge-muted">{r.type}</span> }]} />
        </>
      ) : (
        <Table rows={db.systemFields.map((f) => ({ ...f, id: f.key }))} columns={[{ key: 'key', label: 'Chave', render: (r) => <code className="text-violet-300">{r.key}</code> }, { key: 'label', label: 'Descrição' }, { key: 'type', label: 'Tipo', render: (r) => <span className="badge-muted">{r.type}</span> }]} />
      )}
    </>
  )
}

function Labels() {
  const db = useDB()
  return (
    <Crud coll="labels" icon={Tag} newLabel="Nova Etiqueta" emptyTitle="Nenhuma etiqueta criada" emptyHint="Crie sua primeira etiqueta para começar a organizar" searchKeys={['name']}
      fields={[{ key: 'name', label: 'Nome', required: true }, { key: 'color', label: 'Cor', type: 'color', default: '#7fee64' }]}
      columns={[{ key: 'name', label: 'Etiqueta', render: (l) => <span className="inline-flex items-center gap-2"><span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: l.color + '25', color: l.color }}>{l.name}</span>{l.automatica && <span className="badge-muted" title="Uma rotina do sistema põe e tira esta etiqueta sozinha">Automática</span>}</span> }, { key: 'n', label: 'Contatos', render: (l) => db.contacts.filter((c) => c.labels.includes(l.id)).length }]} />
  )
}

/* ---------- Integrações ---------- */

const INTEGRATIONS = [
  { id: 'vortexpay', name: BRAND.payName, cat: 'Pagamentos', desc: 'Receba no Brasil, no México e na América Latina.', featured: true },
  { id: 'nfe', name: 'Emissor NF-e', cat: 'Notas Fiscais', desc: 'Emissão automatizada de Notas Fiscais eletrônicas de vendas' },
  { id: 'openai', name: 'OpenAI GPT', cat: 'Inteligência Artificial', desc: 'Respostas dos agentes de IA, leitura de imagens, transcrição de áudio e voz' },
  { id: 'gemini', name: 'Google Gemini', cat: 'Inteligência Artificial', desc: 'Respostas dos agentes de IA e leitura de imagens' },
  { id: 'compat', name: 'Outro provedor de IA', cat: 'Inteligência Artificial', desc: 'Groq, DeepSeek, OpenRouter e outros com API no padrão da OpenAI' },
  { id: 'elevenlabs', name: 'ElevenLabs', cat: 'Inteligência Artificial', desc: 'Transcreve os áudios dos clientes e gera a voz dos agentes' },
  { id: 'xpag', name: 'XPag', cat: 'Pagamentos', desc: 'PIX (BRL), API LATAM e API Cripto (USDT) com recebimento em tempo real' },
  { id: 'mercadopago', name: 'Mercado Pago', cat: 'Pagamentos', desc: 'Pix, cartão e boleto com webhooks de aprovação' },
]

// Provedores que os agentes de IA usam: a chave vai para o servidor (nunca fica no navegador) e dá para testar.
const AI_KEYS = {
  openai: { model: 'gpt-4.1-mini', modelHint: 'Ex.: gpt-4.1-mini ou gpt-4o-mini (confira os modelos da sua conta). Também transcreve áudio e gera voz.' },
  gemini: { model: 'gemini-2.5-flash', modelHint: 'Ex.: gemini-2.5-flash. A chave é criada no Google AI Studio.' },
  compat: { model: '', baseUrl: true, modelHint: 'Nome do modelo no provedor. Ex.: llama-3.3-70b-versatile (Groq), deepseek-chat (DeepSeek).' },
  elevenlabs: { noModel: true },
}

function Integrations() {
  const db = useDB()
  const modules = useModules()
  const [cat, setCat] = useState('Todas')
  const [q, setQ] = useState('')
  const [cfg, setCfg] = useState(null)
  const [keys, setKeys] = useState([])
  const [form, setForm] = useState({ apiKey: '', model: '', baseUrl: '' })
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const reloadKeys = () => (BACKEND ? aiCredentialList(db.company.id).then(setKeys).catch((e) => toast(e.message, 'error')) : Promise.resolve())
  useEffect(() => { reloadKeys() }, [db.company.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const isAi = (i) => BACKEND && !!AI_KEYS[i?.id]
  const keyOf = (i) => keys.find((k) => k.provider === i?.id)
  const connectedIds = new Set([...db.integrations.filter((x) => !(BACKEND && AI_KEYS[x])), ...keys.map((k) => k.provider)])
  const cats = ['Todas', 'Notas Fiscais', 'Rastreamento', 'Pagamentos', 'Inteligência Artificial']
  // Card de um módulo que a empresa não tem só aparece se já houver chave salva (para poder desconectar).
  const filtered = INTEGRATIONS.filter((i) => (!i.module || modules.includes(i.module) || connectedIds.has(i.id)) && (cat === 'Todas' || i.cat === cat) && i.name.toLowerCase().includes(q.toLowerCase()))
  const active = filtered.filter((i) => connectedIds.has(i.id))
  const available = filtered.filter((i) => !connectedIds.has(i.id))
  const featured = INTEGRATIONS.find((i) => i.featured)

  const open = (i) => {
    const k = keyOf(i)
    setForm({ apiKey: '', model: k?.model || AI_KEYS[i.id]?.model || '', baseUrl: k?.baseUrl || '' })
    setResult(null)
    setCfg(i)
  }
  const disconnect = async (i) => {
    if (isAi(i)) {
      try { await aiCredentialRemove(db.company.id, i.id) } catch (e) { return toast(e.message, 'error') }
      await reloadKeys()
    }
    db.setKey('integrations', (l) => l.filter((x) => x !== i.id))
    toast(`${i.name} desconectada.`)
  }
  const test = async (i) => {
    setBusy('test')
    setResult(null)
    try {
      const r = await aiCheck(db.company.id, i.id)
      setResult({ ok: true, text: `Funcionando${r.model ? ` · ${r.model}` : ''}${r.reply ? ` · respondeu "${r.reply}"` : ''} (${r.ms} ms)` })
    } catch (e) {
      setResult({ ok: false, text: e.message })
    } finally {
      setBusy(null)
    }
  }
  const saveAi = async () => {
    const meta = AI_KEYS[cfg.id]
    if (!keyOf(cfg) && !form.apiKey.trim()) return toast('Cole a chave de API.', 'error')
    if (meta.baseUrl && !/^https:\/\//.test(form.baseUrl.trim())) return toast('Informe a URL base (começando com https://).', 'error')
    if (!meta.noModel && !form.model.trim()) return toast('Informe o modelo.', 'error')
    setBusy('save')
    try {
      await aiCredentialSave(db.company.id, cfg.id, form)
      await reloadKeys()
      if (!db.integrations.includes(cfg.id)) db.setKey('integrations', (l) => [...new Set([...l, cfg.id])])
      setForm((f) => ({ ...f, apiKey: '' }))
      toast(`${cfg.name} conectada. Testando…`)
      setBusy(null)
      await test(cfg)
    } catch (e) {
      toast(e.message, 'error')
      setBusy(null)
    }
  }

  const Card = ({ i }) => {
    const k = keyOf(i)
    return (
      <div className="card flex flex-col p-4">
        <p className="eyebrow-label">{i.cat}</p>
        <p className="mt-1 font-semibold">{i.name}</p>
        <p className="mb-4 flex-1 text-xs text-text-muted">{i.desc}</p>
        {k && <p className="mb-2 truncate font-mono text-[11px] text-text-muted">{k.model || 'chave'} · {k.keyHint || '••••'}</p>}
        {connectedIds.has(i.id) ? (
          <div className="flex flex-wrap gap-2">
            <span className="badge-success self-center">Conectada</span>
            {isAi(i) && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => open(i)}>Editar / testar</button>}
            <button className="btn-ghost ml-auto text-xs text-red-400" onClick={() => disconnect(i)}>Desconectar</button>
          </div>
        ) : <button className="btn-secondary text-xs" onClick={() => open(i)}>Configurar</button>}
      </div>
    )
  }
  const meta = cfg && AI_KEYS[cfg.id]
  return (
    <>
      <div className="mb-4 flex flex-col gap-2 md:flex-row">
        <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Buscar integração…" />
        <div className="flex flex-wrap gap-1.5">{cats.map((c) => <button key={c} onClick={() => setCat(c)} className={cx('rounded-full border px-3 py-1.5 text-xs', cat === c ? 'chip-on' : 'border-border text-text-secondary')}>{c}</button>)}</div>
      </div>
      <div className="mb-5 flex flex-col gap-3 rounded-[20px] border border-[var(--border-accent)] p-5 sm:flex-row sm:items-center" style={{ background: 'var(--banner-bg)', boxShadow: 'var(--shadow-panel)' }}>
        <div className="flex-1"><span className="badge-primary mb-1">Novidade · Destaque</span><p className="text-lg font-bold">{featured.name}</p><p className="text-sm text-text-secondary">{featured.desc}</p></div>
        <button className="btn-primary" onClick={() => open(featured)}>Configurar</button>
      </div>
      <p className="mb-2 text-sm font-semibold">Ativas <span className="text-text-muted">{active.length}</span> <span className="font-normal text-text-muted">· Conectadas na sua conta</span></p>
      {active.length === 0 ? <p className="mb-5 text-sm text-text-muted">Nenhuma integração ativa em {cat}. Escolha uma opção abaixo para começar.</p> : <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{active.map((i) => <Card key={i.id} i={i} />)}</div>}
      <p className="mb-2 text-sm font-semibold">Disponíveis <span className="text-text-muted">{available.length}</span> <span className="font-normal text-text-muted">· Prontas para conectar</span></p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{available.map((i) => <Card key={i.id} i={i} />)}</div>
      {cfg && isAi(cfg) ? (
        <Modal open onClose={() => setCfg(null)} title={`Configurar ${cfg.name}`} subtitle="A chave fica guardada só no servidor, separada por empresa. Ninguém a vê depois de salva." size="sm"
          footer={<>
            {keyOf(cfg) && <button className="btn-secondary" disabled={!!busy} onClick={() => test(cfg)}>{busy === 'test' && <Loader2 size={14} className="animate-spin" />} Testar</button>}
            <button className="btn-primary" disabled={!!busy} onClick={saveAi}>{busy === 'save' && <Loader2 size={14} className="animate-spin" />} Salvar e testar</button>
          </>}>
          <Field label="Chave de API" hint={keyOf(cfg) ? `Salva: ${keyOf(cfg).keyHint || '••••'}. Deixe em branco para manter a atual.` : 'Cole a chave criada no painel do provedor.'}>
            <input className="input font-mono" type="password" autoComplete="off" placeholder={keyOf(cfg) ? '••••••••' : 'sk-...'} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </Field>
          {meta.baseUrl && (
            <Field label="URL base da API" hint="Ex.: https://api.groq.com/openai/v1 · https://api.deepseek.com/v1 · https://openrouter.ai/api/v1">
              <input className="input font-mono text-xs" placeholder="https://..." value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </Field>
          )}
          {!meta.noModel && (
            <Field label="Modelo" hint={meta.modelHint}>
              <input className="input font-mono text-xs" placeholder={meta.model || 'nome-do-modelo'} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </Field>
          )}
          {result && <p className={cx('rounded-[12px] p-2.5 text-xs', result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>{result.ok ? '✓ ' : '✕ '}{result.text}</p>}
        </Modal>
      ) : (
        <Modal open={!!cfg} onClose={() => setCfg(null)} title={`Configurar ${cfg?.name}`} size="sm" footer={<button className="btn-primary" onClick={() => { db.setKey('integrations', (l) => [...new Set([...l, cfg.id])]); toast(`${cfg.name} conectada.`); setCfg(null) }}>Salvar e conectar</button>}>
          <Field label="Chave de API / Token" hint="Fica salvo só neste navegador nesta versão de demonstração."><input className="input font-mono" type="password" placeholder="sk-..." /></Field>
        </Modal>
      )}
    </>
  )
}

/* ---------- Uso da IA ---------- */

const RUN_STATUS = {
  respondeu: ['badge-success', 'Respondeu'], transferiu: ['badge-warning', 'Transferiu'], sem_resposta: ['badge-muted', 'Sem resposta'],
  pulou: ['badge-muted', 'Não respondeu'], erro: ['badge-danger', 'Erro'], sem_credito: ['badge-danger', 'Sem Créditos de IA'],
}

// Cada vez que um agente de IA foi acionado numa conversa: o que fez, com qual modelo e quanto usou.
function AiUsage() {
  const db = useDB()
  const [rows, setRows] = useState(null)
  useEffect(() => {
    if (!BACKEND) return setRows([])
    let alive = true
    aiRuns(db.company.id).then((r) => alive && setRows(r)).catch((e) => { toast(e.message, 'error'); if (alive) setRows([]) })
    return () => { alive = false }
  }, [db.company.id])
  if (rows === null) return <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Carregando…</p>
  if (!rows.length) return <EmptyBox title={`Nenhum uso da ${BRAND.aiName} ainda.`} hint="Cada resposta dos agentes de IA aparece aqui, com o resultado, o modelo e os tokens usados." icon={Sparkles} />
  const name = (chatId) => db.contacts.find((c) => c.id === db.chats.find((x) => x.id === chatId)?.contactId)?.name || '—'
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0)
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Execuções', rows.length], ['Respondidas', rows.filter((r) => r.status === 'respondeu').length], ['Transferidas', rows.filter((r) => r.status === 'transferiu').length], ['Tokens (entrada / saída)', `${sum('inputTokens').toLocaleString('pt-BR')} / ${sum('outputTokens').toLocaleString('pt-BR')}`]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs text-text-muted">{l}</p><p className="text-lg font-bold">{v}</p></div>
        ))}
      </div>
      <Table rows={rows} columns={[
        { key: 'createdAt', label: 'Quando', render: (r) => fmtDate(r.createdAt) },
        { key: 'chat', label: 'Conversa', render: (r) => name(r.chatId) },
        { key: 'agent', label: 'Agente', render: (r) => db.agents.find((a) => a.id === r.agentId)?.name || '—' },
        { key: 'status', label: 'Resultado', render: (r) => <span className={(RUN_STATUS[r.status] || RUN_STATUS.pulou)[0]}>{(RUN_STATUS[r.status] || RUN_STATUS.pulou)[1]}</span> },
        { key: 'model', label: 'Modelo', render: (r) => <span className="font-mono text-xs">{r.model || '—'}</span> },
        { key: 'tokens', label: 'Tokens', render: (r) => `${r.inputTokens} / ${r.outputTokens}` },
        { key: 'actions', label: 'Ações', render: (r) => (r.actions || []).map((x) => `${x.ok ? '✓' : '✕'} ${x.tool}`).join(', ') || '—' },
        { key: 'detail', label: 'Detalhe', render: (r) => <span className="text-xs text-text-muted">{r.error || r.reason || ''}</span> },
      ]} />
    </>
  )
}

function Products() {
  return (
    <Crud coll="products" icon={Package} newLabel="Novo produto" emptyTitle="Nenhum produto cadastrado" emptyHint="Crie o primeiro produto para usar em vendas e fluxos." searchKeys={['name']}
      fields={[{ key: 'name', label: 'Nome', required: true }, { key: 'price', label: 'Valor padrão', type: 'number', default: 0 }, { key: 'min', label: 'Preço mínimo', type: 'number', default: 0 }, { key: 'max', label: 'Preço máximo', type: 'number', default: 0 }, { key: 'currency', label: 'Moeda', type: 'select', options: ['BRL', 'USD', 'EUR', 'MXN'], default: 'BRL' }]}
      columns={[{ key: 'name', label: 'Produto', render: (p) => <span className="text-text-primary">{p.name}</span> }, { key: 'price', label: 'Valor padrão', render: (p) => <b>{brl(p.price, p.currency)}</b> }, { key: 'range', label: 'Faixa', render: (p) => `${brl(p.min, p.currency)} – ${brl(p.max, p.currency)}` }]} />
  )
}

// Servidor MCP do Vórtex CRM (supabase/functions/mcp). A chave é da empresa aberta; o banco guarda só o hash,
// então ela aparece uma vez, na criação. Criar e revogar: só Proprietário ou Admin (conferido também no banco).
function Mcp() {
  const db = useDB()
  const url = BACKEND ? `${SUPABASE_URL}/functions/v1/mcp` : 'https://<seu-projeto>.supabase.co/functions/v1/mcp'
  const canEdit = !BACKEND || ['Proprietário', 'Admin'].includes(db.user.role)
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(BACKEND)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('envio')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)
  const [revoke, setRevoke] = useState(null)
  const [info, setInfo] = useState(false)

  const load = async () => {
    if (!BACKEND) return
    const { data, error } = await supabase.from('mcp_keys').select('id, name, prefix, scope, last_used_at, revoked_at, created_at').eq('company_id', db.company.id).order('created_at', { ascending: false })
    if (error) toast(error.message, 'error')
    setKeys(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [db.company.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (t, msg) => { navigator.clipboard?.writeText(t); toast(msg) }
  const command = (key) => `claude mcp add --transport http --scope user vortex-crm ${url} --header "Authorization: Bearer ${key}"`

  const create = async () => {
    if (!name.trim()) return toast('Dê um nome à chave.', 'error')
    if (!BACKEND) return toast('No modo demonstração não há servidor MCP.', 'error')
    setBusy(true)
    const { data, error } = await supabase.rpc('mcp_key_create', { p_name: name.trim(), p_scope: scope })
    setBusy(false)
    if (error) return toast(error.message, 'error')
    setCreated({ name: name.trim(), key: data.key, scope })
    setName('')
    load()
  }
  const doRevoke = async () => {
    const { error } = await supabase.rpc('mcp_key_revoke', { p_id: revoke.id })
    if (error) return toast(error.message, 'error')
    toast('Chave revogada.')
    setRevoke(null)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between"><p className="font-semibold">Servidor MCP</p><button className="btn-ghost text-xs" onClick={() => setInfo(true)}><Info size={14} /> Como usar?</button></div>
        <p className="mb-3 text-sm text-text-muted">Conecte o Claude, o Cursor ou o n8n ao {BRAND.name} desta empresa: buscar contatos, ler conversas e mandar mensagens pelo WhatsApp conectado, no privado ou nos grupos.</p>
        <Field label="URL"><div className="flex gap-2"><input readOnly className="input font-mono text-xs" value={url} /><button className="btn-secondary" onClick={() => copy(url, 'URL copiada.')}><Copy size={14} /></button></div></Field>
        <pre className="panel-soft mt-3 overflow-x-auto p-3 text-xs text-[var(--accent-text)]">Authorization: Bearer vcrm_…</pre>
      </div>
      <div className="card p-5">
        <p className="font-semibold">Chaves</p>
        <p className="mb-3 text-sm text-text-muted">Cada chave vale só para esta empresa. "Leitura e envio" também cria contatos e manda mensagens de verdade.</p>
        {canEdit ? (
          <div className="mb-3 flex flex-col gap-2 md:flex-row">
            <input className="input" placeholder="Nome (ex.: Claude Code da Ana)" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <select className="input md:w-48" value={scope} onChange={(e) => setScope(e.target.value)}><option value="envio">Leitura e envio</option><option value="leitura">Só leitura</option></select>
            <button className="btn-primary shrink-0" disabled={busy} onClick={create}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Key size={15} />} Nova chave</button>
          </div>
        ) : <p className="mb-3 text-xs text-text-muted">Só o proprietário ou um admin cria e revoga chaves.</p>}
        {loading ? <p className="text-sm text-text-muted">Carregando…</p> : keys.length === 0 ? <p className="text-sm text-text-muted">Nenhuma chave. Crie uma para conectar seu assistente.</p> : keys.map((k) => (
          <div key={k.id} className={cx('flex flex-wrap items-center gap-3 border-t border-border py-2.5 text-sm', k.revoked_at && 'opacity-50')}>
            <Key size={14} className="text-violet-400" /><span className="min-w-0 flex-1 truncate">{k.name}</span>
            <code className="text-xs text-text-muted">vcrm_{k.prefix}…</code>
            <span className={k.scope === 'envio' ? 'badge-warning' : 'badge-muted'}>{k.scope === 'envio' ? 'Leitura e envio' : 'Só leitura'}</span>
            <span className="text-xs text-text-muted" title="Criada em">{fmtDate(k.created_at)}</span>
            <span className="text-xs text-text-muted">{k.last_used_at ? `Usada ${fmtDate(k.last_used_at)}` : 'Nunca usada'}</span>
            {k.revoked_at ? <span className="text-xs text-red-400">Revogada</span> : canEdit && <button className="btn-ghost px-2 py-1 text-xs text-red-400" onClick={() => setRevoke(k)}>Revogar</button>}
          </div>
        ))}
      </div>
      <Modal open={!!created} onClose={() => setCreated(null)} title="Chave criada" subtitle="Copie agora: por segurança ela não aparece de novo.">
        {created && <div className="space-y-3">
          <Field label="Chave"><div className="flex gap-2"><input readOnly className="input font-mono text-xs" value={created.key} /><button className="btn-secondary" onClick={() => copy(created.key, 'Chave copiada.')}><Copy size={14} /></button></div></Field>
          <Field label="Claude Code (cole no terminal)"><div className="flex gap-2"><textarea readOnly rows={3} className="input font-mono text-xs" value={command(created.key)} /><button className="btn-secondary self-start" onClick={() => copy(command(created.key), 'Comando copiado.')}><Copy size={14} /></button></div></Field>
          <div className="flex justify-end"><button className="btn-primary" onClick={() => setCreated(null)}>Pronto, copiei</button></div>
        </div>}
      </Modal>
      <Confirm open={!!revoke} onClose={() => setRevoke(null)} onConfirm={doRevoke} title="Revogar chave?" message={`Quem usa "${revoke?.name}" perde o acesso na hora. Não dá para desfazer.`} confirmLabel="Revogar" />
      <Modal open={info} onClose={() => setInfo(false)} title="Como usar o servidor MCP">
        <ul className="list-disc space-y-2 pl-5 text-sm text-text-secondary">
          <li>Crie uma chave e copie (ela só aparece uma vez).</li>
          <li>No Claude Code, cole o comando que aparece depois de criar a chave. Em outros clientes, cadastre a URL (transporte HTTP) e mande a chave no cabeçalho Authorization como Bearer.</li>
          <li>Ferramentas: listar conexões, buscar e ver contatos, etiquetas, listar e ler conversas, criar/editar contato, preparar upload e enviar mensagem.</li>
          <li>Grupos (só conexão por QR Code): listar os grupos do número e mandar mensagem num grupo. Mandar a mesma coisa em muitos grupos seguidos pode bloquear o número: espace os envios.</li>
          <li>Conversa aberta pelo MCP fica com a automação desligada: as respostas não caem em fluxo nem em agente de IA.</li>
          <li>Limite de 60 chamadas por minuto por chave. Revogue as chaves que não usa mais.</li>
        </ul>
      </Modal>
    </div>
  )
}
