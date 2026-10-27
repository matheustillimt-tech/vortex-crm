import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, MessageCircle, Columns3, Users, Workflow, Bot, Plug, Send, CreditCard, Settings,
  PlayCircle, Sparkles, Sun, Moon, Bell, ChevronsLeft, ChevronsRight, ChevronRight, Menu, X, LogOut, ChevronDown, Crown, Lock, Coins, AlertTriangle,
} from 'lucide-react'
import { creditos, fmtCred } from '../lib/creditos'
import { useDB, useModules, useTheme, toast } from '../lib/store'
import { moduleForPath, moduleName } from '../lib/modules'
import { BRAND } from '../lib/brand'
import { cx } from '../lib/utils'
import { Avatar } from './ui'
import { BrandSymbol } from './BrandSymbol'
import SupportWidget from './SupportWidget'
import ErroTela from './ErroTela'
import CompanySwitcher from './CompanySwitcher'
import { useAdminAttention } from '../lib/support'
import { SUPER_NAV } from '../pages/SuperAdmin'

// Ordem do menu: estes itens e, no rodapé, Tutoriais, Notificações e Sair.
// Webhooks de entrada (/settings/inbound-webhooks) e Facebook (/facebook/…) saíram do menu, mas as rotas continuam no ar.
// O suporte fica no botão flutuante "Suporte" (SupportWidget).
export const NAV = [
  {
    section: 'Principal',
    items: [
      { to: '/welcome', label: 'Início', icon: LayoutDashboard },
      { to: '/inteligencia', label: 'Vórtex Inteligência', icon: Sparkles, module: 'inteligencia' },
      { to: '/chats', label: 'Chat Ao Vivo', icon: MessageCircle, module: 'chat' },
      { to: '/crms', label: 'Kanban', icon: Columns3, module: 'kanban' },
      { to: '/customers', label: 'Contatos', icon: Users, module: 'contatos' },
    ],
  },
  {
    section: 'Operações',
    items: [
      { to: '/flows', label: 'Automações', icon: Workflow, module: 'fluxos' },
      { to: '/agentes', label: 'Agentes de IA', icon: Bot, module: 'agentes' },
      { to: '/connections', label: 'Conexões', icon: Plug, module: 'conexoes' },
      { to: '/mass-dispatches', label: 'Disparos em Massa', icon: Send, module: 'disparos' },
    ],
  },
  {
    section: 'Gestão',
    items: [
      { to: '/billing', label: 'Minha Assinatura', icon: CreditCard },
      { to: '/creditos-ia', label: 'Créditos de IA', icon: Coins, module: 'agentes' },
      { to: '/settings', label: 'Configurações', icon: Settings, exact: true },
    ],
  },
]

export function Logo({ compact }) {
  const [word, ...rest] = BRAND.name.split(' ') // "Vórtex" + "CRM" (na cor de destaque)
  return (
    <div className="flex items-center gap-2.5">
      <div className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]">
        <BrandSymbol size={23} />
      </div>
      {!compact && (
        <span className="whitespace-nowrap text-[20px] leading-none text-text-primary" style={{ fontWeight: 800, letterSpacing: '-0.035em' }}>
          {word} <span style={{ color: 'var(--accent-text)' }}>{rest.join(' ')}</span>
        </span>
      )}
    </div>
  )
}

/*
 * Luz que percorre a borda do Tutorial: <rect> SVG com a geometria do centro da borda
 * de 1px, pathLength=100 e stroke-dashoffset animado. A velocidade é constante no contorno inteiro e o cartão e o
 * texto não giram. Halo desfocado embaixo e, por cima, traços sobrepostos que encurtam e clareiam até o ponto mais
 * brilhante. Os keyframes e o fallback de movimento reduzido estão em index.css (.tutorial-light).
 */
const LIGHT = [
  [0, 10, 0, 0.18], [1.5, 9.8, 0, 0.2], [3, 9.6, 0, 0.22], [4.2, 9.3, 8, 0.26], [5.2, 9.1, 18, 0.3],
  [6, 8.9, 30, 0.36], [6.6, 8.7, 45, 0.45], [7.1, 8.55, 60, 0.58], [7.5, 8.45, 75, 0.78], [7.75, 8.35, 88, 1],
]
const BRAND_COLOR = 'rgb(var(--accent))'
const segment = (from, to) => ({ strokeDasharray: `0 ${from} ${to - from} ${100 - to}`, strokeLinecap: 'butt' })
const TRACK = { x: 0.5, y: 0.5, rx: 13.5, pathLength: 100, fill: 'none' }

function TutorialLight() {
  return (
    <>
      <svg aria-hidden focusable="false" className="tutorial-light opacity-80 blur-[2px] transition-opacity group-hover:opacity-100">
        <rect {...TRACK} stroke={BRAND_COLOR} strokeOpacity={0.55} strokeWidth={5} {...segment(0, 10)} />
        <rect {...TRACK} stroke={BRAND_COLOR} strokeOpacity={0.55} strokeWidth={5} {...segment(5, 9.5)} />
      </svg>
      <svg aria-hidden focusable="false" className="tutorial-light opacity-90 blur-[0.5px] transition-opacity group-hover:opacity-100">
        {LIGHT.map(([from, to, warm, opacity]) => (
          <rect
            key={from}
            {...TRACK}
            stroke={warm ? `color-mix(in srgb, ${BRAND_COLOR} ${100 - warm}%, #effff6)` : BRAND_COLOR}
            strokeOpacity={opacity}
            strokeWidth={1.75}
            {...segment(from, to)}
          />
        ))}
      </svg>
    </>
  )
}

function SidebarContent({ collapsed, onNavigate, onToggleCollapse, isMobile }) {
  const { company, user, connections, logout, isSuperadmin } = useDB()
  const modules = useModules()
  const { theme, toggle } = useTheme()
  const loc = useLocation()
  const nav = useNavigate()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef(null)
  const navRef = useRef(null)
  const disconnected = connections.some((c) => c.status === 'disconnected')
  const supportAttention = useAdminAttention()
  // Acesso ao desenvolvedor: aberto quando se está numa tela dele (inclusive ao atualizar a página)
  const inDev = loc.pathname.startsWith('/superadmin')
  const [devOpen, setDevOpen] = useState(inDev)
  const devRef = useRef(null)
  useEffect(() => { if (inDev) setDevOpen(true) }, [inDev])
  // ao abrir pelo botão, rola o menu até os blocos (em telas baixas eles ficariam escondidos embaixo)
  const toggleDev = () => {
    const opening = !devOpen
    setDevOpen(opening)
    if (opening) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      requestAnimationFrame(() => devRef.current?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' }))
    }
  }

  // fecha o menu da conta ao clicar fora
  useEffect(() => {
    if (!menu) return
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  // Em telas baixas o menu rola: traz o item aberto para a área visível (também ao atualizar a página)
  useEffect(() => {
    const box = navRef.current
    const el = box?.querySelector('[aria-current="page"]')
    if (!el) return
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 8
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8
  }, [loc.pathname, collapsed])

  // O destaque segue a URL (e não um clique), então continua certo ao atualizar a página ou abrir um link direto
  const isActive = (it) => {
    if (it.exact) return loc.pathname === it.to
    if (typeof it.match === 'function') return it.match(loc.pathname)
    const m = it.match || it.to
    return loc.pathname === m || loc.pathname.startsWith(m + '/')
  }
  const groups = NAV.map((sec) => sec.items.filter((it) => !it.module || modules.includes(it.module))).filter((items) => items.length)

  return (
    <div className="flex h-full flex-col">
      {/* Marca, numa faixa com divisória embaixo */}
      <div className={cx('flex h-16 shrink-0 items-center border-b border-border-subtle', collapsed ? 'justify-center px-2' : 'justify-between pl-6 pr-4')}>
        <Link to="/welcome" onClick={onNavigate} aria-label="Início">
          <Logo compact={collapsed} />
        </Link>
        {!isMobile && !collapsed && (
          <button className="btn-ghost p-1.5" onClick={onToggleCollapse} aria-label="Recolher menu">
            <ChevronsLeft size={16} />
          </button>
        )}
      </div>
      {!isMobile && collapsed && (
        <button className="btn-ghost mx-auto mt-2 p-1.5" onClick={onToggleCollapse} aria-label="Expandir menu">
          <ChevronsRight size={16} />
        </button>
      )}

      {/* Empresa ativa: clicar abre o seletor de empresas (pesquisar, trocar e adicionar) */}
      {!collapsed && (
        <div ref={menuRef} className="relative px-3 pb-1 pt-4">
          <button onClick={() => setMenu((v) => !v)} aria-haspopup="dialog" aria-expanded={menu} title="Trocar de empresa" className="flex w-full items-center gap-3 rounded-[14px] px-2 py-1.5 text-left transition hover:bg-surface-interactive">
            <Avatar name={company.name} size={36} letters={1} src={company.logoUrl} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary" title={company.name}>{company.name}</span>
            <ChevronDown size={14} className={cx('shrink-0 text-text-muted transition-transform', menu && 'rotate-180')} />
          </button>
          {menu && <CompanySwitcher onClose={() => setMenu(false)} onNavigate={onNavigate} />}
        </div>
      )}

      <nav ref={navRef} aria-label="Menu principal" className="flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {groups.map((items, i) => (
          <ul key={i} className={cx('flex flex-col gap-0.5', i > 0 && 'mt-2')}>
            {items.map((it) => {
              const active = isActive(it)
              return (
                <li key={it.to}>
                  <Link
                    to={it.to}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? it.label : undefined}
                    className={cx('nav-row', collapsed && 'justify-center !px-0')}
                  >
                    <span className="relative shrink-0">
                      <it.icon size={20} strokeWidth={1.7} />
                      {it.to === '/connections' && disconnected && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" title="Instância desconectada nas últimas 24 horas" />}
                    </span>
                    {!collapsed && <span className="min-w-0 flex-1 leading-snug">{it.label}</span>}
                    {!collapsed && it.badge && <span className="nav-badge">{it.badge}</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        ))}

        {/* Só para o superadmin (o servidor também confere: rota protegida e funções sa_* recusam os demais).
            O botão abre e fecha os itens logo abaixo, sem sair do painel. */}
        {isSuperadmin && (
          <div ref={devRef} className="mt-3">
            <button
              onClick={toggleDev}
              aria-expanded={devOpen}
              aria-controls="dev-menu"
              title={supportAttention ? `Acesso ao desenvolvedor · ${supportAttention} ${supportAttention === 1 ? 'atendimento aguardando' : 'atendimentos aguardando'} no suporte` : 'Acesso ao desenvolvedor: usuários, suporte e colaboradores'}
              className={cx('dev-access relative', collapsed && 'justify-center !px-0')}
            >
              {collapsed ? (
                <Crown size={16} />
              ) : (
                <>
                  <span className="truncate text-[11px] font-bold uppercase tracking-[0.06em]">Acesso ao desenvolvedor</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {!devOpen && supportAttention > 0 && <span className="support-count static">{supportAttention > 9 ? '9+' : supportAttention}</span>}
                    <ChevronRight size={14} className={cx('transition-transform', devOpen && '-rotate-90')} />
                  </span>
                </>
              )}
              {collapsed && !devOpen && supportAttention > 0 && <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-red-500" />}
            </button>
            {devOpen && (
              <ul id="dev-menu" className="mt-1.5 flex flex-col gap-0.5">
                {SUPER_NAV.map((it) => {
                  const active = isActive(it)
                  return (
                    <li key={it.to}>
                      <Link to={it.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={collapsed ? it.label : undefined} className={cx('nav-row relative', collapsed && 'justify-center !px-0')}>
                        <it.icon size={20} strokeWidth={1.7} className="shrink-0" />
                        {!collapsed && <span className="min-w-0 flex-1 leading-snug">{it.label}</span>}
                        {it.count && supportAttention > 0 && (collapsed
                          ? <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-red-500" />
                          : <span className="support-count static" title="Atendimentos aguardando resposta ou com mensagem nova">{supportAttention > 9 ? '9+' : supportAttention}</span>)}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </nav>

      <div className={cx('border-t border-border-subtle pb-5 pt-3', collapsed ? 'px-2' : 'px-4')}>
        <Link to="/tutoriais" onClick={onNavigate} title="Tutoriais" className={cx('tutorial-cta group', collapsed && 'justify-center !px-0')}>
          <TutorialLight />
          <PlayCircle size={20} strokeWidth={1.8} className="relative shrink-0" style={{ color: 'rgb(var(--accent))' }} />
          {!collapsed && <span className="relative min-w-0 flex-1 truncate">Tutoriais</span>}
        </Link>
        <div className="flex flex-col gap-0.5">
          <button className={cx('foot-row', collapsed && 'justify-center !px-0')} title="Notificações" onClick={() => toast('Nenhuma notificação nova.', 'info')}>
            <Bell size={16} className="shrink-0" />{!collapsed && 'Notificações'}
          </button>
        </div>
        <div className={cx('mt-0.5 flex items-center gap-2', collapsed && 'flex-col')}>
          <button className={cx('foot-row min-w-0 flex-1', collapsed && 'justify-center !px-0')} title="Sair" onClick={() => { logout(); nav('/login') }}>
            <LogOut size={16} className="shrink-0" />{!collapsed && 'Sair'}
          </button>
          <button onClick={toggle} className="btn-ghost h-9 w-9 shrink-0 rounded-full p-0" title={`Mudar para o tema ${theme === 'dark' ? 'claro' : 'escuro'} · Ctrl+M`} aria-label="Alternar tema">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}

const BOTTOM = [
  { to: '/welcome', label: 'Início', icon: LayoutDashboard },
  { to: '/chats', label: 'Chat Ao Vivo', icon: MessageCircle, module: 'chat' },
  { to: '/crms', label: 'Kanban', icon: Columns3, module: 'kanban' },
  { to: '/flows', label: 'Automações', icon: Workflow, module: 'fluxos' },
]

export function ModuleUnavailable({ module }) {
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <div className="card flex flex-col items-center px-6 py-12">
        <div className="icon-tile mb-4 h-14 w-14"><Lock size={24} /></div>
        <h1 className="text-[22px] text-text-primary" style={{ letterSpacing: '-0.04em' }}>Módulo não disponível</h1>
        <p className="mt-2 text-sm text-text-secondary">
          <b className="text-text-primary">{moduleName(module)}</b> não está liberado para a sua empresa. Fale com o administrador da plataforma para liberar o acesso.
        </p>
        <NavLink to="/welcome" className="btn-primary mt-5">Voltar ao início</NavLink>
      </div>
    </div>
  )
}

// Saldo de Créditos de IA baixo ou zerado (só para empresa que usa a IA da plataforma em pré-pago). Confere ao abrir a
// empresa e a cada 2 minutos.
function useAvisoCreditos(companyId, ativo) {
  const [s, setS] = useState(null)
  useEffect(() => {
    if (!companyId || !ativo) return setS(null)
    let vivo = true
    const ler = () => creditos.summary(companyId).then((x) => vivo && setS(x)).catch(() => {})
    ler()
    const t = setInterval(ler, 120_000)
    return () => { vivo = false; clearInterval(t) }
  }, [companyId, ativo])
  if (!s?.exists || !s.active || s.mode !== 'prepago') return null
  if (s.available <= 0) return { tom: 'zero', s }
  if (s.available < s.alertCredits) return { tom: 'baixo', s }
  return null
}

function AvisoCreditos({ aviso }) {
  const nav = useNavigate()
  const zero = aviso.tom === 'zero'
  return (
    <button onClick={() => nav('/creditos-ia')} className={cx('mb-4 flex w-full items-center gap-2 rounded-[14px] p-3 text-left text-sm', zero ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400')}>
      <AlertTriangle size={16} className="shrink-0" />
      <span className="flex-1">{zero
        ? 'Acabaram os Créditos de IA: os agentes não respondem e as conversas vão para a equipe. Recarregue para a IA voltar.'
        : `Créditos de IA acabando: ${fmtCred(aviso.s.available)} restantes. Recarregue antes de a IA parar.`}</span>
      <span className="shrink-0 text-xs underline">Créditos de IA</span>
    </button>
  )
}

export default function Layout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1')
  const [drawer, setDrawer] = useState(false)
  const { company, user } = useDB()
  const modules = useModules()
  const toggleTheme = useTheme((s) => s.toggle)
  const loc = useLocation()
  // Rota de um módulo que a empresa não tem: mostra o aviso em vez da tela (os dados também não vêm do banco)
  const routeModule = moduleForPath(loc.pathname)
  const blocked = routeModule && !modules.includes(routeModule) ? routeModule : null
  const fullBleed = !blocked && (/^\/flows\/[^/]+\/edit/.test(loc.pathname) || loc.pathname.startsWith('/chats'))
  const editor = /^\/flows\/[^/]+/.test(loc.pathname)
  const bottom = BOTTOM.filter((b) => !b.module || modules.includes(b.module))
  // o botão do suporte sobe nas telas que têm controles no canto de baixo (campo do chat, minimapa do editor)
  const supportPlace = blocked ? 'default' : editor ? 'editor' : loc.pathname.startsWith('/chats') ? 'chat' : 'default'
  const avisoCreditos = useAvisoCreditos(company.id, modules.includes('agentes'))

  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggleTheme()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [toggleTheme])

  useEffect(() => { setDrawer(false) }, [loc.pathname])

  const toggleCollapse = () => {
    setCollapsed((v) => {
      localStorage.setItem('sidebar-collapsed', v ? '0' : '1')
      return !v
    })
  }

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Desktop sidebar */}
      <aside className={cx('glass-bar fixed inset-y-0 left-0 z-40 hidden border-r border-border-subtle transition-all duration-300 lg:block', collapsed ? 'w-[72px]' : 'w-[264px]')}>
        <SidebarContent collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      </aside>

      {/* Mobile top bar */}
      <header className="glass-bar sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border-subtle px-4 lg:hidden">
        <Logo compact />
        <span className="max-w-[55%] truncate rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-semibold">{company.name}</span>
        <div className="flex items-center gap-2">
          <Bell size={18} className="text-text-secondary" />
          <Avatar name={user.name} size={28} color="#d97706" />
        </div>
      </header>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-[150] lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
          <aside className="animate-fade-in absolute inset-y-0 left-0 w-[min(288px,88vw)] border-r border-border-subtle bg-surface-base">
            <button className="btn-ghost absolute right-2 top-4 p-1.5" onClick={() => setDrawer(false)}><X size={18} /></button>
            <SidebarContent isMobile onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      {/* Telas de altura total (chat, editor de fluxos) ocupam exatamente a tela: sem folga embaixo, senão a página inteira rola
          e corta o cabeçalho. No celular a folga é só a da barra inferior (64px). */}
      <main className={cx('min-w-0 transition-all duration-300', collapsed ? 'lg:ml-[72px]' : 'lg:ml-[264px]', fullBleed ? 'pb-16 lg:pb-0' : 'px-4 pb-24 pt-5 sm:px-5 lg:px-8 lg:pb-6 lg:pt-8')}>
        {avisoCreditos && !fullBleed && !blocked && loc.pathname !== '/creditos-ia' && !loc.pathname.startsWith('/superadmin') && <AvisoCreditos aviso={avisoCreditos} />}
        {blocked ? <ModuleUnavailable module={blocked} /> : <ErroTela dentro key={loc.pathname}><Outlet /></ErroTela>}
      </main>

      {/* Mobile bottom nav */}
      <nav className="glass-bar fixed inset-x-0 bottom-0 z-30 grid border-t border-border-subtle px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 lg:hidden" style={{ gridTemplateColumns: `repeat(${bottom.length + 1}, minmax(0, 1fr))` }} aria-label="Navegação inferior">
        {bottom.map((b) => (
          <NavLink key={b.to} to={b.to} className={({ isActive }) => cx('mx-1 mb-1.5 flex flex-col items-center gap-0.5 rounded-[13px] py-1.5 text-[11px] font-[550]', isActive ? 'is-selected' : 'text-text-secondary')}>
            <b.icon size={18} />
            {b.label}
          </NavLink>
        ))}
        <button onClick={() => setDrawer(true)} className="mx-1 mb-1.5 flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] font-medium text-text-secondary">
          <Menu size={18} />
          Mais
        </button>
      </nav>

      {/* nas telas do desenvolvedor o suporte é a Central (como no antigo painel separado, sem o botão flutuante) */}
      {!loc.pathname.startsWith('/superadmin') && <SupportWidget place={supportPlace} />}
    </div>
  )
}
