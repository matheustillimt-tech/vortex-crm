-- Instagram com a chave da Zernio de cada conexão (quem conecta cola a própria chave da API da Zernio e escolhe um dos
-- Instagrams que já estão conectados nela; o login no Instagram acontece só na Zernio, nunca no CRM).
-- A chave, o segredo do webhook e o id do webhook ficam no Vault (`zernio_connection:<conexão>`), como os tokens da
-- API Oficial da Meta (0011). Em connection_secrets fica só o que não é segredo: accountId, @, final da chave.
-- Só adiciona.

create or replace function public.zernio_secret_set(p_connection uuid, p_secret jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n text := 'zernio_connection:' || p_connection;
  sid uuid;
begin
  select s.id into sid from vault.secrets s where s.name = n;
  if sid is null then
    perform vault.create_secret(p_secret::text, n, 'Instagram pela Zernio: chave da API e segredo do webhook da conexão');
  else
    perform vault.update_secret(sid, p_secret::text);
  end if;
end;
$$;

create or replace function public.zernio_secret_get(p_connection uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'zernio_connection:' || p_connection;
$$;

create or replace function public.zernio_secret_drop(p_connection uuid)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets where name = 'zernio_connection:' || p_connection;
$$;

revoke all on function public.zernio_secret_set(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.zernio_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.zernio_secret_drop(uuid) from public, anon, authenticated;
grant execute on function public.zernio_secret_set(uuid, jsonb) to service_role;
grant execute on function public.zernio_secret_get(uuid) to service_role;
grant execute on function public.zernio_secret_drop(uuid) to service_role;

-- Excluir a conexão (ou a empresa) apaga a chave dela no Vault
create or replace function private.drop_zernio_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where name = 'zernio_connection:' || old.id;
  return old;
end;
$$;
revoke all on function private.drop_zernio_secret() from public, anon, authenticated;
drop trigger if exists drop_zernio_secret on public.connections;
create trigger drop_zernio_secret after delete on public.connections for each row execute function private.drop_zernio_secret();
