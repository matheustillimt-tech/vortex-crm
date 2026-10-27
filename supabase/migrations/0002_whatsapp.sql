-- Webhooks de WhatsApp e agendamento dos fluxos.

-- Provedores reenviam o mesmo evento às vezes: a mesma mensagem (wa_id) não entra duas vezes.
create unique index messages_company_wa_id_key on public.messages (company_id, wa_id) where wa_id is not null;

-- Status das conexões (conectou/desconectou) aparece na hora no painel.
alter publication supabase_realtime add table public.connections;

-- A cada minuto, retoma fluxos parados em "Intervalo Inteligente" e "Aguarda Resposta" com timeout.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- O endereço do projeto e a chave anon vêm do Supabase Vault (segredos 'project_url' e 'anon_key'), criados uma vez
-- na instalação (veja INSTALACAO.md). Assim nenhuma chave fica escrita no código.
select cron.schedule(
  'vortex-crm-flow-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/flow-tick',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);
