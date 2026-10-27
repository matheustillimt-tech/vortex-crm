-- WhatsApp não oficial pelo Zapbot (QR Code ou código de pareamento).
-- As credenciais da conta Zapbot ficam no Vault (criptografadas). Os valores NÃO estão neste arquivo:
-- são gravados uma vez com vault.create_secret('<valor>', 'zapbot_api_url' | 'zapbot_email' | 'zapbot_password').
-- Credenciais de cada conexão (id, token, Client-Token, segredo do webhook) ficam em connection_secrets, como as demais.

-- JWT da conta Zapbot em cache (vale 30 dias; o servidor refaz o login quando a API responde 401).
create table public.zapbot_session (
  id int primary key default 1 check (id = 1),
  jwt text,
  updated_at timestamptz not null default now()
);
alter table public.zapbot_session enable row level security; -- sem políticas: só a service role lê e grava

-- Só a service role (funções do servidor) lê as credenciais da conta.
create or replace function public.zapbot_account()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'url', (select decrypted_secret from vault.decrypted_secrets where name = 'zapbot_api_url'),
    'email', (select decrypted_secret from vault.decrypted_secrets where name = 'zapbot_email'),
    'password', (select decrypted_secret from vault.decrypted_secrets where name = 'zapbot_password')
  );
$$;
revoke all on function public.zapbot_account() from public, anon, authenticated;
grant execute on function public.zapbot_account() to service_role;

-- Mídia recebida pelo WhatsApp: o Zapbot apaga o arquivo em 24 h, então o servidor baixa e guarda aqui.
-- Caminho: <company_id>/<chat_id>/<arquivo>. Bucket privado; membros da empresa (com Chat ao vivo) leem por link assinado.
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 67108864)
on conflict (id) do nothing;

create policy "membros leem a mídia do WhatsApp da empresa" on storage.objects for select to authenticated
using (
  bucket_id = 'whatsapp-media'
  and ((storage.foldername(name))[1])::uuid = any ((select private.companies_with_module('chat'))::uuid[])
);

-- Monitor das conexões (não existe webhook de desconexão): a cada 2 minutos confere o status de cada número.
-- O endereço do projeto e a chave anon vêm do Supabase Vault (segredos 'project_url' e 'anon_key'), criados uma vez
-- na instalação (veja INSTALACAO.md). Assim nenhuma chave fica escrita no código.
select cron.schedule(
  'vortex-crm-connection-monitor',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/connection-monitor',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);
