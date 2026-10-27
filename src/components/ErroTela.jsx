import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { recarregarParaVersao, VERSAO, versaoNoAr } from '../lib/versao'

// Uma tela que quebra mostrava a página inteira preta. Agora aparece o aviso com "Recarregar"; se já saiu versão nova
// (aba aberta antes de uma publicação), recarrega sozinho uma vez. Dentro do Layout (`dentro`) o menu continua e o aviso
// some ao trocar de tela; em volta do app inteiro ocupa a página.
export default class ErroTela extends Component {
  state = { erro: null }

  static getDerivedStateFromError(erro) {
    return { erro }
  }

  componentDidCatch(erro, info) {
    console.error('Tela quebrou', erro, info?.componentStack)
    versaoNoAr().then((v) => {
      if (v && v !== VERSAO) recarregarParaVersao(v)
    })
  }

  render() {
    const { erro } = this.state
    if (!erro) return this.props.children
    const aviso = (
      <div className="card flex flex-col items-center px-6 py-12">
        <div className="icon-tile mb-4 h-14 w-14"><AlertTriangle size={24} /></div>
        <h1 className="text-[22px] text-text-primary" style={{ letterSpacing: '-0.04em' }}>Algo deu errado nesta tela</h1>
        <p className="mt-2 text-sm text-text-secondary">Recarregue a página. Se continuar, mande um print deste aviso para o suporte.</p>
        <p className="mt-3 max-w-full break-words font-mono text-[11px] text-text-muted">{String(erro?.message || erro).slice(0, 300)}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className="btn-primary" onClick={() => window.location.reload()}><RefreshCw size={14} /> Recarregar</button>
          <button className="btn-secondary" onClick={() => window.location.assign('/welcome')}>Ir para o início</button>
        </div>
      </div>
    )
    if (this.props.dentro) return <div className="mx-auto mt-10 max-w-md text-center">{aviso}</div>
    return <div className="flex min-h-screen items-center justify-center bg-surface-base p-6 text-center"><div className="w-full max-w-md">{aviso}</div></div>
  }
}
