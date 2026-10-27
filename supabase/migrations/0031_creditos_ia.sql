-- Carteira de Créditos de IA: saldo pré-pago por empresa, dividido pelos agentes dela.
-- - Unidade comercial: Crédito de IA (1 crédito = credit_brl, padrão R$ 0,01). Não é token de provedor.
-- - Só gasta crédito a chamada feita com a chave da plataforma (segredos AI_* e ELEVENLABS_API_KEY).
--   Empresa com chave própria em Integrações paga o provedor direto e não usa a carteira.
-- - Cada chamada (functions/_shared/carteira.ts): ai_wallet_reserve antes (estimativa) → provedor →
--   ai_wallet_settle pelo consumo apurado, ou ai_wallet_release se o provedor falhou. Sem saldo, a IA não chama o
--   provedor e a conversa vai para a equipe (o atendimento manual continua).
-- - Preço cobrado = custo em dólar × câmbio × (1 + acréscimo) × multiplicador ÷ valor do crédito.
-- - Recarga (functions/creditos e creditos-webhook): pedido aqui, oferta na Vórtex Pay, créditos só depois do aviso
--   assinado + pedido conferido (ai_recharge_confirm, uma vez por recarga). Reembolso e chargeback estornam.
-- - Valores em numeric com 6 casas: uma resposta da IA custa frações de crédito.
-- - Modo da carteira: 'prepago' (desconta do saldo) ou 'interno' (empresa do próprio dono da plataforma: registra o custo, não desconta).
-- - O histórico de antes da carteira (ai_runs) só serve para dimensionar pacotes (sa_ai_history): nada é descontado.
-- Só adiciona (a coluna active de ai_wallets continua dizendo se a empresa pode usar a chave da plataforma).

/* ---------- Configuração da plataforma (uma linha) ---------- */

create table public.ai_billing_settings (
  id boolean primary key default true check (id),
  credit_brl numeric(12, 6) not null default 0.01 check (credit_brl > 0),
  multiplier numeric(8, 4) not null default 2 check (multiplier > 0),
  -- câmbio do custo dos provedores (cobram em dólar) e acréscimo sobre ele: IOF do cartão internacional e taxa do gateway
  usd_brl numeric(10, 4) not null default 5.0826 check (usd_brl > 0),
  surcharge_pct numeric(6, 3) not null default 9 check (surcharge_pct >= 0 and surcharge_pct < 100),
  -- saldo baixo padrão (cada empresa pode ter o seu)
  alert_credits numeric(20, 6) not null default 2000 check (alert_credits >= 0),
  -- reserva aberta há mais tempo que isso é dada como perdida e devolvida
  reserve_minutes int not null default 10 check (reserve_minutes between 1 and 120),
  -- produto da Vórtex Pay usado nas ofertas de recarga
  vortexpay_product_id text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.ai_billing_settings default values;

/* ---------- Preço dos provedores (dólar) por modelo e unidade ---------- */
-- model: o nome sem o prefixo do gateway ("google/gemini-2.5-flash" usa "gemini-2.5-flash"); vale também para versões
-- que começam com ele. "*" é o preço de segurança para modelo sem preço cadastrado.

create table public.ai_prices (
  id uuid primary key default gen_random_uuid(),
  provider text not null default '',
  model text not null check (char_length(model) between 1 and 80),
  unit text not null check (unit in ('input_mtok', 'cached_mtok', 'audio_input_mtok', 'output_mtok', 'stt_hour', 'tts_kchar')),
  usd numeric(14, 6) not null check (usd >= 0),
  source text not null default '',
  updated_at timestamptz not null default now(),
  unique (model, unit)
);
insert into public.ai_prices (provider, model, unit, usd, source) values
  ('google', 'gemini-2.5-flash', 'input_mtok', 0.30, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026'),
  ('google', 'gemini-2.5-flash', 'audio_input_mtok', 1.00, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026'),
  ('google', 'gemini-2.5-flash', 'output_mtok', 2.50, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026 (inclui raciocínio)'),
  ('google', 'gemini-2.5-flash-lite', 'input_mtok', 0.10, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026'),
  ('google', 'gemini-2.5-flash-lite', 'audio_input_mtok', 0.30, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026'),
  ('google', 'gemini-2.5-flash-lite', 'output_mtok', 0.40, 'ai.google.dev/gemini-api/docs/pricing, 26/10/2026'),
  ('elevenlabs', 'scribe_v2', 'stt_hour', 0.22, 'elevenlabs.io/pricing/api, 26/10/2026'),
  ('elevenlabs', 'eleven_multilingual_v2', 'tts_kchar', 0.08, 'elevenlabs.io/pricing/api, 26/10/2026'),
  ('openai', 'gpt-4.1-mini', 'input_mtok', 0.40, 'platform.openai.com/pricing'),
  ('openai', 'gpt-4.1-mini', 'output_mtok', 1.60, 'platform.openai.com/pricing'),
  ('openai', 'whisper-1', 'stt_hour', 0.36, 'platform.openai.com/pricing (US$ 0,006/min)'),
  ('openai', 'tts-1', 'tts_kchar', 0.015, 'platform.openai.com/pricing (US$ 15/M caracteres)'),
  ('', '*', 'input_mtok', 1.00, 'preço de segurança para modelo sem preço cadastrado'),
  ('', '*', 'output_mtok', 5.00, 'preço de segurança para modelo sem preço cadastrado'),
  ('', '*', 'stt_hour', 0.40, 'preço de segurança para modelo sem preço cadastrado'),
  ('', '*', 'tts_kchar', 0.30, 'preço de segurança para modelo sem preço cadastrado');

/* ---------- Carteira ---------- */

alter table public.ai_wallets
  add column mode text not null default 'prepago' check (mode in ('prepago', 'interno')),
  add column balance numeric(20, 6) not null default 0,
  add column multiplier numeric(8, 4) check (multiplier is null or multiplier > 0), -- null = o da plataforma
  add column alert_credits numeric(20, 6) check (alert_credits is null or alert_credits >= 0), -- null = o da plataforma
  add column low_alert_at timestamptz, -- quando o saldo ficou baixo (zera na recarga)
  add column blocked_at timestamptz; -- quando faltou saldo para uma operação (zera na recarga)

-- O painel vê saldo e situação; multiplicador e custo são só do superadmin (funções sa_ai_*).
revoke select on public.ai_wallets from authenticated;
grant select (company_id, active, mode, balance, alert_credits, low_alert_at, blocked_at, created_at, updated_at) on public.ai_wallets to authenticated;

/* ---------- Reservas (saldo separado antes da chamada) ---------- */

create table public.ai_reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  credits numeric(20, 6) not null check (credits > 0),
  status text not null default 'aberta' check (status in ('aberta', 'liquidada', 'cancelada', 'expirada')),
  key text not null unique, -- a mesma operação nunca reserva duas vezes
  multiplier numeric(8, 4) not null,
  credit_brl numeric(12, 6) not null,
  meta jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index ai_reservations_open_idx on public.ai_reservations (company_id, expires_at) where status = 'aberta';
alter table public.ai_reservations enable row level security;
revoke all on public.ai_reservations from authenticated, anon;
grant select, insert, update on public.ai_reservations to service_role;

/* ---------- Pacotes ---------- */

create table public.ai_credit_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '',
  credits numeric(20, 6) not null check (credits > 0),
  bonus numeric(20, 6) not null default 0 check (bonus >= 0),
  price_cents int not null check (price_cents > 0),
  active boolean not null default true,
  highlight boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_credit_packages enable row level security;
create policy "pacotes à venda" on public.ai_credit_packages for select to authenticated using (active or (select private.is_superadmin()));
revoke all on public.ai_credit_packages from authenticated, anon;
grant select on public.ai_credit_packages to authenticated;
grant select on public.ai_credit_packages to service_role;

/* ---------- Recargas (pedidos de compra) ---------- */

create table public.ai_recharges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  package_id uuid references public.ai_credit_packages (id) on delete set null,
  package_name text not null default '',
  credits numeric(20, 6) not null check (credits > 0),
  bonus numeric(20, 6) not null default 0 check (bonus >= 0),
  price_cents int not null check (price_cents > 0),
  status text not null default 'pendente' check (status in ('pendente', 'paga', 'cancelada', 'em_analise', 'estornada')),
  ref text not null unique check (ref ~ '^CR[0-9A-F]{12}$'), -- vai no link de pagamento e volta no aviso
  buyer_email text not null default '',
  checkout_url text,
  provider text not null default 'vortexpay',
  order_id text unique, -- pedido na Vórtex Pay: um pedido credita uma recarga só
  note text not null default '',
  paid_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.ai_recharges (company_id, created_at desc);
create index ai_recharges_pending_idx on public.ai_recharges (lower(buyer_email), created_at) where status in ('pendente', 'em_analise');
alter table public.ai_recharges enable row level security;
create policy "empresa vê as próprias recargas" on public.ai_recharges for select to authenticated using (private.is_member(company_id) or (select private.is_superadmin()));
revoke all on public.ai_recharges from authenticated, anon;
grant select on public.ai_recharges to authenticated;
grant select, insert, update on public.ai_recharges to service_role;

/* ---------- Avisos de pagamento (auditoria e reprocessamento) ---------- */

create table public.ai_payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'vortexpay',
  event_type text not null default '',
  order_id text,
  signature_ok boolean not null default false,
  status text not null default 'recebido' check (status in ('recebido', 'creditado', 'estornado', 'ignorado', 'sem_vinculo', 'em_analise', 'invalido', 'repetido', 'erro')),
  recharge_id uuid references public.ai_recharges (id) on delete set null,
  reason text not null default '',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- o mesmo aviso reenviado pelo provedor cai aqui de novo: o primeiro vale, o resto fica como repetido
create unique index ai_payment_events_once on public.ai_payment_events (provider, order_id, event_type) where order_id is not null and status <> 'repetido';
alter table public.ai_payment_events enable row level security;
revoke all on public.ai_payment_events from authenticated, anon;
grant select, insert, update on public.ai_payment_events to service_role;

/* ---------- Extrato (só inclusão: nada é editado nem apagado) ---------- */

create table public.ai_ledger (
  id uuid primary key default gen_random_uuid(),
  n bigint generated always as identity unique,
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('recarga', 'consumo', 'ajuste', 'estorno')),
  credits numeric(20, 6) not null, -- entra (+) ou sai (−)
  balance_after numeric(20, 6) not null,
  key text not null unique, -- recarga:<id>, consumo:<reserva>, estorno:<id>, ajuste:<id>: o mesmo lançamento nunca entra duas vezes
  description text not null default '',
  agent_id uuid,
  chat_id uuid,
  origin text check (origin is null or origin in ('atendimento', 'teste', 'verificacao', 'vendas')),
  modality text check (modality is null or modality in ('texto', 'audio', 'voz')),
  provider text,
  model text,
  units jsonb not null default '{}'::jsonb, -- tokens, segundos, caracteres (só o superadmin vê)
  cost_usd numeric(20, 8), -- custo real (só o superadmin vê)
  cost_brl numeric(20, 8),
  multiplier numeric(8, 4),
  credit_brl numeric(12, 6),
  estimated boolean not null default false, -- o provedor não informou o uso: custo por estimativa
  reservation_id uuid,
  recharge_id uuid,
  payment_event_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index on public.ai_ledger (company_id, n desc);
create index ai_ledger_consumo_idx on public.ai_ledger (company_id, created_at) where kind = 'consumo';
alter table public.ai_ledger enable row level security;
create policy "empresa vê o próprio extrato" on public.ai_ledger for select to authenticated using (private.is_member(company_id) or (select private.is_superadmin()));
revoke all on public.ai_ledger from authenticated, anon;
grant select (id, n, company_id, kind, credits, balance_after, description, agent_id, chat_id, origin, modality, recharge_id, created_at) on public.ai_ledger to authenticated;
grant select, insert on public.ai_ledger to service_role;
grant select, update on public.ai_wallets to service_role;
grant select on public.ai_billing_settings, public.ai_prices to service_role;

/* ---------- Funções do servidor (chave de serviço) ---------- */

-- Separa o saldo de uma operação antes de chamar o provedor. p_cost_usd: custo estimado em dólar.
-- Trava a carteira: duas chamadas ao mesmo tempo nunca usam o mesmo saldo.
create or replace function public.ai_wallet_reserve(p_company uuid, p_cost_usd numeric, p_key text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  s public.ai_billing_settings;
  w public.ai_wallets;
  r public.ai_reservations;
  mult numeric;
  cred numeric;
  avail numeric;
begin
  select * into s from public.ai_billing_settings where id;
  select * into w from public.ai_wallets where company_id = p_company for update;
  if not found or not w.active then return jsonb_build_object('ok', false, 'motivo', 'carteira_inativa'); end if;
  select * into r from public.ai_reservations where key = p_key;
  if found then return jsonb_build_object('ok', r.status = 'aberta', 'id', r.id, 'creditos', r.credits, 'repetida', true); end if;
  update public.ai_reservations set status = 'expirada', closed_at = now() where company_id = p_company and status = 'aberta' and expires_at <= now();
  mult := coalesce(w.multiplier, s.multiplier);
  cred := greatest(round(greatest(coalesce(p_cost_usd, 0), 0) * s.usd_brl * (1 + s.surcharge_pct / 100) * mult / s.credit_brl, 6), 0.000001);
  avail := w.balance - coalesce((select sum(x.credits) from public.ai_reservations x where x.company_id = p_company and x.status = 'aberta'), 0);
  if w.mode = 'prepago' and avail < cred then
    if w.blocked_at is null then update public.ai_wallets set blocked_at = now() where company_id = p_company; end if;
    return jsonb_build_object('ok', false, 'motivo', 'saldo_insuficiente', 'disponivel', avail, 'necessario', cred);
  end if;
  insert into public.ai_reservations (company_id, credits, key, multiplier, credit_brl, meta, expires_at)
  values (p_company, cred, p_key, mult, s.credit_brl, coalesce(p_meta, '{}'::jsonb), now() + make_interval(mins => s.reserve_minutes))
  returning * into r;
  return jsonb_build_object('ok', true, 'id', r.id, 'creditos', cred, 'disponivel', avail - cred, 'modo', w.mode);
end;
$$;

-- Desconta o consumo apurado (custo real em dólar) e fecha a reserva. Repetir a mesma reserva não desconta de novo.
-- Pode passar da reserva (a estimativa erra para menos às vezes): o saldo fica negativo e a próxima operação não sai.
create or replace function public.ai_wallet_settle(p_reservation uuid, p_cost_usd numeric, p_info jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  s public.ai_billing_settings;
  r public.ai_reservations;
  w public.ai_wallets;
  cost_brl numeric;
  cred numeric;
  charge numeric;
  nb numeric;
  avail numeric;
  alerta boolean := false;
begin
  select * into r from public.ai_reservations where id = p_reservation for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'reserva_inexistente'); end if;
  if r.status = 'liquidada' then return jsonb_build_object('ok', true, 'repetida', true); end if;
  if r.status = 'cancelada' then return jsonb_build_object('ok', false, 'motivo', 'reserva_cancelada'); end if;
  select * into s from public.ai_billing_settings where id;
  select * into w from public.ai_wallets where company_id = r.company_id for update;
  cost_brl := greatest(coalesce(p_cost_usd, 0), 0) * s.usd_brl * (1 + s.surcharge_pct / 100);
  cred := round(cost_brl * r.multiplier / r.credit_brl, 6);
  charge := case when w.mode = 'interno' then 0 else cred end;
  update public.ai_wallets set balance = balance - charge, updated_at = now() where company_id = r.company_id returning balance into nb;
  update public.ai_reservations set status = 'liquidada', closed_at = now() where id = r.id;
  insert into public.ai_ledger (company_id, kind, credits, balance_after, key, description, agent_id, chat_id, origin, modality, provider, model,
    units, cost_usd, cost_brl, multiplier, credit_brl, estimated, reservation_id)
  values (r.company_id, 'consumo', -charge, nb, 'consumo:' || r.id,
    left(coalesce(p_info ->> 'descricao', ''), 160) || case when w.mode = 'interno' then ' · uso interno, sem cobrança' else '' end,
    nullif(p_info ->> 'agentId', '')::uuid, nullif(p_info ->> 'chatId', '')::uuid,
    coalesce(nullif(p_info ->> 'origem', ''), 'atendimento'), coalesce(nullif(p_info ->> 'modalidade', ''), 'texto'),
    left(coalesce(p_info ->> 'provedor', ''), 40), left(coalesce(p_info ->> 'modelo', ''), 80), coalesce(p_info -> 'uso', '{}'::jsonb),
    greatest(coalesce(p_cost_usd, 0), 0), cost_brl, r.multiplier, r.credit_brl, coalesce((p_info ->> 'estimado')::boolean, false), r.id);
  if w.mode = 'prepago' then
    avail := nb - coalesce((select sum(x.credits) from public.ai_reservations x where x.company_id = r.company_id and x.status = 'aberta' and x.expires_at > now()), 0);
    if avail < coalesce(w.alert_credits, s.alert_credits) and w.low_alert_at is null then
      update public.ai_wallets set low_alert_at = now() where company_id = r.company_id;
      alerta := true;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'creditos', charge, 'saldo', nb, 'alerta', alerta);
end;
$$;

-- O provedor falhou (nada a cobrar): devolve a reserva.
create or replace function public.ai_wallet_release(p_reservation uuid)
returns void language sql security invoker set search_path = public as $$
  update public.ai_reservations set status = 'cancelada', closed_at = now() where id = p_reservation and status in ('aberta', 'expirada');
$$;

-- Saldo livre agora (saldo − reservas abertas). null = a empresa não pode usar a IA da plataforma.
create or replace function public.ai_wallet_available(p_company uuid)
returns jsonb language sql stable security invoker set search_path = public as $$
  select case when w.company_id is null or not w.active then null else jsonb_build_object(
    'modo', w.mode,
    'disponivel', w.balance - coalesce((select sum(x.credits) from public.ai_reservations x where x.company_id = w.company_id and x.status = 'aberta' and x.expires_at > now()), 0)
  ) end
  from (select 1) one left join public.ai_wallets w on w.company_id = p_company;
$$;

-- Pagamento confirmado: credita a recarga uma vez só (a mesma recarga ou o mesmo pedido nunca creditam duas vezes).
create or replace function public.ai_recharge_confirm(p_recharge uuid, p_order text, p_event uuid default null, p_note text default '')
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  r public.ai_recharges;
  total numeric;
  nb numeric;
begin
  select * into r from public.ai_recharges where id = p_recharge for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'recarga_inexistente'); end if;
  if r.status = 'paga' then return jsonb_build_object('ok', true, 'repetida', true); end if;
  if r.status = 'estornada' then return jsonb_build_object('ok', false, 'motivo', 'recarga_estornada'); end if;
  if p_order is not null and exists (select 1 from public.ai_recharges x where x.order_id = p_order and x.id <> r.id) then
    return jsonb_build_object('ok', false, 'motivo', 'pedido_ja_usado');
  end if;
  total := r.credits + r.bonus;
  insert into public.ai_wallets (company_id, active) values (r.company_id, false) on conflict (company_id) do nothing;
  update public.ai_wallets set balance = balance + total, low_alert_at = null, blocked_at = null, updated_at = now()
  where company_id = r.company_id returning balance into nb;
  update public.ai_recharges set status = 'paga', order_id = coalesce(p_order, order_id), paid_at = now(), updated_at = now(),
    note = left(coalesce(nullif(p_note, ''), note), 300)
  where id = r.id;
  insert into public.ai_ledger (company_id, kind, credits, balance_after, key, description, recharge_id, payment_event_id)
  values (r.company_id, 'recarga', total, nb, 'recarga:' || r.id,
    'Recarga · ' || r.package_name || case when r.bonus > 0 then ' (com bônus)' else '' end, r.id, p_event);
  return jsonb_build_object('ok', true, 'creditos', total, 'saldo', nb, 'empresa', r.company_id);
end;
$$;

-- Reembolso ou chargeback de um pedido já creditado: tira os créditos (o saldo pode ficar negativo).
create or replace function public.ai_recharge_reverse(p_order text, p_reason text, p_event uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  r public.ai_recharges;
  total numeric;
  nb numeric;
begin
  select * into r from public.ai_recharges where order_id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'pedido_sem_recarga'); end if;
  if r.status = 'estornada' then return jsonb_build_object('ok', true, 'repetida', true); end if;
  if r.status <> 'paga' then
    update public.ai_recharges set status = 'cancelada', updated_at = now(), note = left(p_reason, 300) where id = r.id;
    return jsonb_build_object('ok', true, 'creditado', false);
  end if;
  total := r.credits + r.bonus;
  update public.ai_wallets set balance = balance - total, updated_at = now() where company_id = r.company_id returning balance into nb;
  update public.ai_recharges set status = 'estornada', updated_at = now(), note = left(p_reason, 300) where id = r.id;
  insert into public.ai_ledger (company_id, kind, credits, balance_after, key, description, recharge_id, payment_event_id)
  values (r.company_id, 'estorno', -total, nb, 'estorno:' || r.id, left('Estorno · ' || r.package_name || ' (' || p_reason || ')', 160), r.id, p_event);
  return jsonb_build_object('ok', true, 'creditos', -total, 'saldo', nb, 'empresa', r.company_id);
end;
$$;

revoke execute on function public.ai_wallet_reserve(uuid, numeric, text, jsonb), public.ai_wallet_settle(uuid, numeric, jsonb),
  public.ai_wallet_release(uuid), public.ai_wallet_available(uuid), public.ai_recharge_confirm(uuid, text, uuid, text),
  public.ai_recharge_reverse(text, text, uuid) from public, anon, authenticated;
grant execute on function public.ai_wallet_reserve(uuid, numeric, text, jsonb), public.ai_wallet_settle(uuid, numeric, jsonb),
  public.ai_wallet_release(uuid), public.ai_wallet_available(uuid), public.ai_recharge_confirm(uuid, text, uuid, text),
  public.ai_recharge_reverse(text, text, uuid) to service_role;

/* ---------- Funções do painel da empresa ---------- */

-- Saldo da empresa (sem multiplicador nem custo).
create or replace function public.ai_wallet_summary(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  w public.ai_wallets;
  s public.ai_billing_settings;
  res numeric;
begin
  if not private.is_member(p_company) and not private.is_superadmin() then raise exception 'Empresa não encontrada.'; end if;
  select * into s from public.ai_billing_settings where id;
  select * into w from public.ai_wallets where company_id = p_company;
  if not found then return jsonb_build_object('exists', false, 'creditBrl', s.credit_brl); end if;
  res := coalesce((select sum(x.credits) from public.ai_reservations x where x.company_id = p_company and x.status = 'aberta' and x.expires_at > now()), 0);
  return jsonb_build_object('exists', true, 'active', w.active, 'mode', w.mode, 'balance', w.balance, 'reserved', res, 'available', w.balance - res,
    'alertCredits', coalesce(w.alert_credits, s.alert_credits), 'ownAlert', w.alert_credits is not null, 'lowAlertAt', w.low_alert_at,
    'blockedAt', w.blocked_at, 'creditBrl', s.credit_brl, 'paymentReady', s.vortexpay_product_id <> '');
end;
$$;

-- Consumo por agente, por tipo (texto, áudio, voz) e por dia desde p_from (créditos e operações; custo não aparece).
create or replace function public.ai_wallet_usage(p_company uuid, p_from timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member(p_company) and not private.is_superadmin() then raise exception 'Empresa não encontrada.'; end if;
  return jsonb_build_object(
    'byAgent', coalesce((select jsonb_agg(x order by x.credits desc) from (
      select l.agent_id as "agentId", coalesce(a.name, case when l.agent_id is null then 'Sem agente' else 'Agente excluído' end) as name,
        count(*) as ops, -sum(l.credits) as credits
      from public.ai_ledger l left join public.agents a on a.id = l.agent_id
      where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_from group by 1, 2) x), '[]'::jsonb),
    'byModality', coalesce((select jsonb_agg(x order by x.credits desc) from (
      select l.modality, count(*) as ops, -sum(l.credits) as credits
      from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_from group by 1) x), '[]'::jsonb),
    'byOrigin', coalesce((select jsonb_agg(x order by x.credits desc) from (
      select l.origin, count(*) as ops, -sum(l.credits) as credits
      from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_from group by 1) x), '[]'::jsonb),
    'byDay', coalesce((select jsonb_agg(x order by x.day) from (
      select (l.created_at at time zone 'America/Sao_Paulo')::date as day, count(*) as ops, -sum(l.credits) as credits,
        count(distinct l.chat_id) as chats
      from public.ai_ledger l where l.company_id = p_company and l.kind = 'consumo' and l.created_at >= p_from group by 1) x), '[]'::jsonb)
  );
end;
$$;

-- Saldo baixo: o admin da empresa escolhe o limite do aviso (null volta ao padrão).
create or replace function public.ai_wallet_set_alert(p_company uuid, p_credits numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin(p_company) then raise exception 'Só o proprietário ou um admin da empresa muda o aviso.'; end if;
  if p_credits is not null and (p_credits < 0 or p_credits > 100000000) then raise exception 'Limite inválido.'; end if;
  update public.ai_wallets set alert_credits = p_credits, low_alert_at = null, updated_at = now() where company_id = p_company;
end;
$$;

-- Pedido de recarga na empresa aberta (profiles.current_company_id). A função creditos cria a oferta na Vórtex Pay.
create or replace function public.ai_recharge_create(p_package uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
  p public.ai_credit_packages;
  w public.ai_wallets;
  r public.ai_recharges;
  email text;
begin
  select current_company_id into cid from public.profiles where id = (select auth.uid());
  if cid is null or not private.is_admin(cid) then raise exception 'Só o proprietário ou um admin da empresa compra créditos.'; end if;
  select * into p from public.ai_credit_packages where id = p_package and active;
  if not found then raise exception 'Pacote indisponível.'; end if;
  select * into w from public.ai_wallets where company_id = cid;
  if not found or not w.active then raise exception 'A IA da plataforma não está liberada para esta empresa. Fale com o suporte.'; end if;
  if w.mode = 'interno' then raise exception 'Esta empresa usa a IA da plataforma sem cobrança (uso interno).'; end if;
  if (select count(*) from public.ai_recharges x where x.company_id = cid and x.status = 'pendente' and x.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Muitas recargas abertas hoje. Conclua ou cancele as que estão pendentes.';
  end if;
  select lower(coalesce(pr.email, '')) into email from public.profiles pr where pr.id = (select auth.uid());
  insert into public.ai_recharges (company_id, package_id, package_name, credits, bonus, price_cents, ref, buyer_email, created_by)
  values (cid, p.id, p.name, p.credits, p.bonus, p.price_cents, 'CR' || upper(encode(extensions.gen_random_bytes(6), 'hex')), email, (select auth.uid()))
  returning * into r;
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'priceCents', r.price_cents, 'companyId', cid, 'buyerEmail', r.buyer_email);
end;
$$;

-- Desistiu antes de pagar. Se o pagamento chegar mesmo assim, ele credita (ai_recharge_confirm aceita).
create or replace function public.ai_recharge_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
begin
  select company_id into cid from public.ai_recharges where id = p_id;
  if cid is null or not private.is_admin(cid) then raise exception 'Recarga não encontrada.'; end if;
  update public.ai_recharges set status = 'cancelada', updated_at = now() where id = p_id and status = 'pendente';
end;
$$;

revoke execute on function public.ai_wallet_summary(uuid), public.ai_wallet_usage(uuid, timestamptz), public.ai_wallet_set_alert(uuid, numeric),
  public.ai_recharge_create(uuid), public.ai_recharge_cancel(uuid) from public, anon;
grant execute on function public.ai_wallet_summary(uuid), public.ai_wallet_usage(uuid, timestamptz), public.ai_wallet_set_alert(uuid, numeric),
  public.ai_recharge_create(uuid), public.ai_recharge_cancel(uuid) to authenticated;

/* ---------- Funções do superadmin ---------- */

-- Preço em dólar por unidade para um modelo (o mais específico que casar; senão o "*").
create or replace function private.ai_price(p_model text, p_unit text)
returns numeric language sql stable security definer set search_path = '' as $$
  select p.usd from public.ai_prices p
  where p.unit = p_unit and (p.model = regexp_replace(lower(coalesce(p_model, '')), '^[a-z0-9_.-]+/', '')
    or regexp_replace(lower(coalesce(p_model, '')), '^[a-z0-9_.-]+/', '') like p.model || '%' or p.model = '*')
  order by (p.model = '*'), length(p.model) desc limit 1;
$$;

create or replace function public.sa_ai_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from public.ai_billing_settings s where s.id),
    'prices', coalesce((select jsonb_agg(to_jsonb(p) order by p.model = '*', p.provider, p.model, p.unit) from public.ai_prices p), '[]'::jsonb),
    'packages', coalesce((select jsonb_agg(to_jsonb(k) order by k.sort, k.price_cents) from public.ai_credit_packages k), '[]'::jsonb)
  );
end;
$$;

create or replace function public.sa_ai_settings_save(p_credit_brl numeric, p_multiplier numeric, p_usd_brl numeric, p_surcharge_pct numeric,
  p_alert_credits numeric, p_reserve_minutes int, p_product text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  antes jsonb;
begin
  perform private.require_superadmin();
  select to_jsonb(s) - 'id' into antes from public.ai_billing_settings s where s.id;
  update public.ai_billing_settings set credit_brl = p_credit_brl, multiplier = p_multiplier, usd_brl = p_usd_brl, surcharge_pct = p_surcharge_pct,
    alert_credits = p_alert_credits, reserve_minutes = p_reserve_minutes, vortexpay_product_id = trim(coalesce(p_product, '')),
    updated_at = now(), updated_by = (select auth.uid())
  where id;
  perform private.audit('creditos_config', null, jsonb_build_object('antes', antes, 'depois', (select to_jsonb(s) - 'id' from public.ai_billing_settings s where s.id)));
end;
$$;

create or replace function public.sa_ai_price_save(p_id uuid, p_provider text, p_model text, p_unit text, p_usd numeric, p_source text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  if p_id is null then
    insert into public.ai_prices (provider, model, unit, usd, source) values (trim(coalesce(p_provider, '')), lower(trim(p_model)), p_unit, p_usd, coalesce(p_source, ''))
    on conflict (model, unit) do update set provider = excluded.provider, usd = excluded.usd, source = excluded.source, updated_at = now();
  else
    update public.ai_prices set provider = trim(coalesce(p_provider, '')), model = lower(trim(p_model)), unit = p_unit, usd = p_usd, source = coalesce(p_source, ''), updated_at = now() where id = p_id;
  end if;
  perform private.audit('creditos_preco', null, jsonb_build_object('modelo', lower(trim(p_model)), 'unidade', p_unit, 'usd', p_usd));
end;
$$;

create or replace function public.sa_ai_price_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  if (select model from public.ai_prices where id = p_id) = '*' then raise exception 'O preço de segurança (*) não pode ser apagado, só alterado.'; end if;
  delete from public.ai_prices where id = p_id;
end;
$$;

create or replace function public.sa_ai_package_save(p_id uuid, p_name text, p_description text, p_credits numeric, p_bonus numeric, p_price_cents int,
  p_active boolean, p_highlight boolean, p_sort int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  novo uuid;
begin
  perform private.require_superadmin();
  if p_id is null then
    insert into public.ai_credit_packages (name, description, credits, bonus, price_cents, active, highlight, sort)
    values (trim(p_name), coalesce(p_description, ''), p_credits, coalesce(p_bonus, 0), p_price_cents, p_active, p_highlight, coalesce(p_sort, 0)) returning id into novo;
  else
    update public.ai_credit_packages set name = trim(p_name), description = coalesce(p_description, ''), credits = p_credits, bonus = coalesce(p_bonus, 0),
      price_cents = p_price_cents, active = p_active, highlight = p_highlight, sort = coalesce(p_sort, 0), updated_at = now()
    where id = p_id returning id into novo;
  end if;
  perform private.audit('creditos_pacote', null, jsonb_build_object('id', novo, 'nome', p_name, 'creditos', p_credits, 'bonus', p_bonus, 'centavos', p_price_cents, 'ativo', p_active));
  return novo;
end;
$$;

-- Pacote já vendido não some (as recargas guardam o nome e os créditos): só desativa.
create or replace function public.sa_ai_package_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  if exists (select 1 from public.ai_recharges where package_id = p_id) then
    update public.ai_credit_packages set active = false, updated_at = now() where id = p_id;
  else
    delete from public.ai_credit_packages where id = p_id;
  end if;
end;
$$;

-- Carteiras de todas as empresas com o consumo, o custo e a margem do período.
create or replace function public.sa_ai_wallets(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.cost_brl desc nulls last, x.name) from (
    select c.id, c.name, w.company_id is not null as has_wallet, coalesce(w.active, false) as active, w.mode, w.balance, w.multiplier, w.alert_credits,
      w.low_alert_at, w.blocked_at,
      coalesce((select sum(r.credits) from public.ai_reservations r where r.company_id = c.id and r.status = 'aberta' and r.expires_at > now()), 0) as reserved,
      (select count(*) from public.ai_ledger l where l.company_id = c.id and l.kind = 'consumo' and l.created_at >= p_from and l.created_at < p_to) as ops,
      (select coalesce(-sum(l.credits), 0) from public.ai_ledger l where l.company_id = c.id and l.kind = 'consumo' and l.created_at >= p_from and l.created_at < p_to) as credits_used,
      (select coalesce(sum(-l.credits * l.credit_brl), 0) from public.ai_ledger l where l.company_id = c.id and l.kind = 'consumo' and l.created_at >= p_from and l.created_at < p_to) as revenue_brl,
      (select coalesce(sum(l.cost_brl), 0) from public.ai_ledger l where l.company_id = c.id and l.kind = 'consumo' and l.created_at >= p_from and l.created_at < p_to) as cost_brl,
      (select coalesce(sum(r.price_cents), 0) from public.ai_recharges r where r.company_id = c.id and r.status = 'paga' and r.paid_at >= p_from and r.paid_at < p_to) as recharged_cents,
      (select count(*) from public.ai_recharges r where r.company_id = c.id and r.status in ('pendente', 'em_analise')) as pending_recharges
    from public.companies c left join public.ai_wallets w on w.company_id = c.id
    where w.company_id is not null or exists (select 1 from public.ai_ledger l where l.company_id = c.id)
  ) x), '[]'::jsonb);
end;
$$;

-- Liga, desliga e configura a carteira de uma empresa (modo, multiplicador próprio, aviso de saldo baixo).
create or replace function public.sa_ai_wallet_set(p_company uuid, p_active boolean, p_mode text, p_multiplier numeric, p_alert_credits numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  antes jsonb;
begin
  perform private.require_superadmin();
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'Empresa não encontrada'; end if;
  select to_jsonb(w) into antes from public.ai_wallets w where w.company_id = p_company;
  insert into public.ai_wallets (company_id, active, mode, multiplier, alert_credits) values (p_company, p_active, p_mode, p_multiplier, p_alert_credits)
  on conflict (company_id) do update set active = excluded.active, mode = excluded.mode, multiplier = excluded.multiplier,
    alert_credits = excluded.alert_credits, updated_at = now();
  perform private.audit('creditos_carteira', p_company, jsonb_build_object('antes', antes, 'depois', jsonb_build_object('ativa', p_active, 'modo', p_mode, 'multiplicador', p_multiplier, 'aviso', p_alert_credits)));
end;
$$;

-- Ajuste manual de saldo (cortesia, correção), com motivo. Vai para o extrato da empresa.
create or replace function public.sa_ai_wallet_adjust(p_company uuid, p_credits numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  nb numeric;
  id uuid := gen_random_uuid();
begin
  perform private.require_superadmin();
  if coalesce(p_credits, 0) = 0 then raise exception 'Informe os créditos (positivo para dar, negativo para tirar).'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Escreva o motivo do ajuste.'; end if;
  insert into public.ai_wallets (company_id, active) values (p_company, false) on conflict (company_id) do nothing;
  update public.ai_wallets set balance = balance + p_credits, updated_at = now(),
    low_alert_at = case when p_credits > 0 then null else low_alert_at end, blocked_at = case when p_credits > 0 then null else blocked_at end
  where company_id = p_company returning balance into nb;
  insert into public.ai_ledger (company_id, kind, credits, balance_after, key, description, created_by)
  values (p_company, 'ajuste', p_credits, nb, 'ajuste:' || id, left('Ajuste · ' || trim(p_reason), 160), (select auth.uid()));
  perform private.audit('creditos_ajuste', p_company, jsonb_build_object('creditos', p_credits, 'motivo', trim(p_reason), 'saldo', nb));
  return jsonb_build_object('saldo', nb);
end;
$$;

-- Extrato completo de uma empresa (com custo real, multiplicador e uso técnico).
create or replace function public.sa_ai_ledger(p_company uuid, p_limit int, p_before bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.n desc) from (
    select l.*, a.name as agent_name from public.ai_ledger l left join public.agents a on a.id = l.agent_id
    where l.company_id = p_company and (p_before is null or l.n < p_before) order by l.n desc limit least(coalesce(p_limit, 100), 500)) x), '[]'::jsonb);
end;
$$;

-- Recargas e avisos de pagamento (os que pedem atenção primeiro).
create or replace function public.sa_ai_payments(p_limit int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return jsonb_build_object(
    'recharges', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
      select r.*, c.name as company_name from public.ai_recharges r join public.companies c on c.id = r.company_id order by r.created_at desc limit least(coalesce(p_limit, 100), 500)) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.received_at desc) from (
      select e.id, e.provider, e.event_type, e.order_id, e.signature_ok, e.status, e.recharge_id, e.reason, e.received_at, e.processed_at,
        e.payload -> 'Customer' ->> 'email' as email, e.payload -> 'Product' ->> 'product_id' as product_id
      from public.ai_payment_events e order by e.received_at desc limit least(coalesce(p_limit, 100), 500)) x), '[]'::jsonb)
  );
end;
$$;

-- Aviso de pagamento que não achou a recarga sozinho (o comprador usou outro e-mail): o superadmin confere e vincula.
create or replace function public.sa_ai_link_payment(p_event uuid, p_recharge uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.ai_payment_events;
  res jsonb;
begin
  perform private.require_superadmin();
  select * into e from public.ai_payment_events where id = p_event for update;
  if not found then raise exception 'Aviso não encontrado.'; end if;
  if not e.signature_ok then raise exception 'Aviso sem assinatura válida: não pode creditar.'; end if;
  if e.status not in ('sem_vinculo', 'em_analise') then raise exception 'Este aviso já foi tratado (%).', e.status; end if;
  res := public.ai_recharge_confirm(p_recharge, e.order_id, e.id, 'vinculado à mão pelo superadmin');
  if not coalesce((res ->> 'ok')::boolean, false) then raise exception 'Não creditou: %', res ->> 'motivo'; end if;
  update public.ai_payment_events set status = 'creditado', recharge_id = p_recharge, processed_at = now(), reason = 'vinculado à mão' where id = e.id;
  perform private.audit('creditos_vinculo', (select company_id from public.ai_recharges where id = p_recharge), jsonb_build_object('aviso', e.id, 'pedido', e.order_id));
  return res;
end;
$$;

-- Histórico de uso da IA da plataforma antes da carteira (ai_runs), com o custo estimado pela tabela de preços.
-- Só para dimensionar pacotes: nada disso é descontado.
create or replace function public.sa_ai_history(p_company uuid, p_from timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_superadmin();
  return jsonb_build_object(
    'models', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select r.provider, r.model, count(*) as runs, count(distinct r.chat_id) as chats, sum(r.input_tokens) as input_tokens, sum(r.output_tokens) as output_tokens,
        sum(r.input_tokens) / 1e6 * private.ai_price(r.model, 'input_mtok') + sum(r.output_tokens) / 1e6 * private.ai_price(r.model, 'output_mtok') as cost_usd
      from public.ai_runs r where r.company_id = p_company and r.created_at >= p_from and r.input_tokens > 0 and r.provider not in ('simulado', '')
      group by 1, 2) x), '[]'::jsonb),
    'transcripts', (select jsonb_build_object('n', count(*), 'chars', coalesce(sum(length(m.extra ->> 'transcript')), 0))
      from public.messages m where m.company_id = p_company and m.at >= p_from and m.extra ? 'transcript'),
    'voice', (select jsonb_build_object('n', count(*), 'chars', coalesce(sum(length(m.text)), 0))
      from public.messages m where m.company_id = p_company and m.at >= p_from and m.type = 'audio' and m.extra ? 'tts'),
    'days', (select count(distinct (r.created_at at time zone 'America/Sao_Paulo')::date) from public.ai_runs r where r.company_id = p_company and r.created_at >= p_from and r.input_tokens > 0)
  );
end;
$$;

revoke execute on function private.ai_price(text, text) from public, anon;
grant execute on function private.ai_price(text, text) to authenticated;
revoke execute on function public.sa_ai_settings(), public.sa_ai_settings_save(numeric, numeric, numeric, numeric, numeric, int, text),
  public.sa_ai_price_save(uuid, text, text, text, numeric, text), public.sa_ai_price_delete(uuid),
  public.sa_ai_package_save(uuid, text, text, numeric, numeric, int, boolean, boolean, int), public.sa_ai_package_delete(uuid),
  public.sa_ai_wallets(timestamptz, timestamptz), public.sa_ai_wallet_set(uuid, boolean, text, numeric, numeric),
  public.sa_ai_wallet_adjust(uuid, numeric, text), public.sa_ai_ledger(uuid, int, bigint), public.sa_ai_payments(int),
  public.sa_ai_link_payment(uuid, uuid), public.sa_ai_history(uuid, timestamptz) from public, anon;
grant execute on function public.sa_ai_settings(), public.sa_ai_settings_save(numeric, numeric, numeric, numeric, numeric, int, text),
  public.sa_ai_price_save(uuid, text, text, text, numeric, text), public.sa_ai_price_delete(uuid),
  public.sa_ai_package_save(uuid, text, text, numeric, numeric, int, boolean, boolean, int), public.sa_ai_package_delete(uuid),
  public.sa_ai_wallets(timestamptz, timestamptz), public.sa_ai_wallet_set(uuid, boolean, text, numeric, numeric),
  public.sa_ai_wallet_adjust(uuid, numeric, text), public.sa_ai_ledger(uuid, int, bigint), public.sa_ai_payments(int),
  public.sa_ai_link_payment(uuid, uuid), public.sa_ai_history(uuid, timestamptz) to authenticated;
