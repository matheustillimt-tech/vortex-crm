-- Gatilhos de início dos fluxos: o bloco "Início do fluxo" passa a ter vários gatilhos (mensagem, webhook, CRM, datas,
-- internos) e regras de entrada. O motor fica em supabase/functions/_shared/triggers.ts.
--  1. flows.trigger_types: tipos de gatilho ligados no fluxo (calculado do bloco Início). Os gatilhos do banco abaixo só
--     geram eventos quando algum fluxo ativo da empresa escuta aquele tipo.
--  2. flow_runs: cada vez que um fluxo começa para um contato (histórico e contadores Sucessos/Alertas/Erros). A chave do
--     evento (flow_id, event_key) impede que o mesmo evento rode o mesmo fluxo duas vezes.
--  3. flow_jobs: o que vai acontecer depois (sem resposta da equipe, cliente sem responder, tempo parado na etapa, data
--     programada, espera pelo horário permitido). Revalidado antes de executar; cancelado quando a condição muda.
--  4. flow_events: fila dos eventos que nascem no banco (contato criado, etiqueta, campo, negócio, responsável, mensagem
--     enviada). O flow-tick consome a cada 20 s.
--  5. webhook_events: recebimentos dos webhooks de entrada (status, erro, payload real para o mapeamento, id do evento).
-- Mudanças feitas por um fluxo levam extra._flow (execução e cadeia de fluxos): o gatilho do banco tira a marca e passa a
-- cadeia para o evento, e o motor não deixa um fluxo começar de novo dentro da própria cadeia (sem ciclos).
-- Reverter: ver o fim do arquivo.

-- ---------- 1. Tipos de gatilho de cada fluxo ----------

alter table public.flows add column if not exists trigger_types text[] not null default '{}';

-- Bloco Início: data.triggers (formato novo) ou data.keywords (formato antigo = gatilho "Mensagem recebida").
-- Condições de interrupção também precisam dos eventos: entram como stop:tag e stop:deal.
create or replace function private.flow_trigger_types(p_nodes jsonb)
returns text[] language sql immutable set search_path = '' as $$
  with start as (
    select n -> 'data' as d
      from jsonb_array_elements(case when jsonb_typeof(p_nodes) = 'array' then p_nodes else '[]'::jsonb end) n
     where n ->> 'type' = 'start'
     limit 1
  ), types as (
    select tr ->> 'type' as t
      from start, jsonb_array_elements(case when jsonb_typeof(start.d -> 'triggers') = 'array' then start.d -> 'triggers' else '[]'::jsonb end) tr
     where tr -> 'enabled' is distinct from 'false'::jsonb
    union all
    select 'message' from start
     where jsonb_typeof(start.d -> 'triggers') is distinct from 'array'
       and jsonb_typeof(start.d -> 'keywords') = 'array' and jsonb_array_length(start.d -> 'keywords') > 0
    union all
    select 'stop:tag' from start
     where jsonb_typeof(start.d #> '{rules,stopOn,labels}') = 'array' and jsonb_array_length(start.d #> '{rules,stopOn,labels}') > 0
    union all
    select 'stop:deal' from start where coalesce(start.d #>> '{rules,stopOn,kanbanId}', '') <> ''
  )
  select coalesce(array_agg(distinct t order by t), '{}') from types where t is not null and t <> '';
$$;

create or replace function private.flow_trigger_types_set()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.trigger_types := private.flow_trigger_types(new.nodes);
  -- o painel lê a coluna e, ao salvar, mandaria a cópia para extra: não guarda
  new.extra := coalesce(new.extra, '{}'::jsonb) - 'triggerTypes';
  return new;
end;
$$;
revoke all on function private.flow_trigger_types(jsonb), private.flow_trigger_types_set() from public, anon, authenticated;

drop trigger if exists flow_trigger_types on public.flows;
create trigger flow_trigger_types before insert or update on public.flows
  for each row execute function private.flow_trigger_types_set();

update public.flows set trigger_types = private.flow_trigger_types(nodes);

-- Algum fluxo ativo da empresa escuta um destes tipos?
create or replace function private.flow_listens(p_company uuid, p_types text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.flows where company_id = p_company and status = 'active' and trigger_types && p_types);
$$;
revoke all on function private.flow_listens(uuid, text[]) from public, anon, authenticated;

-- ---------- 2. Execuções ----------

create table public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  flow_id uuid not null references public.flows (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete set null,
  trigger_id text not null default '',
  trigger_type text not null default '',
  event_key text,
  status text not null default 'running'
    check (status in ('running', 'waiting', 'done', 'alert', 'error', 'cancelled', 'skipped')),
  reason text,
  chain uuid[] not null default '{}',     -- fluxos que levaram a este (proteção contra ciclos)
  data jsonb not null default '{}'::jsonb, -- variáveis que vieram do evento
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index flow_runs_event_key on public.flow_runs (flow_id, event_key) where event_key is not null;
create index flow_runs_flow_idx on public.flow_runs (flow_id, started_at desc);
create index flow_runs_contact_idx on public.flow_runs (contact_id, flow_id, started_at desc);
create index flow_runs_company_idx on public.flow_runs (company_id, started_at desc);
create index flow_runs_chat_idx on public.flow_runs (chat_id);
create trigger touch before update on public.flow_runs for each row execute function private.touch_updated_at();

-- ---------- 3. Agendamentos dos gatilhos ----------

create table public.flow_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  flow_id uuid not null references public.flows (id) on delete cascade,
  trigger_id text not null default '',
  kind text not null,
  contact_id uuid references public.contacts (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete cascade,
  key text not null,
  run_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'cancelled', 'error')),
  reason text,
  run_id uuid references public.flow_runs (id) on delete set null,
  event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index flow_jobs_key on public.flow_jobs (key);
create index flow_jobs_due_idx on public.flow_jobs (run_at) where status = 'pending';
create index flow_jobs_chat_idx on public.flow_jobs (chat_id) where status = 'pending';
create index flow_jobs_contact_idx on public.flow_jobs (contact_id, flow_id) where status = 'pending';
create index flow_jobs_flow_idx on public.flow_jobs (flow_id, created_at desc);
create index flow_jobs_running_idx on public.flow_jobs (updated_at) where status = 'running';
create trigger touch before update on public.flow_jobs for each row execute function private.touch_updated_at();

-- Pega os vencidos e marca "running" na mesma operação (duas rodadas do flow-tick nunca pegam o mesmo).
-- Os que ficaram "running" por mais de 10 min (rodada que morreu no meio) voltam para a fila.
create or replace function public.flow_jobs_claim(p_limit int)
returns setof public.flow_jobs language plpgsql security definer set search_path = '' as $$
begin
  update public.flow_jobs set status = 'pending' where status = 'running' and updated_at < now() - interval '10 minutes';
  return query
    update public.flow_jobs j set status = 'running'
     where j.id in (select id from public.flow_jobs where status = 'pending' and run_at <= now() order by run_at limit p_limit for update skip locked)
    returning j.*;
end;
$$;

-- ---------- 4. Fila de eventos do banco ----------

create table public.flow_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  contact_id uuid,
  chat_id uuid,
  data jsonb not null default '{}'::jsonb,
  origin jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index flow_events_pending_idx on public.flow_events (id) where processed_at is null;
create index flow_events_processed_idx on public.flow_events (processed_at) where processed_at is not null;

create or replace function public.flow_events_claim(p_limit int)
returns setof public.flow_events language sql security definer set search_path = '' as $$
  update public.flow_events e set processed_at = now()
   where e.id in (select id from public.flow_events where processed_at is null order by id limit p_limit for update skip locked)
  returning e.*;
$$;

revoke all on function public.flow_jobs_claim(int), public.flow_events_claim(int) from public, anon, authenticated;
grant execute on function public.flow_jobs_claim(int), public.flow_events_claim(int) to service_role;

-- Contato: criado, etiquetas e campos. Um erro aqui nunca impede de gravar o contato.
create or replace function private.flow_contact_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origin jsonb := new.extra -> '_flow';
  v_types text[];
  v_added uuid[];
  v_removed uuid[];
  v_changed text[];
begin
  if v_origin is not null then new.extra := new.extra - '_flow'; end if;
  begin
    -- upsert de um contato que já existe: quem conta a mudança é o gatilho de UPDATE que vem em seguida
    if tg_op = 'INSERT' and exists (select 1 from public.contacts where id = new.id) then return new; end if;
    select coalesce(array_agg(distinct t), '{}') into v_types
      from public.flows f, unnest(f.trigger_types) t
     where f.company_id = new.company_id and f.status = 'active';
    if cardinality(v_types) = 0 then return new; end if;

    if tg_op = 'INSERT' then
      if 'contact_created' = any (v_types) then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'contact_created', new.id, jsonb_build_object('origin', new.origin, 'connectionId', new.connection_id), v_origin);
      end if;
      v_added := coalesce(new.labels, '{}');
      v_removed := '{}';
    else
      v_added := array(select unnest(coalesce(new.labels, '{}')) except select unnest(coalesce(old.labels, '{}')));
      v_removed := array(select unnest(coalesce(old.labels, '{}')) except select unnest(coalesce(new.labels, '{}')));
    end if;

    if v_types && array['tag', 'stop:tag'] then
      if cardinality(v_added) > 0 then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'tag', new.id, jsonb_build_object('action', 'added', 'labels', to_jsonb(v_added)), v_origin);
      end if;
      if cardinality(v_removed) > 0 then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'tag', new.id, jsonb_build_object('action', 'removed', 'labels', to_jsonb(v_removed)), v_origin);
      end if;
    end if;

    if tg_op = 'UPDATE' and 'field_updated' = any (v_types) then
      v_changed := array(
        select k from jsonb_each(coalesce(new.fields, '{}'::jsonb)) as n(k, v) where coalesce(old.fields, '{}'::jsonb) -> k is distinct from v
        union
        select k from jsonb_each(coalesce(old.fields, '{}'::jsonb)) as o(k, v) where not coalesce(new.fields, '{}'::jsonb) ? k
      );
      if new.name is distinct from old.name then v_changed := v_changed || 'nome'::text; end if;
      if new.email is distinct from old.email then v_changed := v_changed || 'email'::text; end if;
      if new.status is distinct from old.status then v_changed := v_changed || 'status'::text; end if;
      if new.state is distinct from old.state then v_changed := v_changed || 'estado'::text; end if;
      if cardinality(v_changed) > 0 then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'field_updated', new.id, jsonb_build_object('fields', to_jsonb(v_changed)), v_origin);
      end if;
    end if;
  exception when others then
    raise warning 'flow_contact_events: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Negócio (card do Kanban): criado, mudou de etapa, responsável. extra.columnSince guarda quando entrou na etapa atual
-- (o "tempo parado na etapa" confere isso antes de executar).
create or replace function private.flow_card_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origin jsonb := new.extra -> '_flow';
  v_types text[];
begin
  if v_origin is not null then new.extra := new.extra - '_flow'; end if;
  -- o painel grava os cards com upsert: no INSERT de um card que já existe, quem decide é o gatilho de UPDATE seguinte
  if tg_op = 'INSERT' then
    if exists (select 1 from public.kanban_cards where id = new.id) then return new; end if;
    new.extra := jsonb_set(coalesce(new.extra, '{}'::jsonb), '{columnSince}', to_jsonb(now()));
  elsif new.column_id is distinct from old.column_id then
    new.extra := jsonb_set(coalesce(new.extra, '{}'::jsonb), '{columnSince}', to_jsonb(now()));
  elsif old.extra ? 'columnSince' then
    new.extra := jsonb_set(coalesce(new.extra, '{}'::jsonb), '{columnSince}', old.extra -> 'columnSince');
  end if;
  begin
    select coalesce(array_agg(distinct t), '{}') into v_types
      from public.flows f, unnest(f.trigger_types) t
     where f.company_id = new.company_id and f.status = 'active';
    if cardinality(v_types) = 0 then return new; end if;
    if v_types && array['deal', 'deal_result', 'stage_idle', 'stop:deal'] then
      if tg_op = 'INSERT' then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'deal', new.contact_id, jsonb_build_object('event', 'created', 'cardId', new.id, 'kanbanId', new.kanban_id,
          'from', null, 'to', new.column_id, 'since', new.extra -> 'columnSince'), v_origin);
      elsif new.column_id is distinct from old.column_id then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'deal', new.contact_id, jsonb_build_object('event', 'moved', 'cardId', new.id, 'kanbanId', new.kanban_id,
          'from', old.column_id, 'to', new.column_id, 'since', new.extra -> 'columnSince'), v_origin);
      end if;
    end if;
    if tg_op = 'UPDATE' and 'assignee' = any (v_types) then
      if new.assignee is distinct from old.assignee then
        insert into public.flow_events (company_id, kind, contact_id, data, origin)
        values (new.company_id, 'assignee', new.contact_id, jsonb_build_object('scope', 'deal', 'cardId', new.id, 'from', old.assignee, 'to', new.assignee), v_origin);
      end if;
    end if;
  exception when others then
    raise warning 'flow_card_events: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Conversa: responsável alterado.
create or replace function private.flow_chat_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.assigned_to is distinct from old.assigned_to and private.flow_listens(new.company_id, array['assignee']) then
      insert into public.flow_events (company_id, kind, contact_id, chat_id, data)
      values (new.company_id, 'assignee', new.contact_id, new.id, jsonb_build_object('scope', 'chat', 'from', old.assigned_to, 'to', new.assigned_to));
    end if;
  exception when others then
    raise warning 'flow_chat_events: %', sqlerrm;
  end;
  return null;
end;
$$;

-- Mensagem: a resposta cancela o que esperava por ela; mensagem enviada ao cliente abre a espera "cliente sem responder".
create or replace function private.flow_message_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.sender = 'contact' then
      update public.flow_jobs set status = 'cancelled', reason = 'O cliente respondeu antes do prazo.'
       where chat_id = new.chat_id and status = 'pending' and kind = 'no_client_reply';
    elsif new.sender in ('agent', 'bot') then
      if new.sender = 'agent' then
        update public.flow_jobs set status = 'cancelled', reason = 'A equipe respondeu antes do prazo.'
         where chat_id = new.chat_id and status = 'pending' and kind = 'no_team_reply';
      end if;
      if private.flow_listens(new.company_id, array['no_client_reply']) then
        insert into public.flow_events (company_id, kind, chat_id, data)
        values (new.company_id, 'outbound', new.chat_id, jsonb_build_object('sender', new.sender, 'at', new.at, 'messageId', new.id));
      end if;
    end if;
  exception when others then
    raise warning 'flow_message_events: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.flow_contact_events(), private.flow_card_events(), private.flow_chat_events(), private.flow_message_events()
  from public, anon, authenticated;

drop trigger if exists flow_contact_events on public.contacts;
create trigger flow_contact_events before insert or update on public.contacts
  for each row execute function private.flow_contact_events();
drop trigger if exists flow_card_events on public.kanban_cards;
create trigger flow_card_events before insert or update on public.kanban_cards
  for each row execute function private.flow_card_events();
drop trigger if exists flow_chat_events on public.chats;
create trigger flow_chat_events after update of assigned_to on public.chats
  for each row execute function private.flow_chat_events();
drop trigger if exists flow_message_events on public.messages;
create trigger flow_message_events after insert on public.messages
  for each row execute function private.flow_message_events();

-- ---------- 5. Recebimentos dos webhooks de entrada ----------

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  webhook_id uuid not null references public.webhooks (id) on delete cascade,
  flow_id uuid references public.flows (id) on delete set null,
  status text not null default 'received' check (status in ('received', 'ok', 'test', 'duplicate', 'ignored', 'error')),
  reason text,
  event_key text,   -- id do evento lido do payload (ou o hash do corpo)
  dedupe text,      -- trava: o mesmo evento não é processado duas vezes
  payload jsonb not null default '{}'::jsonb,
  contact_id uuid references public.contacts (id) on delete set null,
  run_id uuid references public.flow_runs (id) on delete set null,
  received_at timestamptz not null default now()
);
create unique index webhook_events_dedupe on public.webhook_events (webhook_id, dedupe) where dedupe is not null;
create index webhook_events_webhook_idx on public.webhook_events (webhook_id, received_at desc);
create index webhook_events_company_idx on public.webhook_events (company_id, received_at desc);

create or replace function public.webhook_hit(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.webhooks set calls = calls + 1 where id = p_id;
$$;
revoke all on function public.webhook_hit(uuid) from public, anon, authenticated;
grant execute on function public.webhook_hit(uuid) to service_role;

-- ---------- RLS: membros leem (com o módulo); só o servidor grava ----------

alter table public.flow_runs enable row level security;
alter table public.flow_jobs enable row level security;
alter table public.flow_events enable row level security; -- sem políticas: só o servidor
alter table public.webhook_events enable row level security;
create policy "membros veem as execuções dos fluxos" on public.flow_runs for select to authenticated
  using (company_id = any ((select private.companies_with_module('fluxos'))::uuid[]));
create policy "membros veem os agendamentos dos fluxos" on public.flow_jobs for select to authenticated
  using (company_id = any ((select private.companies_with_module('fluxos'))::uuid[]));
create policy "membros veem os recebimentos dos webhooks" on public.webhook_events for select to authenticated
  using (company_id = any ((select private.companies_with_module('fluxos'))::uuid[]));

-- Contadores do bloco Início (Sucessos, Alertas, Erros) por gatilho. Respeita o RLS de quem chama.
create or replace function public.flow_run_stats(p_flow uuid)
returns table (trigger_id text, status text, total bigint) language sql stable set search_path = '' as $$
  select r.trigger_id, r.status, count(*) from public.flow_runs r where r.flow_id = p_flow group by r.trigger_id, r.status;
$$;
revoke all on function public.flow_run_stats(uuid) from public, anon;
grant execute on function public.flow_run_stats(uuid) to authenticated;

-- Reverter:
--   drop trigger flow_contact_events on public.contacts; drop trigger flow_card_events on public.kanban_cards;
--   drop trigger flow_chat_events on public.chats; drop trigger flow_message_events on public.messages;
--   drop trigger flow_trigger_types on public.flows;
--   drop table public.webhook_events, public.flow_events, public.flow_jobs, public.flow_runs;
--   drop function public.flow_run_stats(uuid), public.webhook_hit(uuid), public.flow_events_claim(int), public.flow_jobs_claim(int),
--     private.flow_contact_events(), private.flow_card_events(), private.flow_chat_events(), private.flow_message_events(),
--     private.flow_listens(uuid, text[]), private.flow_trigger_types_set(), private.flow_trigger_types(jsonb);
--   alter table public.flows drop column trigger_types;
