-- Ajuste do 0009: o aviso "fulano assumiu o atendimento" é só para o que um usuário faz no painel.
-- Pausas feitas pelo servidor (mensagem pelo celular da empresa, resposta pelo painel) já gravam o próprio aviso.
create or replace function private.chat_ai_human_note()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  who text;
begin
  if coalesce((select auth.role()), '') <> 'authenticated' then
    return null;
  end if;
  select nullif(m.name, '') into who from public.company_members m where m.company_id = new.company_id and m.user_id = (select auth.uid());
  insert into public.messages (company_id, chat_id, sender, text, delivery)
  values (new.company_id, new.id, 'sys', '👤 ' || coalesce(who, 'Um atendente') || ' assumiu o atendimento. IA pausada nesta conversa.', 'local');
  return null;
end;
$$;
revoke all on function private.chat_ai_human_note() from public, anon, authenticated;
