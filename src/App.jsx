import { useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useDB, reloadData } from './lib/store'
import Layout from './components/Layout'
import { Toasts } from './components/ui'
import { Login, Register, ForgotPassword, ResetPassword } from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Chats from './pages/Chats'
import { KanbanList, KanbanBoard } from './pages/Kanban'
import Contacts from './pages/Contacts'
import Flows from './pages/Flows'
import FlowEditor from './pages/FlowEditor'
import { AgentList, AgentEditor } from './pages/Agents'
import Connections from './pages/Connections'
import Webhooks from './pages/Webhooks'
import MassDispatches from './pages/MassDispatches'
import Facebook from './pages/Facebook'
import Billing from './pages/Billing'
import Settings from './pages/Settings'
import Profile from './pages/Profile'
import Companies from './pages/Companies'
import { SuperAdmins, SuperCompanies, SuperCompany, SuperPackages } from './pages/SuperAdmin'
import { SuperSupport } from './pages/SupportCenter'
import AiCredits from './pages/AiCredits'
import SuperCredits from './pages/SuperCredits'
import Tutorials from './pages/Tutorials'
import Inteligencia from './pages/Inteligencia'
import { useSupportSync } from './lib/support'
import { useAtualizacaoAutomatica } from './lib/versao'

// Política de Privacidade e Termos são HTML estático (public/privacidade, public/termos). Na Vercel o servidor entrega
// direto (vercel.json); no servidor de desenvolvimento a rota cai no app, que só recarrega a página estática.
function StaticPage({ path }) {
  useEffect(() => { window.location.replace(path) }, [path])
  return null
}

// Remonta o editor quando o :id muda, para não reaproveitar o estado do item anterior
const Keyed = ({ C }) => <C key={useParams().id} />

function Splash({ text, error }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-base p-6 text-center">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" style={error ? { animation: 'none', borderColor: '#EF4444' } : undefined} />
      <p className="text-sm text-text-secondary">{text}</p>
      {error && (
        <>
          <p className="max-w-md text-xs text-red-400">{error}</p>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={reloadData}>Tentar de novo</button>
            <button className="btn-secondary" onClick={() => useDB.getState().logout()}>Sair</button>
          </div>
        </>
      )}
    </div>
  )
}

function RequireAuth({ children }) {
  const { session, authChecked, ready, loadError, noCompany } = useDB()
  const loc = useLocation()
  if (!authChecked) return <Splash text="Verificando autenticação..." />
  if (!session) return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  if (loadError) return <Splash text="Não foi possível carregar sua empresa." error={loadError} />
  if (!ready) return <Splash text="Carregando sua empresa..." />
  // sem nenhuma empresa (saiu de todas): escolhe, cria ou entra por convite
  if (noCompany && loc.pathname !== '/empresas') return <Navigate to="/empresas" replace />
  return children
}

// Painel da plataforma: só superadmin (o banco também recusa as funções do painel para os demais)
function RequireSuperadmin({ children }) {
  const isSuperadmin = useDB((s) => s.isSuperadmin)
  if (!isSuperadmin) return <Navigate to="/welcome" replace />
  return children
}

export default function App() {
  // suporte da plataforma: atendimentos do usuário e, para o superadmin, de todas as contas, em tempo real
  useSupportSync()
  // versão nova publicada: recarrega na próxima troca de tela
  useAtualizacaoAutomatica()
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/cadastro" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/privacidade" element={<StaticPage path="/privacidade/index.html" />} />
        <Route path="/termos" element={<StaticPage path="/termos/index.html" />} />
        {/* Boas-vindas: entrar em outra empresa, criar uma nova ou entrar por convite (já logado) */}
        <Route path="/empresas" element={<RequireAuth><Companies /></RequireAuth>} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route path="/welcome" element={<Dashboard />} />
          <Route path="/inteligencia" element={<Inteligencia />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/chat" element={<Navigate to="/chats" replace />} />
          <Route path="/crms" element={<KanbanList />} />
          <Route path="/crms/:id" element={<KanbanBoard />} />
          <Route path="/customers" element={<Contacts />} />
          <Route path="/flows" element={<Flows />} />
          <Route path="/flows/:id/edit" element={<Keyed C={FlowEditor} />} />
          <Route path="/flows/:id" element={<Keyed C={FlowEditor} />} />
          <Route path="/agentes" element={<AgentList />} />
          <Route path="/agentes/:id" element={<Keyed C={AgentEditor} />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/settings/inbound-webhooks" element={<Webhooks />} />
          <Route path="/mass-dispatches" element={<MassDispatches />} />
          <Route path="/facebook" element={<Navigate to="/facebook/campaigns" replace />} />
          <Route path="/facebook/:tab" element={<Facebook />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/creditos-ia" element={<AiCredits />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/labels" element={<Navigate to="/settings?tab=tags" replace />} />
          <Route path="/quick_replies" element={<Navigate to="/settings?tab=quick_replies" replace />} />
          <Route path="/global_variables" element={<Navigate to="/settings?tab=global_variables" replace />} />
          <Route path="/customer_custom_fields" element={<Navigate to="/settings?tab=custom_fields" replace />} />
          <Route path="/products" element={<Navigate to="/settings?tab=products" replace />} />
          <Route path="/integrations" element={<Navigate to="/settings?tab=integrations" replace />} />
          <Route path="/departments" element={<Navigate to="/settings?tab=accounts&sub=departments" replace />} />
          <Route path="/business-hours" element={<Navigate to="/settings?tab=accounts&sub=hours" replace />} />
          <Route path="/users" element={<Navigate to="/settings?tab=team" replace />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/tutoriais" element={<Tutorials />} />
          {/* Acesso ao desenvolvedor: no mesmo painel, com os itens no menu lateral */}
          <Route element={<RequireSuperadmin><div className="mx-auto max-w-[1400px]"><Outlet /></div></RequireSuperadmin>}>
            <Route path="/superadmin" element={<SuperCompanies />} />
            <Route path="/superadmin/empresas/:id" element={<SuperCompany />} />
            <Route path="/superadmin/pacotes" element={<SuperPackages />} />
            <Route path="/superadmin/admins" element={<SuperAdmins />} />
            <Route path="/superadmin/creditos" element={<SuperCredits />} />
            <Route path="/superadmin/suporte" element={<SuperSupport />} />
            <Route path="/superadmin/suporte/:id" element={<SuperSupport />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/welcome" replace />} />
      </Routes>
      <Toasts />
    </>
  )
}
