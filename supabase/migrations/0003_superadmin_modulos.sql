-- Superadministração da plataforma.
-- Catálogo de módulos com dependências, módulos liberados por empresa, pacotes reutilizáveis,
-- assinaturas e a lista de superadministradores. Clientes só LEEM o que é da própria empresa;
-- quem escreve é o superadmin, sempre pelas funções sa_* (security definer, conferem o papel).

-- ---------- Catálogo de módulos ----------

create table public.modules (
  key text primary key,
  name text not null,
  description text not null default '',
  sort int not null default 0
);

create table public.module_dependencies (
  module text not null references public.modules (key) on delete cascade,
  requires text not null references public.modules (key) on delete cascade,
  reason text not null default '',
  primary key (module, requires),
  check (module <> requires)
);
create index on public.module_dependencies (requires);

insert into public.modules (key, name, description, sort) values
  ('conexoes', 'Conexões', 'Números de WhatsApp (API Web e API Oficial) e templates', 10),
  ('contatos', 'Contatos', 'Base de contatos e campos personalizados', 20),
  ('chat', 'Chat ao vivo', 'Atendimento das conversas e respostas rápidas', 30),
  ('kanban', 'Kanban', 'Quadros de CRM e cards', 40),
  ('fluxos', 'Fluxos de automação', 'Chatbot, fluxos padrões e variáveis globais', 50),
  ('agentes', 'Agentes de IA', 'Atendentes de IA e vozes', 60),
  ('webhooks', 'Webhooks de entrada', 'Recebe leads de outros sistemas', 70),
  ('disparos', 'Disparos em massa', 'Envia um fluxo para muitos contatos', 80),
  ('facebook', 'Facebook', 'Meta Ads, pixels e perfis', 90);

-- Dependências levantadas no código (front, motor de fluxos e funções do servidor).
insert into public.module_dependencies (module, requires, reason) values
  ('chat', 'conexoes', 'as conversas chegam e saem por um número conectado'),
  ('chat', 'contatos', 'toda conversa pertence a um contato'),
  ('agentes', 'chat', 'o agente responde dentro das conversas'),
  ('agentes', 'conexoes', 'o agente fala com o cliente pelo WhatsApp'),
  ('fluxos', 'conexoes', 'os fluxos começam com mensagens recebidas e respondem pelo WhatsApp'),
  ('fluxos', 'contatos', 'os fluxos leem e alteram dados do contato'),
  ('disparos', 'fluxos', 'cada disparo envia um fluxo'),
  ('disparos', 'conexoes', 'o disparo sai por um número conectado'),
  ('disparos', 'contatos', 'o público do disparo são os contatos'),
  ('webhooks', 'contatos', 'cada chamada cria ou atualiza um contato'),
  ('webhooks', 'conexoes', 'o webhook usa uma conexão para falar com o contato');

-- Fecho das dependências: o que foi selecionado + tudo de que ele precisa (em cadeia).
create or replace function private.module_closure(sel text[])
returns text[] language sql stable set search_path = '' as $$
  with recursive c(key) as (
    select m.key from public.modules m where m.key = any (coalesce(sel, '{}'))
    union
    select d.requires from public.module_dependencies d join c on d.module = c.key
  )
  select coalesce(array_agg(key order by key), '{}') from c;
$$;

-- ---------- Superadministradores ----------

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.platform_admins (added_by);

create or replace function private.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins p where p.user_id = (select auth.uid()));
$$;

create or replace function private.require_superadmin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then
    raise exception 'Acesso restrito ao superadministrador da plataforma' using errcode = '42501';
  end if;
end;
$$;

-- ---------- Pacotes, módulos por empresa, assinaturas, histórico ----------

create table public.module_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  modules text[] not null default '{}',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index module_packages_um_padrao on public.module_packages (is_default) where is_default;

-- selected = o que o superadmin marcou; effective = selected + dependências (é o que vale no acesso).
create table public.company_access (
  company_id uuid primary key references public.companies (id) on delete cascade,
  selected text[] not null default '{}',
  effective text[] not null default '{}',
  package_id uuid references public.module_packages (id) on delete set null,
  customized boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index on public.company_access (package_id);
create index on public.company_access (updated_by);

-- source: 'manual' = informado pelo superadmin; 'provider' = confirmado pelo provedor de pagamento (integração futura).
create table public.company_subscriptions (
  company_id uuid primary key references public.companies (id) on delete cascade,
  plan text not null default 'Trial',
  status text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'canceled')),
  source text not null default 'manual' check (source in ('manual', 'provider')),
  provider text,
  provider_ref text,
  trial_ends_at timestamptz,
  renews_at timestamptz,
  canceled_at timestamptz,
  confirmed_at timestamptz,
  notes text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index on public.company_subscriptions (updated_by);

create table public.platform_audit (
  id bigint generated always as identity primary key,
  actor uuid references auth.users (id) on delete set null,
  actor_email text not null default '',
  action text not null,
  company_id uuid references public.companies (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index on public.platform_audit (company_id, at desc);
create index on public.platform_audit (actor);

create trigger touch before update on public.module_packages for each row execute function private.touch_updated_at();
create trigger touch before update on public.company_access for each row execute function private.touch_updated_at();
create trigger touch before update on public.company_subscriptions for each row execute function private.touch_updated_at();

create or replace function private.audit(act text, cid uuid, det jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.platform_audit (actor, actor_email, action, company_id, detail)
  values ((select auth.uid()), coalesce((select auth.jwt() ->> 'email'), ''), act, cid, coalesce(det, '{}'::jsonb));
$$;

-- ---------- Acesso por módulo ----------

create or replace function private.has_module(cid uuid, m text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_access a where a.company_id = cid and m = any (a.effective));
$$;

-- Empresas do usuário logado que têm o módulo m. Usada nas políticas como subconsulta escalar
-- (o Postgres calcula uma vez por consulta, não uma vez por linha).
create or replace function private.companies_with_module(m text)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(a.company_id), '{}')
  from public.company_access a
  join public.company_members cm on cm.company_id = a.company_id
  where cm.user_id = (select auth.uid()) and m = any (a.effective);
$$;

revoke all on function private.module_closure(text[]), private.is_superadmin(), private.require_superadmin(),
  private.audit(text, uuid, jsonb), private.has_module(uuid, text), private.companies_with_module(text) from public, anon;
grant execute on function private.is_superadmin(), private.has_module(uuid, text), private.companies_with_module(text) to authenticated;

-- Tabela -> módulo. Política RESTRITIVA: soma-se (E lógico) à política "membros da empresa".
-- Módulo suspenso = a API devolve vazio na leitura e recusa gravação; os dados continuam no banco.
do $$
declare
  r record;
begin
  for r in select * from (values
    ('connections', 'conexoes'), ('whatsapp_templates', 'conexoes'),
    ('contacts', 'contatos'), ('custom_fields', 'contatos'),
    ('chats', 'chat'), ('messages', 'chat'), ('quick_replies', 'chat'),
    ('kanbans', 'kanban'), ('kanban_cards', 'kanban'),
    ('flows', 'fluxos'), ('global_vars', 'fluxos'),
    ('agents', 'agentes'), ('voices', 'agentes'),
    ('webhooks', 'webhooks'),
    ('dispatches', 'disparos'),
    ('pixels', 'facebook'), ('meta_profiles', 'facebook')
  ) as t(tbl, modulo) loop
    execute format(
      'create policy "módulo liberado" on public.%I as restrictive for all to authenticated '
      'using (company_id = any ((select private.companies_with_module(%L))::uuid[])) '
      'with check (company_id = any ((select private.companies_with_module(%L))::uuid[]))',
      r.tbl, r.modulo, r.modulo);
  end loop;
end $$;

-- ---------- RLS das tabelas novas (sem políticas de escrita: só as funções sa_* escrevem) ----------

alter table public.modules enable row level security;
alter table public.module_dependencies enable row level security;
alter table public.platform_admins enable row level security;
alter table public.module_packages enable row level security;
alter table public.company_access enable row level security;
alter table public.company_subscriptions enable row level security;
alter table public.platform_audit enable row level security;

create policy "catálogo visível" on public.modules for select to authenticated using (true);
create policy "catálogo visível" on public.module_dependencies for select to authenticated using (true);
create policy "superadmins veem a lista" on public.platform_admins for select to authenticated using ((select private.is_superadmin()));
create policy "superadmins veem os pacotes" on public.module_packages for select to authenticated using ((select private.is_superadmin()));
create policy "empresa vê os próprios módulos" on public.company_access for select to authenticated using (private.is_member(company_id) or (select private.is_superadmin()));
create policy "empresa vê a própria assinatura" on public.company_subscriptions for select to authenticated using (private.is_member(company_id) or (select private.is_superadmin()));
create policy "superadmins veem o histórico" on public.platform_audit for select to authenticated using ((select private.is_superadmin()));

-- ---------- Funções do painel (API) ----------

create or replace function public.am_i_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_superadmin();
$$;

create or replace function public.sa_companies()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
      select c.id, c.public_id, c.name, c.active, c.created_at,
        o.name as owner_name, o.email as owner_email,
        (select count(*) from public.company_members m where m.company_id = c.id) as members,
        s.plan, s.status, s.source, s.provider, s.trial_ends_at, s.renews_at, s.canceled_at, s.confirmed_at, s.notes,
        s.updated_at as subscription_updated_at,
        case
          when s.status in ('canceled', 'past_due') then s.status
          when s.status = 'trial' and s.trial_ends_at < now() then 'past_due'
          when s.status = 'active' and s.renews_at < now() and s.source = 'manual' then 'past_due'
          else coalesce(s.status, 'trial')
        end as display_status,
        coalesce(a.selected, '{}') as selected, coalesce(a.effective, '{}') as effective,
        a.package_id, p.name as package_name, coalesce(a.customized, false) as customized, a.updated_at as access_updated_at
      from public.companies c
      left join lateral (
        select m.name, m.email from public.company_members m
        where m.company_id = c.id and m.role = 'Proprietário' order by m.created_at limit 1
      ) o on true
      left join public.company_subscriptions s on s.company_id = c.id
      left join public.company_access a on a.company_id = c.id
      left join public.module_packages p on p.id = a.package_id
    ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.sa_set_company_modules(p_company uuid, p_selected text[], p_package uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  bad text[];
  sel text[];
  eff text[];
  old_eff text[];
  pkg_mods text[];
  cust boolean := false;
begin
  perform private.require_superadmin();
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'Empresa não encontrada';
  end if;
  select array_agg(x) into bad from unnest(coalesce(p_selected, '{}')) x where not exists (select 1 from public.modules m where m.key = x);
  if bad is not null then
    raise exception 'Módulos desconhecidos: %', array_to_string(bad, ', ');
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into sel from unnest(coalesce(p_selected, '{}')) x;
  -- dependências sempre entram: não existe configuração salva com módulo sem o que ele precisa
  eff := private.module_closure(sel);
  if p_package is not null then
    select modules into pkg_mods from public.module_packages where id = p_package;
    if not found then
      raise exception 'Pacote não encontrado';
    end if;
    cust := private.module_closure(pkg_mods) is distinct from eff;
  end if;

  select effective into old_eff from public.company_access where company_id = p_company;
  insert into public.company_access (company_id, selected, effective, package_id, customized, updated_by)
  values (p_company, sel, eff, p_package, cust, (select auth.uid()))
  on conflict (company_id) do update
    set selected = excluded.selected, effective = excluded.effective, package_id = excluded.package_id,
        customized = excluded.customized, updated_by = excluded.updated_by;

  -- Fluxos suspenso: automações em andamento são canceladas (não disparam atrasadas na volta).
  -- Os fluxos, contatos e conversas ficam intactos.
  if 'fluxos' = any (coalesce(old_eff, '{}')) and not ('fluxos' = any (eff)) then
    update public.chats set flow_state = '{}'::jsonb where company_id = p_company and flow_state <> '{}'::jsonb;
  end if;

  perform private.audit('modulos', p_company, jsonb_build_object('antes', old_eff, 'depois', eff, 'selecionados', sel, 'pacote', p_package));
  return jsonb_build_object('selected', sel, 'effective', eff, 'customized', cust);
end;
$$;

create or replace function public.sa_apply_package(p_company uuid, p_package uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mods text[];
begin
  perform private.require_superadmin();
  select modules into mods from public.module_packages where id = p_package;
  if not found then
    raise exception 'Pacote não encontrado';
  end if;
  return public.sa_set_company_modules(p_company, mods, p_package);
end;
$$;

create or replace function public.sa_set_subscription(
  p_company uuid, p_plan text, p_status text, p_trial_ends_at timestamptz, p_renews_at timestamptz, p_notes text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  prev record;
begin
  perform private.require_superadmin();
  if p_status not in ('trial', 'active', 'past_due', 'canceled') then
    raise exception 'Situação inválida: %', p_status;
  end if;
  select * into prev from public.company_subscriptions where company_id = p_company;
  insert into public.company_subscriptions (company_id, plan, status, source, provider, provider_ref, trial_ends_at, renews_at, canceled_at, confirmed_at, notes, updated_by)
  values (
    p_company, coalesce(nullif(trim(p_plan), ''), 'Trial'), p_status, 'manual', null, null, p_trial_ends_at, p_renews_at,
    case when p_status = 'canceled' then coalesce(prev.canceled_at, now()) end, null, coalesce(p_notes, ''), (select auth.uid())
  )
  on conflict (company_id) do update
    set plan = excluded.plan, status = excluded.status, source = 'manual', confirmed_at = null,
        trial_ends_at = excluded.trial_ends_at, renews_at = excluded.renews_at, canceled_at = excluded.canceled_at,
        notes = excluded.notes, updated_by = excluded.updated_by;
  perform private.audit('assinatura', p_company, jsonb_build_object(
    'antes', case when prev.company_id is null then null else jsonb_build_object('plano', prev.plan, 'situacao', prev.status) end,
    'depois', jsonb_build_object('plano', p_plan, 'situacao', p_status)));
end;
$$;

create or replace function public.sa_packages()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.is_default desc, x.name) from (
      select p.id, p.name, p.description, p.modules, private.module_closure(p.modules) as effective, p.is_default, p.updated_at,
        (select count(*) from public.company_access a where a.package_id = p.id) as companies
      from public.module_packages p
    ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.sa_save_package(p_id uuid, p_name text, p_description text, p_modules text[], p_default boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  bad text[];
  pid uuid := p_id;
begin
  perform private.require_superadmin();
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Dê um nome ao pacote';
  end if;
  select array_agg(x) into bad from unnest(coalesce(p_modules, '{}')) x where not exists (select 1 from public.modules m where m.key = x);
  if bad is not null then
    raise exception 'Módulos desconhecidos: %', array_to_string(bad, ', ');
  end if;
  if p_default then
    update public.module_packages set is_default = false where is_default and id is distinct from p_id;
  end if;
  if pid is null then
    insert into public.module_packages (name, description, modules, is_default)
    values (trim(p_name), coalesce(p_description, ''), coalesce(p_modules, '{}'), coalesce(p_default, false))
    returning id into pid;
  else
    update public.module_packages
      set name = trim(p_name), description = coalesce(p_description, ''), modules = coalesce(p_modules, '{}'), is_default = coalesce(p_default, false)
      where id = pid;
    if not found then
      raise exception 'Pacote não encontrado';
    end if;
  end if;
  perform private.audit('pacote', null, jsonb_build_object('id', pid, 'nome', p_name, 'modulos', p_modules, 'padrao', p_default));
  return pid;
end;
$$;

create or replace function public.sa_delete_package(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  -- empresas que usavam o pacote mantêm os módulos atuais (só perdem o vínculo)
  delete from public.module_packages where id = p_id;
  perform private.audit('pacote_excluido', null, jsonb_build_object('id', p_id));
end;
$$;

create or replace function public.sa_admins()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'email', p.email, 'created_at', p.created_at, 'added_by_email', b.email) order by p.created_at)
    from public.platform_admins p left join public.platform_admins b on b.user_id = p.added_by
  ), '[]'::jsonb);
end;
$$;

create or replace function public.sa_add_admin(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  u record;
begin
  perform private.require_superadmin();
  select id, email into u from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if u.id is null then
    raise exception 'Não existe conta com esse e-mail. Peça para a pessoa criar a conta na plataforma primeiro.';
  end if;
  insert into public.platform_admins (user_id, email, added_by) values (u.id, u.email, (select auth.uid()))
  on conflict (user_id) do nothing;
  perform private.audit('superadmin_adicionado', null, jsonb_build_object('email', u.email));
end;
$$;

create or replace function public.sa_remove_admin(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  em text;
begin
  perform private.require_superadmin();
  if (select count(*) from public.platform_admins) <= 1 then
    raise exception 'É preciso manter pelo menos um superadministrador.';
  end if;
  delete from public.platform_admins where user_id = p_user returning email into em;
  perform private.audit('superadmin_removido', null, jsonb_build_object('email', em));
end;
$$;

create or replace function public.sa_audit(p_company uuid default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.at desc) from (
      select a.id, a.actor_email, a.action, a.company_id, a.detail, a.at from public.platform_audit a
      where p_company is null or a.company_id = p_company
      order by a.at desc limit least(greatest(coalesce(p_limit, 30), 1), 200)
    ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.am_i_superadmin(), public.sa_companies(), public.sa_set_company_modules(uuid, text[], uuid),
  public.sa_apply_package(uuid, uuid), public.sa_set_subscription(uuid, text, text, timestamptz, timestamptz, text),
  public.sa_packages(), public.sa_save_package(uuid, text, text, text[], boolean), public.sa_delete_package(uuid),
  public.sa_admins(), public.sa_add_admin(text), public.sa_remove_admin(uuid), public.sa_audit(uuid, int) from public, anon;
grant execute on function public.am_i_superadmin(), public.sa_companies(), public.sa_set_company_modules(uuid, text[], uuid),
  public.sa_apply_package(uuid, uuid), public.sa_set_subscription(uuid, text, text, timestamptz, timestamptz, text),
  public.sa_packages(), public.sa_save_package(uuid, text, text, text[], boolean), public.sa_delete_package(uuid),
  public.sa_admins(), public.sa_add_admin(text), public.sa_remove_admin(uuid), public.sa_audit(uuid, int) to authenticated;

-- ---------- Dados iniciais: ninguém perde acesso na atualização ----------

insert into public.module_packages (name, description, modules, is_default)
values ('Completo', 'Todos os módulos da plataforma', (select array_agg(key order by sort) from public.modules), true);

insert into public.company_access (company_id, selected, effective, package_id)
select c.id, p.modules, private.module_closure(p.modules), p.id
from public.companies c cross join public.module_packages p where p.is_default
on conflict (company_id) do nothing;

insert into public.company_subscriptions (company_id, plan, status, trial_ends_at, renews_at)
select c.id,
  coalesce(nullif(c.settings -> 'billing' ->> 'plan', ''), 'Trial'),
  b.st,
  case when b.st = 'trial' then (c.settings -> 'billing' ->> 'nextDue')::timestamptz end,
  case when b.st <> 'trial' then (c.settings -> 'billing' ->> 'nextDue')::timestamptz end
from public.companies c
cross join lateral (
  select case c.settings -> 'billing' ->> 'status' when 'active' then 'active' when 'canceled' then 'canceled' when 'past_due' then 'past_due' else 'trial' end as st
) b
on conflict (company_id) do nothing;

-- O primeiro superadministrador é criado à mão depois da instalação (INSTALACAO.md, "Criar o primeiro administrador"):
--   insert into public.platform_admins (user_id, email) select id, email from auth.users where lower(email) = lower('voce@exemplo.com');

-- ---------- Cadastro: empresa nova já nasce com o pacote padrão e em teste ----------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  uname text := coalesce(nullif(meta ->> 'name', ''), split_part(new.email, '@', 1));
  inv record;
  cid uuid;
  pkg record;
  mods text[];
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

    -- módulos do pacote padrão (sem pacote padrão: todos, como era antes desta atualização)
    select id, modules into pkg from public.module_packages where is_default limit 1;
    mods := coalesce(pkg.modules, (select array_agg(key) from public.modules));
    insert into public.company_access (company_id, selected, effective, package_id)
    values (cid, mods, private.module_closure(mods), pkg.id);
    insert into public.company_subscriptions (company_id, plan, status, trial_ends_at)
    values (cid, 'Trial', 'trial', now() + interval '7 days');
  end if;

  insert into public.profiles (id, name, email, phone, current_company_id)
  values (new.id, uname, new.email, coalesce(meta ->> 'phone', ''), cid);

  return new;
end;
$$;

-- O app do cliente recebe na hora quando o superadmin muda módulos ou assinatura.
alter publication supabase_realtime add table public.company_access, public.company_subscriptions;
