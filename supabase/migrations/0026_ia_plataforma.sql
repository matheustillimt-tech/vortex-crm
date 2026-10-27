-- IA da plataforma: as chaves do dono da plataforma (segredos AI_API_KEY e ELEVENLABS_API_KEY das Edge Functions) só valem para
-- empresa com a carteira de IA ativa. Sem isso, toda empresa sem chave própria, inclusive as em teste, gastaria a
-- IA da plataforma. Saldo, extrato e cobrança por uso entram na etapa dos créditos; por ora a carteira só liga e desliga.
-- Liberar uma empresa (superadmin, por SQL até existir a tela):
--   insert into public.ai_wallets (company_id, active) values ('<empresa>', true)
--   on conflict (company_id) do update set active = excluded.active, updated_at = now();
-- Só adiciona.

create table public.ai_wallets (
  company_id uuid primary key references public.companies (id) on delete cascade,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_wallets enable row level security;
create policy "empresa vê a própria carteira de IA" on public.ai_wallets for select to authenticated
  using (private.is_member(company_id) or (select private.is_superadmin()));
-- Só o servidor grava.
revoke all on public.ai_wallets from authenticated, anon;
grant select on public.ai_wallets to authenticated;
grant select, insert, update, delete on public.ai_wallets to service_role;
