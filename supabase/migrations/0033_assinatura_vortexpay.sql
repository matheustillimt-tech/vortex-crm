-- Assinatura do plano pela Vórtex Pay: o cliente clica em "Ativar plano" (Cobrança e Assinatura), paga a oferta do
-- plano e a assinatura fica ativa sozinha por um mês.
-- - Mesmo caminho da recarga de Créditos de IA (0031): pedido aqui com um código (AS + 12 hex) que vai no link, aviso
--   assinado no creditos-webhook (o produto e o código do aviso dizem se é recarga ou plano), valor conferido no aviso
--   ou na API da Vórtex Pay, e plan_payment_confirm ativa uma vez por pedido. Reembolso e chargeback tiram o mês pago.
-- - A API de ofertas só cria link a partir de R$ 997: o plano usa o link fixo da oferta (plan_settings.checkout_url,
--   criada à mão no produto do plano na Vórtex Pay).
-- - Em dia, o mês pago começa no vencimento; vencida, em teste ou cancelada, começa no pagamento.
-- - A assinatura paga fica com source 'provider' ("Confirmado pelo provedor" no painel do superadmin) e gera a fatura.
-- Só adiciona (fora a situação "ativado" nos avisos e a regra de vencida do sa_companies, que passa a valer também
-- para a assinatura paga).

/* ---------- Plano à venda (uma linha) ---------- */

create table public.plan_settings (
  id boolean primary key default true check (id),
  name text not null default 'Pro' check (char_length(name) between 1 and 40),
  price_cents int not null default 40000 check (price_cents > 0),
  vortexpay_product_id text not null default '',
  checkout_url text not null default '' check (checkout_url = '' or checkout_url ~ '^https://'),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.plan_settings default values;
alter table public.plan_settings enable row level security;
create policy "plano à venda" on public.plan_settings for select to authenticated using (true);
revoke all on public.plan_settings from authenticated, anon;
grant select on public.plan_settings to authenticated;
grant select on public.plan_settings to service_role;

/* ---------- Pagamentos do plano (pedidos) ---------- */

create table public.plan_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  plan_name text not null default '',
  price_cents int not null check (price_cents > 0),
  status text not null default 'pendente' check (status in ('pendente', 'paga', 'cancelada', 'em_analise', 'estornada')),
  ref text not null unique check (ref ~ '^AS[0-9A-F]{12}$'), -- vai no link de pagamento e volta no aviso
  buyer_email text not null default '',
  checkout_url text,
  provider text not null default 'vortexpay',
  order_id text unique, -- pedido na Vórtex Pay: um pedido ativa um mês só
  note text not null default '',
  period_start timestamptz,
  period_end timestamptz,
  invoice_id uuid references public.invoices (id) on delete set null,
  paid_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.plan_payments (company_id, created_at desc);
create index plan_payments_pending_idx on public.plan_payments (lower(buyer_email), created_at) where status in ('pendente', 'em_analise');
create index on public.plan_payments (invoice_id);
create index on public.plan_payments (created_by);
alter table public.plan_payments enable row level security;
create policy "empresa vê os próprios pagamentos do plano" on public.plan_payments for select to authenticated using (private.is_member(company_id) or (select private.is_superadmin()));
revoke all on public.plan_payments from authenticated, anon;
grant select on public.plan_payments to authenticated;
grant select, insert, update on public.plan_payments to service_role;

-- Os avisos da Vórtex Pay são os mesmos da recarga: o do plano aponta para o pagamento do plano.
alter table public.ai_payment_events add column plan_payment_id uuid references public.plan_payments (id) on delete set null;
create index on public.ai_payment_events (plan_payment_id);
alter table public.ai_payment_events drop constraint ai_payment_events_status_check;
alter table public.ai_payment_events add constraint ai_payment_events_status_check
  check (status in ('recebido', 'creditado', 'ativado', 'estornado', 'ignorado', 'sem_vinculo', 'em_analise', 'invalido', 'repetido', 'erro'));

-- Vencida: agora o plano pago também vence (cada pagamento vale um mês; sem o próximo, passa do vencimento).
-- Igual à 0003, só sem o "s.source = 'manual'" na regra do ativo com renovação no passado.
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
          when s.status = 'active' and s.renews_at < now() then 'past_due'
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

/* ---------- Funções do servidor (chave de serviço) ---------- */

-- Pagamento confirmado: ativa (ou estende) a assinatura um mês e gera a fatura, uma vez só por pagamento e por pedido.
create or replace function public.plan_payment_confirm(p_payment uuid, p_order text, p_event uuid default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.plan_payments;
  sub public.company_subscriptions;
  ini timestamptz;
  fim timestamptz;
  inv uuid;
begin
  select * into p from public.plan_payments where id = p_payment for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'pagamento_inexistente'); end if;
  if p.status = 'paga' then return jsonb_build_object('ok', true, 'repetida', true, 'ate', p.period_end); end if;
  if p.status = 'estornada' then return jsonb_build_object('ok', false, 'motivo', 'pagamento_estornado'); end if;
  if p_order is not null and exists (select 1 from public.plan_payments x where x.order_id = p_order and x.id <> p.id) then
    return jsonb_build_object('ok', false, 'motivo', 'pedido_ja_usado');
  end if;
  select * into sub from public.company_subscriptions where company_id = p.company_id for update;
  ini := case when sub.status = 'active' and sub.renews_at > now() then sub.renews_at else now() end;
  fim := ini + interval '1 month';
  insert into public.invoices (company_id, number, amount, status, date, extra)
  values (p.company_id, p.ref, round(p.price_cents / 100.0, 2), 'paga', now(),
    jsonb_build_object('plan', p.plan_name, 'orderId', p_order, 'planPaymentId', p.id, 'periodStart', ini, 'periodEnd', fim))
  returning id into inv;
  insert into public.company_subscriptions (company_id, plan, status, source, provider, provider_ref, renews_at, confirmed_at)
  values (p.company_id, p.plan_name, 'active', 'provider', 'vortexpay', p_order, fim, now())
  on conflict (company_id) do update set plan = excluded.plan, status = 'active', source = 'provider', provider = 'vortexpay',
    provider_ref = excluded.provider_ref, renews_at = excluded.renews_at, canceled_at = null, confirmed_at = now();
  update public.plan_payments set status = 'paga', order_id = coalesce(p_order, order_id), paid_at = now(), period_start = ini,
    period_end = fim, invoice_id = inv, note = left(coalesce(nullif(p_note, ''), note), 300), updated_at = now()
  where id = p.id;
  perform private.audit('assinatura_paga', p.company_id, jsonb_build_object('pagamento', p.id, 'pedido', p_order, 'centavos', p.price_cents, 'ate', fim, 'aviso', p_event));
  return jsonb_build_object('ok', true, 'empresa', p.company_id, 'ate', fim);
end;
$$;

-- Reembolso ou chargeback de um pedido do plano: tira o mês pago (sem período pago sobrando, a assinatura é cancelada).
create or replace function public.plan_payment_reverse(p_order text, p_reason text, p_event uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.plan_payments;
  mes interval;
begin
  select * into p from public.plan_payments where order_id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'pedido_sem_pagamento'); end if;
  if p.status = 'estornada' then return jsonb_build_object('ok', true, 'repetida', true); end if;
  if p.status <> 'paga' then
    update public.plan_payments set status = 'cancelada', note = left(p_reason, 300), updated_at = now() where id = p.id;
    return jsonb_build_object('ok', true, 'desfeito', false);
  end if;
  mes := p.period_end - p.period_start;
  update public.plan_payments set status = 'estornada', note = left(p_reason, 300), updated_at = now() where id = p.id;
  update public.invoices set status = 'estornada', updated_at = now() where id = p.invoice_id;
  update public.company_subscriptions s set
    renews_at = s.renews_at - mes,
    status = case when s.renews_at - mes <= now() then 'canceled' else s.status end,
    canceled_at = case when s.renews_at - mes <= now() then now() else s.canceled_at end
  where s.company_id = p.company_id and s.status = 'active' and s.renews_at is not null;
  perform private.audit('assinatura_estornada', p.company_id, jsonb_build_object('pagamento', p.id, 'pedido', p_order, 'motivo', p_reason, 'aviso', p_event));
  return jsonb_build_object('ok', true, 'desfeito', true, 'empresa', p.company_id);
end;
$$;

revoke execute on function public.plan_payment_confirm(uuid, text, uuid, text), public.plan_payment_reverse(text, text, uuid) from public, anon, authenticated;
grant execute on function public.plan_payment_confirm(uuid, text, uuid, text), public.plan_payment_reverse(text, text, uuid) to service_role;

/* ---------- Funções do painel da empresa ---------- */

-- Pedido de pagamento do plano na empresa aberta (profiles.current_company_id). A função assinatura monta o link.
create or replace function public.plan_payment_create()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
  s public.plan_settings;
  p public.plan_payments;
  email text;
begin
  select current_company_id into cid from public.profiles where id = (select auth.uid());
  if cid is null or not private.is_admin(cid) then raise exception 'Só o proprietário ou um admin da empresa ativa o plano.'; end if;
  select * into s from public.plan_settings where id;
  if (select count(*) from public.plan_payments x where x.company_id = cid and x.status = 'pendente' and x.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Muitos pagamentos abertos hoje. Conclua o que já está aberto ou tente amanhã.';
  end if;
  select lower(coalesce(pr.email, '')) into email from public.profiles pr where pr.id = (select auth.uid());
  insert into public.plan_payments (company_id, plan_name, price_cents, ref, buyer_email, created_by)
  values (cid, s.name, s.price_cents, 'AS' || upper(encode(extensions.gen_random_bytes(6), 'hex')), email, (select auth.uid()))
  returning * into p;
  return jsonb_build_object('id', p.id, 'ref', p.ref, 'priceCents', p.price_cents, 'companyId', cid);
end;
$$;

revoke execute on function public.plan_payment_create() from public, anon;
grant execute on function public.plan_payment_create() to authenticated;

/* ---------- Superadmin ---------- */

create or replace function public.sa_plan_settings_save(p_name text, p_price_cents int, p_product_id text, p_checkout_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  link text := trim(coalesce(p_checkout_url, ''));
begin
  perform private.require_superadmin();
  if coalesce(p_price_cents, 0) <= 0 then raise exception 'Preço inválido.'; end if;
  if link <> '' and link !~ '^https://' then raise exception 'O link da oferta precisa começar com https://'; end if;
  update public.plan_settings set name = coalesce(nullif(trim(p_name), ''), 'Pro'), price_cents = p_price_cents,
    vortexpay_product_id = trim(coalesce(p_product_id, '')), checkout_url = link, updated_at = now(), updated_by = (select auth.uid())
  where id;
  perform private.audit('plano_config', null, jsonb_build_object('nome', p_name, 'centavos', p_price_cents, 'produto', p_product_id, 'link', link));
end;
$$;

revoke execute on function public.sa_plan_settings_save(text, int, text, text) from public, anon;
grant execute on function public.sa_plan_settings_save(text, int, text, text) to authenticated;
