-- Servidor MCP do Vórtex CRM (Configurações → Ferramentas MCP), no mesmo modelo do Vórtex Grupo.
-- Cada chave é de uma empresa. O banco guarda só o prefixo (8 caracteres depois de "vcrm_", pra identificar na
-- tela) e o hash SHA-256 da chave inteira; a chave em texto aparece uma vez, na criação.
-- Escopo: "leitura" só consulta; "envio" também cria contato e manda mensagem pelo WhatsApp.
-- A tabela antiga mcp_credentials (tela de demonstração, token em texto e nunca usado pelo servidor) fica como está.
-- Só adiciona.

create table public.mcp_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  prefix text not null check (prefix ~ '^[A-Za-z0-9]{8}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('leitura', 'envio')),
  created_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.mcp_keys (company_id);

alter table public.mcp_keys enable row level security;
create policy "membros leem" on public.mcp_keys for select to authenticated using (private.is_member(company_id));
-- Sem a coluna hash para o navegador. Criar e revogar só pelas funções abaixo (Proprietário ou Admin).
revoke all on public.mcp_keys from authenticated, anon;
grant select (id, company_id, name, prefix, scope, created_by, last_used_at, revoked_at, created_at) on public.mcp_keys to authenticated;
grant select, insert, update, delete on public.mcp_keys to service_role;

-- Contador de chamadas por chave e por minuto (limite de 60/min). Só o servidor lê e grava.
create table public.mcp_usage (
  key_id uuid not null references public.mcp_keys (id) on delete cascade,
  minute timestamptz not null,
  calls int not null default 0 check (calls >= 0),
  primary key (key_id, minute)
);
alter table public.mcp_usage enable row level security;
revoke all on public.mcp_usage from authenticated, anon;
grant select, insert, update, delete on public.mcp_usage to service_role;

-- Soma uma chamada no minuto atual, marca o último uso e limpa os minutos com mais de uma hora. Devolve o total do minuto.
create or replace function public.mcp_register_use(p_key uuid)
returns int language plpgsql security invoker set search_path = public as $$
declare
  v_total int;
begin
  insert into public.mcp_usage (key_id, minute, calls) values (p_key, date_trunc('minute', now()), 1)
  on conflict (key_id, minute) do update set calls = mcp_usage.calls + 1
  returning calls into v_total;
  update public.mcp_keys set last_used_at = now() where id = p_key;
  delete from public.mcp_usage where key_id = p_key and minute < now() - interval '1 hour';
  return v_total;
end;
$$;
revoke execute on function public.mcp_register_use(uuid) from public, anon, authenticated;
grant execute on function public.mcp_register_use(uuid) to service_role;

-- Cria a chave na empresa aberta (profiles.current_company_id). Só Proprietário ou Admin.
-- Formato: "vcrm_" + 40 caracteres base62. Devolve a chave em texto (mostrar uma vez só).
create or replace function public.mcp_key_create(p_name text, p_scope text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
  nome text := trim(coalesce(p_name, ''));
  alfabeto text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  corpo text := '';
  b int;
  chave text;
  novo uuid;
begin
  select current_company_id into cid from public.profiles where id = (select auth.uid());
  if cid is null or not private.is_admin(cid) then raise exception 'Só o proprietário ou um admin da empresa cria chaves.'; end if;
  if char_length(nome) < 1 or char_length(nome) > 60 then raise exception 'Nome da chave: de 1 a 60 caracteres.'; end if;
  if p_scope not in ('leitura', 'envio') then raise exception 'Permissão inválida.'; end if;
  -- Sem viés: descarta bytes >= 248 (maior múltiplo de 62 abaixo de 256).
  while char_length(corpo) < 40 loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    if b < 248 then corpo := corpo || substr(alfabeto, (b % 62) + 1, 1); end if;
  end loop;
  chave := 'vcrm_' || corpo;
  insert into public.mcp_keys (company_id, name, prefix, hash, scope, created_by)
  values (cid, nome, substr(corpo, 1, 8), encode(extensions.digest(chave, 'sha256'), 'hex'), p_scope, (select auth.uid()))
  returning id into novo;
  return json_build_object('id', novo, 'key', chave);
end;
$$;

-- Revoga (não apaga, pra lista mostrar). Só Proprietário ou Admin da empresa da chave.
create or replace function public.mcp_key_revoke(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
begin
  select company_id into cid from public.mcp_keys where id = p_id;
  if cid is null or not private.is_admin(cid) then raise exception 'Chave não encontrada.'; end if;
  update public.mcp_keys set revoked_at = now() where id = p_id and revoked_at is null;
end;
$$;

revoke execute on function public.mcp_key_create(text, text), public.mcp_key_revoke(uuid) from public, anon;
grant execute on function public.mcp_key_create(text, text), public.mcp_key_revoke(uuid) to authenticated;
