-- Conexão Z-API: a pessoa cola uma instância que já tem no Z-API (connection_secrets.provider = 'zapi').
-- connection_secrets.provider é texto livre (sem check), então não há o que liberar. Aqui só a garantia de que uma
-- instância do Z-API fica em uma conexão só: os webhooks dela apontam para um lugar (connection-setup também confere).
create unique index if not exists connection_secrets_zapi_instance_key
  on public.connection_secrets ((credentials ->> 'instanceId')) where provider = 'zapi';
