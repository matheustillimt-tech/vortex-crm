-- Rotacionador (Conexões → Rotacionador): um link público que reveza o clique entre vários números conectados.
--   https://seu-dominio.com.br/r/<slug>  → a Vercel repassa para a função rotacionador → 302 para wa.me/<número>
-- Só entram na roda os números com status 'connected' (o connection-monitor e os webhooks atualizam o status), então
-- um número que cai sai sozinho e volta quando reconecta.
-- agent_id: agente de IA que atende em todos os números do rotacionador que não têm agente ativo próprio
-- (resolveAgent em _shared/agent-core.ts).
-- turn, clicks, counts, misses e last_click_at: só a função rotator_hit grava (o painel só lê). Só adiciona.

create table public.rotators (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- endereço do link, único na plataforma inteira (o link é público)
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  -- números na ordem da roda
  connection_ids uuid[] not null default '{}',
  -- 'clique': cada clique vai para o próximo número; 'hora': um número diferente a cada hora
  mode text not null default 'clique' check (mode in ('clique', 'hora')),
  message text not null default '',
  agent_id uuid,
  active boolean not null default true,
  turn bigint not null default 0,
  clicks bigint not null default 0,
  counts jsonb not null default '{}'::jsonb,
  misses bigint not null default 0,
  last_click_at timestamptz,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rotators_agent_fk foreign key (agent_id, company_id) references public.agents (id, company_id) on delete set null (agent_id)
);
create index on public.rotators (company_id);
create index rotators_connections_idx on public.rotators using gin (connection_ids);

alter table public.rotators enable row level security;
create policy "membros da empresa" on public.rotators for all to authenticated
  using (private.is_member(company_id)) with check (private.is_member(company_id));
create policy "módulo liberado" on public.rotators as restrictive for all to authenticated
  using (company_id = any ((select private.companies_with_module('conexoes'))::uuid[]))
  with check (company_id = any ((select private.companies_with_module('conexoes'))::uuid[]));
create trigger touch before update on public.rotators for each row execute function private.touch_updated_at();

-- Um clique no link. p_available: os números no ar, na ordem da roda (a função rotacionador filtra).
-- Devolve o número escolhido (null sem nenhum no ar). Com p_count = false (prévia de link do WhatsApp, robôs) só
-- diz qual seria o próximo, sem andar a roda nem contar.
-- A roda anda num update com trava da linha: dois cliques ao mesmo tempo nunca pegam a mesma vez.
create or replace function public.rotator_hit(p_id uuid, p_available uuid[], p_count boolean default true)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  r public.rotators;
  n int := coalesce(array_length(p_available, 1), 0);
  k bigint;
  chosen uuid;
begin
  if n = 0 then
    if p_count then update public.rotators set misses = misses + 1, last_click_at = now() where id = p_id; end if;
    return null;
  end if;
  if p_count then
    update public.rotators set turn = turn + 1 where id = p_id returning * into r;
    k := r.turn - 1;
  else
    select * into r from public.rotators where id = p_id;
    k := r.turn;
  end if;
  if r.id is null then return null; end if;
  if r.mode = 'hora' then k := floor(extract(epoch from now()) / 3600)::bigint; end if;
  chosen := p_available[(k % n)::int + 1];
  if p_count then
    update public.rotators set clicks = clicks + 1, last_click_at = now(),
      counts = jsonb_set(counts, array[chosen::text], to_jsonb(coalesce((counts ->> chosen::text)::bigint, 0) + 1))
    where id = p_id;
  end if;
  return chosen;
end;
$$;
revoke execute on function public.rotator_hit(uuid, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.rotator_hit(uuid, uuid[], boolean) to service_role;
