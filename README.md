# Vórtex CRM

Atendimento, CRM, chatbot e agentes de IA no WhatsApp (e no Direct do Instagram), num painel só, para uma ou várias
empresas.

Você conecta os números de WhatsApp da empresa, a equipe atende todas as conversas no mesmo lugar, os contatos andam
num Kanban de vendas, os fluxos de automação respondem sozinhos e os agentes de IA conversam com os clientes, vendem,
tiram dúvidas e passam para uma pessoa quando precisa.

## O que ele faz

- **Chat ao vivo:** todas as conversas do WhatsApp e do Instagram numa tela, separadas em "Atendimento humano" e
  "Atendimento IA". Assumir, devolver para a IA, transferir, respostas rápidas com `/`, fotos, áudios, vídeos e
  documentos.
- **Conexões de WhatsApp:**
  - por **QR Code** (API não oficial, pelo Zapbot), sem burocracia;
  - pela **API Oficial da Meta**, com o botão "Entrar com o Facebook" (a própria empresa escolhe o número e paga as
    mensagens direto à Meta);
  - **Instagram Direct** pela Zernio (API oficial da Meta).
- **Contatos:** busca, filtros, etiquetas, campos personalizados, importar e exportar planilha (CSV).
- **Kanban (funil de vendas):** quadros com colunas, arrastar e soltar, valor de cada negócio, visão de funil.
- **Automações (chatbot):** editor visual de fluxos com blocos de mensagem, menu com botões, espera de resposta,
  condição, etiqueta, Kanban, integração por HTTP, venda aprovada e outros. Começam por palavra-chave, primeiro
  contato, falta de resposta, etiqueta, mudança no Kanban, data marcada, agendamento, webhook ou à mão.
- **Agentes de IA:** atendentes de IA com instruções, conhecimento, coleta de dados e habilidades que viram ações de
  verdade (disparar fluxo, etiquetar, mover no Kanban, enviar arquivo, registrar venda, transferir para humano). Ouvem
  áudios, veem imagens, podem responder em áudio, respeitam horário comercial e têm modo de teste.
- **Rotacionador de números:** um link (`seu-dominio.com.br/r/nome`) que reveza quem clica entre os seus números
  conectados. Número que cai sai da roda sozinho.
- **Disparos em massa:** envia um fluxo para uma lista de contatos, com intervalo entre mensagens.
- **Webhooks de entrada:** recebe avisos de outras plataformas (Hotmart, Kiwify, formulários...), cria o contato e
  dispara um fluxo.
- **Vórtex Inteligência:** assistente que responde perguntas sobre vendas, recuperação e atendimento com os dados reais
  da empresa, e o botão "Melhorar agente", que estuda as conversas e propõe melhorias para os agentes de IA.
- **Servidor MCP:** liga o Claude Code, o Cursor ou o n8n ao CRM (ler conversas, buscar contatos, mandar mensagem).
- **Várias empresas:** um login participa de várias empresas, com convites por e-mail, funções e departamentos.
- **Área do dono da plataforma (superadmin):** liga e desliga módulos por empresa, pacotes de módulos, assinaturas,
  central de suporte para os clientes e Créditos de IA.
- **Opcional, para quem revende o CRM:** cobrança do plano e venda de Créditos de IA pré-pagos pela Vórtex Pay.
- **Modo demonstração:** sem banco configurado, o painel abre com dados de exemplo guardados só no navegador.

Alguns blocos aparecem no editor de fluxos mas ainda não executam no servidor (o fluxo pula e deixa um aviso na
conversa): Pixel, Bloco de IA, Pagamento, Vórtex Pay, Ligar e Kie.ai. As telas de Facebook (campanhas, pixels e perfis)
ficam fora do menu e não se conectam à Meta.

## Como funciona

1. O **painel** (as telas) é um site que fica na **Vercel**.
2. O **banco de dados**, o login e os arquivos ficam no **Supabase**. Cada empresa só enxerga os próprios dados.
3. As **Edge Functions** (pequenos programas que rodam no servidor do Supabase) recebem as mensagens do WhatsApp e do
   Instagram, enviam as respostas, rodam os fluxos e os agentes de IA.
4. Rotinas automáticas do banco (**pg_cron**) chamam essas funções de tempos em tempos: retomar fluxos parados,
   conferir se os números continuam conectados, continuar as melhorias de agente.
5. As chaves e senhas nunca vão para o navegador: ficam nos segredos do Supabase e no cofre de segredos dele (Vault).

## Com o que é feito

- **Painel:** React 18, Vite 5, Tailwind CSS 3, React Router 6, React Flow (editor de fluxos), Recharts (gráficos),
  Zustand (estado) e ícones lucide-react.
- **Servidor:** Supabase (Postgres, Auth, Realtime, Storage, Vault, pg_cron e pg_net) e Edge Functions em Deno
  (TypeScript).
- **Hospedagem do painel:** Vercel.
- **Integrações:** Zapbot (WhatsApp por QR Code), Meta Cloud API (WhatsApp oficial), Zernio (Instagram), OpenAI,
  Google Gemini ou qualquer provedor compatível com a OpenAI (Groq, DeepSeek, OpenRouter), ElevenLabs (voz) e,
  opcionalmente, Vórtex Pay e Vórtex Call.

## De quais contas você precisa

| Conta | Para quê | Custo |
|---|---|---|
| **GitHub** | Guardar a sua cópia do código | Grátis |
| **Supabase** | Banco de dados, login e funções do servidor | Tem plano grátis (bom para começar) |
| **Vercel** | Colocar o painel no ar | Plano Hobby grátis para testar; uso comercial pede o plano Pro |
| **Provedor de IA** (OpenAI, Google Gemini ou compatível) | Os agentes de IA | Pago por uso (o Gemini tem cota grátis) |
| **Zapbot** | Conectar WhatsApp por QR Code | Pago (veja os planos no site deles) |
| **Meta for Developers** (opcional) | WhatsApp pela API Oficial | Criar o app é grátis; as mensagens são cobradas pela Meta |
| **Zernio** (opcional) | Direct do Instagram | A caixa de mensagens vem no plano pago |
| **ElevenLabs** (opcional) | Ouvir áudios e responder em áudio | Tem plano grátis |
| **Vórtex Pay** (opcional) | Cobrar plano e Créditos de IA de outras empresas | Outro sistema aberto do Grupo Vórtex |

Um domínio próprio (ex.: `crm.suaempresa.com.br`) é opcional: sem ele, a Vercel dá um endereço `.vercel.app` de graça.

## Instalar com o Claude Code

Abra o **Claude Code** (aba **Code**) numa **pasta vazia** do seu computador, cole o texto abaixo inteiro e mande. O
Claude instala tudo com você, um passo de cada vez. O mesmo texto está em [PROMPT-DE-INSTALACAO.md](PROMPT-DE-INSTALACAO.md).

```text
Você vai instalar o Vórtex CRM comigo, do zero, nesta pasta (que está vazia). O Vórtex CRM é um sistema de
atendimento, CRM, chatbot e agentes de IA no WhatsApp, com painel React (Vercel) e servidor no Supabase.
Repositório: https://github.com/matheustillimt-tech/vortex-crm
O passo a passo completo está no arquivo INSTALACAO.md do repositório: leia-o inteiro depois de baixar o código e
siga a mesma ordem.

Eu não sou programador. Explique cada passo em português simples, com frases curtas, e espere eu confirmar antes de
ir pro próximo.

REGRAS (siga sempre):
1. NUNCA me peça pra colar chave, senha, token ou segredo aqui no chat. Quando eu precisar colocar um valor secreto,
   abra o arquivo certo pra mim (Mac: `open -e ARQUIVO`; Windows: `notepad ARQUIVO`) e me diga em qual linha colar.
   Para usar um valor do arquivo num comando, leia direto do arquivo, sem mostrar na tela.
2. Arquivos de segredo: `.env.local` (painel e senha do banco) e `supabase/functions/.env` (segredos do servidor).
   Os dois estão no .gitignore. Nunca faça commit deles e nunca mostre o conteúdo deles na tela.
3. Uma conta por vez: me diga o site, onde clicar e o que copiar, e espere eu dizer "pronto".
4. Se der erro, explique o erro numa frase e proponha a correção antes de tentar de novo.
5. Nunca rode comandos que apaguem dados do banco (ex.: `supabase db reset`) sem me perguntar.
6. O id do projeto do Supabase (o "project ref", que aparece no endereço do projeto) não é segredo: esse eu posso
   te dizer no chat.

PASSOS:
1. Pré-requisitos: confira se tenho Node.js 20 ou mais novo (`node -v`) e Git (`git --version`). Instale o que faltar
   (Mac: Homebrew; Windows: me passe o instalador oficial e espere). A CLI do Supabase roda com `npx supabase` (não
   precisa instalar nem de Docker). Instale a CLI da Vercel (`npm i -g vercel`) e a do GitHub (`gh`).
2. Baixe o código nesta pasta: `git clone https://github.com/matheustillimt-tech/vortex-crm.git .` e `npm install`.
   Se eu quiser ver antes, rode `npm run dev` e me mande abrir http://localhost:5173 (modo demonstração: qualquer
   e-mail e senha entram). Depois pare o servidor.
3. Crie o `.env.local` só com o BLOCO 1 do `.env.example` e o `supabase/functions/.env` só com o BLOCO 2 (valores
   em branco; eu preencho depois).
4. Supabase (o plano grátis serve): me guie pra criar a conta em supabase.com e um projeto novo (região São Paulo).
   Eu guardo a senha do banco e colo no `.env.local` (SUPABASE_DB_PASSWORD). Depois me mostre onde copiar o Project
   URL e a chave anon (Project Settings → API Keys → aba "Legacy API Keys") e eu colo no `.env.local`.
5. Banco: rode `npx supabase login` (abre o navegador), `npx supabase link --project-ref <ref>` e
   `npx supabase db push`, passando a senha do banco pela variável SUPABASE_DB_PASSWORD lida do `.env.local`
   (sem mostrar). Se pedir a senha de forma interativa, me peça pra rodar o comando no Terminal e digitar lá.
6. Cofre de segredos (Vault): me mostre o SQL do INSTALACAO.md que cria `project_url` e `anon_key`. Eu rodo no
   SQL Editor do Supabase, trocando os valores lá mesmo.
7. Segredos do servidor: abra `supabase/functions/.env` pra eu preencher (pelo menos SITE_URL; o resto conforme as
   integrações que eu for usar, uma conta por vez). Apague as linhas vazias e rode
   `npx supabase secrets set --env-file supabase/functions/.env`. Depois publique as funções com
   `npx supabase functions deploy` (se pedir Docker, acrescente `--use-api`).
8. GitHub: troque `SEU-PROJETO` pelo meu project ref no `vercel.json` (linha do `/r/:slug`), crie um repositório
   PRIVADO meu (`gh repo create`), aponte o `origin` para ele e faça o push.
9. Vercel: me guie pra importar o repositório (framework Vite) e cadastre VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY e
   VITE_SITE_URL (com `vercel env add`, lendo do `.env.local`, ou eu colo no site da Vercel). Publique e me passe o
   endereço. Se eu tiver domínio, me ajude a ligar.
10. Supabase → Authentication → URL Configuration: me ajude a colocar o endereço do painel como Site URL e nas
    Redirect URLs. Confira se SITE_URL nos segredos é o mesmo endereço.
11. Primeiro administrador: eu crio a minha conta no painel e confirmo o e-mail. Me mostre o SQL que me torna
    superadmin (INSTALACAO.md) pra eu rodar no SQL Editor com o meu e-mail. Depois me ajude a liberar os módulos
    Instagram e Vórtex Inteligência para a minha empresa, se eu quiser.
12. Integrações, uma de cada vez e só as que eu quiser: chave de IA (Configurações → Integrações), WhatsApp por QR
    Code (Zapbot), WhatsApp oficial (Meta), Instagram (Zernio), ElevenLabs, MCP.
13. Rode o checklist de teste do INSTALACAO.md comigo e me diga o que ficou pendente.
```

O passo a passo manual, com todos os detalhes, está em **[INSTALACAO.md](INSTALACAO.md)**.

## Estrutura de pastas

```
src/                       painel (React)
  pages/                   uma tela por arquivo (Chats, Kanban, Flows, Agents, Connections, Settings, SuperAdmin...)
  components/              peças das telas (menu, editor de fluxos, Vórtex Inteligência...)
  lib/                     dados e regras do painel (store, backend, módulos, marca em brand.js, dados de exemplo)
public/                    favicon e páginas fixas: /privacidade, /termos e /rotacionador-indisponivel (modelos)
supabase/
  config.toml              quais funções não exigem login (verify_jwt)
  migrations/              o banco, em ordem (0001 → 0035, com alguns números pulados de propósito)
  functions/               Edge Functions (Deno): whatsapp-webhook, send-message, ai-agent, flow-tick, mcp...
    _shared/               código comum: motor de fluxos, agente de IA, WhatsApp, Instagram, créditos, funil
  tests/                   testes (deno test) e testes do SQL num Postgres local (tests/sql)
vercel.json                rotas do painel e o link /r/ do rotacionador
.env.example               todas as variáveis, com explicação
```

## Personalizar

- **Nome, cores e dados da empresa:** `src/lib/brand.js` (nome, símbolo e os dados que aparecem no login) e as cores
  em `src/index.css` e `tailwind.config.js`.
- **Páginas de privacidade e termos:** `public/privacidade/index.html` e `public/termos/index.html` são modelos com
  "SUA EMPRESA LTDA". Troque pelos seus dados e peça para um advogado revisar.
- **Frases com o nome do produto** nas telas e nas mensagens do servidor: procure por "Vórtex CRM" no código.

## Testes

```bash
npm run build
DENO_NO_PACKAGE_JSON=1 deno test -A --no-lock --node-modules-dir=none supabase/tests/
cd supabase/tests/sql && npm install && node run.mjs ../../migrations inteligencia.mjs
```

O primeiro confere o painel, o segundo as regras do servidor e o terceiro aplica todas as migrações num Postgres
local (baixado pelo npm, sem Docker) e testa o SQL do Vórtex Inteligência.

## Licença

MIT. Veja [LICENSE](LICENSE).

---

Feito pelo Grupo Vórtex · entregue na Plataforma Vórtex IA
