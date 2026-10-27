-- Fotos de perfil dos contatos e funil no Kanban (comentou → clicou → cadastrou → grupo → aula → comprou).
-- Só adiciona.

-- ---------- Fotos de perfil ----------
-- WhatsApp (API Web/Zapbot: /contact-picture) e Instagram (Zernio: participantPicture, só de quem já mandou mensagem).
-- O link do WhatsApp e do Instagram expira em horas: o servidor baixa e guarda no bucket público "avatares"
-- (<empresa>/<contato>-<data>.jpg, nome que ninguém adivinha). avatar_at = última vez que procurou (com ou sem foto).
alter table public.contacts add column if not exists avatar_url text;
alter table public.contacts add column if not exists avatar_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatares', 'avatares', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
-- Sem política de escrita para o painel: só o servidor (service role) grava.

-- ---------- Funil no Kanban ----------
-- Um funil por empresa: o quadro e a coluna de cada etapa. O card só anda para a frente.
create table public.funis (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kanban_id uuid not null,
  nome text not null default 'Funil',
  colunas jsonb not null default '{}'::jsonb, -- { comentou, clicou, cadastrou, grupo, aula, comprou: <column id> }
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (kanban_id, company_id) references public.kanbans (id, company_id) on delete cascade
);
create unique index funis_kanban_key on public.funis (kanban_id);
create index on public.funis (company_id);
alter table public.funis enable row level security;
create policy "membros veem os funis da empresa" on public.funis for select to authenticated using (private.is_member(company_id));

-- Tokens e segredos de quem avisa o funil (isca, grupo, webinar, plataforma). Sem política: só o servidor lê.
create table public.funil_segredos (
  funil_id uuid primary key references public.funis (id) on delete cascade,
  fontes jsonb not null default '{}'::jsonb, -- { isca: { token, segredo }, grupo: {...}, webinar: {...}, plataforma: {...} }
  updated_at timestamptz not null default now()
);
alter table public.funil_segredos enable row level security;
revoke all on public.funil_segredos from authenticated, anon;
grant select, insert, update, delete on public.funil_segredos to service_role;

-- Cada aviso recebido (ou clique lido na Zernio): a chave barra repetição e o registro ajuda no suporte.
create table public.funil_eventos (
  id uuid primary key default gen_random_uuid(),
  funil_id uuid not null references public.funis (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  fonte text not null,
  chave text not null,
  etapa text,
  contact_id uuid references public.contacts (id) on delete set null,
  status text not null default 'ok' check (status in ('ok', 'ignorado', 'erro')),
  motivo text,
  payload jsonb,
  recebido_em timestamptz not null default now(),
  unique (funil_id, fonte, chave)
);
create index on public.funil_eventos (funil_id, recebido_em desc);
create index on public.funil_eventos (company_id, recebido_em desc);
alter table public.funil_eventos enable row level security;
create policy "membros veem os eventos do funil" on public.funil_eventos for select to authenticated using (private.is_member(company_id));

-- Clique no link da DM: a rotina lê os registros das automações da Zernio a cada 5 min (função funil, action tick).
-- O endereço do projeto e a chave anon vêm do Supabase Vault (segredos 'project_url' e 'anon_key'), criados uma vez
-- na instalação (veja INSTALACAO.md). Assim nenhuma chave fica escrita no código.
select cron.schedule(
  'vortex-funil-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/funil',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')),
    body := '{"action": "tick"}'::jsonb
  );
  $$
);
