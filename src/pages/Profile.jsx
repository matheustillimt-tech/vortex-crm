import { useState } from 'react'
import { User, Lock, Bell, RotateCcw } from 'lucide-react'
import { useDB, toast } from '../lib/store'
import { BACKEND } from '../lib/supabase'
import { Avatar, Confirm, Field, PageHeader, Select, Tabs, Toggle } from '../components/ui'

export default function Profile() {
  const db = useDB()
  const [tab, setTab] = useState('info')
  const [f, setF] = useState({ name: db.user.name, email: db.user.email, phone: db.user.phone || '', locale: db.user.locale || 'pt-BR', timezone: db.user.timezone || 'America/Sao_Paulo' })
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [notif, setNotif] = useState(db.user.notif || { toast: true, sound: true, volume: 70 })
  const [reset, setReset] = useState(false)
  const strength = pw.next.length >= 12 ? ['Forte', 'bg-green-500', 3] : pw.next.length >= 8 ? ['Média', 'bg-amber-500', 2] : pw.next ? ['Fraca', 'bg-red-500', 1] : null

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader icon={User} title="Meu perfil" subtitle="Seus dados pessoais, segurança e preferências" />
      <div className="card mb-4 flex items-center gap-4 p-5">
        <Avatar name={db.user.name} size={64} color="#d97706" />
        <div>
          <p className="text-lg font-semibold">{db.user.name}</p>
          <p className="text-sm text-text-muted">{db.user.email}</p>
          <span className="badge-warning mt-1">Proprietário · {db.company.name}</span>
        </div>
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'info', label: 'Informações', icon: User }, { id: 'security', label: 'Segurança', icon: Lock }, { id: 'notifications', label: 'Notificações', icon: Bell }]} />
      {tab === 'info' && (
        <div className="card p-5">
          <div className="grid gap-x-4 md:grid-cols-2">
            <Field label="Nome completo"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="E-mail"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Telefone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Idioma"><Select value={f.locale} onChange={(v) => setF({ ...f, locale: v })} options={[{ value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} /></Field>
            <Field label="Fuso horário"><Select value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} options={['America/Sao_Paulo', 'America/Manaus', 'America/Mexico_City', 'Europe/Lisbon']} /></Field>
          </div>
          <button className="btn-primary" onClick={() => { db.setKey('user', (u) => ({ ...u, ...f })); toast('Perfil atualizado.') }}>Salvar alterações</button>
        </div>
      )}
      {tab === 'security' && (
        <div className="card p-5">
          <Field label="Senha atual"><input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="Nova senha"><input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          {strength && (
            <div className="-mt-2 mb-4 flex items-center gap-2">
              <div className="flex flex-1 gap-1">{[1, 2, 3].map((i) => <div key={i} className={`h-1.5 flex-1 rounded-full ${i <= strength[2] ? strength[1] : 'bg-surface-interactive'}`} />)}</div>
              <span className="text-xs text-text-muted">{strength[0]}</span>
            </div>
          )}
          <Field label="Confirmar nova senha"><input className="input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <button className="btn-primary" onClick={async () => {
            if (pw.next.length < 8) return toast('A nova senha precisa de pelo menos 8 caracteres.', 'error')
            if (pw.next !== pw.confirm) return toast('As senhas não conferem.', 'error')
            const error = await db.updatePassword(pw.next)
            if (error) return toast(error, 'error')
            setPw({ current: '', next: '', confirm: '' }); toast('Senha alterada.')
          }}>Alterar senha</button>
        </div>
      )}
      {tab === 'notifications' && (
        <div className="card p-5">
          <Toggle checked={notif.toast} onChange={(v) => setNotif({ ...notif, toast: v })} label="Alertas na tela" description="Mostrar toasts quando chegar mensagem" />
          <Toggle checked={notif.sound} onChange={(v) => setNotif({ ...notif, sound: v })} label="Sons" description="Tocar som ao receber mensagem" />
          <Field label={`Volume (${notif.volume}%)`}><input type="range" min={0} max={100} value={notif.volume} onChange={(e) => setNotif({ ...notif, volume: +e.target.value })} className="w-full accent-violet-500" /></Field>
          <button className="btn-primary" onClick={() => { db.setKey('user', (u) => ({ ...u, notif })); toast('Preferências salvas.') }}>Salvar</button>
        </div>
      )}
      {!BACKEND && (
        <div className="card mt-6 flex items-center justify-between border-amber-500/30 p-5">
          <div><p className="font-semibold">Dados de demonstração</p><p className="text-sm text-text-muted">Volta todos os dados do app para o estado inicial.</p></div>
          <button className="btn-secondary" onClick={() => setReset(true)}><RotateCcw size={15} /> Restaurar</button>
        </div>
      )}
      <Confirm open={reset} onClose={() => setReset(false)} title="Restaurar dados de demonstração" message="Tudo que você criou neste navegador será substituído pelos dados de exemplo." confirmLabel="Restaurar" onConfirm={() => { db.resetDemo(); toast('Dados restaurados.') }} />
    </div>
  )
}
