-- Instagram (Direct) pela Zernio, que usa a API oficial da Meta (permissão instagram_manage_messages).
-- Fase 1: receber e responder à mão pelo Chat ao vivo. Automações (canal no fluxo) ficam para a Fase 2.
-- Só adiciona.

-- Módulo novo: o superadmin libera por empresa (depende de Conexões e do Chat ao vivo).
insert into public.modules (key, name, description, sort)
values ('instagram', 'Instagram', 'Direct do Instagram pela API oficial (via Zernio)', 15)
on conflict (key) do nothing;
insert into public.module_dependencies (module, requires, reason) values
  ('instagram', 'conexoes', 'a conta do Instagram é uma conexão'),
  ('instagram', 'chat', 'as conversas do Direct são atendidas no Chat ao vivo')
on conflict do nothing;

-- Profile da Zernio de cada empresa (uma empresa = um profile, que separa as contas de cada cliente).
-- Sem política de RLS: só o servidor lê.
create table public.zernio_profiles (
  company_id uuid primary key references public.companies (id) on delete cascade,
  profile_id text not null unique,
  created_at timestamptz not null default now()
);
alter table public.zernio_profiles enable row level security;
revoke all on public.zernio_profiles from authenticated, anon;
grant select, insert, update, delete on public.zernio_profiles to service_role;

-- Webhook -> conexão: cada evento da Zernio traz o accountId da conta do Instagram.
-- Único: a mesma conta do Instagram não pode estar em duas conexões (nem em duas empresas).
create unique index if not exists connection_secrets_zernio_account_key
  on public.connection_secrets ((credentials ->> 'accountId')) where provider = 'instagram';

-- Contato do Instagram. O telefone continua opcional (default ''), como já era.
alter table public.contacts add column if not exists instagram_id text;        -- id do remetente na Zernio/Instagram
alter table public.contacts add column if not exists instagram_username text;  -- @, sem o @
alter table public.contacts add column if not exists instagram_profile jsonb;  -- isFollower, isVerified, followerCount, fetchedAt
create unique index if not exists contacts_company_instagram_key on public.contacts (company_id, instagram_id) where instagram_id is not null;

-- Conversa: id da conversa na Zernio, que é o destino dos envios.
alter table public.chats add column if not exists external_id text;
create unique index if not exists chats_connection_external_key on public.chats (connection_id, external_id) where external_id is not null;

-- Canal do fluxo (a tela de Automações usa na Fase 2; aqui só nasce a coluna, todos ficam WhatsApp).
alter table public.flows add column if not exists channel text not null default 'whatsapp';
alter table public.flows drop constraint if exists flows_channel_check;
alter table public.flows add constraint flows_channel_check check (channel in ('whatsapp', 'instagram', 'tiktok'));

-- Eventos da Zernio: o id do evento barra reenvio (a entrega é "pelo menos uma vez") e o registro ajuda no suporte.
-- Sem política de RLS: só o servidor lê.
create table public.zernio_events (
  id text primary key,
  event text not null,
  account_id text,
  connection_id uuid references public.connections (id) on delete set null,
  status text not null default 'received' check (status in ('received', 'ok', 'ignored', 'error')),
  error text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create index on public.zernio_events (connection_id, received_at desc);
create index on public.zernio_events (received_at);
alter table public.zernio_events enable row level security;
revoke all on public.zernio_events from authenticated, anon;
grant select, insert, update, delete on public.zernio_events to service_role;
