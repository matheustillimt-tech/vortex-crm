-- A IA não resolveu (transferiu, prometeu um atendente, deu erro, ficou sem resposta ou anotou um problema): o servidor
-- põe a conversa em Aguardando com o motivo em chats.ai_state.precisaHumano (agent-core.ts, toWaiting). A marca vale
-- enquanto a conversa está em Aguardando: quando alguém assume, retoma a IA, resolve ou move a conversa, ela some sozinha.
create or replace function private.chat_precisa_humano_limpa()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from 'waiting' and new.ai_state ? 'precisaHumano' then
    new.ai_state := new.ai_state - 'precisaHumano';
  end if;
  return new;
end;
$$;
revoke all on function private.chat_precisa_humano_limpa() from public, anon, authenticated;

drop trigger if exists chat_precisa_humano_limpa on public.chats;
create trigger chat_precisa_humano_limpa before insert or update on public.chats
  for each row execute function private.chat_precisa_humano_limpa();

-- Reverter: drop trigger chat_precisa_humano_limpa on public.chats; drop function private.chat_precisa_humano_limpa();
