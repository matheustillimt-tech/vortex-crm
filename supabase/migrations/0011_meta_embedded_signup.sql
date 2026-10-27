-- API Oficial pelo Embedded Signup da Meta ("Entrar com o Facebook").
-- O cliente entra com o Facebook, escolhe o portfólio, a conta do WhatsApp Business e o número. O servidor troca o
-- código pelo token de integração da empresa, assina os webhooks da conta, registra o número e guarda o token no Vault.
-- Os webhooks chegam todos na URL única do app do Vórtex CRM (whatsapp-webhook sem ?c=) e são roteados pelo phone_number_id.
-- As mensagens são cobradas pela Meta direto na forma de pagamento da conta do cliente (o Vórtex CRM é Tech Provider e não
-- compartilha linha de crédito): o Vórtex CRM cobra só a assinatura.

-- ---------- Dados da conta Meta na conexão (o painel lê; só o servidor grava) ----------
-- { onboarding, wabaId, wabaName, businessId, businessName, phoneNumberId, verifiedName, nameStatus, quality,
--   messagingLimit, payment: ok|pending|unknown, alert, status, connectedAt, syncedAt }
alter table public.connections add column if not exists meta jsonb;

create or replace function private.keep_connection_meta()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') in ('authenticated', 'anon') then
    new.meta := case when tg_op = 'UPDATE' then old.meta else null end;
  end if;
  return new;
end;
$$;
revoke all on function private.keep_connection_meta() from public, anon, authenticated;
create trigger keep_meta before insert or update on public.connections for each row execute function private.keep_connection_meta();

-- ---------- Roteamento do webhook do app: um número só pode estar em uma conexão ----------
create unique index if not exists connection_secrets_meta_phone_key
  on public.connection_secrets ((credentials ->> 'phoneNumberId')) where provider = 'meta';
create index if not exists connection_secrets_meta_waba_idx
  on public.connection_secrets ((credentials ->> 'wabaId')) where provider = 'meta';

-- ---------- Token e PIN de cada conexão no Vault (criptografados; só a service role lê) ----------
-- Nome do segredo: meta_connection:<connection_id>. Conteúdo: {"accessToken": "...", "pin": "123456"}.
create or replace function public.meta_secret_set(p_connection uuid, p_secret jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n text := 'meta_connection:' || p_connection;
  sid uuid;
  merged jsonb;
begin
  select s.id, coalesce(d.decrypted_secret::jsonb, '{}'::jsonb) || p_secret into sid, merged
  from vault.secrets s left join vault.decrypted_secrets d on d.id = s.id
  where s.name = n;
  if sid is null then
    perform vault.create_secret(p_secret::text, n, 'API Oficial (Embedded Signup): token e PIN da conexão');
  else
    perform vault.update_secret(sid, merged::text);
  end if;
end;
$$;

create or replace function public.meta_secret_get(p_connection uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'meta_connection:' || p_connection;
$$;

create or replace function public.meta_secret_drop(p_connection uuid)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets where name = 'meta_connection:' || p_connection;
$$;

revoke all on function public.meta_secret_set(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.meta_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.meta_secret_drop(uuid) from public, anon, authenticated;
grant execute on function public.meta_secret_set(uuid, jsonb) to service_role;
grant execute on function public.meta_secret_get(uuid) to service_role;
grant execute on function public.meta_secret_drop(uuid) to service_role;

-- Excluir a conexão (ou a empresa) apaga o token dela no Vault
create or replace function private.drop_meta_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where name = 'meta_connection:' || old.id;
  return old;
end;
$$;
revoke all on function private.drop_meta_secret() from public, anon, authenticated;
create trigger drop_meta_secret after delete on public.connections for each row execute function private.drop_meta_secret();

-- ---------- Tentativas de conexão pelo Embedded Signup ----------
-- authorizing (janela da Meta aberta) → authorized (token salvo) → completed; ou needs_pin, cancelled, failed.
create table public.meta_signup_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null references public.connections (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'authorizing'
    check (status in ('authorizing', 'processing', 'authorized', 'needs_pin', 'completed', 'cancelled', 'failed')),
  step text,
  finish_type text,
  waba_id text,
  phone_number_id text,
  business_id text,
  error_code text,
  error_message text,
  meta_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on public.meta_signup_sessions (connection_id, created_at desc);
create index on public.meta_signup_sessions (company_id);
create index on public.meta_signup_sessions (user_id);
create trigger touch before update on public.meta_signup_sessions for each row execute function private.touch_updated_at();
alter table public.meta_signup_sessions enable row level security;
-- só leitura no painel; quem grava é o servidor (connection-setup)
create policy "membros veem as tentativas de conexão da empresa" on public.meta_signup_sessions for select to authenticated
  using (private.is_member(company_id) or private.is_superadmin());

-- ---------- Eventos da conta recebidos da Meta (account_update, qualidade, nome, templates) ----------
create table public.meta_account_events (
  id bigint generated always as identity primary key,
  waba_id text not null,
  connection_id uuid references public.connections (id) on delete set null,
  company_id uuid references public.companies (id) on delete cascade,
  field text not null,
  event text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create index on public.meta_account_events (waba_id, received_at desc);
create index on public.meta_account_events (connection_id);
create index on public.meta_account_events (company_id, received_at desc);
alter table public.meta_account_events enable row level security;
create policy "membros veem os eventos da Meta da empresa" on public.meta_account_events for select to authenticated
  using (private.is_member(company_id) or private.is_superadmin());
