-- Vórtex CRM: esquema multiempresa. Cada linha pertence a uma empresa (company_id) e o RLS
-- só deixa ver/alterar quem é membro dessa empresa. Campos extras do front ficam em "extra" (jsonb).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- ---------- Núcleo: empresas, perfis, membros ----------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  public_id bigint generated always as identity (start with 10001) unique,
  name text not null default 'Minha Empresa',
  description text not null default '',
  slug text not null default '',
  timezone text not null default 'America/Sao_Paulo',
  email_notifications boolean not null default true,
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  locale text not null default 'pt-BR',
  timezone text not null default 'America/Sao_Paulo',
  notif jsonb not null default '{"toast": true, "sound": true, "volume": 70}'::jsonb,
  current_company_id uuid references public.companies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text not null default '#8B5CF6',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  role text not null default 'Membro' check (role in ('Proprietário', 'Admin', 'Membro')),
  department_id uuid references public.departments (id) on delete set null,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);

-- ---------- Funções de acesso (schema privado, fora da API) ----------

create or replace function private.is_member(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_admin(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = (select auth.uid()) and m.role in ('Proprietário', 'Admin')
  );
$$;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.is_member(uuid), private.is_admin(uuid) from public, anon;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- ---------- Operação ----------

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text not null default '#8B5CF6',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  number text not null default '',
  provider text not null default 'web',
  plan text not null default 'starter',
  status text not null default 'disconnected',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tokens/credenciais do provedor de WhatsApp: sem política de RLS = só o servidor (service role) lê.
create table public.connection_secrets (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null,
  credentials jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null default '',
  phone text not null default '',
  phone_digits text generated always as (regexp_replace(phone, '\D', '', 'g')) stored,
  email text not null default '',
  status text not null default 'lead',
  origin text not null default 'Manual',
  state text not null default '',
  labels uuid[] not null default '{}',
  connection_id uuid references public.connections (id) on delete set null,
  fields jsonb not null default '{}'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid not null,
  connection_id uuid references public.connections (id) on delete set null,
  status text not null default 'waiting' check (status in ('waiting', 'attending', 'resolved')),
  unread int not null default 0,
  answered boolean not null default false,
  assigned_to uuid references public.company_members (id) on delete set null,
  department_id uuid references public.departments (id) on delete set null,
  last_message_at timestamptz not null default now(),
  bot_active boolean not null default true,
  flow_state jsonb not null default '{}'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (contact_id, company_id) references public.contacts (id, company_id) on delete cascade
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  chat_id uuid not null,
  sender text not null default 'contact' check (sender in ('contact', 'agent', 'bot', 'sys')),
  text text not null default '',
  type text not null default 'text',
  media_url text,
  wa_id text,
  delivery text not null default 'sent',
  at timestamptz not null default now(),
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (chat_id, company_id) references public.chats (id, company_id) on delete cascade
);

create table public.kanbans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text not null default '#8B5CF6',
  columns jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create table public.kanban_cards (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kanban_id uuid not null,
  column_id text not null,
  contact_id uuid references public.contacts (id) on delete set null,
  title text not null default '',
  value numeric not null default 0,
  labels uuid[] not null default '{}',
  assignee uuid references public.company_members (id) on delete set null,
  notes text not null default '',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (kanban_id, company_id) references public.kanbans (id, company_id) on delete cascade
);

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null default 'Novo Fluxo',
  folder text,
  status text not null default 'active' check (status in ('active', 'paused')),
  nodes jsonb not null default '[]'::jsonb,
  edges jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null default 'Agente',
  avatar text not null default '🤖',
  active boolean not null default true,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.voices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  connection_id uuid references public.connections (id) on delete set null,
  flow_id uuid references public.flows (id) on delete set null,
  token text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  active boolean not null default true,
  calls int not null default 0,
  mapping jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.dispatches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null default '',
  flow_id uuid references public.flows (id) on delete set null,
  connection_id uuid references public.connections (id) on delete set null,
  interval int not null default 15,
  total int not null default 0,
  sent int not null default 0,
  status text not null default 'andamento',
  contacts uuid[] not null default '{}',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pixels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  platform text not null default 'Meta',
  pixel_id text not null default '',
  events text[] not null default '{}',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.meta_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  accounts jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  price numeric not null default 0,
  min numeric not null default 0,
  max numeric not null default 0,
  currency text not null default 'BRL',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid references public.connections (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  product_id uuid references public.products (id) on delete set null,
  value numeric not null default 0,
  currency text not null default 'BRL',
  state text not null default '',
  source_id text not null default '',
  at timestamptz not null default now(),
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  shortcut text not null,
  type text not null default 'texto',
  content text not null default '',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.global_vars (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  value text not null default '',
  description text not null default '',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  key text not null,
  label text not null default '',
  type text not null default 'Texto',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid references public.connections (id) on delete cascade,
  name text not null,
  category text not null default 'MARKETING',
  language text not null default 'pt_BR',
  body text not null default '',
  status text not null default 'EM ANÁLISE',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mcp_credentials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  token text not null,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null,
  role text not null default 'Membro' check (role in ('Admin', 'Membro')),
  department_id uuid references public.departments (id) on delete set null,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null,
  status text not null default 'pendente',
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number text not null default '',
  amount numeric not null default 0,
  status text not null default 'paga',
  date timestamptz not null default now(),
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Índices, gatilhos de updated_at e RLS em massa ----------

do $$
declare
  t text;
  tenant_tables text[] := array[
    'departments','labels','connections','contacts','chats','messages','kanbans','kanban_cards','flows','agents','voices',
    'webhooks','dispatches','pixels','meta_profiles','products','sales','quick_replies','global_vars','custom_fields',
    'whatsapp_templates','mcp_credentials','invitations','platform_invites','invoices'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index on public.%I (company_id)', t);
    execute format(
      'create policy "membros da empresa" on public.%I for all to authenticated using (private.is_member(company_id)) with check (private.is_member(company_id))', t);
    if t <> 'messages' then
      execute format('create trigger touch before update on public.%I for each row execute function private.touch_updated_at()', t);
    end if;
  end loop;
end $$;

create trigger touch before update on public.companies for each row execute function private.touch_updated_at();
create trigger touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger touch before update on public.company_members for each row execute function private.touch_updated_at();
create trigger touch before update on public.connection_secrets for each row execute function private.touch_updated_at();

-- índices de chaves estrangeiras e buscas usadas pelo servidor
create index on public.company_members (user_id);
create index on public.company_members (department_id);
create index on public.connection_secrets (company_id);
create index on public.contacts (company_id, phone_digits);
create index on public.contacts (connection_id);
create index on public.chats (contact_id, company_id);
create index on public.chats (connection_id);
create index on public.chats (assigned_to);
create index on public.chats (department_id);
create index on public.chats (company_id, last_message_at desc);
create index on public.messages (chat_id, company_id, at);
create index on public.kanban_cards (kanban_id, company_id);
create index on public.kanban_cards (contact_id);
create index on public.kanban_cards (assignee);
create index on public.webhooks (connection_id);
create index on public.webhooks (flow_id);
create index on public.dispatches (flow_id);
create index on public.dispatches (connection_id);
create index on public.sales (company_id, at desc);
create index on public.sales (connection_id);
create index on public.sales (contact_id);
create index on public.sales (product_id);
create index on public.whatsapp_templates (connection_id);
create index on public.invitations (department_id);
create index on public.invitations (lower(email));
create index on public.profiles (current_company_id);

-- RLS das tabelas do núcleo
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.company_members enable row level security;
alter table public.connection_secrets enable row level security; -- sem políticas: só service role

create policy "membros veem a empresa" on public.companies for select to authenticated using (private.is_member(id));
create policy "admins editam a empresa" on public.companies for update to authenticated using (private.is_admin(id)) with check (private.is_admin(id));

create policy "perfil próprio: ler" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "perfil próprio: editar" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "membros veem a equipe" on public.company_members for select to authenticated using (private.is_member(company_id));
create policy "admins gerenciam a equipe: inserir" on public.company_members for insert to authenticated with check (private.is_admin(company_id));
create policy "admins gerenciam a equipe: editar" on public.company_members for update to authenticated using (private.is_admin(company_id)) with check (private.is_admin(company_id));
create policy "admins gerenciam a equipe: remover" on public.company_members for delete to authenticated using (private.is_admin(company_id) and role <> 'Proprietário');

-- ---------- Cadastro: cria perfil + empresa (ou entra na empresa que convidou) ----------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  uname text := coalesce(nullif(meta ->> 'name', ''), split_part(new.email, '@', 1));
  inv record;
  cid uuid;
begin
  select * into inv from public.invitations i where lower(i.email) = lower(new.email) order by i.created_at desc limit 1;

  if inv.id is not null then
    cid := inv.company_id;
    insert into public.company_members (company_id, user_id, name, email, role, department_id)
    values (cid, new.id, uname, new.email, inv.role, inv.department_id);
    delete from public.invitations where lower(email) = lower(new.email) and company_id = cid;
  else
    insert into public.companies (name, settings)
    values (
      coalesce(nullif(meta ->> 'company', ''), 'Minha Empresa'),
      jsonb_build_object(
        'tokens', 0,
        'billing', jsonb_build_object('status', 'trial', 'plan', 'Trial', 'recurrence', 'Mensal', 'nextDue', (now() + interval '7 days'),
                                      'starter', jsonb_build_object('used', 0, 'total', 1), 'pro', jsonb_build_object('used', 0, 'total', 0)),
        'expenses', jsonb_build_object('fee', 0, 'fixed', 0),
        'webhookQuota', jsonb_build_object('used', 0, 'total', 30000),
        'dispatchQuota', jsonb_build_object('used', 0, 'total', 1000),
        'flowFolders', '[]'::jsonb,
        'integrations', '[]'::jsonb,
        'connectionFlowConfigs', '{}'::jsonb,
        'savedFilters', '[]'::jsonb,
        'businessHours', '[
          {"day":"Segunda","open":true,"from":"08:00","to":"18:00"},{"day":"Terça","open":true,"from":"08:00","to":"18:00"},
          {"day":"Quarta","open":true,"from":"08:00","to":"18:00"},{"day":"Quinta","open":true,"from":"08:00","to":"18:00"},
          {"day":"Sexta","open":true,"from":"08:00","to":"18:00"},{"day":"Sábado","open":true,"from":"09:00","to":"13:00"},
          {"day":"Domingo","open":false,"from":"09:00","to":"13:00"}]'::jsonb,
        'systemFields', '[
          {"key":"ctwa_clid","label":"Anúncio: CTWA Click ID","type":"Texto"},{"key":"media_url","label":"Anúncio: Media URL","type":"Texto"},
          {"key":"source_id","label":"Anúncio: Source ID","type":"Texto"},{"key":"source_url","label":"Anúncio: Source URL","type":"Texto"},
          {"key":"thumbnail_url","label":"Anúncio: Thumbnail URL","type":"Texto"}]'::jsonb
      )
    )
    returning id into cid;

    insert into public.company_members (company_id, user_id, name, email, role)
    values (cid, new.id, uname, new.email, 'Proprietário');

    insert into public.departments (company_id, name, color) values (cid, 'Vendas', '#8B5CF6'), (cid, 'Suporte', '#3B82F6');
    insert into public.labels (company_id, name, color) values (cid, 'Quente', '#EF4444'), (cid, 'Comprou', '#22C55E'), (cid, 'Aguardando Pix', '#F59E0B');
    insert into public.voices (company_id, name) values (cid, 'Padrão da plataforma');
  end if;

  insert into public.profiles (id, name, email, phone, current_company_id)
  values (new.id, uname, new.email, coalesce(meta ->> 'phone', ''), cid);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- Realtime ----------

alter publication supabase_realtime add table public.messages, public.chats, public.contacts, public.kanban_cards;
