-- Agentes de IA no atendimento de verdade:
--  - vínculo agente ↔ conexão (no máximo um agente ativo por número);
--  - estado da IA em cada conversa (agente, pausa, agrupamento de mensagens e trava contra resposta dupla);
--  - chaves de IA por empresa (só o servidor lê) e registro de cada execução (ai_runs);
--  - arquivos e foto do agente no Storage;
--  - pausa automática quando um atendente assume pelo painel.

-- ---------- Vínculo agente ↔ conexão ----------
-- (id, company_id) únicos para as chaves estrangeiras compostas: agente e conversa só apontam para a mesma empresa.
alter table public.connections add constraint connections_id_company_key unique (id, company_id);
alter table public.agents add constraint agents_id_company_key unique (id, company_id);

alter table public.agents add column if not exists connection_id uuid;
alter table public.agents add constraint agents_connection_fk foreign key (connection_id, company_id)
  references public.connections (id, company_id) on delete set null (connection_id);
create index if not exists agents_connection_idx on public.agents (connection_id);

-- Dois agentes não respondem ao mesmo número: só um ativo por conexão.
create unique index agents_one_active_per_connection on public.agents (connection_id)
  where active and connection_id is not null;

-- Agente novo nasce pausado; os que já existiam (sem número) também ficam pausados até serem vinculados e ativados.
alter table public.agents alter column active set default false;
update public.agents set active = false where connection_id is null;

-- ---------- Estado da IA em cada conversa ----------
-- ai_agent_id: agente definido por um fluxo (bloco "Agente de IA"); sem ele, vale o agente ativo da conexão.
-- ai_paused / ai_pause_reason: humano | manual | transferido | fluxo | limite.
-- ai_due_at: quando responder (agrupamento: cada mensagem nova do cliente empurra para frente).
-- ai_lock_until: trava enquanto uma resposta está sendo gerada e enviada (evita resposta dupla).
alter table public.chats
  add column if not exists ai_agent_id uuid,
  add column if not exists ai_paused boolean not null default false,
  add column if not exists ai_pause_reason text,
  add column if not exists ai_due_at timestamptz,
  add column if not exists ai_lock_until timestamptz,
  add column if not exists ai_state jsonb not null default '{}'::jsonb;
alter table public.chats add constraint chats_ai_agent_fk foreign key (ai_agent_id, company_id)
  references public.agents (id, company_id) on delete set null (ai_agent_id);
create index if not exists chats_ai_agent_idx on public.chats (ai_agent_id);
create index if not exists chats_ai_due_idx on public.chats (ai_due_at) where ai_due_at is not null;
create index if not exists chats_ai_lock_idx on public.chats (ai_lock_until) where ai_lock_until is not null;

-- o bloco "Agente de IA" dos fluxos guardava o agente em extra.agentId
update public.chats c set ai_agent_id = (c.extra ->> 'agentId')::uuid
 where c.extra ? 'agentId' and (c.extra ->> 'agentId') ~ '^[0-9a-f-]{36}$'
   and exists (select 1 from public.agents a where a.id = (c.extra ->> 'agentId')::uuid and a.company_id = c.company_id);

-- Conversas que um atendente já estava atendendo continuam com ele: a IA não entra nelas.
update public.chats set ai_paused = true, ai_pause_reason = 'humano' where status = 'attending';

-- ---------- Chaves de IA por empresa (sem política de RLS = só o servidor lê) ----------
create table public.ai_credentials (
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('openai', 'gemini', 'compat', 'elevenlabs', 'simulado')),
  api_key text not null default '',
  model text not null default '',
  base_url text not null default '',
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (company_id, provider)
);
alter table public.ai_credentials enable row level security;

-- Administradores gravam a chave pelo painel (Configurações → Integrações). Chave em branco mantém a atual.
-- "simulado" (respostas automáticas para testes) só entra por SQL.
create or replace function public.ai_credential_save(p_company uuid, p_provider text, p_api_key text, p_model text, p_base_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  if not private.is_admin(p_company) then
    raise exception 'Só administradores da empresa conectam integrações.' using errcode = '42501';
  end if;
  if p_provider not in ('openai', 'gemini', 'compat', 'elevenlabs') then
    raise exception 'Provedor de IA inválido.';
  end if;
  if p_provider = 'compat' and coalesce(trim(p_base_url), '') !~ '^https://' then
    raise exception 'Informe a URL base do provedor (começando com https://).';
  end if;
  insert into public.ai_credentials (company_id, provider, api_key, model, base_url)
  values (p_company, p_provider, coalesce(trim(p_api_key), ''), coalesce(trim(p_model), ''), coalesce(trim(p_base_url), ''))
  on conflict (company_id, provider) do update set
    api_key = case when excluded.api_key = '' then public.ai_credentials.api_key else excluded.api_key end,
    model = excluded.model, base_url = excluded.base_url, updated_at = now()
  returning api_key into k;
  if k = '' then
    raise exception 'Informe a chave de API.';
  end if;
end;
$$;

-- O painel vê só se há chave (e os 4 últimos caracteres), nunca a chave.
create or replace function public.ai_credential_list(p_company uuid)
returns table (provider text, model text, base_url text, key_hint text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.provider, c.model, c.base_url, case when length(c.api_key) > 8 then '…' || right(c.api_key, 4) else '' end, c.updated_at
  from public.ai_credentials c
  where c.company_id = p_company and private.is_member(p_company) and c.provider <> 'simulado'
  order by c.provider;
$$;

create or replace function public.ai_credential_remove(p_company uuid, p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin(p_company) then
    raise exception 'Só administradores da empresa desconectam integrações.' using errcode = '42501';
  end if;
  delete from public.ai_credentials where company_id = p_company and provider = p_provider and provider <> 'simulado';
end;
$$;

revoke all on function public.ai_credential_save(uuid, text, text, text, text), public.ai_credential_list(uuid),
  public.ai_credential_remove(uuid, text) from public, anon;
grant execute on function public.ai_credential_save(uuid, text, text, text, text), public.ai_credential_list(uuid),
  public.ai_credential_remove(uuid, text) to authenticated;

-- ---------- Registro de cada execução do agente ----------
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete set null,
  agent_id uuid references public.agents (id) on delete set null,
  status text not null,               -- respondeu | sem_resposta | pulou | transferiu | erro
  reason text not null default '',
  provider text not null default '',
  model text not null default '',
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  actions jsonb not null default '[]'::jsonb,
  error text,
  ms int not null default 0,
  created_at timestamptz not null default now()
);
create index ai_runs_company_idx on public.ai_runs (company_id, created_at desc);
create index ai_runs_chat_idx on public.ai_runs (chat_id);
create index ai_runs_agent_idx on public.ai_runs (agent_id);
alter table public.ai_runs enable row level security;
create policy "membros veem o uso da IA" on public.ai_runs for select to authenticated
  using (company_id = any ((select private.companies_with_module('agentes'))::uuid[]));

-- ---------- Agrupamento e trava (só o servidor chama) ----------
-- Cada mensagem do cliente marca "responder em N segundos" (relógio do banco); mensagem nova reinicia a contagem.
create or replace function public.ai_schedule(p_chat uuid, p_seconds int)
returns timestamptz language sql security definer set search_path = '' as $$
  update public.chats set ai_due_at = now() + make_interval(secs => greatest(coalesce(p_seconds, 0), 0))
   where id = p_chat
  returning ai_due_at;
$$;

-- Tenta pegar a conversa para responder. state: none (nada pendente) | wait (ms até vencer) | locked (ms até a trava
-- vencer) | claimed (at = horário do corte: mensagens até ali entram neste turno) | retry (outra execução pegou antes).
create or replace function public.ai_claim(p_chat uuid, p_lock_seconds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
  t timestamptz := now();
begin
  select ai_due_at, ai_lock_until into r from public.chats where id = p_chat;
  if not found or r.ai_due_at is null then
    return jsonb_build_object('state', 'none');
  end if;
  if r.ai_due_at > t then
    return jsonb_build_object('state', 'wait', 'ms', ceil(extract(epoch from r.ai_due_at - t) * 1000));
  end if;
  if r.ai_lock_until is not null and r.ai_lock_until > t then
    return jsonb_build_object('state', 'locked', 'ms', ceil(extract(epoch from r.ai_lock_until - t) * 1000));
  end if;
  update public.chats
     set ai_due_at = null, ai_lock_until = t + make_interval(secs => p_lock_seconds),
         ai_state = ai_state || jsonb_build_object('inflight', t)
   where id = p_chat and ai_due_at is not null and ai_due_at <= t and (ai_lock_until is null or ai_lock_until <= t);
  if found then
    return jsonb_build_object('state', 'claimed', 'at', t);
  end if;
  return jsonb_build_object('state', 'retry');
end;
$$;

create or replace function public.ai_release(p_chat uuid)
returns void language sql security definer set search_path = '' as $$
  update public.chats set ai_lock_until = null, ai_state = ai_state - 'inflight' where id = p_chat;
$$;

-- Rede de segurança (flow-tick): respostas vencidas que ninguém pegou e turnos que morreram no meio (trava vencida
-- com "inflight") voltam para a fila.
create or replace function public.ai_overdue(p_limit int)
returns setof uuid language plpgsql security definer set search_path = '' as $$
begin
  update public.chats
     set ai_due_at = now(), ai_lock_until = null, ai_state = ai_state - 'inflight'
   where ai_lock_until is not null and ai_lock_until < now() and ai_state ? 'inflight';
  return query
    select c.id from public.chats c
     where c.ai_due_at is not null and c.ai_due_at < now() - interval '8 seconds'
       and (c.ai_lock_until is null or c.ai_lock_until < now())
     order by c.ai_due_at
     limit p_limit;
end;
$$;

revoke all on function public.ai_schedule(uuid, int), public.ai_claim(uuid, int), public.ai_release(uuid), public.ai_overdue(int)
  from public, anon, authenticated;
grant execute on function public.ai_schedule(uuid, int), public.ai_claim(uuid, int), public.ai_release(uuid), public.ai_overdue(int)
  to service_role;

-- ---------- Pausar / retomar a IA numa conversa (Chat ao Vivo) ----------
-- Retomar devolve a conversa para a IA (sem responsável humano). Não mexe nas outras conversas.
create or replace function public.chat_ai_set(p_chat uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c record;
  who text;
begin
  select * into c from public.chats where id = p_chat;
  if not found or not private.is_member(c.company_id) or not private.has_module(c.company_id, 'agentes') then
    raise exception 'Conversa não encontrada.';
  end if;
  select nullif(m.name, '') into who from public.company_members m where m.company_id = c.company_id and m.user_id = (select auth.uid());
  -- quem retoma devolve a conversa para a IA: o gatilho de "humano assumiu" não deve pausar de novo
  perform set_config('vortex_crm.ai_set', '1', true);
  if p_active then
    update public.chats
       set ai_paused = false, ai_pause_reason = null, bot_active = true, assigned_to = null,
           status = case when status = 'resolved' then status else 'attending' end,
           ai_state = ai_state - 'repeat'
     where id = p_chat;
    insert into public.messages (company_id, chat_id, sender, text, delivery)
    values (c.company_id, c.id, 'sys', '🤖 IA retomada nesta conversa por ' || coalesce(who, 'um atendente') || '.', 'local');
  else
    update public.chats set ai_paused = true, ai_pause_reason = 'manual', ai_due_at = null where id = p_chat;
    insert into public.messages (company_id, chat_id, sender, text, delivery)
    values (c.company_id, c.id, 'sys', '⏸️ IA pausada nesta conversa por ' || coalesce(who, 'um atendente') || '.', 'local');
  end if;
end;
$$;
revoke all on function public.chat_ai_set(uuid, boolean) from public, anon;
grant execute on function public.chat_ai_set(uuid, boolean) to authenticated;

-- ---------- Humano assumiu pelo painel → IA pausa (se o agente estiver configurado assim) ----------
-- Vale para o que um usuário logado faz: Atender, transferir para atendente ou departamento, mover para Atendendo.
-- O servidor (service role) não dispara: a IA e os fluxos mudam status sem pausar a si mesmos.
create or replace function private.chat_ai_human_takeover()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  stop boolean;
begin
  if coalesce((select auth.role()), '') <> 'authenticated' or new.ai_paused
     or current_setting('vortex_crm.ai_set', true) = '1' then
    return new;
  end if;
  if not ((new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null)
       or (new.status = 'attending' and old.status is distinct from 'attending')
       or (new.department_id is distinct from old.department_id and new.department_id is not null)) then
    return new;
  end if;
  select coalesce((a.extra -> 'settings' ->> 'stopOnHuman')::boolean, true) into stop
    from public.agents a
   where a.company_id = new.company_id and a.active
     and (a.id = new.ai_agent_id or (new.ai_agent_id is null and a.connection_id = new.connection_id))
   order by (a.id = new.ai_agent_id) desc
   limit 1;
  if coalesce(stop, false) then
    new.ai_paused := true;
    new.ai_pause_reason := 'humano';
    new.ai_due_at := null;
  end if;
  return new;
end;
$$;

create or replace function private.chat_ai_human_note()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  who text;
begin
  select nullif(m.name, '') into who from public.company_members m where m.company_id = new.company_id and m.user_id = (select auth.uid());
  insert into public.messages (company_id, chat_id, sender, text, delivery)
  values (new.company_id, new.id, 'sys', '👤 ' || coalesce(who, 'Um atendente') || ' assumiu o atendimento. IA pausada nesta conversa.', 'local');
  return null;
end;
$$;
revoke all on function private.chat_ai_human_takeover(), private.chat_ai_human_note() from public, anon, authenticated;

create trigger chat_ai_human_takeover before update on public.chats
  for each row execute function private.chat_ai_human_takeover();
create trigger chat_ai_human_note after update on public.chats
  for each row
  when (new.ai_paused and not old.ai_paused and new.ai_pause_reason = 'humano')
  execute function private.chat_ai_human_note();

-- ---------- Arquivos e foto do agente ----------
-- Arquivos: bucket privado agent-files/<empresa>/<agente>/<arquivo>; o servidor manda por link temporário.
insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-files', 'agent-files', false, 67108864)
on conflict (id) do nothing;
-- Foto: bucket público agent-avatars/<empresa>/<arquivo> (só aparece no painel).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-avatars', 'agent-avatars', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "membros gerenciam arquivos dos agentes: ler" on storage.objects for select to authenticated
  using (bucket_id in ('agent-files', 'agent-avatars') and (storage.foldername(name))[1] = any ((select private.companies_with_module('agentes'))::text[]));
create policy "membros gerenciam arquivos dos agentes: enviar" on storage.objects for insert to authenticated
  with check (bucket_id in ('agent-files', 'agent-avatars') and (storage.foldername(name))[1] = any ((select private.companies_with_module('agentes'))::text[]));
create policy "membros gerenciam arquivos dos agentes: trocar" on storage.objects for update to authenticated
  using (bucket_id in ('agent-files', 'agent-avatars') and (storage.foldername(name))[1] = any ((select private.companies_with_module('agentes'))::text[]))
  with check (bucket_id in ('agent-files', 'agent-avatars') and (storage.foldername(name))[1] = any ((select private.companies_with_module('agentes'))::text[]));
create policy "membros gerenciam arquivos dos agentes: apagar" on storage.objects for delete to authenticated
  using (bucket_id in ('agent-files', 'agent-avatars') and (storage.foldername(name))[1] = any ((select private.companies_with_module('agentes'))::text[]));
