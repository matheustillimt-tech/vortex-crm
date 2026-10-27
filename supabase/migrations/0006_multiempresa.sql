-- Várias empresas por usuário: quem já está logado cria outra empresa, troca a empresa ativa e entra por convite,
-- sem novo login nem senha. Os dados continuam separados pelo RLS de cada tabela (company_id + private.is_member);
-- aqui só muda de quais empresas a pessoa é membro e qual delas o perfil tem aberta (profiles.current_company_id).

-- ---------- Criação de empresa: a mesma do cadastro, agora reaproveitável ----------

create or replace function private.setup_company(p_user uuid, p_user_name text, p_user_email text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  cid uuid;
  pkg record;
  mods text[];
begin
  insert into public.companies (name, settings)
  values (
    coalesce(nullif(trim(p_name), ''), 'Minha Empresa'),
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
  values (cid, p_user, p_user_name, p_user_email, 'Proprietário');

  insert into public.departments (company_id, name, color) values (cid, 'Vendas', '#8B5CF6'), (cid, 'Suporte', '#3B82F6');
  insert into public.labels (company_id, name, color) values (cid, 'Quente', '#EF4444'), (cid, 'Comprou', '#22C55E'), (cid, 'Aguardando Pix', '#F59E0B');
  insert into public.voices (company_id, name) values (cid, 'Padrão da plataforma');

  -- módulos do pacote padrão (sem pacote padrão: todos)
  select id, modules into pkg from public.module_packages where is_default limit 1;
  mods := coalesce(pkg.modules, (select array_agg(key) from public.modules));
  insert into public.company_access (company_id, selected, effective, package_id)
  values (cid, mods, private.module_closure(mods), pkg.id);
  insert into public.company_subscriptions (company_id, plan, status, trial_ends_at)
  values (cid, 'Trial', 'trial', now() + interval '7 days');

  return cid;
end;
$$;

revoke all on function private.setup_company(uuid, text, text, text) from public, anon, authenticated;

-- Cadastro: como antes, só que a criação da empresa agora está em private.setup_company
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
    cid := private.setup_company(new.id, uname, new.email, meta ->> 'company');
  end if;

  insert into public.profiles (id, name, email, phone, current_company_id)
  values (new.id, uname, new.email, coalesce(meta ->> 'phone', ''), cid);

  return new;
end;
$$;

-- ---------- Convites: código para quem já tem conta; só administradores convidam ----------

alter table public.invitations add column if not exists code text;
update public.invitations set code = upper(substr(md5(gen_random_uuid()::text), 1, 12)) where code is null;
alter table public.invitations
  alter column code set default upper(substr(md5(gen_random_uuid()::text), 1, 12)),
  alter column code set not null;
create unique index if not exists invitations_code_key on public.invitations (code);

-- antes qualquer membro podia criar convite (inclusive como Admin); agora só quem administra a empresa
drop policy if exists "membros da empresa" on public.invitations;
create policy "membros veem os convites" on public.invitations for select to authenticated using (private.is_member(company_id));
create policy "admins gerenciam convites: inserir" on public.invitations for insert to authenticated with check (private.is_admin(company_id));
create policy "admins gerenciam convites: editar" on public.invitations for update to authenticated
  using (private.is_admin(company_id)) with check (private.is_admin(company_id));
create policy "admins gerenciam convites: remover" on public.invitations for delete to authenticated using (private.is_admin(company_id));

-- ---------- Funções do painel (todas conferem o usuário logado) ----------

-- Empresas das quais o usuário é membro (o seletor e a tela de boas-vindas só mostram estas)
create or replace function public.my_companies()
returns table (id uuid, public_id bigint, name text, role text, plan text, status text, is_current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.public_id, c.name, m.role, s.plan, s.status, c.id is not distinct from p.current_company_id
  from public.company_members m
  join public.companies c on c.id = m.company_id
  left join public.company_subscriptions s on s.company_id = c.id
  left join public.profiles p on p.id = m.user_id
  where m.user_id = (select auth.uid())
  order by lower(c.name), c.created_at;
$$;

-- Troca a empresa ativa (só para uma empresa da qual a pessoa é membro)
create or replace function public.switch_company(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.company_members where company_id = p_company and user_id = (select auth.uid())) then
    raise exception 'Você não tem acesso a esta empresa.' using errcode = '42501';
  end if;
  update public.profiles set current_company_id = p_company where id = (select auth.uid());
end;
$$;

-- Cria uma empresa para o usuário logado, com ele como proprietário, e já entra nela
create or replace function public.create_company(p_name text, p_description text default '', p_phone text default '', p_timezone text default 'America/Sao_Paulo')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  uemail text;
  uname text;
  owned int;
  cid uuid;
  nm text := trim(coalesce(p_name, ''));
  tz text := coalesce(nullif(trim(p_timezone), ''), 'America/Sao_Paulo');
begin
  if uid is null then
    raise exception 'Entre na sua conta para criar uma empresa.' using errcode = '28000';
  end if;
  if char_length(nm) < 2 or char_length(nm) > 80 then
    raise exception 'Informe o nome da empresa (de 2 a 80 caracteres).' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then
    tz := 'America/Sao_Paulo';
  end if;
  select count(*) into owned from public.company_members where user_id = uid and role = 'Proprietário';
  if owned >= 20 then
    raise exception 'Limite de 20 empresas por conta. Fale com o suporte para criar mais.' using errcode = '54000';
  end if;

  select u.email, coalesce(nullif(p.name, ''), split_part(u.email, '@', 1))
    into uemail, uname
  from auth.users u left join public.profiles p on p.id = u.id
  where u.id = uid;

  cid := private.setup_company(uid, uname, uemail, nm);
  update public.companies
     set description = left(trim(coalesce(p_description, '')), 300),
         timezone = tz,
         settings = settings || jsonb_build_object('corporate', jsonb_build_object('phone', left(regexp_replace(coalesce(p_phone, ''), '[^0-9+() -]', '', 'g'), 30)))
   where id = cid;
  update public.profiles set current_company_id = cid where id = uid;
  return cid;
end;
$$;

-- Convites pendentes para o e-mail do usuário logado (de empresas em que ele ainda não está)
create or replace function public.my_invitations()
returns table (id uuid, company_id uuid, company_name text, role text, department text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.company_id, c.name, i.role, d.name, i.created_at
  from public.invitations i
  join public.companies c on c.id = i.company_id
  left join public.departments d on d.id = i.department_id
  where lower(i.email) = lower((select u.email from auth.users u where u.id = (select auth.uid())))
    and not exists (select 1 from public.company_members m where m.company_id = i.company_id and m.user_id = (select auth.uid()))
  order by i.created_at desc;
$$;

-- Aceita um convite: pelo id (convite para o seu e-mail) ou pelo código que o administrador compartilhou.
-- Entra com a função e o departamento definidos no convite; o convite deixa de valer.
create or replace function public.accept_invitation(p_id uuid default null, p_code text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  uemail text;
  uname text;
  inv public.invitations%rowtype;
  norm text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if uid is null then
    raise exception 'Entre na sua conta para aceitar o convite.' using errcode = '28000';
  end if;
  select u.email, coalesce(nullif(p.name, ''), split_part(u.email, '@', 1))
    into uemail, uname
  from auth.users u left join public.profiles p on p.id = u.id
  where u.id = uid;

  if p_id is not null then
    select * into inv from public.invitations i where i.id = p_id and lower(i.email) = lower(uemail);
  elsif norm <> '' then
    select * into inv from public.invitations i where i.code = norm;
  end if;
  if inv.id is null then
    raise exception 'Convite inválido ou já utilizado. Confira o código com quem convidou você.' using errcode = 'P0002';
  end if;

  insert into public.company_members (company_id, user_id, name, email, role, department_id)
  values (inv.company_id, uid, uname, uemail, inv.role, inv.department_id)
  on conflict (company_id, user_id) do nothing;
  delete from public.invitations i where i.company_id = inv.company_id and (i.id = inv.id or lower(i.email) = lower(uemail));
  update public.profiles set current_company_id = inv.company_id where id = uid;
  return inv.company_id;
end;
$$;

revoke all on function public.my_companies(), public.switch_company(uuid), public.create_company(text, text, text, text),
  public.my_invitations(), public.accept_invitation(uuid, text) from public, anon;
grant execute on function public.my_companies(), public.switch_company(uuid), public.create_company(text, text, text, text),
  public.my_invitations(), public.accept_invitation(uuid, text) to authenticated;
