-- Créditos de IA: link fixo da oferta de cada pacote na Vórtex Pay.
-- A API de ofertas da Vórtex Pay (/api/integracao/ofertas) só cria link a partir de R$ 997 (o piso que protege os
-- links do módulo Comandos), e os pacotes de créditos custam menos. Com o link do pacote (oferta criada à mão no
-- produto Créditos de IA, aba Ofertas), o Comprar abre direto essa oferta com o código da recarga; sem link, a função
-- creditos tenta a API como antes. A confirmação do pagamento não muda (assinatura + valor conferido).
-- Só adiciona.

alter table public.ai_credit_packages
  add column checkout_url text not null default '' check (checkout_url = '' or checkout_url ~ '^https://');

drop function public.sa_ai_package_save(uuid, text, text, numeric, numeric, int, boolean, boolean, int);
create function public.sa_ai_package_save(p_id uuid, p_name text, p_description text, p_credits numeric, p_bonus numeric, p_price_cents int,
  p_active boolean, p_highlight boolean, p_sort int, p_checkout_url text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  novo uuid;
  link text := trim(coalesce(p_checkout_url, ''));
begin
  perform private.require_superadmin();
  if link <> '' and link !~ '^https://' then raise exception 'O link da oferta precisa começar com https://'; end if;
  if p_id is null then
    insert into public.ai_credit_packages (name, description, credits, bonus, price_cents, active, highlight, sort, checkout_url)
    values (trim(p_name), coalesce(p_description, ''), p_credits, coalesce(p_bonus, 0), p_price_cents, p_active, p_highlight, coalesce(p_sort, 0), link) returning id into novo;
  else
    update public.ai_credit_packages set name = trim(p_name), description = coalesce(p_description, ''), credits = p_credits, bonus = coalesce(p_bonus, 0),
      price_cents = p_price_cents, active = p_active, highlight = p_highlight, sort = coalesce(p_sort, 0), checkout_url = link, updated_at = now()
    where id = p_id returning id into novo;
  end if;
  perform private.audit('creditos_pacote', null, jsonb_build_object('id', novo, 'nome', p_name, 'creditos', p_credits, 'bonus', p_bonus, 'centavos', p_price_cents, 'ativo', p_active, 'link', link));
  return novo;
end;
$$;
revoke execute on function public.sa_ai_package_save(uuid, text, text, numeric, numeric, int, boolean, boolean, int, text) from public, anon;
grant execute on function public.sa_ai_package_save(uuid, text, text, numeric, numeric, int, boolean, boolean, int, text) to authenticated;
