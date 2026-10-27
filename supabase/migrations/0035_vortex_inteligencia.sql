-- Vórtex Inteligência: assistente de gestão com dados reais e evolução dos agentes de IA ("Melhorar agente").
-- Funções do servidor em supabase/functions/inteligencia e supabase/functions/_shared/inteligencia/.
--  1. Módulo "inteligencia" (liberado por empresa no superadmin) e permissões por papel (intel_settings).
--  2. Coleta sem IA: pedidos e tentativas de pagamento normalizados (intel_orders, intel_payment_attempts) a partir dos
--     webhooks das plataformas, e eventos internos (intel_events: lead, conversa, transferência, concluído, reaberto,
--     etapa do CRM). Cada evento tem chave única (repetido não conta duas vezes); o status do pedido só avança pela
--     ordem de força (pago não volta a pendente se o aviso do Pix chegar atrasado).
--  3. Consultas autorizadas (intel_m_*): números calculados aqui, com a empresa e a permissão conferidas no banco. A IA
--     do assistente só chama estas funções; não existe SQL livre.
--  4. Evolução dos agentes: execuções (intel_agent_jobs, uma ativa por agente), análises por conversa reaproveitadas
--     entre execuções (intel_chat_digests), base consolidada de aprendizados (intel_learnings), versões do agente
--     (intel_agent_versions), alterações com evidência (intel_agent_changes) e validação (intel_validation_*).
--  5. Consumo: novas origens no extrato dos Créditos de IA (inteligencia, melhoria, validacao) e intel_usage (tokens de
--     toda chamada, inclusive com a chave própria da empresa, que não passa pela carteira).
-- Só adiciona (redefine private.unir_contatos para levar também os pedidos e eventos do contato repetido).

/* ---------- 1. Módulo ---------- */

insert into public.modules (key, name, description, sort)
values ('inteligencia', 'Vórtex Inteligência', 'Assistente de gestão com dados reais e evolução dos agentes de IA', 62)
on conflict (key) do nothing;
insert into public.module_dependencies (module, requires, reason) values
  ('inteligencia', 'chat', 'as análises de atendimento leem as conversas'),
  ('inteligencia', 'contatos', 'pedidos e oportunidades são ligados aos contatos')
on conflict do nothing;

-- Origens novas no extrato dos Créditos de IA
alter table public.ai_ledger drop constraint if exists ai_ledger_origin_check;
alter table public.ai_ledger add constraint ai_ledger_origin_check
  check (origin is null or origin in ('atendimento', 'teste', 'verificacao', 'vendas', 'inteligencia', 'melhoria', 'validacao'));

-- Data desde quando os eventos internos (concluído, reaberto, transferência, etapa do CRM) são registrados
create table public.intel_platform (
  id boolean primary key default true check (id),
  coleta_desde timestamptz not null default now()
);
insert into public.intel_platform default values;
alter table public.intel_platform enable row level security;
revoke all on public.intel_platform from authenticated, anon;
grant select on public.intel_platform to service_role;

/* ---------- Permissões e limites por empresa ---------- */

create table public.intel_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  permissoes jsonb not null default '{}'::jsonb, -- { consultar: [papéis], conversas, melhorar, aprovar, restaurar, configurar }
  limites jsonb not null default '{}'::jsonb,
  atribuicao jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.intel_settings enable row level security;
revoke all on public.intel_settings from authenticated, anon;
grant select, insert, update on public.intel_settings to service_role;

-- Padrões. O Proprietário sempre tem todas as permissões.
-- atribuicao: carenciaMinutos = pagou antes disso não é oportunidade (Pix pago na hora não é abandono);
-- janelaHoras = pagou até X h depois do último contato da empresa conta como recuperado; conversaoDias = até quando
-- uma compra do mesmo cliente fecha a oportunidade; pixExpiraHoras = Pix sem data de expiração vence depois disso.
create or replace function private.intel_defaults()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'permissoes', jsonb_build_object(
      'consultar', jsonb_build_array('Proprietário', 'Admin', 'Membro'),
      'conversas', jsonb_build_array('Proprietário', 'Admin'),
      'melhorar', jsonb_build_array('Proprietário', 'Admin'),
      'aprovar', jsonb_build_array('Proprietário'),
      'restaurar', jsonb_build_array('Proprietário', 'Admin'),
      'configurar', jsonb_build_array('Proprietário', 'Admin')),
    'limites', jsonb_build_object('consultaMaxCreditos', 60, 'melhoriaMaxCreditos', 3000, 'mensalMaxCreditos', 30000,
      'conversasPorExecucao', 1500, 'casosValidacao', 10),
    'atribuicao', jsonb_build_object('carenciaMinutos', 30, 'janelaHoras', 72, 'conversaoDias', 30, 'pixExpiraHoras', 48));
$$;

create or replace function private.intel_cfg(cid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'permissoes', (d -> 'permissoes') || coalesce(s.permissoes, '{}'::jsonb),
    'limites', (d -> 'limites') || coalesce(s.limites, '{}'::jsonb),
    'atribuicao', (d -> 'atribuicao') || coalesce(s.atribuicao, '{}'::jsonb))
  from (select private.intel_defaults() d) x
  left join public.intel_settings s on s.company_id = cid;
$$;

-- O servidor (chave de serviço) passa; quem está logado precisa ser membro, ter o módulo e o papel na permissão.
create or replace function private.intel_can(cid uuid, perm text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  r text;
begin
  if coalesce((select auth.role()), '') = 'service_role' then return true; end if;
  if cid is null or not private.has_module(cid, 'inteligencia') then return false; end if;
  select m.role into r from public.company_members m where m.company_id = cid and m.user_id = (select auth.uid());
  if r is null then return false; end if;
  if r = 'Proprietário' then return true; end if;
  return coalesce((private.intel_cfg(cid) -> 'permissoes' -> perm) ? r, false);
end;
$$;

create or replace function private.intel_exigir(cid uuid, perm text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.intel_can(cid, perm) then
    raise exception 'Sem permissão no Vórtex Inteligência para esta ação (%).', perm using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.intel_defaults(), private.intel_cfg(uuid), private.intel_can(uuid, text), private.intel_exigir(uuid, text) from public, anon;
grant execute on function private.intel_can(uuid, text) to authenticated;

-- O que eu posso fazer nesta empresa (a tela esconde o que não pode; o banco recusa de qualquer jeito).
create or replace function public.intel_me(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cfg jsonb := private.intel_cfg(p_company);
begin
  if not private.is_member(p_company) then raise exception 'Empresa não encontrada.'; end if;
  return jsonb_build_object(
    'modulo', private.has_module(p_company, 'inteligencia'),
    'agentes', private.has_module(p_company, 'agentes'),
    'papel', (select m.role from public.company_members m where m.company_id = p_company and m.user_id = (select auth.uid())),
    'pode', jsonb_build_object(
      'consultar', private.intel_can(p_company, 'consultar'), 'conversas', private.intel_can(p_company, 'conversas'),
      'melhorar', private.intel_can(p_company, 'melhorar'), 'aprovar', private.intel_can(p_company, 'aprovar'),
      'restaurar', private.intel_can(p_company, 'restaurar'), 'configurar', private.intel_can(p_company, 'configurar')),
    'config', cfg,
    'coletaDesde', (select coleta_desde from public.intel_platform where id));
end;
$$;

-- Salvar permissões, limites e regras de atribuição (só valores conhecidos e dentro de faixas seguras).
create or replace function public.intel_settings_save(p_company uuid, p_permissoes jsonb, p_limites jsonb, p_atribuicao jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  perms jsonb := '{}'::jsonb;
  lim jsonb := '{}'::jsonb;
  atr jsonb := '{}'::jsonb;
  k text;
  faixa record;
begin
  perform private.intel_exigir(p_company, 'configurar');
  foreach k in array array['consultar', 'conversas', 'melhorar', 'aprovar', 'restaurar', 'configurar'] loop
    if p_permissoes ? k and jsonb_typeof(p_permissoes -> k) = 'array' then
      perms := perms || jsonb_build_object(k, (
        select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from jsonb_array_elements_text(p_permissoes -> k) v
        where v in ('Proprietário', 'Admin', 'Membro')) || '["Proprietário"]'::jsonb);
    end if;
  end loop;
  for faixa in select * from (values
    ('consultaMaxCreditos', 1, 5000), ('melhoriaMaxCreditos', 10, 200000), ('mensalMaxCreditos', 10, 5000000),
    ('conversasPorExecucao', 20, 20000), ('casosValidacao', 3, 30)) as t(chave, minimo, maximo) loop
    if p_limites ? faixa.chave then
      lim := lim || jsonb_build_object(faixa.chave, least(greatest((p_limites ->> faixa.chave)::numeric, faixa.minimo), faixa.maximo));
    end if;
  end loop;
  for faixa in select * from (values
    ('carenciaMinutos', 0, 1440), ('janelaHoras', 1, 720), ('conversaoDias', 1, 90), ('pixExpiraHoras', 1, 720)) as t(chave, minimo, maximo) loop
    if p_atribuicao ? faixa.chave then
      atr := atr || jsonb_build_object(faixa.chave, least(greatest((p_atribuicao ->> faixa.chave)::numeric, faixa.minimo), faixa.maximo));
    end if;
  end loop;
  insert into public.intel_settings (company_id, permissoes, limites, atribuicao, updated_by)
  values (p_company, perms, lim, atr, (select auth.uid()))
  on conflict (company_id) do update set permissoes = public.intel_settings.permissoes || excluded.permissoes,
    limites = public.intel_settings.limites || excluded.limites, atribuicao = public.intel_settings.atribuicao || excluded.atribuicao,
    updated_at = now(), updated_by = excluded.updated_by;
  return private.intel_cfg(p_company);
end;
$$;

-- Configuração para o servidor (limites e regras), sem usuário logado
create or replace function public.intel_cfg_servidor(p_company uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  select private.intel_cfg(p_company);
$$;
revoke all on function public.intel_cfg_servidor(uuid) from public, anon, authenticated;
grant execute on function public.intel_cfg_servidor(uuid), private.intel_cfg(uuid), private.intel_defaults() to service_role;

revoke all on function public.intel_me(uuid), public.intel_settings_save(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.intel_me(uuid), public.intel_settings_save(uuid, jsonb, jsonb, jsonb) to authenticated;

/* ---------- 2. Coleta: pedidos, tentativas e eventos ---------- */

-- Pedido = uma compra (ou um carrinho abandonado) numa plataforma. Contato ≠ atendimento ≠ pedido ≠ tentativa:
-- o mesmo contato pode ter vários pedidos, e o mesmo pedido várias tentativas (cartão recusado, Pix novo...).
create table public.intel_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  source text not null,                       -- kiwify | vortexpay | hotmart | generico
  kind text not null default 'pedido' check (kind in ('pedido', 'carrinho')),
  external_id text not null,                  -- id do pedido (ou do carrinho) na plataforma
  contact_id uuid references public.contacts (id) on delete set null,
  customer_email text not null default '',    -- minúsculo
  customer_phone text not null default '',    -- chave do WhatsApp (private.chave_telefone)
  customer_name text not null default '',
  product_key text not null default '',
  product_name text not null default '',
  status text not null default 'pendente'
    check (status in ('abandonado', 'pendente', 'expirado', 'recusado', 'cancelado', 'pago', 'reembolsado', 'chargeback')),
  status_rank int not null default 0,
  status_at timestamptz not null,
  method text not null default '',            -- pix | cartao | boleto | outro
  amount_cents bigint check (amount_cents is null or amount_cents >= 0), -- null = valor não informado
  currency text not null default 'BRL',
  pix_expires_at timestamptz,
  opened_at timestamptz not null,             -- primeiro acontecimento conhecido
  paid_at timestamptz,
  refunded_at timestamptz,
  last_event_at timestamptz not null,
  events int not null default 0,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, source, kind, external_id)
);
create index intel_orders_opened_idx on public.intel_orders (company_id, opened_at);
create index intel_orders_paid_idx on public.intel_orders (company_id, paid_at) where paid_at is not null;
create index intel_orders_refund_idx on public.intel_orders (company_id, refunded_at) where refunded_at is not null;
create index intel_orders_contact_idx on public.intel_orders (contact_id);
create index intel_orders_email_idx on public.intel_orders (company_id, customer_email) where customer_email <> '';
create index intel_orders_phone_idx on public.intel_orders (company_id, customer_phone) where customer_phone <> '';
create trigger touch before update on public.intel_orders for each row execute function private.touch_updated_at();

create table public.intel_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  order_id uuid not null references public.intel_orders (id) on delete cascade,
  attempt_key text not null,
  method text not null default '',
  status text not null,
  status_rank int not null default 0,
  amount_cents bigint,
  occurred_at timestamptz not null,
  reason text not null default '',
  unique (order_id, attempt_key)
);
create index on public.intel_payment_attempts (company_id, occurred_at);

-- Tudo que aconteceu (webhooks e eventos internos). dedupe_key barra repetição.
create table public.intel_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  source text not null default 'interno',
  dedupe_key text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  contact_id uuid references public.contacts (id) on delete set null,
  chat_id uuid references public.chats (id) on delete set null,
  order_id uuid references public.intel_orders (id) on delete set null,
  agent_id uuid references public.agents (id) on delete set null,
  amount_cents bigint,
  data jsonb not null default '{}'::jsonb,
  unique (company_id, dedupe_key)
);
create index intel_events_kind_idx on public.intel_events (company_id, kind, occurred_at);
create index intel_events_contact_idx on public.intel_events (contact_id);
create index intel_events_chat_idx on public.intel_events (chat_id);

-- Consultas por período nas mensagens e por e-mail nos contatos
create index if not exists messages_company_at_idx on public.messages (company_id, at);
create index if not exists contacts_company_email_idx on public.contacts (company_id, lower(email)) where email <> '';

alter table public.intel_orders enable row level security;
alter table public.intel_payment_attempts enable row level security;
alter table public.intel_events enable row level security;
revoke all on public.intel_orders, public.intel_payment_attempts, public.intel_events from authenticated, anon;
grant select, insert, update, delete on public.intel_orders, public.intel_payment_attempts, public.intel_events to service_role;

-- Força de cada status: o pedido só muda para um status de força maior (ou igual e mais recente).
create or replace function private.intel_rank(s text)
returns int language sql immutable set search_path = '' as $$
  select case s when 'abandonado' then 1 when 'pendente' then 10 when 'expirado' then 20 when 'cancelado' then 20
    when 'recusado' then 20 when 'pago' then 40 when 'reembolsado' then 50 when 'chargeback' then 60 else 0 end;
$$;

-- Contato pelo WhatsApp (com ou sem o 9) ou pelo e-mail.
create or replace function private.intel_find_contact(cid uuid, p_phone text, p_email text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  k text := private.chave_telefone(p_phone);
  v text[];
  found uuid;
begin
  if k is not null then
    v := array[k, substr(k, 3)];
    if length(k) = 13 and substr(k, 5, 1) = '9' then v := v || (substr(k, 1, 4) || substr(k, 6)) || substr(substr(k, 1, 4) || substr(k, 6), 3); end if;
    select c.id into found from public.contacts c where c.company_id = cid and c.phone_digits = any (v) order by c.created_at limit 1;
    if found is not null then return found; end if;
  end if;
  if coalesce(p_email, '') ~ '@' then
    select c.id into found from public.contacts c where c.company_id = cid and lower(c.email) = lower(trim(p_email)) and c.email <> '' order by c.created_at limit 1;
  end if;
  return found;
end;
$$;

-- Registra um evento de pagamento já normalizado (functions/_shared/inteligencia/pagamentos.ts). Só o servidor chama.
-- p: { fonte, evento, dedupe, pedido, tipo, status, metodo, valorCentavos, moeda, quando, pixExpiraEm, tentativa,
--      motivo, cliente: {email, telefone, nome}, produto: {id, nome}, contatoId }
-- Repetido (mesma dedupe) não muda nada. Fora de ordem: o status só sobe de força; datas guardam o primeiro pagamento,
-- o primeiro reembolso e o primeiro acontecimento. O valor do pedido vem da aprovação quando houver.
create or replace function public.intel_ingest(p_company uuid, p jsonb)
returns jsonb language plpgsql security invoker set search_path = public, private as $$
declare
  ev_id bigint;
  quando timestamptz := coalesce(nullif(p ->> 'quando', '')::timestamptz, now());
  st text := p ->> 'status';
  rk int := private.intel_rank(p ->> 'status');
  evento text := p ->> 'evento';
  valor bigint := nullif(p ->> 'valorCentavos', '')::bigint;
  email text := lower(trim(coalesce(p #>> '{cliente,email}', '')));
  fone text := coalesce(private.chave_telefone(p #>> '{cliente,telefone}'), '');
  contato uuid;
  o public.intel_orders;
begin
  if coalesce(p ->> 'dedupe', '') = '' or coalesce(p ->> 'pedido', '') = '' or rk = 0 then
    return jsonb_build_object('ok', false, 'motivo', 'evento incompleto');
  end if;
  insert into public.intel_events (company_id, kind, source, dedupe_key, occurred_at, amount_cents, data)
  values (p_company, evento, coalesce(p ->> 'fonte', 'generico'), p ->> 'dedupe', quando, valor,
    jsonb_strip_nulls(jsonb_build_object('pedido', p ->> 'pedido', 'status', st, 'metodo', p ->> 'metodo', 'produto', p #>> '{produto,nome}', 'motivo', p ->> 'motivo')))
  on conflict (company_id, dedupe_key) do nothing
  returning id into ev_id;
  if ev_id is null then return jsonb_build_object('ok', true, 'repetido', true); end if;

  contato := coalesce(nullif(p ->> 'contatoId', '')::uuid, private.intel_find_contact(p_company, fone, email));

  insert into public.intel_orders as x (company_id, source, kind, external_id, contact_id, customer_email, customer_phone, customer_name,
    product_key, product_name, status, status_rank, status_at, method, amount_cents, currency, pix_expires_at, opened_at, paid_at, refunded_at,
    last_event_at, events)
  values (p_company, coalesce(p ->> 'fonte', 'generico'), coalesce(nullif(p ->> 'tipo', ''), 'pedido'), p ->> 'pedido', contato, email, fone,
    left(coalesce(p #>> '{cliente,nome}', ''), 120), left(coalesce(p #>> '{produto,id}', p #>> '{produto,nome}', ''), 120),
    left(coalesce(p #>> '{produto,nome}', ''), 160), st, rk, quando, coalesce(p ->> 'metodo', ''), valor, coalesce(nullif(p ->> 'moeda', ''), 'BRL'),
    nullif(p ->> 'pixExpiraEm', '')::timestamptz, quando,
    case when st in ('pago', 'reembolsado', 'chargeback') and evento = 'compra_aprovada' then quando end,
    case when st in ('reembolsado', 'chargeback') then quando end, quando, 1)
  on conflict (company_id, source, kind, external_id) do update set
    status = case when excluded.status_rank > x.status_rank or (excluded.status_rank = x.status_rank and excluded.status_at >= x.status_at) then excluded.status else x.status end,
    status_rank = greatest(x.status_rank, excluded.status_rank),
    status_at = case when excluded.status_rank > x.status_rank or (excluded.status_rank = x.status_rank and excluded.status_at >= x.status_at) then excluded.status_at else x.status_at end,
    contact_id = coalesce(x.contact_id, excluded.contact_id),
    customer_email = coalesce(nullif(x.customer_email, ''), excluded.customer_email),
    customer_phone = coalesce(nullif(x.customer_phone, ''), excluded.customer_phone),
    customer_name = coalesce(nullif(x.customer_name, ''), excluded.customer_name),
    product_key = coalesce(nullif(x.product_key, ''), excluded.product_key),
    product_name = coalesce(nullif(x.product_name, ''), excluded.product_name),
    method = case when evento = 'compra_aprovada' and excluded.method <> '' then excluded.method else coalesce(nullif(x.method, ''), excluded.method) end,
    amount_cents = case when evento = 'compra_aprovada' and excluded.amount_cents is not null then excluded.amount_cents else coalesce(x.amount_cents, excluded.amount_cents) end,
    pix_expires_at = coalesce(excluded.pix_expires_at, x.pix_expires_at),
    opened_at = least(x.opened_at, excluded.opened_at),
    paid_at = case when evento = 'compra_aprovada' then least(coalesce(x.paid_at, excluded.status_at), excluded.status_at) else x.paid_at end,
    refunded_at = case when excluded.status in ('reembolsado', 'chargeback') then least(coalesce(x.refunded_at, excluded.status_at), excluded.status_at) else x.refunded_at end,
    last_event_at = greatest(x.last_event_at, excluded.last_event_at),
    events = x.events + 1
  returning * into o;

  update public.intel_events set order_id = o.id, contact_id = o.contact_id where id = ev_id;

  if coalesce(p ->> 'tentativa', '') <> '' then
    insert into public.intel_payment_attempts as a (company_id, order_id, attempt_key, method, status, status_rank, amount_cents, occurred_at, reason)
    values (p_company, o.id, p ->> 'tentativa', coalesce(p ->> 'metodo', ''), st, rk, valor, quando, left(coalesce(p ->> 'motivo', ''), 200))
    on conflict (order_id, attempt_key) do update set
      status = case when excluded.status_rank >= a.status_rank then excluded.status else a.status end,
      status_rank = greatest(a.status_rank, excluded.status_rank),
      amount_cents = coalesce(excluded.amount_cents, a.amount_cents),
      occurred_at = least(a.occurred_at, excluded.occurred_at);
  end if;
  return jsonb_build_object('ok', true, 'repetido', false, 'pedido', o.id, 'status', o.status, 'contato', o.contact_id);
end;
$$;
revoke all on function public.intel_ingest(uuid, jsonb), private.intel_rank(text), private.intel_find_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.intel_ingest(uuid, jsonb), private.intel_find_contact(uuid, text, text) to service_role;
grant usage on schema private to service_role;
grant execute on function private.intel_rank(text), private.chave_telefone(text) to service_role;

-- Eventos internos: um erro aqui nunca impede a gravação original.
create or replace function private.intel_chat_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  t text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, data)
      values (new.company_id, 'conversa_iniciada', 'chat:' || new.id || ':inicio', coalesce(new.created_at, now()), new.contact_id, new.id,
        jsonb_build_object('conexao', new.connection_id))
      on conflict do nothing;
      return null;
    end if;
    if new.status is distinct from old.status and new.status = 'resolved' then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, agent_id)
      values (new.company_id, 'atendimento_concluido', 'chat:' || new.id || ':concluido:' || t, now(), new.contact_id, new.id, new.ai_agent_id)
      on conflict do nothing;
    elsif new.status is distinct from old.status and old.status = 'resolved' then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, agent_id)
      values (new.company_id, 'atendimento_reaberto', 'chat:' || new.id || ':reaberto:' || t, now(), new.contact_id, new.id, new.ai_agent_id)
      on conflict do nothing;
    end if;
    if (new.ai_state ? 'precisaHumano') and not (coalesce(old.ai_state, '{}'::jsonb) ? 'precisaHumano') then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, agent_id, data)
      values (new.company_id, 'ia_nao_resolveu', 'chat:' || new.id || ':naoresolveu:' || t, now(), new.contact_id, new.id, new.ai_agent_id,
        jsonb_build_object('motivo', left(new.ai_state #>> '{precisaHumano,motivo}', 300)))
      on conflict do nothing;
    end if;
    if new.ai_paused and new.ai_pause_reason = 'transferido' and not (old.ai_paused and old.ai_pause_reason = 'transferido') then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, agent_id)
      values (new.company_id, 'transferencia_humana', 'chat:' || new.id || ':transferencia:' || t, now(), new.contact_id, new.id, new.ai_agent_id)
      on conflict do nothing;
    elsif new.ai_paused and not old.ai_paused and new.ai_pause_reason in ('humano', 'manual') then
      insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, agent_id)
      values (new.company_id, 'humano_assumiu', 'chat:' || new.id || ':assumiu:' || t, now(), new.contact_id, new.id, new.ai_agent_id)
      on conflict do nothing;
    end if;
  exception when others then
    raise warning 'intel_chat_events: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function private.intel_card_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cols jsonb;
begin
  begin
    if tg_op = 'UPDATE' and new.column_id is not distinct from old.column_id then return null; end if;
    select k.columns into cols from public.kanbans k where k.id = new.kanban_id;
    insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, amount_cents, data)
    values (new.company_id, case when tg_op = 'INSERT' then 'crm_negocio_criado' else 'crm_etapa' end,
      'card:' || new.id || ':' || new.column_id || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), now(), new.contact_id,
      case when new.value > 0 then round(new.value * 100)::bigint end,
      jsonb_strip_nulls(jsonb_build_object('quadro', new.kanban_id, 'para', new.column_id,
        'paraNome', (select c ->> 'name' from jsonb_array_elements(coalesce(cols, '[]'::jsonb)) c where c ->> 'id' = new.column_id limit 1),
        'de', case when tg_op = 'UPDATE' then old.column_id end,
        'deNome', case when tg_op = 'UPDATE' then (select c ->> 'name' from jsonb_array_elements(coalesce(cols, '[]'::jsonb)) c where c ->> 'id' = old.column_id limit 1) end)))
    on conflict do nothing;
  exception when others then
    raise warning 'intel_card_events: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function private.intel_contact_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, data)
    values (new.company_id, 'lead_entrou', 'contato:' || new.id, coalesce(new.created_at, now()), new.id, jsonb_build_object('origem', new.origin))
    on conflict do nothing;
  exception when others then
    raise warning 'intel_contact_events: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.intel_chat_events(), private.intel_card_events(), private.intel_contact_events() from public, anon, authenticated;

create trigger intel_chat_events after insert or update on public.chats for each row execute function private.intel_chat_events();
create trigger intel_card_events after insert or update of column_id on public.kanban_cards for each row execute function private.intel_card_events();
create trigger intel_contact_events after insert on public.contacts for each row execute function private.intel_contact_events();

-- Histórico que já existe: entrada de leads e conversas iniciadas (as mudanças de status antigas não têm data).
insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, data)
select c.company_id, 'lead_entrou', 'contato:' || c.id, c.created_at, c.id, jsonb_build_object('origem', c.origin) from public.contacts c
on conflict do nothing;
insert into public.intel_events (company_id, kind, dedupe_key, occurred_at, contact_id, chat_id, data)
select c.company_id, 'conversa_iniciada', 'chat:' || c.id || ':inicio', c.created_at, c.contact_id, c.id, jsonb_build_object('conexao', c.connection_id) from public.chats c
on conflict do nothing;

-- Contatos repetidos: os pedidos e eventos vão junto para o contato que fica (resto igual à 0029).
create or replace function private.unir_contatos(p_fica uuid, p_sai uuid) returns void language plpgsql security definer set search_path = '' as $$
declare
  f public.contacts;
  s public.contacts;
begin
  if p_fica = p_sai then return; end if;
  select * into f from public.contacts where id = p_fica;
  select * into s from public.contacts where id = p_sai;
  if f.id is null or s.id is null or f.company_id <> s.company_id then return; end if;

  update public.chats set contact_id = p_fica where contact_id = p_sai;
  update public.kanban_cards set contact_id = p_fica where contact_id = p_sai;
  update public.flow_runs set contact_id = p_fica where contact_id = p_sai;
  update public.flow_jobs set contact_id = p_fica where contact_id = p_sai;
  update public.funil_eventos set contact_id = p_fica where contact_id = p_sai;
  update public.sales set contact_id = p_fica where contact_id = p_sai;
  update public.webhook_events set contact_id = p_fica where contact_id = p_sai;
  update public.intel_orders set contact_id = p_fica where contact_id = p_sai;
  update public.intel_events set contact_id = p_fica where contact_id = p_sai;
  -- o id do Instagram é único por empresa: sai do repetido antes de ir para o que fica
  update public.contacts set instagram_id = null where id = p_sai;

  update public.contacts set
    name = case when (coalesce(f.name, '') = '' or f.name ~ '^[@+]' ) and coalesce(s.name, '') !~ '^[@+]' and coalesce(s.name, '') <> '' then s.name else f.name end,
    phone = case when coalesce(regexp_replace(f.phone, '\D', '', 'g'), '') = '' then s.phone else f.phone end,
    email = case when coalesce(f.email, '') = '' then coalesce(s.email, '') else f.email end,
    instagram_id = coalesce(f.instagram_id, s.instagram_id),
    instagram_username = coalesce(f.instagram_username, s.instagram_username),
    instagram_profile = coalesce(f.instagram_profile, s.instagram_profile),
    avatar_url = coalesce(f.avatar_url, s.avatar_url),
    avatar_at = coalesce(f.avatar_at, s.avatar_at),
    connection_id = coalesce(f.connection_id, s.connection_id),
    labels = (select coalesce(array_agg(distinct l), '{}') from unnest(coalesce(f.labels, '{}') || coalesce(s.labels, '{}')) l),
    fields = coalesce(s.fields, '{}'::jsonb) || coalesce(f.fields, '{}'::jsonb),
    status = case when f.status = 'ativo' or s.status = 'ativo' then 'ativo' else f.status end
  where id = p_fica;

  delete from public.contacts where id = p_sai;
end;
$$;
revoke all on function private.unir_contatos(uuid, uuid) from public, anon, authenticated;

/* ---------- 3. Assistente: conversas, consumo ---------- */

create table public.intel_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Nova conversa',
  context jsonb not null default '{}'::jsonb, -- filtros em uso (período, produto, agente) e a última consulta
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.intel_conversations (company_id, user_id, updated_at desc);

create table public.intel_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.intel_conversations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  blocks jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  tools jsonb not null default '[]'::jsonb, -- consultas feitas (auditoria)
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.intel_messages (conversation_id, created_at);

alter table public.intel_conversations enable row level security;
alter table public.intel_messages enable row level security;
create policy "dono lê as próprias conversas" on public.intel_conversations for select to authenticated
  using (user_id = (select auth.uid()) and private.intel_can(company_id, 'consultar'));
create policy "dono apaga as próprias conversas" on public.intel_conversations for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id));
create policy "dono lê as próprias mensagens" on public.intel_messages for select to authenticated
  using (user_id = (select auth.uid()) and private.intel_can(company_id, 'consultar'));
revoke all on public.intel_conversations, public.intel_messages from authenticated, anon;
grant select, delete on public.intel_conversations to authenticated;
grant select on public.intel_messages to authenticated;
grant select, insert, update, delete on public.intel_conversations, public.intel_messages to service_role;

-- Uso de IA do módulo (inclusive com a chave própria da empresa). Os créditos ficam no ai_ledger, sem duplicar.
create table public.intel_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  origem text not null check (origem in ('inteligencia', 'melhoria', 'validacao')),
  ref text not null default '', -- conversa:<id> ou job:<id>
  agent_id uuid,
  provider text not null default '',
  model text not null default '',
  source text not null default 'empresa' check (source in ('empresa', 'plataforma')),
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(14, 8) not null default 0,
  ms int not null default 0,
  created_at timestamptz not null default now()
);
create index on public.intel_usage (company_id, created_at);
create index on public.intel_usage (ref);
alter table public.intel_usage enable row level security;
revoke all on public.intel_usage from authenticated, anon;
grant select, insert on public.intel_usage to service_role;

/* ---------- 4. Evolução dos agentes ---------- */

create table public.intel_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  status text not null default 'na_fila'
    check (status in ('na_fila', 'em_andamento', 'concluido', 'sem_melhoria', 'pendente_revisao', 'pausado', 'falhou', 'cancelado')),
  etapa text not null default 'preparar' check (etapa in ('preparar', 'analisar', 'consolidar', 'propor', 'validar', 'aplicar', 'fim')),
  progresso jsonb not null default '{}'::jsonb,  -- { feitos, total, mensagem }
  cursor jsonb not null default '{}'::jsonb,     -- onde parou (retomada)
  cobertura jsonb not null default '{}'::jsonb,  -- conversas no histórico, analisadas, reaproveitadas, parcial
  estimativa jsonb not null default '{}'::jsonb,
  orcamento_usd numeric(14, 8) not null check (orcamento_usd > 0),
  gasto_usd numeric(14, 8) not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tentativas int not null default 0,
  erro text,
  motivo_pausa text,
  base_rev int not null default 0, -- intelRev do agente quando começou (o agente mudou no meio = não sobrescreve)
  versao_antes uuid,
  versao_publicada uuid,
  relatorio jsonb not null default '{}'::jsonb,
  started_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
-- Uma execução por agente de cada vez
create unique index intel_jobs_um_ativo on public.intel_agent_jobs (agent_id) where status in ('na_fila', 'em_andamento');
create index intel_jobs_fila_idx on public.intel_agent_jobs (created_at) where status in ('na_fila', 'em_andamento');
create index on public.intel_agent_jobs (company_id, agent_id, created_at desc);
create trigger touch before update on public.intel_agent_jobs for each row execute function private.touch_updated_at();

-- Análise de cada conversa (reaproveitada: só o que mudou depois de "ate" é analisado de novo)
create table public.intel_chat_digests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  ate timestamptz not null,                 -- última mensagem analisada
  n_msgs int not null default 0,
  reservado boolean not null default false, -- conversa separada para validação (não entra nas mudanças)
  versao int not null,                      -- versão do roteiro de análise
  resumo jsonb not null default '{}'::jsonb,
  job_id uuid references public.intel_agent_jobs (id) on delete set null,
  analisado_em timestamptz not null default now(),
  unique (agent_id, chat_id)
);
create index on public.intel_chat_digests (company_id, agent_id);

-- Base consolidada de aprendizados (frequência = conversas distintas; repetir a análise não duplica)
create table public.intel_learnings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  chave text not null,
  tipo text not null check (tipo in ('duvida_recorrente', 'resposta_incorreta', 'resposta_incompleta', 'correcao_humana', 'objecao',
    'info_ausente', 'resposta_longa', 'repetitiva', 'pergunta_desnecessaria', 'transferencia_evitavel', 'transferencia_necessaria',
    'instrucao_conflitante', 'uso_de_contexto', 'tom')),
  titulo text not null,
  detalhe text not null default '',
  natureza text not null default 'hipotese' check (natureza in ('confirmado', 'hipotese', 'excecao')),
  area_protegida text,
  chats uuid[] not null default '{}',
  evidencias jsonb not null default '[]'::jsonb,
  estado text not null default 'aberto' check (estado in ('aberto', 'aplicado', 'pendente', 'descartado')),
  primeira_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  job_id uuid references public.intel_agent_jobs (id) on delete set null,
  versao_aplicada uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, chave)
);
create index on public.intel_learnings (company_id, agent_id, estado);
create trigger touch before update on public.intel_learnings for each row execute function private.touch_updated_at();

-- Versões do agente: cópia dos campos que o processo pode mudar (e o extra inteiro, para consulta)
create table public.intel_agent_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  numero int not null,
  origem text not null check (origem in ('copia', 'melhoria', 'aprovacao', 'restauracao')),
  conteudo jsonb not null,
  extra_completo jsonb not null,
  resumo text not null default '',
  job_id uuid references public.intel_agent_jobs (id) on delete set null,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  publicada_em timestamptz,
  unique (agent_id, numero)
);

create table public.intel_agent_changes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  job_id uuid references public.intel_agent_jobs (id) on delete cascade,
  versao_id uuid references public.intel_agent_versions (id) on delete set null,
  campo text not null,                      -- prompt | examples | rules | tone | does | audience | knowledge | (protegido: settings, skills...)
  operacao text not null check (operacao in ('editar', 'adicionar', 'remover', 'mesclar', 'proposta')),
  alvo text,                                -- id do conhecimento (ou ids separados por vírgula ao mesclar)
  antes text,
  depois text,
  motivo text not null default '',
  aprendizados text[] not null default '{}',
  evidencias jsonb not null default '[]'::jsonb,
  protegida boolean not null default false,
  area text,
  estado text not null check (estado in ('aplicada', 'pendente_aprovacao', 'aprovada', 'rejeitada', 'bloqueada', 'revisao')),
  bloqueio text,
  decidido_por uuid,
  decidido_em timestamptz,
  created_at timestamptz not null default now()
);
create index on public.intel_agent_changes (company_id, agent_id, created_at desc);
create index on public.intel_agent_changes (job_id);

-- Casos de validação (persistem: uma falha antiga continua sendo testada nas próximas execuções)
create table public.intel_validation_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  chave text not null,
  tipo text not null check (tipo in ('falha_anterior', 'representativo', 'regra_essencial')),
  chat_id uuid references public.chats (id) on delete set null,
  contexto jsonb not null,  -- [{ from: 'user'|'bot', text }]
  criterio text not null,
  ativo boolean not null default true,
  job_id uuid references public.intel_agent_jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agent_id, chave)
);

create table public.intel_validation_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid not null references public.intel_agent_jobs (id) on delete cascade,
  case_id uuid references public.intel_validation_cases (id) on delete set null,
  caso jsonb not null,
  atual jsonb not null default '{}'::jsonb,     -- { resposta, transferiu, tokens, ms }
  candidata jsonb not null default '{}'::jsonb,
  avaliacao jsonb not null default '{}'::jsonb, -- notas de 1 a 5 e regras
  veredito text not null default '',            -- melhor | igual | pior | erro
  created_at timestamptz not null default now(),
  unique (job_id, case_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['intel_agent_jobs', 'intel_chat_digests', 'intel_learnings', 'intel_agent_versions', 'intel_agent_changes',
    'intel_validation_cases', 'intel_validation_results'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from authenticated, anon', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- Proteção contra sobrescrever: o editor do agente aberto antes de uma melhoria guarda o intelRev antigo; ao salvar,
-- o banco recusa em vez de apagar a versão nova.
create or replace function private.agents_intel_rev_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') = 'authenticated'
     and coalesce((old.extra ->> 'intelRev')::int, 0) > coalesce((new.extra ->> 'intelRev')::int, 0) then
    raise exception 'Este agente foi atualizado pelo Vórtex Inteligência enquanto a tela estava aberta. Recarregue a página para ver a versão nova antes de salvar.'
      using errcode = '40001';
  end if;
  return new;
end;
$$;
revoke all on function private.agents_intel_rev_guard() from public, anon, authenticated;
create trigger agents_intel_rev_guard before update on public.agents for each row execute function private.agents_intel_rev_guard();

-- Campos que o "Melhorar agente" pode mudar sozinho (o resto é revisado, mas só vira proposta)
create or replace function private.intel_conteudo(x jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('prompt', coalesce(x ->> 'prompt', ''), 'examples', coalesce(x ->> 'examples', ''), 'rules', coalesce(x ->> 'rules', ''),
    'tone', coalesce(x ->> 'tone', ''), 'does', coalesce(x ->> 'does', ''), 'audience', coalesce(x ->> 'audience', ''),
    'knowledge', case when jsonb_typeof(x -> 'knowledge') = 'array' then x -> 'knowledge' else '[]'::jsonb end);
$$;

-- Grava uma versão do agente (número sequencial por agente)
create or replace function private.intel_save_version(p_agent public.agents, p_origem text, p_resumo text, p_job uuid, p_user uuid, p_publicada boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  vid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('intel_versao:' || p_agent.id, 0));
  insert into public.intel_agent_versions (company_id, agent_id, numero, origem, conteudo, extra_completo, resumo, job_id, criado_por, publicada_em)
  values (p_agent.company_id, p_agent.id,
    coalesce((select max(v.numero) from public.intel_agent_versions v where v.agent_id = p_agent.id), 0) + 1,
    p_origem, private.intel_conteudo(p_agent.extra), p_agent.extra, left(coalesce(p_resumo, ''), 500), p_job, p_user,
    case when p_publicada then now() end)
  returning id into vid;
  return vid;
end;
$$;
revoke all on function private.intel_conteudo(jsonb), private.intel_save_version(public.agents, text, text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function private.intel_conteudo(jsonb), private.intel_save_version(public.agents, text, text, uuid, uuid, boolean) to service_role;

-- Publica a versão candidata de uma execução (só o servidor). Atômico: guarda a versão atual, aplica os campos
-- permitidos e grava a nova versão. Se o agente mudou desde o começo da execução, não aplica (conflito).
create or replace function public.intel_apply(p_job uuid, p_patch jsonb, p_resumo text)
returns jsonb language plpgsql security invoker set search_path = public, private as $$
declare
  j public.intel_agent_jobs;
  a public.agents;
  antes uuid;
  depois uuid;
  campos jsonb := '{}'::jsonb;
  k text;
begin
  select * into j from public.intel_agent_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'execução não encontrada'); end if;
  select * into a from public.agents where id = j.agent_id and company_id = j.company_id for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'agente não encontrado'); end if;
  if coalesce((a.extra ->> 'intelRev')::int, 0) <> j.base_rev then
    return jsonb_build_object('ok', false, 'motivo', 'conflito', 'detalhe', 'o agente foi alterado durante a análise');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k in ('prompt', 'examples', 'rules', 'tone', 'does', 'audience') and jsonb_typeof(p_patch -> k) = 'string' then
      campos := campos || jsonb_build_object(k, p_patch -> k);
    elsif k = 'knowledge' and jsonb_typeof(p_patch -> k) = 'array' then
      campos := campos || jsonb_build_object(k, p_patch -> k);
    end if;
  end loop;
  if campos = '{}'::jsonb then return jsonb_build_object('ok', false, 'motivo', 'nada para aplicar'); end if;
  antes := private.intel_save_version(a, 'copia', 'Antes da melhoria', j.id, j.started_by, false);
  update public.agents set extra = extra || campos || jsonb_build_object('intelRev', coalesce((extra ->> 'intelRev')::int, 0) + 1), updated_at = now()
  where id = a.id returning * into a;
  depois := private.intel_save_version(a, 'melhoria', p_resumo, j.id, j.started_by, true);
  update public.intel_agent_jobs set versao_antes = antes, versao_publicada = depois where id = j.id;
  return jsonb_build_object('ok', true, 'antes', antes, 'depois', depois, 'rev', (a.extra ->> 'intelRev')::int);
end;
$$;
revoke all on function public.intel_apply(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.intel_apply(uuid, jsonb, text) to service_role;

-- Conversas que o agente atendeu (vínculo explícito: respondeu nela, tem execução registrada nela ou foi posto nela
-- por um fluxo). Conversas do mesmo número sem participação do agente ficam de fora.
create or replace function public.intel_chats_do_agente(p_company uuid, p_agent uuid)
returns table (chat_id uuid, ultima timestamptz, mensagens int) language sql stable security invoker set search_path = public as $$
  with ids as (
    select m.chat_id from public.messages m where m.company_id = p_company and m.sender = 'bot' and m.extra ->> 'agentId' = p_agent::text
    union select r.chat_id from public.ai_runs r where r.company_id = p_company and r.agent_id = p_agent and r.chat_id is not null
    union select c.id from public.chats c where c.company_id = p_company and c.ai_agent_id = p_agent
  )
  select i.chat_id, max(m.at), count(*)::int from ids i
  join public.messages m on m.chat_id = i.chat_id and m.company_id = p_company and m.sender <> 'sys'
  group by i.chat_id;
$$;

-- Junta itens na base de aprendizados: a frequência é o conjunto de conversas (a mesma conversa nunca conta duas vezes,
-- nem quando é analisada de novo); evidências até 8 por aprendizado, uma por conversa. Problema já resolvido que volta
-- a aparecer em conversa nova reabre.
create or replace function public.intel_learning_merge(p_company uuid, p_agent uuid, p_job uuid, p_itens jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare
  it jsonb;
  n int := 0;
  novos uuid[];
begin
  for it in select * from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) loop
    novos := array(select (x)::uuid from jsonb_array_elements_text(coalesce(it -> 'chats', '[]'::jsonb)) x);
    insert into public.intel_learnings as l (company_id, agent_id, chave, tipo, titulo, detalhe, natureza, area_protegida, chats, evidencias, job_id)
    values (p_company, p_agent, left(it ->> 'chave', 80), it ->> 'tipo', left(it ->> 'titulo', 200), left(coalesce(it ->> 'detalhe', ''), 600),
      coalesce(nullif(it ->> 'natureza', ''), 'hipotese'), nullif(it ->> 'area', ''), novos,
      coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(coalesce(it -> 'evidencias', '[]'::jsonb)) e limit 8) x), '[]'::jsonb), p_job)
    on conflict (agent_id, chave) do update set
      chats = (select coalesce(array_agg(distinct c), '{}') from unnest(l.chats || excluded.chats) c),
      evidencias = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
        select distinct on (e ->> 'chat') e from jsonb_array_elements(l.evidencias || excluded.evidencias) e order by e ->> 'chat' limit 8) x),
      detalhe = case when excluded.detalhe <> '' then excluded.detalhe else l.detalhe end,
      natureza = case when l.natureza = 'confirmado' or excluded.natureza = 'confirmado' then 'confirmado' else excluded.natureza end,
      area_protegida = coalesce(l.area_protegida, excluded.area_protegida),
      estado = case when l.estado = 'aplicado' and exists (select 1 from unnest(excluded.chats) c where not c = any (l.chats)) then 'aberto' else l.estado end,
      ultima_vez = now(), job_id = p_job;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.intel_chats_do_agente(uuid, uuid), public.intel_learning_merge(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.intel_chats_do_agente(uuid, uuid), public.intel_learning_merge(uuid, uuid, uuid, jsonb) to service_role;

-- Início da execução (pelo usuário logado, pela função inteligencia): confere permissão, módulo de Agentes e trava
-- uma execução por agente (o índice único recusa a segunda).
create or replace function public.intel_job_start(p_company uuid, p_agent uuid, p_orcamento_usd numeric, p_estimativa jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  jid uuid;
begin
  perform private.intel_exigir(p_company, 'melhorar');
  if not private.has_module(p_company, 'agentes') then raise exception 'O módulo Agentes de IA não está liberado para esta empresa.'; end if;
  select * into a from public.agents where id = p_agent and company_id = p_company;
  if not found then raise exception 'Agente não encontrado.'; end if;
  if coalesce(a.extra ->> 'engine', 'padrao') <> 'padrao' then raise exception 'Este agente usa um motor próprio e não é ajustado por aqui.'; end if;
  if coalesce(p_orcamento_usd, 0) <= 0 then raise exception 'Orçamento inválido.'; end if;
  begin
    insert into public.intel_agent_jobs (company_id, agent_id, orcamento_usd, estimativa, base_rev, started_by)
    values (p_company, p_agent, p_orcamento_usd, coalesce(p_estimativa, '{}'::jsonb), coalesce((a.extra ->> 'intelRev')::int, 0), (select auth.uid()))
    returning id into jid;
  exception when unique_violation then
    raise exception 'Já existe uma melhoria em andamento para este agente.' using errcode = '23505';
  end;
  return jid;
end;
$$;

-- Pausadas ou com falha continuam de onde pararam (o cursor e as análises feitas ficam guardados).
create or replace function public.intel_job_resume(p_job uuid, p_orcamento_usd numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  j public.intel_agent_jobs;
  a public.agents;
begin
  select * into j from public.intel_agent_jobs where id = p_job;
  if not found then raise exception 'Execução não encontrada.'; end if;
  perform private.intel_exigir(j.company_id, 'melhorar');
  if j.status not in ('pausado', 'falhou') then raise exception 'Só uma execução pausada ou com falha pode continuar.'; end if;
  select * into a from public.agents where id = j.agent_id;
  begin
    update public.intel_agent_jobs set status = 'na_fila', erro = null, motivo_pausa = null, tentativas = 0, locked_until = null,
      orcamento_usd = orcamento_usd + greatest(coalesce(p_orcamento_usd, 0), 0),
      -- o agente mudou enquanto estava parada: a candidata é refeita sobre a versão atual
      base_rev = coalesce((a.extra ->> 'intelRev')::int, 0),
      etapa = case when base_rev <> coalesce((a.extra ->> 'intelRev')::int, 0) and etapa in ('validar', 'aplicar') then 'propor' else etapa end
    where id = p_job;
  exception when unique_violation then
    raise exception 'Já existe outra melhoria em andamento para este agente.';
  end;
end;
$$;

create or replace function public.intel_job_cancel(p_job uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  j public.intel_agent_jobs;
begin
  select * into j from public.intel_agent_jobs where id = p_job;
  if not found then raise exception 'Execução não encontrada.'; end if;
  perform private.intel_exigir(j.company_id, 'melhorar');
  update public.intel_agent_jobs set status = 'cancelado', finished_at = now(), locked_until = null,
    relatorio = relatorio || jsonb_build_object('cancelada', true)
  where id = p_job and status in ('na_fila', 'em_andamento', 'pausado', 'falhou');
end;
$$;

-- Pega a próxima execução da fila (duas rodadas nunca pegam a mesma). Trava vencida = a rodada morreu: volta para a fila.
create or replace function public.intel_job_claim(p_lock_seconds int)
returns setof public.intel_agent_jobs language plpgsql security invoker set search_path = public as $$
begin
  return query
    update public.intel_agent_jobs j set status = 'em_andamento', locked_until = now() + make_interval(secs => p_lock_seconds),
      heartbeat_at = now(), started_at = coalesce(j.started_at, now())
     where j.id = (select x.id from public.intel_agent_jobs x
                    where x.status in ('na_fila', 'em_andamento') and (x.locked_until is null or x.locked_until < now())
                    order by x.created_at limit 1 for update skip locked)
    returning j.*;
end;
$$;
revoke all on function public.intel_job_claim(int) from public, anon, authenticated;
grant execute on function public.intel_job_claim(int) to service_role;

-- Aplica uma mudança protegida aprovada (ou rejeita). Cria uma versão nova; se o campo mudou desde a proposta, recusa.
create or replace function public.intel_change_decide(p_change uuid, p_aprovar boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.intel_agent_changes;
  a public.agents;
  kb jsonb;
  novo jsonb;
  ids text[];
  vid uuid;
begin
  select * into c from public.intel_agent_changes where id = p_change for update;
  if not found then raise exception 'Alteração não encontrada.'; end if;
  perform private.intel_exigir(c.company_id, 'aprovar');
  if c.estado not in ('pendente_aprovacao', 'revisao', 'bloqueada') then raise exception 'Esta alteração já foi decidida.'; end if;
  if not p_aprovar then
    update public.intel_agent_changes set estado = 'rejeitada', decidido_por = (select auth.uid()), decidido_em = now() where id = c.id;
    return jsonb_build_object('ok', true, 'estado', 'rejeitada');
  end if;
  if c.operacao = 'proposta' then
    -- área que só o cliente altera (preço, garantia, integração...): aprovar só registra a decisão
    update public.intel_agent_changes set estado = 'aprovada', decidido_por = (select auth.uid()), decidido_em = now() where id = c.id;
    return jsonb_build_object('ok', true, 'estado', 'aprovada', 'manual', true);
  end if;
  select * into a from public.agents where id = c.agent_id and company_id = c.company_id for update;
  if not found then raise exception 'Agente não encontrado.'; end if;
  perform private.intel_save_version(a, 'copia', 'Antes de aprovar uma alteração', c.job_id, (select auth.uid()), false);
  if c.campo in ('prompt', 'examples', 'rules', 'tone', 'does', 'audience') then
    if coalesce(a.extra ->> c.campo, '') <> coalesce(c.antes, '') then
      raise exception 'O campo mudou desde a proposta. Rode a melhoria de novo para uma proposta atualizada.';
    end if;
    novo := jsonb_build_object(c.campo, coalesce(c.depois, ''));
  elsif c.campo = 'knowledge' then
    kb := case when jsonb_typeof(a.extra -> 'knowledge') = 'array' then a.extra -> 'knowledge' else '[]'::jsonb end;
    ids := string_to_array(coalesce(c.alvo, ''), ',');
    if c.operacao in ('editar', 'remover', 'mesclar') and not exists (select 1 from jsonb_array_elements(kb) k where k ->> 'id' = any (ids)) then
      raise exception 'O conhecimento mudou desde a proposta.';
    end if;
    if c.operacao in ('remover', 'mesclar', 'editar') then
      kb := coalesce((select jsonb_agg(k) from jsonb_array_elements(kb) k where not (k ->> 'id' = any (ids))), '[]'::jsonb);
    end if;
    if c.operacao in ('adicionar', 'editar', 'mesclar') then
      kb := kb || jsonb_build_array(jsonb_build_object('id', coalesce(ids[1], gen_random_uuid()::text)) || (c.depois::jsonb - 'id'));
    end if;
    novo := jsonb_build_object('knowledge', kb);
  else
    raise exception 'Campo não alterável por aprovação.';
  end if;
  update public.agents set extra = extra || novo || jsonb_build_object('intelRev', coalesce((extra ->> 'intelRev')::int, 0) + 1), updated_at = now()
  where id = a.id returning * into a;
  vid := private.intel_save_version(a, 'aprovacao', left('Aprovado: ' || c.motivo, 300), c.job_id, (select auth.uid()), true);
  update public.intel_agent_changes set estado = 'aprovada', versao_id = vid, decidido_por = (select auth.uid()), decidido_em = now() where id = c.id;
  return jsonb_build_object('ok', true, 'estado', 'aprovada', 'versao', vid, 'agente', to_jsonb(a));
end;
$$;

-- Restaura instruções e conhecimento de uma versão. A versão atual é guardada antes (dá para voltar).
create or replace function public.intel_version_restore(p_version uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.intel_agent_versions;
  a public.agents;
  vid uuid;
begin
  select * into v from public.intel_agent_versions where id = p_version;
  if not found then raise exception 'Versão não encontrada.'; end if;
  perform private.intel_exigir(v.company_id, 'restaurar');
  select * into a from public.agents where id = v.agent_id and company_id = v.company_id for update;
  if not found then raise exception 'Agente não encontrado.'; end if;
  perform private.intel_save_version(a, 'copia', 'Antes de restaurar a versão ' || v.numero, null, (select auth.uid()), false);
  update public.agents set extra = extra || v.conteudo || jsonb_build_object('intelRev', coalesce((extra ->> 'intelRev')::int, 0) + 1), updated_at = now()
  where id = a.id returning * into a;
  vid := private.intel_save_version(a, 'restauracao', 'Restaurada a versão ' || v.numero, null, (select auth.uid()), true);
  return jsonb_build_object('ok', true, 'versao', vid, 'agente', to_jsonb(a));
end;
$$;

revoke all on function public.intel_job_start(uuid, uuid, numeric, jsonb), public.intel_job_resume(uuid, numeric), public.intel_job_cancel(uuid),
  public.intel_change_decide(uuid, boolean), public.intel_version_restore(uuid) from public, anon;
grant execute on function public.intel_job_start(uuid, uuid, numeric, jsonb), public.intel_job_resume(uuid, numeric), public.intel_job_cancel(uuid),
  public.intel_change_decide(uuid, boolean), public.intel_version_restore(uuid) to authenticated;

-- Evolução de um agente para a tela: execuções, versões, alterações, aprendizados e o desempenho antes/depois da última
-- publicação. Trechos de conversa só para quem pode ver conversas.
create or replace function public.intel_evolucao(p_company uuid, p_agent uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  ver boolean;
  pub timestamptz;
begin
  perform private.intel_exigir(p_company, 'consultar');
  if not exists (select 1 from public.agents where id = p_agent and company_id = p_company) then raise exception 'Agente não encontrado.'; end if;
  ver := private.intel_can(p_company, 'conversas');
  select max(publicada_em) into pub from public.intel_agent_versions where agent_id = p_agent and origem in ('melhoria', 'aprovacao', 'restauracao');
  return jsonb_build_object(
    'jobs', coalesce((select jsonb_agg(to_jsonb(j) - 'cursor' order by j.created_at desc) from (
      select * from public.intel_agent_jobs where agent_id = p_agent and company_id = p_company order by created_at desc limit 15) j), '[]'::jsonb),
    'versoes', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'numero', v.numero, 'origem', v.origem, 'resumo', v.resumo, 'criadoEm', v.criado_em,
        'publicadaEm', v.publicada_em, 'jobId', v.job_id, 'conteudo', v.conteudo) order by v.numero desc)
      from public.intel_agent_versions v where v.agent_id = p_agent and v.company_id = p_company), '[]'::jsonb),
    'alteracoes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'jobId', c.job_id, 'versaoId', c.versao_id, 'campo', c.campo, 'operacao', c.operacao,
        'alvo', c.alvo, 'antes', c.antes, 'depois', c.depois, 'motivo', c.motivo, 'aprendizados', c.aprendizados, 'protegida', c.protegida, 'area', c.area,
        'estado', c.estado, 'bloqueio', c.bloqueio, 'decididoEm', c.decidido_em, 'criadaEm', c.created_at,
        'evidencias', case when ver then c.evidencias else (select coalesce(jsonb_agg(e - 'trecho'), '[]'::jsonb) from jsonb_array_elements(c.evidencias) e) end)
        order by c.created_at desc)
      from (select * from public.intel_agent_changes where agent_id = p_agent and company_id = p_company order by created_at desc limit 200) c), '[]'::jsonb),
    'aprendizados', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'chave', l.chave, 'tipo', l.tipo, 'titulo', l.titulo, 'detalhe', l.detalhe,
        'natureza', l.natureza, 'area', l.area_protegida, 'frequencia', cardinality(l.chats), 'estado', l.estado, 'ultimaVez', l.ultima_vez,
        'evidencias', case when ver then l.evidencias else '[]'::jsonb end) order by cardinality(l.chats) desc, l.ultima_vez desc)
      from (select * from public.intel_learnings where agent_id = p_agent and company_id = p_company and estado <> 'descartado'
            order by cardinality(chats) desc limit 80) l), '[]'::jsonb),
    'validacao', coalesce((select jsonb_agg(jsonb_build_object('jobId', r.job_id, 'tipo', r.caso ->> 'tipo', 'criterio', r.caso ->> 'criterio',
        'veredito', r.veredito, 'avaliacao', r.avaliacao,
        'atual', case when ver then r.atual else r.atual - 'resposta' end, 'candidata', case when ver then r.candidata else r.candidata - 'resposta' end,
        'contexto', case when ver then r.caso -> 'contexto' end) order by r.created_at desc)
      from (select * from public.intel_validation_results where company_id = p_company
            and job_id in (select id from public.intel_agent_jobs where agent_id = p_agent order by created_at desc limit 3) limit 100) r), '[]'::jsonb),
    'desempenho', case when pub is null then null else jsonb_build_object('publicadaEm', pub,
      'antes', private.intel_agente_janela(p_company, p_agent, pub - interval '14 days', pub),
      'depois', private.intel_agente_janela(p_company, p_agent, pub, least(now(), pub + interval '14 days'))) end);
end;
$$;

-- Números de um agente numa janela: execuções, respostas, transferências, erros, tokens por execução e conversas.
create or replace function private.intel_agente_janela(p_company uuid, p_agent uuid, p_de timestamptz, p_ate timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('de', p_de, 'ate', p_ate,
    'execucoes', count(*), 'conversas', count(distinct r.chat_id),
    'respondeu', count(*) filter (where r.status = 'respondeu'), 'transferiu', count(*) filter (where r.status = 'transferiu'),
    'erros', count(*) filter (where r.status = 'erro'),
    'taxaTransferencia', round(count(*) filter (where r.status = 'transferiu')::numeric / nullif(count(*) filter (where r.status in ('respondeu', 'transferiu', 'sem_resposta')), 0), 4),
    'tokensEntradaMedia', round(avg(nullif(r.input_tokens, 0))), 'tokensSaidaMedia', round(avg(nullif(r.output_tokens, 0))), 'msMedia', round(avg(nullif(r.ms, 0))),
    'iaNaoResolveu', (select count(*) from public.intel_events e where e.company_id = p_company and e.kind = 'ia_nao_resolveu'
      and e.occurred_at >= p_de and e.occurred_at < p_ate and e.chat_id in (select x.chat_id from public.ai_runs x where x.agent_id = p_agent and x.created_at >= p_de and x.created_at < p_ate)))
  from public.ai_runs r where r.company_id = p_company and r.agent_id = p_agent and r.created_at >= p_de and r.created_at < p_ate;
$$;

revoke all on function public.intel_evolucao(uuid, uuid), private.intel_agente_janela(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.intel_evolucao(uuid, uuid) to authenticated, service_role;
grant execute on function private.intel_agente_janela(uuid, uuid, timestamptz, timestamptz) to service_role;

/* ---------- 5. Consultas (métricas) ---------- */

-- Fuso da empresa e baldes do período (dia, semana ou mês, no horário da empresa)
create or replace function private.intel_tz(cid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(c.timezone, ''), 'America/Sao_Paulo') from public.companies c where c.id = cid;
$$;

create or replace function private.intel_baldes(p_de timestamptz, p_ate timestamptz, p_tz text, p_gran text)
returns table (b date) language sql stable set search_path = '' as $$
  select generate_series(
    date_trunc(g, p_de at time zone p_tz),
    date_trunc(g, (p_ate - interval '1 microsecond') at time zone p_tz),
    ('1 ' || g)::interval)::date
  from (select case p_gran when 'semana' then 'week' when 'mes' then 'month' else 'day' end g) x;
$$;

create or replace function private.intel_balde(t timestamptz, p_tz text, p_gran text)
returns date language sql stable set search_path = '' as $$
  select date_trunc(case p_gran when 'semana' then 'week' when 'mes' then 'month' else 'day' end, t at time zone p_tz)::date;
$$;

-- Produto do filtro: casa com o id ou o nome (sem diferenciar maiúsculas)
create or replace function private.intel_produto_ok(p_filtros jsonb, p_key text, p_nome text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_filtros ->> 'produto', '') = ''
    or p_key = p_filtros ->> 'produto'
    or p_nome ilike '%' || (p_filtros ->> 'produto') || '%';
$$;

-- Vendas: pagamentos confirmados pelas plataformas (intel_orders) e, separado, as vendas registradas no CRM (sales).
-- As duas fontes nunca são somadas (a mesma venda costuma estar nas duas).
create or replace function public.intel_m_vendas(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := private.intel_tz(p_company);
  tem_pag boolean;
  tem_crm boolean;
  res jsonb;
begin
  perform private.intel_exigir(p_company, 'consultar');
  tem_pag := exists (select 1 from public.intel_orders o where o.company_id = p_company and o.kind = 'pedido');
  tem_crm := exists (select 1 from public.sales s where s.company_id = p_company);
  with o as (
    select * from public.intel_orders o where o.company_id = p_company and o.kind = 'pedido'
      and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)
  ), ap as (select * from o where o.paid_at >= p_de and o.paid_at < p_ate and o.currency = 'BRL'),
  rb as (select * from o where o.refunded_at >= p_de and o.refunded_at < p_ate and o.currency = 'BRL')
  select jsonb_build_object(
    'aprovadas', (select count(*) from ap),
    'receitaCentavos', (select coalesce(sum(amount_cents), 0) from ap),
    'semValor', (select count(*) from ap where amount_cents is null),
    'ticketMedioCentavos', (select round(avg(amount_cents)) from ap where amount_cents is not null),
    'reembolsos', (select count(*) from rb where status = 'reembolsado'),
    'chargebacks', (select count(*) from rb where status = 'chargeback'),
    'reembolsadoCentavos', (select coalesce(sum(amount_cents), 0) from rb),
    'liquidoCentavos', (select coalesce(sum(amount_cents), 0) from ap) - (select coalesce(sum(amount_cents), 0) from rb),
    'pedidosAbertos', (select count(*) from o where o.opened_at >= p_de and o.opened_at < p_ate),
    'outrasMoedas', (select count(*) from o where o.paid_at >= p_de and o.paid_at < p_ate and o.currency <> 'BRL'),
    'serie', (select coalesce(jsonb_agg(jsonb_build_object('x', b.b, 'vendas', coalesce(s.n, 0), 'receitaCentavos', coalesce(s.v, 0)) order by b.b), '[]'::jsonb)
      from private.intel_baldes(p_de, p_ate, tz, p_gran) b
      left join (select private.intel_balde(paid_at, tz, p_gran) d, count(*) n, sum(amount_cents) v from ap group by 1) s on s.d = b.b),
    'porStatus', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'pedidos', n, 'valorCentavos', v) order by n desc), '[]'::jsonb)
      from (select status, count(*) n, coalesce(sum(amount_cents), 0) v from o where o.opened_at >= p_de and o.opened_at < p_ate group by 1) x),
    'porProduto', (select coalesce(jsonb_agg(jsonb_build_object('produto', p, 'vendas', n, 'receitaCentavos', v) order by v desc), '[]'::jsonb)
      from (select coalesce(nullif(product_name, ''), 'Sem produto') p, count(*) n, coalesce(sum(amount_cents), 0) v from ap group by 1 order by 3 desc limit 10) x),
    'porMetodo', (select coalesce(jsonb_agg(jsonb_build_object('metodo', m, 'vendas', n, 'receitaCentavos', v) order by n desc), '[]'::jsonb)
      from (select coalesce(nullif(method, ''), 'outro') m, count(*) n, coalesce(sum(amount_cents), 0) v from ap group by 1) x)
  ) into res;
  return jsonb_build_object(
    'disponivel', tem_pag or tem_crm,
    'fonte', case when tem_pag then 'pagamentos' when tem_crm then 'crm' else null end,
    'pagamentos', case when tem_pag then res end,
    'crm', case when tem_crm then (
      select jsonb_build_object('vendas', count(*), 'receitaCentavos', coalesce(round(sum(s.value) * 100), 0),
        'serie', (select coalesce(jsonb_agg(jsonb_build_object('x', b.b, 'vendas', coalesce(z.n, 0), 'receitaCentavos', coalesce(z.v, 0)) order by b.b), '[]'::jsonb)
          from private.intel_baldes(p_de, p_ate, tz, p_gran) b
          left join (select private.intel_balde(s2.at, tz, p_gran) d, count(*) n, round(sum(s2.value) * 100) v from public.sales s2
                     left join public.products pr on pr.id = s2.product_id
                     where s2.company_id = p_company and s2.at >= p_de and s2.at < p_ate and s2.currency = 'BRL'
                       and private.intel_produto_ok(p_filtros, coalesce(s2.product_id::text, ''), coalesce(pr.name, '')) group by 1) z on z.d = b.b))
      from public.sales s left join public.products pr on pr.id = s.product_id
      where s.company_id = p_company and s.at >= p_de and s.at < p_ate and s.currency = 'BRL'
        and private.intel_produto_ok(p_filtros, coalesce(s.product_id::text, ''), coalesce(pr.name, ''))) end,
    'fuso', tz);
end;
$$;

-- Oportunidades de recuperação: cliente (contato, e-mail ou WhatsApp) + produto, a partir do primeiro carrinho
-- abandonado, cartão recusado ou Pix/boleto não pago no período. Só vira oportunidade o que não foi pago até a carência.
-- convertida: o mesmo cliente pagou (o mesmo produto, quando os dois lados informam) até conversaoDias depois.
-- comContato: a empresa mandou mensagem (IA, fluxo ou equipe) entre o começo e o pagamento.
-- recuperada (atribuída): convertida, com contato, paga depois da carência e até janelaHoras após o último contato.
create or replace function private.intel_oportunidades(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb)
returns table (cliente text, produto text, produto_nome text, tipo text, inicio timestamptz, valor_centavos bigint, valor_estimado boolean,
  contact_id uuid, pix_pendente boolean, pago_em timestamptz, receita_centavos bigint, ultimo_contato timestamptz, com_contato boolean, recuperada boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  cfg jsonb := private.intel_cfg(p_company) -> 'atribuicao';
  carencia interval := make_interval(mins => coalesce((cfg ->> 'carenciaMinutos')::int, 30));
  janela interval := make_interval(hours => coalesce((cfg ->> 'janelaHoras')::int, 72));
  conv interval := make_interval(days => coalesce((cfg ->> 'conversaoDias')::int, 30));
  pixexp interval := make_interval(hours => coalesce((cfg ->> 'pixExpiraHoras')::int, 48));
begin
  return query
  with base as (
    select o.*, coalesce(o.contact_id::text, nullif(o.customer_email, ''), nullif(o.customer_phone, ''), o.id::text) cli,
      case when o.kind = 'carrinho' then 'carrinho'
           when exists (select 1 from public.intel_payment_attempts t where t.order_id = o.id and t.status = 'recusado') and o.method <> 'pix' then 'cartao_recusado'
           when o.method = 'pix' or exists (select 1 from public.intel_payment_attempts t where t.order_id = o.id and t.method = 'pix') then 'pix'
           when o.method = 'boleto' then 'boleto'
           when o.status = 'recusado' then 'cartao_recusado'
           else 'outro' end tp
    from public.intel_orders o
    where o.company_id = p_company and o.opened_at >= p_de and o.opened_at < p_ate
      and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)
      and (o.kind = 'carrinho' or o.status in ('pendente', 'expirado', 'recusado', 'cancelado') or o.paid_at > o.opened_at + carencia)
      and coalesce(p_filtros ->> 'tipo', '') in ('', 'todos', case when o.kind = 'carrinho' then 'carrinho' else '' end, case when o.method = 'pix' then 'pix' else '' end,
        case when o.status = 'recusado' or exists (select 1 from public.intel_payment_attempts t where t.order_id = o.id and t.status = 'recusado') then 'cartao_recusado' else '' end)
  ), grp as (
    select b.cli, coalesce(nullif(b.product_key, ''), '?') pk, (array_agg(b.product_name order by b.opened_at))[1] pn,
      (array_agg(b.tp order by b.opened_at))[1] tp, min(b.opened_at) ini, max(b.amount_cents) val,
      (array_agg(b.contact_id order by b.contact_id is null, b.opened_at))[1] ct,
      bool_or(b.tp = 'pix' and b.paid_at is null and coalesce(b.pix_expires_at, b.opened_at + pixexp) > now()) pixp,
      array_agg(b.customer_email) filter (where b.customer_email <> '') emails, array_agg(b.customer_phone) filter (where b.customer_phone <> '') fones
    from base b group by 1, 2
  ), pago as (
    select g.*, (select min(p.paid_at) from public.intel_orders p
        where p.company_id = p_company and p.kind = 'pedido' and p.paid_at is not null and p.paid_at >= g.ini and p.paid_at <= g.ini + conv
          and (p.contact_id = g.ct or (p.customer_email <> '' and p.customer_email = any (coalesce(g.emails, '{}')))
               or (p.customer_phone <> '' and p.customer_phone = any (coalesce(g.fones, '{}'))))
          and (g.pk = '?' or p.product_key = '' or p.product_key = g.pk)) pg
    from grp g
  ), receita as (
    select p.*, (select o2.amount_cents from public.intel_orders o2 where o2.company_id = p_company and o2.kind = 'pedido' and o2.paid_at = p.pg
        and (o2.contact_id = p.ct or o2.customer_email = any (coalesce(p.emails, '{}')) or o2.customer_phone = any (coalesce(p.fones, '{}'))) limit 1) rc,
      (select max(m.at) from public.messages m join public.chats ch on ch.id = m.chat_id
        where p.ct is not null and ch.company_id = p_company and ch.contact_id = p.ct and m.company_id = p_company
          and m.sender in ('bot', 'agent') and m.at > p.ini and m.at < coalesce(p.pg, least(now(), p_ate + conv))) uc
    from pago p
  )
  select r.cli, r.pk, r.pn, r.tp, r.ini,
    coalesce(r.val, (select round(avg(x.amount_cents)) from public.intel_orders x where x.company_id = p_company and x.paid_at is not null
      and x.product_key = r.pk and x.amount_cents is not null)::bigint),
    r.val is null,
    r.ct, coalesce(r.pixp, false), r.pg, r.rc, r.uc, r.uc is not null,
    r.pg is not null and r.uc is not null and r.pg > r.ini + carencia and r.pg <= r.uc + janela
  from receita r;
end;
$$;
revoke all on function private.intel_oportunidades(uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated;

create or replace function public.intel_m_recuperacao(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := private.intel_tz(p_company);
  res jsonb;
begin
  perform private.intel_exigir(p_company, 'consultar');
  if not exists (select 1 from public.intel_orders o where o.company_id = p_company) then
    return jsonb_build_object('disponivel', false, 'motivo', 'Nenhum pedido, Pix ou carrinho recebido das plataformas de pagamento.', 'fuso', tz);
  end if;
  with op as (select * from private.intel_oportunidades(p_company, p_de, p_ate, p_filtros))
  select jsonb_build_object(
    'disponivel', true,
    'oportunidades', count(*),
    'porTipo', coalesce((select jsonb_agg(jsonb_build_object('tipo', tipo, 'oportunidades', n, 'convertidas', c, 'recuperadas', r) order by n desc)
      from (select tipo, count(*) n, count(*) filter (where pago_em is not null) c, count(*) filter (where recuperada) r from op group by 1) x), '[]'::jsonb),
    'convertidas', count(*) filter (where pago_em is not null),
    'receitaConvertidaCentavos', coalesce(sum(receita_centavos) filter (where pago_em is not null), 0),
    'compraAposContato', count(*) filter (where pago_em is not null and com_contato),
    'recuperadas', count(*) filter (where recuperada),
    'receitaRecuperadaCentavos', coalesce(sum(receita_centavos) filter (where recuperada), 0),
    'semContato', count(*) filter (where not com_contato and pago_em is null),
    'naoConvertidas', count(*) filter (where pago_em is null),
    -- valor informado pela plataforma; o estimado (preço médio pago do mesmo produto) fica separado
    'valorPotencialCentavos', coalesce(sum(valor_centavos) filter (where pago_em is null and not valor_estimado), 0),
    'valorPotencialEstimadoCentavos', coalesce(sum(valor_centavos) filter (where pago_em is null and valor_estimado), 0),
    'valorPotencialEstimados', count(*) filter (where pago_em is null and valor_estimado and valor_centavos is not null),
    'valorPotencialSemValor', count(*) filter (where pago_em is null and valor_centavos is null),
    'taxaRecuperacao', round(count(*) filter (where recuperada)::numeric / nullif(count(*), 0), 4),
    'taxaConversao', round(count(*) filter (where pago_em is not null)::numeric / nullif(count(*), 0), 4),
    'pix', jsonb_build_object(
      'gerados', (select count(*) from public.intel_orders o where o.company_id = p_company and o.kind = 'pedido' and o.opened_at >= p_de and o.opened_at < p_ate
        and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)
        and (o.method = 'pix' or exists (select 1 from public.intel_payment_attempts t where t.order_id = o.id and t.method = 'pix'))),
      'pagos', (select count(*) from public.intel_orders o where o.company_id = p_company and o.kind = 'pedido' and o.opened_at >= p_de and o.opened_at < p_ate
        and private.intel_produto_ok(p_filtros, o.product_key, o.product_name) and o.paid_at is not null
        and (o.method = 'pix' or exists (select 1 from public.intel_payment_attempts t where t.order_id = o.id and t.method = 'pix'))),
      'pessoasSemPagar', count(*) filter (where tipo = 'pix' and pago_em is null),
      'pendentes', count(*) filter (where tipo = 'pix' and pago_em is null and pix_pendente),
      'expirados', count(*) filter (where tipo = 'pix' and pago_em is null and not pix_pendente)),
    'carrinhos', jsonb_build_object('abandonados', count(*) filter (where tipo = 'carrinho'),
      'convertidos', count(*) filter (where tipo = 'carrinho' and pago_em is not null)),
    'serie', (select coalesce(jsonb_agg(jsonb_build_object('x', b.b, 'oportunidades', coalesce(s.n, 0), 'recuperadas', coalesce(s.r, 0),
        'receitaRecuperadaCentavos', coalesce(s.v, 0)) order by b.b), '[]'::jsonb)
      from private.intel_baldes(p_de, p_ate, tz, p_gran) b
      left join (select private.intel_balde(inicio, tz, p_gran) d, count(*) n, count(*) filter (where recuperada) r,
        coalesce(sum(receita_centavos) filter (where recuperada), 0) v from op group by 1) s on s.d = b.b),
    'regras', private.intel_cfg(p_company) -> 'atribuicao',
    'fuso', tz
  ) into res from op;
  return res;
end;
$$;

-- Atendimento: conversas com mensagem do cliente no período (ou só as que o agente atendeu, com o filtro de agente).
create or replace function public.intel_m_suporte(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := private.intel_tz(p_company);
  ag text := nullif(p_filtros ->> 'agente', '');
  desde timestamptz := (select coleta_desde from public.intel_platform where id);
  res jsonb;
begin
  perform private.intel_exigir(p_company, 'consultar');
  with m as (
    select m.chat_id, m.sender, m.at, length(m.text) len, m.extra ->> 'agentId' agente, m.text
    from public.messages m where m.company_id = p_company and m.at >= p_de and m.at < p_ate and m.sender <> 'sys'
      and (nullif(p_filtros ->> 'conexao', '') is null or m.chat_id in (select c.id from public.chats c where c.company_id = p_company and c.connection_id::text = p_filtros ->> 'conexao'))
  ), escopo as (
    select distinct chat_id from m where m.sender = 'contact'
      and (ag is null or m.chat_id in (select chat_id from m m2 where m2.sender = 'bot' and m2.agente = ag))
  ), mm as (select * from m where m.chat_id in (select chat_id from escopo)),
  runs as (select * from public.ai_runs r where r.company_id = p_company and r.created_at >= p_de and r.created_at < p_ate and (ag is null or r.agent_id::text = ag)),
  ev as (select * from public.intel_events e where e.company_id = p_company and e.occurred_at >= p_de and e.occurred_at < p_ate
    and e.kind in ('atendimento_concluido', 'atendimento_reaberto', 'transferencia_humana', 'ia_nao_resolveu', 'humano_assumiu')
    and (ag is null or e.chat_id in (select chat_id from escopo))),
  primeiro as (
    select c.id, (select min(x.at) from public.messages x where x.chat_id = c.id and x.company_id = p_company and x.sender = 'contact') pc
    from public.chats c where c.company_id = p_company and c.created_at >= p_de and c.created_at < p_ate and c.id in (select chat_id from escopo)
  ), resp as (
    select p.id, extract(epoch from ((select min(x.at) from public.messages x where x.chat_id = p.id and x.company_id = p_company and x.sender in ('bot', 'agent') and x.at >= p.pc) - p.pc)) / 60.0 minutos
    from primeiro p where p.pc is not null
  )
  select jsonb_build_object(
    'disponivel', true,
    'conversas', (select count(*) from escopo),
    'conversasNovas', (select count(*) from primeiro),
    'mensagensClientes', (select count(*) from mm where sender = 'contact'),
    'mensagensIa', (select count(*) from mm where sender = 'bot'),
    'mensagensEquipe', (select count(*) from mm where sender = 'agent'),
    'conversasComIa', (select count(distinct chat_id) from mm where sender = 'bot'),
    'conversasComEquipe', (select count(distinct chat_id) from mm where sender = 'agent'),
    'tamanhoMedioRespostaIa', (select round(avg(len)) from mm where sender = 'bot'),
    'execucoesIa', (select count(*) from runs),
    'transferenciasIa', (select count(*) from runs where status = 'transferiu'),
    'errosIa', (select count(*) from runs where status = 'erro'),
    'semCredito', (select count(*) from runs where status = 'sem_credito'),
    'iaNaoResolveu', (select count(distinct chat_id) from ev where kind = 'ia_nao_resolveu'),
    'humanoAssumiu', (select count(distinct chat_id) from ev where kind = 'humano_assumiu'),
    'concluidos', (select count(*) from ev where kind = 'atendimento_concluido'),
    'reabertos', (select count(*) from ev where kind = 'atendimento_reaberto'),
    'primeiraRespostaMedianaMin', (select round((percentile_cont(0.5) within group (order by minutos))::numeric, 1) from resp where minutos is not null),
    'semResposta', (select count(*) from escopo e where (select x.sender from public.messages x where x.chat_id = e.chat_id and x.company_id = p_company and x.sender <> 'sys' order by x.at desc limit 1) = 'contact'
      and (select max(x.at) from public.messages x where x.chat_id = e.chat_id and x.company_id = p_company) < now() - interval '1 hour'),
    'eventosDesde', desde,
    'serie', (select coalesce(jsonb_agg(jsonb_build_object('x', b.b, 'conversas', coalesce(s.n, 0), 'transferencias', coalesce(t.n, 0)) order by b.b), '[]'::jsonb)
      from private.intel_baldes(p_de, p_ate, tz, p_gran) b
      left join (select private.intel_balde(at, tz, p_gran) d, count(distinct chat_id) n from mm where sender = 'contact' group by 1) s on s.d = b.b
      left join (select private.intel_balde(created_at, tz, p_gran) d, count(*) n from runs where status = 'transferiu' group by 1) t on t.d = b.b),
    'porAgente', (select coalesce(jsonb_agg(jsonb_build_object('agenteId', r.agent_id, 'agente', coalesce(a.name, 'Agente excluído'), 'execucoes', r.n,
        'respondeu', r.resp, 'transferiu', r.tr, 'erros', r.er) order by r.n desc), '[]'::jsonb)
      from (select agent_id, count(*) n, count(*) filter (where status = 'respondeu') resp, count(*) filter (where status = 'transferiu') tr,
              count(*) filter (where status = 'erro') er from runs where agent_id is not null group by 1) r
      left join public.agents a on a.id = r.agent_id),
    'motivosTransferencia', (select coalesce(jsonb_agg(jsonb_build_object('motivo', motivo, 'n', n) order by n desc), '[]'::jsonb)
      from (select left(coalesce(nullif(e.data ->> 'motivo', ''), 'sem motivo'), 120) motivo, count(*) n from ev e where e.kind = 'ia_nao_resolveu' group by 1 order by 2 desc limit 8) x),
    'fuso', tz
  ) into res;
  return res;
end;
$$;

-- Funil (volumes por etapa no período, não coorte): leads, conversas, atendidas pela IA, pedidos/carrinhos, pagos.
create or replace function public.intel_m_funil(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := private.intel_tz(p_company);
  tem_pag boolean := exists (select 1 from public.intel_orders o where o.company_id = p_company);
begin
  perform private.intel_exigir(p_company, 'consultar');
  return jsonb_build_object(
    'disponivel', true,
    'etapas', jsonb_build_array(
      jsonb_build_object('etapa', 'Leads novos', 'n', (select count(*) from public.contacts c where c.company_id = p_company and c.created_at >= p_de and c.created_at < p_ate)),
      jsonb_build_object('etapa', 'Conversas iniciadas', 'n', (select count(*) from public.chats c where c.company_id = p_company and c.created_at >= p_de and c.created_at < p_ate)),
      jsonb_build_object('etapa', 'Atendidas pela IA', 'n', (select count(distinct m.chat_id) from public.messages m where m.company_id = p_company and m.sender = 'bot'
        and m.at >= p_de and m.at < p_ate and m.chat_id in (select c.id from public.chats c where c.company_id = p_company and c.created_at >= p_de and c.created_at < p_ate))),
      jsonb_build_object('etapa', 'Iniciaram compra', 'n', case when tem_pag then (select count(distinct coalesce(o.contact_id::text, nullif(o.customer_email, ''), o.customer_phone))
        from public.intel_orders o where o.company_id = p_company and o.opened_at >= p_de and o.opened_at < p_ate and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)) end),
      jsonb_build_object('etapa', 'Compraram', 'n', case when tem_pag then (select count(distinct coalesce(o.contact_id::text, nullif(o.customer_email, ''), o.customer_phone))
        from public.intel_orders o where o.company_id = p_company and o.kind = 'pedido' and o.paid_at >= p_de and o.paid_at < p_ate and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)) end)),
    'kanban', (select coalesce(jsonb_agg(jsonb_build_object('quadro', k.name, 'quadroId', k.id, 'colunas', (
        select coalesce(jsonb_agg(jsonb_build_object('coluna', col ->> 'name', 'colunaId', col ->> 'id',
          'negocios', (select count(*) from public.kanban_cards kc where kc.kanban_id = k.id and kc.column_id = col ->> 'id'),
          'entradas', (select count(*) from public.intel_events e where e.company_id = p_company and e.kind in ('crm_etapa', 'crm_negocio_criado')
            and e.occurred_at >= p_de and e.occurred_at < p_ate and e.data ->> 'quadro' = k.id::text and e.data ->> 'para' = col ->> 'id')) order by ord), '[]'::jsonb)
        from jsonb_array_elements(k.columns) with ordinality as cc(col, ord))) order by k.created_at), '[]'::jsonb)
      from (select * from public.kanbans where company_id = p_company order by created_at limit 3) k),
    'origens', (select coalesce(jsonb_agg(jsonb_build_object('origem', o, 'leads', n) order by n desc), '[]'::jsonb)
      from (select coalesce(nullif(c.origin, ''), 'Sem origem') o, count(*) n from public.contacts c where c.company_id = p_company and c.created_at >= p_de and c.created_at < p_ate group by 1 order by 2 desc limit 8) x),
    'pagamentosDisponiveis', tem_pag,
    'eventosDesde', (select coleta_desde from public.intel_platform where id),
    'fuso', tz);
end;
$$;

-- Consumo de IA: créditos (carteira, por origem/agente/dia) e tokens (todas as chaves, custo estimado pela tabela de preços).
create or replace function public.intel_m_consumo(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := private.intel_tz(p_company);
  ag text := nullif(p_filtros ->> 'agente', '');
  s public.ai_billing_settings;
  w public.ai_wallets;
begin
  perform private.intel_exigir(p_company, 'consultar');
  select * into s from public.ai_billing_settings where id;
  select * into w from public.ai_wallets where company_id = p_company;
  return jsonb_build_object(
    'disponivel', true,
    'carteira', w.company_id is not null and w.active,
    'modo', w.mode,
    'creditoReais', s.credit_brl,
    'creditos', (select coalesce(-sum(l.credits), 0) from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_de and l.created_at < p_ate and (ag is null or l.agent_id::text = ag)),
    'operacoes', (select count(*) from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_de and l.created_at < p_ate and (ag is null or l.agent_id::text = ag)),
    'porOrigem', (select coalesce(jsonb_agg(jsonb_build_object('origem', o, 'creditos', c, 'operacoes', n) order by c desc), '[]'::jsonb)
      from (select coalesce(l.origin, 'atendimento') o, -sum(l.credits) c, count(*) n from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo'
        and l.created_at >= p_de and l.created_at < p_ate and (ag is null or l.agent_id::text = ag) group by 1) x),
    'porAgente', (select coalesce(jsonb_agg(jsonb_build_object('agenteId', x.agent_id, 'agente', coalesce(a.name, case when x.agent_id is null then 'Sem agente' else 'Agente excluído' end), 'creditos', x.c, 'operacoes', x.n) order by x.c desc), '[]'::jsonb)
      from (select l.agent_id, -sum(l.credits) c, count(*) n from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo'
        and l.created_at >= p_de and l.created_at < p_ate group by 1) x left join public.agents a on a.id = x.agent_id),
    'serie', (select coalesce(jsonb_agg(jsonb_build_object('x', b.b, 'creditos', coalesce(z.c, 0)) order by b.b), '[]'::jsonb)
      from private.intel_baldes(p_de, p_ate, tz, p_gran) b
      left join (select private.intel_balde(l.created_at, tz, p_gran) d, -sum(l.credits) c from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo'
        and l.created_at >= p_de and l.created_at < p_ate and (ag is null or l.agent_id::text = ag) group by 1) z on z.d = b.b),
    -- tokens de todas as execuções do atendimento (inclusive com a chave da empresa) e das funções do módulo
    'tokens', jsonb_build_object(
      'atendimento', (select jsonb_build_object('execucoes', count(*), 'entrada', coalesce(sum(r.input_tokens), 0), 'saida', coalesce(sum(r.output_tokens), 0),
          'custoEstimadoUsd', round(coalesce(sum(r.input_tokens / 1e6 * private.ai_price(r.model, 'input_mtok') + r.output_tokens / 1e6 * private.ai_price(r.model, 'output_mtok')), 0), 6))
        from public.ai_runs r where r.company_id = p_company and r.created_at >= p_de and r.created_at < p_ate and r.input_tokens > 0 and r.provider not in ('simulado', '')
          and (ag is null or r.agent_id::text = ag)),
      'modulo', (select coalesce(jsonb_agg(jsonb_build_object('origem', origem, 'chamadas', n, 'entrada', i, 'saida', o, 'custoEstimadoUsd', round(c, 6))), '[]'::jsonb)
        from (select u.origem, count(*) n, sum(u.input_tokens) i, sum(u.output_tokens) o, sum(u.cost_usd) c from public.intel_usage u
          where u.company_id = p_company and u.created_at >= p_de and u.created_at < p_ate and (ag is null or u.agent_id::text = ag) group by 1) x)),
    'fuso', tz);
end;
$$;

-- Registros por trás dos números (até 50 por página). Conversas exigem a permissão de ver conversas.
create or replace function public.intel_m_registros(p_company uuid, p_tipo text, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_pagina int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  lim int := 50;
  off int := greatest(coalesce(p_pagina, 0), 0) * 50;
  st text := nullif(p_filtros ->> 'status', '');
  ag text := nullif(p_filtros ->> 'agente', '');
begin
  perform private.intel_exigir(p_company, 'consultar');
  if p_tipo = 'pedidos' then
    return jsonb_build_object('tipo', p_tipo, 'linhas', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select o.id, o.kind tipo, o.status, o.method metodo, o.amount_cents "valorCentavos", o.product_name produto, o.customer_name cliente, o.contact_id "contatoId",
        o.opened_at "abertoEm", o.paid_at "pagoEm", o.refunded_at "reembolsadoEm", o.source fonte,
        (select ch.id from public.chats ch where ch.company_id = p_company and ch.contact_id = o.contact_id order by ch.last_message_at desc limit 1) "conversaId"
      from public.intel_orders o where o.company_id = p_company and private.intel_produto_ok(p_filtros, o.product_key, o.product_name)
        and (case when st = 'pago' then o.paid_at >= p_de and o.paid_at < p_ate
                  when st in ('reembolsado', 'chargeback') then o.refunded_at >= p_de and o.refunded_at < p_ate and o.status = st
                  else o.opened_at >= p_de and o.opened_at < p_ate and (st is null or o.status = st) end)
      order by coalesce(o.paid_at, o.opened_at) desc limit lim offset off) x), '[]'::jsonb));
  elsif p_tipo = 'oportunidades' then
    return jsonb_build_object('tipo', p_tipo, 'linhas', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select op.tipo, op.produto_nome produto, op.inicio, op.valor_centavos "valorCentavos", op.valor_estimado "valorEstimado", op.contact_id "contatoId",
        (select c.name from public.contacts c where c.id = op.contact_id) cliente, op.pago_em "pagoEm", op.com_contato "comContato", op.recuperada,
        op.ultimo_contato "ultimoContato", op.pix_pendente "pixPendente",
        case when op.recuperada then 'recuperada' when op.pago_em is not null then 'convertida' else 'pendente' end situacao,
        (select ch.id from public.chats ch where ch.company_id = p_company and ch.contact_id = op.contact_id order by ch.last_message_at desc limit 1) "conversaId"
      from private.intel_oportunidades(p_company, p_de, p_ate, p_filtros) op
      where st is null or (st = 'pendente' and op.pago_em is null) or (st = 'recuperada' and op.recuperada) or (st = 'convertida' and op.pago_em is not null)
        or (st = 'sem_contato' and not op.com_contato and op.pago_em is null)
      order by op.inicio desc limit lim offset off) x), '[]'::jsonb));
  elsif p_tipo in ('conversas', 'nao_resolvidas', 'transferidas') then
    perform private.intel_exigir(p_company, 'conversas');
    return jsonb_build_object('tipo', p_tipo, 'linhas', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select c.id "conversaId", ct.name cliente, c.status, c.last_message_at "ultimaMensagemEm", c.last_message_text "ultimaMensagem",
        coalesce(c.ai_state #>> '{precisaHumano,motivo}', (select r.reason from public.ai_runs r where r.chat_id = c.id and r.status in ('transferiu', 'erro') order by r.created_at desc limit 1)) motivo,
        (select a.name from public.agents a where a.id = c.ai_agent_id) agente
      from public.chats c join public.contacts ct on ct.id = c.contact_id
      where c.company_id = p_company
        and exists (select 1 from public.messages m where m.chat_id = c.id and m.company_id = p_company and m.at >= p_de and m.at < p_ate and m.sender = 'contact')
        and (ag is null or exists (select 1 from public.messages m where m.chat_id = c.id and m.company_id = p_company and m.sender = 'bot' and m.extra ->> 'agentId' = ag))
        and (p_tipo = 'conversas'
          or (p_tipo = 'transferidas' and exists (select 1 from public.ai_runs r where r.chat_id = c.id and r.status = 'transferiu' and r.created_at >= p_de and r.created_at < p_ate))
          or (p_tipo = 'nao_resolvidas' and (exists (select 1 from public.ai_runs r where r.chat_id = c.id and r.status in ('transferiu', 'erro', 'sem_credito') and r.created_at >= p_de and r.created_at < p_ate)
               or exists (select 1 from public.intel_events e where e.chat_id = c.id and e.kind = 'ia_nao_resolveu' and e.occurred_at >= p_de and e.occurred_at < p_ate))))
        and (nullif(p_filtros ->> 'ids', '') is null or c.id::text = any (string_to_array(p_filtros ->> 'ids', ',')))
      order by c.last_message_at desc limit lim offset off) x), '[]'::jsonb));
  end if;
  raise exception 'Tipo de registro desconhecido.';
end;
$$;

-- Dúvidas mais frequentes: aprendizados consolidados dos agentes e, para quem pode ver conversas, as perguntas dos
-- clientes no período agrupadas pelo começo do texto (sem IA).
create or replace function public.intel_m_duvidas(p_company uuid, p_de timestamptz, p_ate timestamptz, p_filtros jsonb default '{}'::jsonb, p_gran text default 'dia')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  ver boolean;
  ag text := nullif(p_filtros ->> 'agente', '');
begin
  perform private.intel_exigir(p_company, 'consultar');
  ver := private.intel_can(p_company, 'conversas');
  return jsonb_build_object(
    'disponivel', true,
    'aprendizados', (select coalesce(jsonb_agg(jsonb_build_object('titulo', l.titulo, 'tipo', l.tipo, 'frequencia', cardinality(l.chats), 'agente', a.name,
        'estado', l.estado, 'natureza', l.natureza) order by cardinality(l.chats) desc), '[]'::jsonb)
      from (select * from public.intel_learnings x where x.company_id = p_company and x.tipo in ('duvida_recorrente', 'info_ausente', 'objecao', 'resposta_incorreta', 'resposta_incompleta')
        and x.estado <> 'descartado' and (ag is null or x.agent_id::text = ag) order by cardinality(x.chats) desc limit 15) l
      left join public.agents a on a.id = l.agent_id),
    'perguntas', case when ver then (select coalesce(jsonb_agg(jsonb_build_object('pergunta', ex, 'vezes', n, 'conversas', ids) order by n desc), '[]'::jsonb) from (
        select (array_agg(m.text order by m.at desc))[1] ex, count(distinct m.chat_id) n, (array_agg(distinct m.chat_id))[1:5] ids
        from public.messages m where m.company_id = p_company and m.sender = 'contact' and m.at >= p_de and m.at < p_ate and m.type = 'text'
          and m.text like '%?%' and length(m.text) between 8 and 400
          and (ag is null or m.chat_id in (select m2.chat_id from public.messages m2 where m2.company_id = p_company and m2.sender = 'bot' and m2.extra ->> 'agentId' = ag))
        group by left(regexp_replace(lower(translate(m.text, 'áàâãéêíóôõúç', 'aaaaeeiooouc')), '[^a-z0-9 ]+', '', 'g'), 40)
        having count(distinct m.chat_id) >= 2 order by 2 desc limit 15) x) end,
    'podeVerConversas', ver);
end;
$$;

-- Opções para filtros e desambiguação (produtos, agentes, conexões)
create or replace function public.intel_opcoes(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.intel_exigir(p_company, 'consultar');
  return jsonb_build_object(
    'produtos', (select coalesce(jsonb_agg(distinct jsonb_build_object('id', x.k, 'nome', x.n)), '[]'::jsonb) from (
      select o.product_key k, o.product_name n from public.intel_orders o where o.company_id = p_company and o.product_name <> ''
      union select p.id::text, p.name from public.products p where p.company_id = p_company) x),
    'agentes', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.name, 'ativo', a.active, 'motor', coalesce(a.extra ->> 'engine', 'padrao')) order by a.name), '[]'::jsonb)
      from public.agents a where a.company_id = p_company),
    'conexoes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.name) order by c.name), '[]'::jsonb) from public.connections c where c.company_id = p_company),
    'fuso', private.intel_tz(p_company));
end;
$$;

revoke all on function private.intel_tz(uuid), private.intel_baldes(timestamptz, timestamptz, text, text), private.intel_balde(timestamptz, text, text),
  private.intel_produto_ok(jsonb, text, text) from public, anon;
grant execute on function private.intel_tz(uuid), private.intel_baldes(timestamptz, timestamptz, text, text), private.intel_balde(timestamptz, text, text),
  private.intel_produto_ok(jsonb, text, text) to authenticated, service_role;
revoke all on function public.intel_m_vendas(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_recuperacao(uuid, timestamptz, timestamptz, jsonb, text),
  public.intel_m_suporte(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_funil(uuid, timestamptz, timestamptz, jsonb, text),
  public.intel_m_consumo(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_registros(uuid, text, timestamptz, timestamptz, jsonb, int),
  public.intel_m_duvidas(uuid, timestamptz, timestamptz, jsonb, text), public.intel_opcoes(uuid) from public, anon;
grant execute on function public.intel_m_vendas(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_recuperacao(uuid, timestamptz, timestamptz, jsonb, text),
  public.intel_m_suporte(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_funil(uuid, timestamptz, timestamptz, jsonb, text),
  public.intel_m_consumo(uuid, timestamptz, timestamptz, jsonb, text), public.intel_m_registros(uuid, text, timestamptz, timestamptz, jsonb, int),
  public.intel_m_duvidas(uuid, timestamptz, timestamptz, jsonb, text), public.intel_opcoes(uuid) to authenticated, service_role;

-- Gasto do mês (créditos equivalentes) para o limite mensal: carteira + custo estimado com a chave da empresa
create or replace function public.intel_gasto_mes(p_company uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('usd', coalesce(sum(u.cost_usd), 0), 'desde', date_trunc('month', now() at time zone private.intel_tz(p_company)) at time zone private.intel_tz(p_company))
  from public.intel_usage u where u.company_id = p_company
    and u.created_at >= date_trunc('month', now() at time zone private.intel_tz(p_company)) at time zone private.intel_tz(p_company);
$$;
revoke all on function public.intel_gasto_mes(uuid) from public, anon, authenticated;
grant execute on function public.intel_gasto_mes(uuid) to service_role;

-- Rotina das melhorias (fila de intel_agent_jobs): a cada minuto, a função continua o que está na fila.
-- O endereço do projeto e a chave anon vêm do Supabase Vault (segredos 'project_url' e 'anon_key'), criados uma vez
-- na instalação (veja INSTALACAO.md). Assim nenhuma chave fica escrita no código.
select cron.schedule(
  'vortex-inteligencia-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/inteligencia',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')),
    body := '{"action": "tick"}'::jsonb
  );
  $$
);
