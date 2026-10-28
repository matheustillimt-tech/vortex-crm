# CLAUDE.md · Vórtex CRM

Guia para o Claude Code mexer neste template. Responda e escreva em português do Brasil, simples: quem usa este
projeto normalmente é dono de negócio, não programador.

## O que é

Vórtex CRM: atendimento, CRM, chatbot e agentes de IA no WhatsApp e no Direct do Instagram, multiempresa.

- **Painel:** React 18 + Vite 5 + Tailwind 3 (pasta `src/`), publicado na Vercel.
- **Servidor:** Supabase (Postgres com RLS por empresa, Auth, Realtime, Storage, Vault, pg_cron, pg_net) e Edge
  Functions em Deno (`supabase/functions/`).
- **Sem banco configurado** (`VITE_SUPABASE_URL` vazio), o painel roda em **modo demonstração**, com dados de exemplo
  (`src/lib/seed.js`) guardados no navegador.

Instalação: `INSTALACAO.md`. Prompt de instalação guiada: `PROMPT-DE-INSTALACAO.md`.

## Onde está cada coisa

| O quê | Onde |
|---|---|
| Telas | `src/pages/*.jsx` (Chats, Kanban, Contacts, Flows, FlowEditor, Agents, Connections, Settings, SuperAdmin, Inteligencia...) |
| Menu e layout | `src/components/Layout.jsx` |
| Estado e acesso ao banco | `src/lib/store.js` (Zustand) e `src/lib/backend.js` (coleções → tabelas) |
| Módulos (o que cada empresa pode usar) | `src/lib/modules.js` (espelho de `supabase/migrations/0003_superadmin_modulos.sql`; quem decide é o banco) |
| Blocos do editor de fluxos | `src/lib/blocks.js` (tela) e `supabase/functions/_shared/flow.ts` (execução) |
| Gatilhos dos fluxos | `supabase/functions/_shared/triggers-core.ts` (regras puras, usadas também pelo painel) e `triggers.ts` |
| Agente de IA | `supabase/functions/_shared/agent.ts` (motor), `agent-core.ts` (quem atende, pausas), `ai.ts` (provedores) |
| WhatsApp e Instagram | `_shared/whatsapp.ts`, `_shared/zapbot.ts`, `_shared/zapi.ts` (instância Z-API, mesmas rotas do Zapbot), `_shared/meta.ts`, `_shared/zernio.ts`, funções `whatsapp-webhook`, `zernio-webhook`, `send-message`, `connection-setup`, `connection-monitor` |
| Créditos de IA e plano | `_shared/carteira.ts`, `_shared/recarga.ts`, `_shared/pagamento-vortexpay.ts`, funções `creditos`, `creditos-webhook`, `assinatura` |
| Vórtex Inteligência | `_shared/inteligencia/`, função `inteligencia`, tela `src/pages/Inteligencia.jsx` |
| MCP | `supabase/functions/mcp/` |
| Banco | `supabase/migrations/` (em ordem; alguns números não existem de propósito) |
| Quais funções não exigem login | `supabase/config.toml` |
| Variáveis | `.env.example` (BLOCO 1 = painel/Vercel; BLOCO 2 = segredos das funções) |

## Como rodar

```bash
npm install
npm run dev                      # painel em http://localhost:5173 (modo demonstração sem .env.local)
npm run build                    # confere se o painel compila

# testes do servidor (Deno)
DENO_NO_PACKAGE_JSON=1 deno test -A --no-lock --node-modules-dir=none supabase/tests/
DENO_NO_PACKAGE_JSON=1 deno check supabase/functions/*/index.ts

# SQL num Postgres local (sem Docker; baixa o Postgres pelo npm)
cd supabase/tests/sql && npm install && node run.mjs ../../migrations inteligencia.mjs
```

Publicar o servidor (na conta de quem instalou, nunca em outra):

```bash
npx supabase db push                                         # migrações novas
npx supabase secrets set --env-file supabase/functions/.env  # segredos
npx supabase functions deploy                                # funções (com --use-api se pedir Docker)
```

## Como personalizar marca e textos

- Nome, símbolo, nome da IA e do pagamento, dados da empresa no login: `src/lib/brand.js`.
- Cores: tokens em `src/index.css` e `tailwind.config.js`.
- Páginas `/privacidade` e `/termos`: `public/privacidade/index.html` e `public/termos/index.html` (modelos com
  "SUA EMPRESA LTDA"; revisão jurídica é com advogado).
- Frases com "o Vórtex CRM" estão escritas nas telas e nas mensagens das funções: procure por "Vórtex CRM".
- Domínio dos links do rotacionador: `VITE_SITE_URL` (painel) e `SITE_URL` (servidor); o destino do `/r/:slug` fica no
  `vercel.json`.

## Regras

- **Nunca versione `.env`, `.env.local` nem `supabase/functions/.env`.** Chaves e senhas ficam nesses arquivos, nos
  segredos do Supabase ou no Vault. Nunca escreva chave, senha, JWT ou endereço de projeto no código ou numa migração:
  migração que precisa de chave lê do Vault (`select decrypted_secret from vault.decrypted_secrets where name = '...'`).
- **Nunca peça para a pessoa colar segredo no chat.** Abra o arquivo para ela colar, ou use `supabase secrets set` /
  `vercel env add` lendo do arquivo.
- **Migração nova sempre no fim da fila**, com número maior que o último (`0036_...`). Nunca edite uma migração que já
  foi aplicada num banco de verdade: crie outra que altera.
- Toda tabela nova com dado de empresa leva `company_id`, RLS ligado e política por empresa (veja as existentes).
- Mudou algo em `supabase/functions/_shared/`: publique de novo as funções que usam o arquivo (o mais simples é
  `npx supabase functions deploy`).
- O painel importa `supabase/functions/_shared/triggers-core.ts`: ele precisa continuar sem dependências de Deno. Se
  o painel passar a importar outro arquivo do servidor, libere-o no `.vercelignore`.
- **Push na `main` pode publicar o painel** se o repositório estiver ligado à Vercel. Confirme com a pessoa antes.
- Antes de dizer que terminou: `npm run build` e os testes do Deno passando.
