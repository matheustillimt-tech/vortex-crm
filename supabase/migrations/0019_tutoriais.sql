-- Aba Tutoriais: vídeos curtos de cada ferramenta (gravados com a skill tutorial-em-video).
-- Cada tutorial lista os módulos que exige; a empresa só vê o tutorial se tiver TODOS liberados
-- (company_access.effective já inclui as dependências). Lista vazia = aparece pra todo mundo.
-- Quem publica é o superadmin. Vídeo e capa ficam no bucket público "tutorials".

create table public.tutorials (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  modules text[] not null default '{}',
  video_path text not null,
  cover_path text,
  duration_s int,
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.tutorials enable row level security;

create policy "tutoriais dos módulos da empresa" on public.tutorials for select to authenticated using (
  (select private.is_superadmin())
  or (published and not exists (
    select 1 from unnest(modules) m
    where not private.has_module((select p.current_company_id from public.profiles p where p.id = (select auth.uid())), m)
  ))
);
create policy "superadmins publicam tutoriais" on public.tutorials for all to authenticated
  using ((select private.is_superadmin())) with check ((select private.is_superadmin()));

grant select on public.tutorials to authenticated;
grant insert, update, delete on public.tutorials to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tutorials', 'tutorials', true, 52428800, array['video/mp4', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "superadmins enviam tutoriais" on storage.objects for insert to authenticated
  with check (bucket_id = 'tutorials' and (select private.is_superadmin()));
create policy "superadmins trocam tutoriais" on storage.objects for update to authenticated
  using (bucket_id = 'tutorials' and (select private.is_superadmin()));
create policy "superadmins apagam tutoriais" on storage.objects for delete to authenticated
  using (bucket_id = 'tutorials' and (select private.is_superadmin()));
