-- Logo/foto da empresa: aparece no lugar da letra no menu, no seletor de empresas e na tela de boas-vindas.
-- O arquivo fica no bucket público company-logos, na pasta da empresa (<company_id>/...). Qualquer um com o link vê
-- a imagem (é um logo), mas só administradores da empresa enviam, trocam ou apagam arquivos na pasta dela.

alter table public.companies add column if not exists logo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-logos', 'company-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- pastas (empresas) que o usuário logado administra
create or replace function private.admin_company_folders()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.company_id::text), '{}')
  from public.company_members m
  where m.user_id = (select auth.uid()) and m.role in ('Proprietário', 'Admin');
$$;
revoke all on function private.admin_company_folders() from public, anon;
grant execute on function private.admin_company_folders() to authenticated;

create policy "admins enviam o logo da empresa" on storage.objects for insert to authenticated
  with check (bucket_id = 'company-logos' and (storage.foldername(name))[1] = any (private.admin_company_folders()));
create policy "admins veem os arquivos de logo da empresa" on storage.objects for select to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = any (private.admin_company_folders()));
create policy "admins trocam o logo da empresa" on storage.objects for update to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = any (private.admin_company_folders()))
  with check (bucket_id = 'company-logos' and (storage.foldername(name))[1] = any (private.admin_company_folders()));
create policy "admins apagam o logo da empresa" on storage.objects for delete to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = any (private.admin_company_folders()));

-- O seletor e a tela de boas-vindas mostram o logo de cada empresa
drop function if exists public.my_companies();
create function public.my_companies()
returns table (id uuid, public_id bigint, name text, role text, plan text, status text, is_current boolean, logo_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.public_id, c.name, m.role, s.plan, s.status, c.id is not distinct from p.current_company_id, c.logo_url
  from public.company_members m
  join public.companies c on c.id = m.company_id
  left join public.company_subscriptions s on s.company_id = c.id
  left join public.profiles p on p.id = m.user_id
  where m.user_id = (select auth.uid())
  order by lower(c.name), c.created_at;
$$;
revoke all on function public.my_companies() from public, anon;
grant execute on function public.my_companies() to authenticated;
