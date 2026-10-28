# Instalação do Vórtex CRM (passo a passo manual)

Este guia instala o Vórtex CRM nas **suas** contas, do zero. Faça na ordem. Se preferir que o Claude Code faça com
você, use o [PROMPT-DE-INSTALACAO.md](PROMPT-DE-INSTALACAO.md): ele segue este mesmo roteiro.

Leva por volta de 1 hora para o básico (painel no ar, banco, WhatsApp por QR Code e IA). A API Oficial da Meta
leva mais tempo, porque depende de aprovação da própria Meta.

**Palavras que aparecem aqui:**

- **Supabase:** serviço que guarda o banco de dados, o login dos usuários e os arquivos, e roda as funções do servidor.
- **Edge Functions:** os pequenos programas do servidor (pasta `supabase/functions`). Eles recebem as mensagens do
  WhatsApp, respondem, rodam os fluxos e os agentes de IA.
- **Migrações:** os arquivos da pasta `supabase/migrations`, que criam as tabelas do banco, sempre na mesma ordem.
- **Segredo:** uma chave ou senha que fica guardada no servidor e nunca aparece no navegador.
- **Vercel:** onde o painel (as telas) fica no ar.
- **Terminal:** o programa de linha de comando (Mac: app "Terminal"; Windows: "PowerShell").

---

## 1. Contas

Crie (ou separe) estas contas antes de começar:

| Conta | Obrigatória? | Para quê | Custo |
|---|---|---|---|
| [GitHub](https://github.com) | Sim | Guardar a sua cópia do código e publicar na Vercel | Grátis |
| [Supabase](https://supabase.com) | Sim | Banco, login, arquivos e funções | Plano grátis serve para começar |
| [Vercel](https://vercel.com) | Sim | Painel no ar | Hobby grátis para testar; uso comercial pede o Pro |
| Provedor de IA: [OpenAI](https://platform.openai.com), [Google AI Studio](https://aistudio.google.com) (Gemini) ou compatível (Groq, DeepSeek, OpenRouter) | Para os agentes de IA | Respostas da IA | Pago por uso (o Gemini tem cota grátis) |
| [Zapbot](https://zapbot.online) | Para WhatsApp por QR Code | Conexão não oficial do WhatsApp | Pago |
| [Z-API](https://www.z-api.io) | Opcional, se você já tem uma instância lá | Conexão não oficial do WhatsApp, no lugar do Zapbot | Pago |
| [Meta for Developers](https://developers.facebook.com) | Só para a API Oficial | WhatsApp oficial pelo "Entrar com o Facebook" | Grátis; as mensagens são cobradas pela Meta |
| [Zernio](https://zernio.com) | Só para Instagram | Direct do Instagram | A caixa de mensagens vem no plano pago |
| [ElevenLabs](https://elevenlabs.io) | Não | Ouvir áudios e responder em áudio | Tem plano grátis |
| Vórtex Pay | Não | Vender o plano e Créditos de IA para outras empresas | Outro sistema aberto do Grupo Vórtex |

No computador você precisa de **Node.js 20 ou mais novo** ([nodejs.org](https://nodejs.org)) e **Git**
([git-scm.com](https://git-scm.com)). A CLI do Supabase roda com `npx supabase` (não precisa instalar nem de Docker).

---

## 2. Baixar o código

No Terminal, numa pasta sua:

```bash
git clone https://github.com/matheustillimt-tech/vortex-crm.git
cd vortex-crm
npm install
```

Quer ver o painel antes de configurar tudo? Rode `npm run dev` e abra http://localhost:5173. Sem banco configurado ele
abre no **modo demonstração**: qualquer e-mail e senha entram e os dados de exemplo ficam só no seu navegador. Para
parar, aperte `Ctrl + C` no Terminal.

### Os dois arquivos de segredos

O `.env.example` tem todas as variáveis, explicadas, em dois blocos. Crie dois arquivos a partir dele (os dois já estão
no `.gitignore`, ou seja, nunca vão para o GitHub):

- **`.env.local`** (na raiz): só o **BLOCO 1** (painel) e a senha do banco.
- **`supabase/functions/.env`**: só o **BLOCO 2** (segredos do servidor).

---

## 3. Supabase: criar o projeto e aplicar o banco

### 3.1 Criar o projeto

1. Em [supabase.com](https://supabase.com), **New project**. Região: **South America (São Paulo)**.
2. Crie uma senha forte para o banco e guarde. Cole no `.env.local`, na linha `SUPABASE_DB_PASSWORD=`.
3. Quando o projeto terminar de criar, abra **Project Settings → API Keys**:
   - o endereço do projeto (Project URL, algo como `https://SEU-PROJECT-REF.supabase.co`) vai em
     `VITE_SUPABASE_URL`;
   - na aba **Legacy API Keys**, a chave **anon** (começa com `eyJ`) vai em `VITE_SUPABASE_ANON_KEY`.
   - O pedaço entre `https://` e `.supabase.co` (20 letras) é o **project ref**, o id do projeto. Você vai usar ele
     nos comandos.

### 3.2 Aplicar o banco (migrações)

```bash
npx supabase login                                   # abre o navegador para você autorizar
npx supabase link --project-ref SEU-PROJECT-REF      # pede a senha do banco
npx supabase db push                                 # cria todas as tabelas, na ordem
```

Se não quiser digitar a senha, deixe ela na variável `SUPABASE_DB_PASSWORD` (a CLI lê sozinha), por exemplo:
`SUPABASE_DB_PASSWORD="$(sed -n 's/^SUPABASE_DB_PASSWORD=//p' .env.local)" npx supabase db push`.

As migrações vão de `0001` a `0035`. Alguns números não existem (eram módulos internos que não fazem parte desta
versão); a ordem é a mesma. Elas ligam sozinhas as extensões `pg_cron` (rotinas automáticas) e `pg_net` (chamadas da
rotina para as funções) e criam os espaços de arquivos (buckets).

### 3.3 Cofre de segredos (Vault)

As rotinas automáticas do banco chamam as funções do servidor. Para isso elas leem o endereço do projeto e a chave
anon do **Vault** (o cofre de segredos do Supabase), em vez de deixar essas informações escritas no código.

No Supabase, abra **SQL Editor**, cole o SQL abaixo, troque os dois valores **lá mesmo** e clique em **Run**:

```sql
select vault.create_secret('https://SEU-PROJECT-REF.supabase.co', 'project_url', 'Endereço do projeto (rotinas do pg_cron)');
select vault.create_secret('COLE-AQUI-A-CHAVE-ANON', 'anon_key', 'Chave anon (rotinas do pg_cron)');
```

Para trocar um valor depois:
`select vault.update_secret((select id from vault.secrets where name = 'anon_key'), 'NOVO-VALOR');`

As rotinas que usam esses segredos: `vortex-crm-flow-tick` (a cada 20 s: fluxos parados, disparos, gatilhos de
tempo), `vortex-crm-connection-monitor` (a cada 2 min: confere os números do Zapbot), `vortex-funil-tick` (a cada
5 min: funil no Kanban e fotos de perfil) e `vortex-inteligencia-tick` (a cada minuto: melhorias de agente).

### 3.4 Segredos do servidor e publicação das funções

1. Abra `supabase/functions/.env` e preencha o que for usar (a tabela da seção 4 diz o que é obrigatório). No
   mínimo: `SITE_URL` (o endereço do painel; se ainda não tiver, volte aqui depois da seção 5). Para WhatsApp por QR
   Code: `ZAPBOT_EMAIL` e `ZAPBOT_PASSWORD`.
2. **Apague as linhas que ficaram vazias** e envie:

   ```bash
   npx supabase secrets set --env-file supabase/functions/.env
   ```

3. Publique todas as funções:

   ```bash
   npx supabase functions deploy
   ```

   O arquivo `supabase/config.toml` já diz quais funções não exigem login (webhooks, link do rotacionador, MCP). Se a
   CLI pedir Docker, rode `npx supabase functions deploy --use-api`.

Sempre que mudar um segredo, rode o `secrets set` de novo. Sempre que mudar código em `supabase/functions`, rode o
`functions deploy` de novo.

---

## 4. Todas as variáveis

**Painel** (arquivo `.env.local` e Vercel → Settings → Environment Variables):

| Nome | Para que serve | Onde pegar | Obrigatória |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Endereço do seu projeto | Supabase → Project Settings → API Keys | Sim |
| `VITE_SUPABASE_ANON_KEY` | Chave pública do projeto | Supabase → Project Settings → API Keys → Legacy → anon | Sim |
| `VITE_SITE_URL` | Domínio mostrado nos links do rotacionador | O endereço do painel | Não (sem ela, usa o endereço aberto) |
| `SUPABASE_DB_PASSWORD` | Senha do banco, usada pela CLI no `link` e no `db push` | Você criou com o projeto | Só no seu computador. **Não** vai para a Vercel |

**Servidor** (arquivo `supabase/functions/.env`, enviado com `npx supabase secrets set`):

| Nome | Para que serve | Onde pegar | Obrigatória |
|---|---|---|---|
| `SITE_URL` | Endereço do painel (rotacionador e volta do login do Instagram) | O endereço da Vercel ou o seu domínio | Sim |
| `APP_ORIGINS` | Outros endereços do painel aceitos na volta do login do Instagram, separados por vírgula | Ex.: uma prévia da Vercel | Não |
| `ZAPBOT_EMAIL` / `ZAPBOT_PASSWORD` | Login da conta do Zapbot (WhatsApp por QR Code) | Sua conta no Zapbot | Para QR Code |
| `ZAPBOT_API_URL` | Endereço da API do Zapbot | Documentação do Zapbot | Não (padrão `https://api.zapbot.online`) |
| `META_APP_ID` | Id do seu app na Meta | developers.facebook.com → seu app | Para a API Oficial |
| `META_APP_SECRET` | Chave secreta do app (confere a assinatura dos webhooks) | App → Configurações → Básico | Para a API Oficial |
| `META_CONFIG_ID` | Id da configuração do "Entrar com o Facebook" | Facebook Login for Business → Configurações | Para a API Oficial |
| `META_WEBHOOK_VERIFY_TOKEN` | Texto que você inventa e repete no webhook do app | Você cria | Para a API Oficial |
| `META_GRAPH_VERSION` | Versão da Graph API | Documentação da Meta | Não (padrão `v26.0`) |
| `AI_PROVIDER` | IA da plataforma: `openai`, `gemini` ou `compat` | Você escolhe | Não (só para Créditos de IA) |
| `AI_API_KEY` | Chave da IA da plataforma | Painel do provedor de IA | Não |
| `AI_MODEL` | Modelo da IA da plataforma | Painel do provedor | Não (padrão do provedor) |
| `AI_BASE_URL` | Endereço da API no modo `compat` | Documentação do provedor | Só no `compat` |
| `ELEVENLABS_API_KEY` | Voz e transcrição da plataforma | elevenlabs.io → API Keys | Não |
| `ELEVENLABS_VOICE_ID` | Voz padrão da plataforma | elevenlabs.io → Voices | Não |
| `INTEL_MODELO` / `INTEL_MODELO_LEVE` | Modelos do Vórtex Inteligência | Você escolhe | Não |
| `ZERNIO_API_KEY` | Chave da Zernio da plataforma (Instagram) | zernio.com → Settings → API Keys | Não (cada empresa pode usar a dela) |
| `ZERNIO_WEBHOOK_SECRET` | Segredo do webhook da Zernio da plataforma | Você cria e repete na Zernio | Só com `ZERNIO_API_KEY` |
| `ZERNIO_API_URL` | Endereço da API da Zernio | Documentação da Zernio | Não (padrão `https://zernio.com/api/v1`) |
| `VORTEXPAY_URL` | Endereço da sua Vórtex Pay | Onde a sua Vórtex Pay está no ar | Só para vender plano/créditos |
| `VORTEXPAY_API_KEY` | Chave da API de integração da Vórtex Pay | Painel da sua Vórtex Pay | Não (sem ela, só links fixos) |
| `VORTEXPAY_WEBHOOK_SECRET` | "Secret HMAC" do webhook da Vórtex Pay | Painel da sua Vórtex Pay → Webhooks | Só para vender plano/créditos |
| `VORTEX_CALL_URL` | Endereço padrão do Vórtex Call (habilidade "Agendar no Vórtex Call") | Onde o seu Vórtex Call está no ar | Não (dá para pôr na própria habilidade) |
| `ISCAS_DOMINIO` | Funil no Kanban: só links deste domínio contam como isca | O domínio das suas páginas de isca | Não |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` o Supabase entrega sozinho às funções: não cadastre.

**No Vault** (seção 3.3): `project_url` e `anon_key` (obrigatórios). `zapbot_api_url`, `zapbot_email` e
`zapbot_password` também funcionam no Vault, no lugar dos segredos `ZAPBOT_*`.

---

## 5. Publicar o painel na Vercel

### 5.1 Ajustar o link do rotacionador

Abra `vercel.json` e troque `SEU-PROJETO` pelo seu project ref na linha:

```json
{ "source": "/r/:slug", "destination": "https://SEU-PROJETO.supabase.co/functions/v1/rotacionador/:slug" }
```

(A Vercel não lê variáveis dentro do `vercel.json`, por isso essa troca é à mão.)

### 5.2 Ter o código no seu GitHub

Crie um repositório **privado** vazio no seu GitHub (ex.: `meu-crm`) e envie o código para ele:

```bash
git remote rename origin original
git remote add origin https://github.com/SEU-USUARIO/meu-crm.git
git add vercel.json && git commit -m "Endereço do meu projeto no rotacionador"
git push -u origin main
```

### 5.3 Importar na Vercel

1. Na Vercel: **Add New → Project** e escolha o repositório. O framework é detectado como **Vite** (build
   `vite build`, pasta `dist`; já está no `vercel.json`).
2. Em **Environment Variables**, cadastre `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` e, se quiser,
   `VITE_SITE_URL`. **Não** cadastre `SUPABASE_DB_PASSWORD`.
3. **Deploy**. No fim, a Vercel mostra o endereço (ex.: `https://meu-crm.vercel.app`). Para usar seu domínio: Project
   → Settings → Domains.
4. Volte na seção 3.4 e confira se `SITE_URL` é esse endereço (se mudou, rode o `secrets set` de novo).

**Crons:** este projeto não usa crons da Vercel. As rotinas automáticas rodam dentro do Supabase (pg_cron, seção 3.3).

Daqui pra frente, cada `git push` na branch `main` publica o painel de novo sozinho.

---

## 6. Configurar o login

No Supabase, **Authentication → URL Configuration**:

- **Site URL:** o endereço do painel (ex.: `https://meu-crm.vercel.app`).
- **Redirect URLs:** `https://meu-crm.vercel.app/**` e `http://localhost:5173/**`.

Assim os links de confirmação de e-mail e de troca de senha voltam para o painel. O Supabase manda poucos e-mails por
hora no plano grátis; para muitos usuários, configure um SMTP próprio em **Authentication → Emails → SMTP Settings**.

---

## 7. Criar o primeiro administrador

1. Abra o painel, clique em **Criar conta**, preencha e confirme o e-mail que chegar. O cadastro já cria a sua
   empresa, com departamentos, etiquetas e os módulos do pacote padrão.
2. Para virar **superadmin** (o dono da plataforma, que libera módulos para as empresas), rode no **SQL Editor** do
   Supabase, com o seu e-mail:

   ```sql
   insert into public.platform_admins (user_id, email)
   select id, email from auth.users where lower(email) = lower('voce@exemplo.com')
   on conflict (user_id) do nothing;
   ```

3. Recarregue o painel. Aparece no menu o botão **Acesso ao desenvolvedor** (Usuários, Suporte, Colaboradores e
   Créditos de IA). Outros superadmins entram depois por **Colaboradores** (a pessoa precisa já ter conta).
4. Os módulos **Instagram** e **Vórtex Inteligência** não vêm no pacote padrão. Para usar: Acesso ao desenvolvedor →
   Usuários → sua empresa → Módulos, marque e salve (ou inclua os dois no pacote "Completo" em `/superadmin/pacotes`).

---

## 8. Ligar as integrações

Faça só as que for usar.

### 8.1 IA dos agentes (obrigatória para os agentes responderem)

No painel: **Configurações → Integrações → OpenAI GPT, Google Gemini ou Outro provedor de IA**, cole a chave, o modelo
e clique em **Salvar e testar**. A chave fica só no servidor, separada por empresa.

Alternativa para quem revende: a **IA da plataforma** (segredos `AI_*`), que só vale para empresas com a carteira de
Créditos de IA ligada (Acesso ao desenvolvedor → Créditos de IA). Para uma empresa sua, use o modo "Interno", que
registra o custo sem descontar.

Depois crie um agente em **Agentes de IA**, escolha o número em que ele atende e ligue o atendimento. O botão **Teste
ao vivo** conversa com ele sem WhatsApp.

### 8.2 WhatsApp por QR Code (Zapbot)

1. Tenha os segredos `ZAPBOT_EMAIL` e `ZAPBOT_PASSWORD` cadastrados (seção 3.4).
2. No painel: **Conexões → Nova Conexão → API Web**. O QR Code aparece na tela: no celular, WhatsApp → Aparelhos
   conectados → Conectar um aparelho. Também dá para usar o código de pareamento.
3. A conexão é criada na sua conta do Zapbot com o nome começando por `Vórtex CRM ·`. A rotina
   `vortex-crm-connection-monitor` confere a cada 2 minutos se o número continua conectado.

Se aparecer "Avise o administrador da plataforma", faltam os segredos do Zapbot ou a senha está errada (o superadmin
vê o detalhe na tela).

### 8.2.1 WhatsApp por uma instância da Z-API que você já tem

Se você já paga uma instância na Z-API, dá para usar ela no lugar do Zapbot. Não precisa de conta no Zapbot nem de
segredo novo no Supabase: os dados da instância ficam guardados só no servidor, por conexão.

1. No painel da Z-API, abra **Instâncias** e a sua instância. Copie o **ID da instância** e o **Token da instância**.
2. No Vórtex CRM: **Conexões → Nova Conexão → Z-API**, dê um nome e clique em **Criar conexão**.
3. Cole o ID e o token. O campo **Client-Token (opcional)** você só preenche se ligou o **token de segurança da
   conta** na Z-API. Se não ligou, deixe em branco. O link **Avançado:
   trocar a URL base** você não precisa mexer (o padrão é `https://api.z-api.io`).
4. Clique em **Conferir e conectar**. O sistema confere os dados e aponta os avisos da instância (webhooks) para o
   seu CRM. Se o número já estava conectado na Z-API, pronto. Se não, aparece o QR Code (ou o código de pareamento)
   para você ler no celular, do mesmo jeito que no Zapbot.
5. Na lista de conexões ela aparece como **Z-API (QR Code)**. A rotina `vortex-crm-connection-monitor` também confere
   esse número a cada 2 minutos, e quando a Z-API avisa que o número caiu o sistema tenta reconectar sozinho.

Bom saber:
- O CRM nunca cria nem apaga instância na sua conta da Z-API. Excluir a conexão no CRM só desliga os avisos da
  instância; ela continua sua.
- Uma instância só pode estar em uma conexão.
- Funciona como no Zapbot no chat, fluxos, agentes de IA, disparos, MCP, foto do contato e confirmação de entrega
  e leitura. Diferenças: o menu vai como texto numerado (sem botões), não aparece "digitando…" e grupos ainda não são
  suportados.
- Se o celular pedir uma chave de acesso (passkey) na hora de conectar, conecte o número pelo painel da Z-API e
  depois clique de novo em **Conferir e conectar**.

### 8.3 WhatsApp pela API Oficial (Meta)

Exige um app seu na Meta, com a empresa verificada. Resumo:

1. Em developers.facebook.com, crie um app do tipo **Business** ligado ao seu portfólio empresarial, com os produtos
   **WhatsApp** e **Facebook Login for Business**. Faça a verificação da empresa e o cadastro como **Tech Provider**.
2. Facebook Login for Business → **Configurações → Criar configuração**, variação **WhatsApp Embedded Signup**,
   permissões `whatsapp_business_management` e `whatsapp_business_messaging`. O id dessa configuração é o
   `META_CONFIG_ID`.
3. Em **Domínios permitidos para o SDK do JavaScript** e **URIs de redirecionamento OAuth válidos**, ponha o endereço do
   painel (precisa ser https).
4. WhatsApp → Configuração → **Webhook**: URL `https://SEU-PROJECT-REF.supabase.co/functions/v1/whatsapp-webhook`,
   token de verificação = o seu `META_WEBHOOK_VERIFY_TOKEN`. Assine os campos `messages`, `account_update`,
   `phone_number_quality_update`, `phone_number_name_update` e `message_template_status_update`.
5. Cadastre `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID` e `META_WEBHOOK_VERIFY_TOKEN` (seção 3.4).
6. Peça na **Análise do app** o acesso avançado às duas permissões. Antes disso, só contas com função no app conseguem
   concluir a conexão.
7. No painel: **Conexões → Nova Conexão → API Oficial (Meta) → Entrar com o Facebook**. A empresa escolhe o portfólio,
   a conta do WhatsApp Business e o número. Cada empresa paga as mensagens direto à Meta.

### 8.4 Instagram (Direct) pela Zernio

1. Libere o módulo **Instagram** para a empresa (seção 7, item 4).
2. Na Zernio, conecte o Instagram e crie uma chave da API (de preferência restrita, só com contas, mensagens e
   webhooks).
3. No painel: **Conexões → Nova Conexão → Instagram**, cole a chave da Zernio e escolha a conta. O CRM guarda a chave
   no Vault e cadastra o webhook sozinho.

Regras da Meta: o CRM só responde quem escreveu primeiro; até 24 h depois da última mensagem do cliente, normal; de
24 h a 7 dias, só a equipe; sem disparo em massa pelo Instagram.

(Avançado: com `ZERNIO_API_KEY` e `ZERNIO_WEBHOOK_SECRET`, a plataforma usa uma conta Zernio só. Nesse caso, crie na
Zernio um webhook para `https://SEU-PROJECT-REF.supabase.co/functions/v1/zernio-webhook` com o mesmo segredo e os
eventos `message.received`, `message.sent`, `message.read`, `message.deleted` e `account.disconnected`.)

### 8.5 Áudio (ElevenLabs)

Configurações → Integrações → ElevenLabs. Com ela, os agentes ouvem os áudios e podem responder em áudio. Sem ela, a
chave da OpenAI também faz os dois.

### 8.6 Webhooks de entrada (Hotmart, Kiwify, formulários)

Em **Automações**, crie um fluxo com o gatilho **Webhook recebido**. O painel mostra a URL
(`.../functions/v1/inbound-webhook/...`) para colar na outra plataforma, o mapeamento dos campos e um botão de teste.

### 8.7 MCP (Claude Code, Cursor, n8n)

Configurações → **Ferramentas MCP** → crie uma chave (`vcrm_...`, aparece uma vez só). Endereço:
`https://SEU-PROJECT-REF.supabase.co/functions/v1/mcp`. No Claude Code:

```bash
claude mcp add --transport http vortex-crm https://SEU-PROJECT-REF.supabase.co/functions/v1/mcp --header "Authorization: Bearer SUA-CHAVE-VCRM"
```

"Só leitura" consulta; "Leitura e envio" também cria contato e manda mensagem. Limite de 60 chamadas por minuto por
chave.

### 8.8 Vender o plano e Créditos de IA (Vórtex Pay) (opcional)

Só para quem vai revender o CRM para outras empresas.

1. Tenha a sua Vórtex Pay no ar. Nela, crie o produto "Créditos de IA" e o produto do plano, com as ofertas.
2. Na Vórtex Pay, crie um webhook para `https://SEU-PROJECT-REF.supabase.co/functions/v1/creditos-webhook` com os
   eventos de compra aprovada, reembolsada e chargeback. O "Secret HMAC" dele vai em `VORTEXPAY_WEBHOOK_SECRET`.
3. Cadastre `VORTEXPAY_URL` e, se quiser criar ofertas pela API, `VORTEXPAY_API_KEY` (seção 3.4).
4. No painel: Acesso ao desenvolvedor → **Créditos de IA → Configuração** (id do produto, pacotes com o link de
   pagamento) e **Plano e pagamento** (id do produto e link da oferta do plano).

Os créditos e o plano só são liberados quando o aviso assinado chega e o valor confere.

### 8.9 Vórtex Call (opcional)

Na habilidade **Agendar no Vórtex Call** do agente, preencha a agenda e o endereço do seu Vórtex Call (ou cadastre
`VORTEX_CALL_URL` para valer como padrão). A IA consulta os horários livres e agenda sozinha.

### 8.10 Funil no Kanban (avançado)

A função `funil` recebe avisos de outros sistemas (isca, Vórtex Grupo, aula, checkout, área de membros) e anda o card
do contato num quadro do Kanban. Não tem tela de configuração: cria-se por SQL uma linha em `public.funis` (quadro e
coluna de cada etapa) e os tokens de cada fonte em `public.funil_segredos`. O endereço de cada fonte é
`https://SEU-PROJECT-REF.supabase.co/functions/v1/funil?f=<id do funil>&fonte=<isca|grupo|webinar|checkout|plataforma>&t=<token>`.
Os detalhes de cada formato estão no começo de `supabase/functions/_shared/funil-fontes.ts`.

---

## 9. Checklist de teste

- [ ] O painel abre no seu endereço e **não** está no modo demonstração (o cadastro pede e-mail de confirmação).
- [ ] Você criou a conta, confirmou o e-mail e entrou.
- [ ] O botão **Acesso ao desenvolvedor** aparece (você é superadmin).
- [ ] Configurações → Integrações → a chave de IA foi salva e o **Testar** respondeu.
- [ ] Conexões → um número conectado por QR Code (status "Conectado"), pelo Zapbot ou por uma instância da Z-API.
- [ ] Mandou uma mensagem de outro celular para esse número e ela apareceu no **Chat ao vivo**.
- [ ] Respondeu pelo painel e a resposta chegou no celular.
- [ ] Um agente de IA ativo, ligado ao número, respondeu sozinho.
- [ ] Um fluxo com "Intervalo Inteligente" de 1 minuto continuou depois do tempo (prova que o pg_cron e o Vault estão
      certos).
- [ ] Conexões → Rotacionador: o link `/r/...` abre o WhatsApp com um dos números.
- [ ] No SQL Editor, `select jobname, schedule from cron.job;` mostra as 4 rotinas.

---

## 10. Problemas comuns

**O painel abre em modo demonstração.** Faltam `VITE_SUPABASE_URL` ou `VITE_SUPABASE_ANON_KEY` na Vercel. Cadastre e
publique de novo (Deployments → Redeploy): as variáveis `VITE_` entram no momento do build.

**O link de confirmação do e-mail abre `localhost` ou dá erro.** Ajuste a Site URL e as Redirect URLs (seção 6).

**Fluxos com espera não continuam / números não atualizam o status.** As rotinas não estão conseguindo chamar as
funções. Confira os segredos `project_url` e `anon_key` no Vault (seção 3.3) e veja os erros com:

```sql
select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 20;
select id, status_code, error_msg, created from net._http_response order by created desc limit 20;
```

**"Avise o administrador da plataforma" ao conectar por QR Code.** Faltam `ZAPBOT_EMAIL`/`ZAPBOT_PASSWORD` ou a senha
mudou. Cadastre de novo com `npx supabase secrets set` e espere alguns minutos.

**A Z-API não conecta ("Conferir e conectar" dá erro).** Confira se copiou o ID e o token da **instância** (não o
token da conta). Se você ligou o token de segurança da conta na Z-API, o Client-Token é obrigatório; se não ligou,
deixe o campo vazio. Se a mensagem disser que a instância já está em outra conexão, exclua a conexão antiga primeiro.

**O agente de IA não responde.** Confira: chave de IA salva e testada, agente **ativo**, ligado ao número certo, o
número conectado, a conversa na coluna "Atendimento IA" (não assumida por alguém) e o modo de teste vazio. O motivo
de cada tentativa fica em Configurações → **Uso da IA**.

**O link `/r/...` do rotacionador dá 404.** O `vercel.json` ainda tem `SEU-PROJETO` (seção 5.1) ou a função
`rotacionador` não foi publicada. Se vai para uma página "Link indisponível no momento", falta o segredo `SITE_URL`.

**`supabase functions deploy` pede Docker.** Use `npx supabase functions deploy --use-api`.

**`supabase db push` diz que a migração já existe ou deu conflito.** Você provavelmente aplicou algo à mão antes.
Veja `npx supabase migration list` e não apague nada sem entender: se for um projeto novo e vazio, o mais simples é
criar outro projeto.

**O webhook da Meta não verifica.** O token na Meta precisa ser exatamente o `META_WEBHOOK_VERIFY_TOKEN` e a função
`whatsapp-webhook` precisa estar publicada.

**Mudei o código das funções e nada mudou.** Rode `npx supabase functions deploy` de novo (o push no GitHub só
publica o painel).
