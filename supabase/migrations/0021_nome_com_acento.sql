-- A escrita do nome passou a ser Vórtex CRM, com acento. Mesma função da 0020 (que já foi aplicada com "Vortex CRM"),
-- só com o aviso de "em atendimento" do suporte acentuado. Avisos já gravados não mudam.

create or replace function public.support_set_status(p_ticket uuid, p_status text)
returns public.support_tickets
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  t public.support_tickets;
  my_name text;
  note text;
begin
  perform private.require_superadmin();
  if p_status is null or p_status not in ('open', 'in_progress', 'resolved') then
    raise exception 'Status inválido' using errcode = '22023';
  end if;
  select * into t from public.support_tickets s where s.id = p_ticket for update;
  if not found then
    raise exception 'Atendimento não encontrado' using errcode = 'P0002';
  end if;
  if t.status = p_status then
    return t;
  end if;
  my_name := coalesce(private.support_my_name(), '');
  note := case
    when p_status = 'resolved' then 'Atendimento marcado como resolvido'
    when t.status = 'resolved' then 'Atendimento reaberto'
    when p_status = 'in_progress' then 'A equipe Vórtex CRM começou a cuidar deste atendimento'
    else 'Atendimento voltou para a fila'
  end;
  insert into public.support_messages (ticket_id, company_id, ticket_user_id, sender_id, sender_role, sender_name, body)
  values (t.id, t.company_id, t.user_id, me, 'system', my_name, note);
  update public.support_tickets s set
    status = p_status,
    resolved_at = case when p_status = 'resolved' then now() else null end,
    assigned_to = case when p_status = 'in_progress' and s.assigned_to is null then me else s.assigned_to end,
    assigned_name = case when p_status = 'in_progress' and s.assigned_to is null then my_name else s.assigned_name end
  where s.id = t.id
  returning * into t;
  return t;
end;
$$;
