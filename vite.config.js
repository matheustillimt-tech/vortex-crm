import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Versão do build: o commit na Vercel; fora dela, a hora do build. Vai no código (__APP_VERSION__) e em /version.json,
// que o app aberto consulta para saber que saiu versão nova (src/lib/versao.js).
const VERSAO = process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now()}`

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'versao-do-app',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: VERSAO }) })
      },
    },
  ],
  define: { __APP_VERSION__: JSON.stringify(command === 'build' ? VERSAO : 'dev') },
  // preserveSymlinks evita erro de caminho quando a pasta fica em AppData (virtualizada no Windows)
  resolve: { preserveSymlinks: true },
  server: { port: 5173 },
}))
