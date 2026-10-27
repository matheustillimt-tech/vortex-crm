-- Escala: índices para o painel paginado e para as automações, prévia da última mensagem na própria conversa
-- e a rotina das automações três vezes por minuto.

-- ---------- Painel: mais recentes primeiro ----------
-- (chats já tem (company_id, last_message_at); mensagens por conversa usam (chat_id, company_id, at))
create index if not exists contacts_company_created_idx on public.contacts (company_id, created_at desc);
create index if not exists messages_company_at_idx on public.messages (company_id, at desc);

-- ---------- Automações (flow-tick) ----------
-- fluxos parados no "Intervalo Inteligente" e no tempo do "Aguarda Resposta": a rotina busca só os vencidos
create index if not exists chats_flow_resume_idx on public.chats ((flow_state ->> 'resumeAt'))
  where (flow_state ->> 'resumeAt') is not null;
create index if not exists chats_flow_waiting_idx on public.chats (((flow_state -> 'waiting') ->> 'expiresAt'))
  where ((flow_state -> 'waiting') ->> 'expiresAt') is not null;

-- a cada 20 segundos em vez de a cada minuto (cada rodada pega até 50 de cada tipo; um fluxo nunca roda duas
-- vezes porque a rotina "trava" a conversa antes de executar)
select cron.alter_job(jobid, schedule := '20 seconds') from cron.job where jobname = 'vortex-crm-flow-tick';

-- ---------- Prévia da última mensagem na lista de conversas ----------
-- o painel não carrega mais todas as mensagens de uma vez; a conversa guarda o texto da última
alter table public.chats add column if not exists last_message_text text not null default '';
alter table public.chats add column if not exists last_message_from text not null default '';

create or replace function private.chat_last_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chats
     set last_message_text = left(coalesce(new.text, ''), 200), last_message_from = coalesce(new.sender, '')
   where id = new.chat_id and company_id = new.company_id;
  return null;
end;
$$;
revoke all on function private.chat_last_message() from public, anon, authenticated;

drop trigger if exists chat_last_message on public.messages;
create trigger chat_last_message after insert on public.messages
  for each row execute function private.chat_last_message();

-- conversas que já existem: a última mensagem de cada uma
update public.chats c
   set last_message_text = left(coalesce(m.text, ''), 200), last_message_from = coalesce(m.sender, '')
  from (select distinct on (chat_id) chat_id, text, sender from public.messages order by chat_id, at desc) m
 where m.chat_id = c.id;
