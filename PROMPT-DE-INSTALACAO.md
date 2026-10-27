# Prompt de instalação (Claude Code)

Abra o **Claude Code** (aba **Code**) numa **pasta vazia** do seu computador, cole o texto abaixo inteiro e mande. O
Claude vai instalar o Vórtex CRM com você, um passo de cada vez, e nunca vai pedir para você colar uma chave ou senha
no chat: os segredos vão direto nos arquivos `.env.local` e `supabase/functions/.env` (que não sobem para o GitHub) ou
nos painéis do Supabase e da Vercel.

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

Se preferir fazer tudo à mão, siga o [INSTALACAO.md](INSTALACAO.md).
