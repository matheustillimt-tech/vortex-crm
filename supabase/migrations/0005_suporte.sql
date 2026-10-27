-- Suporte da plataforma: conversa entre quem usa o painel e a equipe da plataforma
-- (balão flutuante no app + Central de suporte no painel do superadmin).
-- Não tem relação com o Chat Ao Vivo (WhatsApp dos clientes de cada empresa): tabelas, funções e canais de tempo real próprios.
-- Leitura: cada usuário vê só os atendimentos que ele abriu, na empresa de que é membro; o superadmin vê todos.
-- Escrita: só pelas funções support_* (security definer), que conferem quem chama e preenchem os campos do servidor.

-- ---------- Tabelas ----------

-- status: open = Aberto (na fila), in_progress = Em atendimento, resolved = Resolvido.
-- user_unread = respostas da equipe que o usuário ainda não viu; admin_unread = mensagens do usuário que a equipe ainda não viu.
-- Nome do usuário e da empresa ficam copiados no atendimento (atualizados a cada mensagem do usuário) para a central
-- mostrar sem precisar ler profiles/companies de outras empresas.
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  user_name text not null default '',
  user_email text not null default '',
  company_name text not null default '',
  subject text not null default '',
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  last_message_at timestamptz not null default now(),
  last_message_preview text not null default '',
  last_sender text not null default 'user' check (last_sender in ('user', 'admin')),
  user_unread int not null default 0,
  admin_unread int not null default 0,
  assigned_to uuid references auth.users (id) on delete set null,
  assigned_name text not null default '',
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.support_tickets (user_id, last_message_at desc);
create index on public.support_tickets (status, last_message_at desc);
create index on public.support_tickets (company_id);
create index on public.support_tickets (assigned_to);

-- ticket_user_id repete o dono do atendimento: a política de leitura e o filtro do tempo real não precisam de join.
-- sender_role: user = quem abriu, admin = equipe da plataforma, system = aviso de mudança de status.
create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  ticket_user_id uuid not null references auth.users (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete set null,
  sender_role text not null check (sender_role in ('user', 'admin', 'system')),
  sender_name text not null default '',
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index on public.support_messages (ticket_id, created_at);
create index on public.support_messages (ticket_user_id);
create index on public.support_messages (company_id);
create index on public.support_messages (sender_id);

create trigger touch before update on public.support_tickets for each row execute function private.touch_updated_at();

-- ---------- Acesso ----------

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;

create policy "dono do atendimento ou superadmin" on public.support_tickets for select to authenticated
  using ((user_id = (select auth.uid()) and private.is_member(company_id)) or (select private.is_superadmin()));
create policy "dono do atendimento ou superadmin" on public.support_messages for select to authenticated
  using ((ticket_user_id = (select auth.uid()) and private.is_member(company_id)) or (select private.is_superadmin()));

-- sem políticas de escrita, e sem privilégio também: gravar é só pelas funções abaixo
revoke insert, update, delete, truncate, references, trigger on public.support_tickets, public.support_messages from anon, authenticated;
revoke select on public.support_tickets, public.support_messages from anon;

-- ---------- Funções ----------

create or replace function private.support_preview(t text)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'), 140);
$$;

create or replace function private.support_body(p_body text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  b text := btrim(coalesce(p_body, ''));
begin
  if b = '' then
    raise exception 'Escreva a mensagem antes de enviar' using errcode = '22023';
  end if;
  if char_length(b) > 4000 then
    raise exception 'Mensagem muito longa (máximo de 4000 caracteres)' using errcode = '22023';
  end if;
  return b;
end;
$$;

create or replace function private.support_my_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.name, ''), p.email, (select auth.jwt() ->> 'email'), '') from public.profiles p where p.id = (select auth.uid());
$$;

-- Usuário abre um atendimento com a primeira mensagem. p_id permite ao app já conhecer o id da mensagem (envio otimista).
create or replace function public.support_open(p_company uuid, p_body text, p_id uuid default null)
returns public.support_tickets
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  b text;
  prof public.profiles;
  t public.support_tickets;
begin
  if me is null then
    raise exception 'Entre na sua conta para falar com o suporte' using errcode = '42501';
  end if;
  if not private.is_member(p_company) then
    raise exception 'Você não faz parte desta empresa' using errcode = '42501';
  end if;
  b := private.support_body(p_body);
  if (select count(*) from public.support_tickets s where s.user_id = me and s.status <> 'resolved') >= 10 then
    raise exception 'Você já tem 10 atendimentos em andamento. Continue um deles ou aguarde a resolução.' using errcode = '54000';
  end if;
  select * into prof from public.profiles p where p.id = me;

  insert into public.support_tickets (company_id, user_id, user_name, user_email, company_name, subject, last_message_preview, last_sender, admin_unread)
  values (
    p_company, me,
    coalesce(nullif(prof.name, ''), prof.email, ''),
    coalesce(prof.email, (select auth.jwt() ->> 'email'), ''),
    coalesce((select c.name from public.companies c where c.id = p_company), ''),
    left(private.support_preview(b), 80), private.support_preview(b), 'user', 1
  )
  returning * into t;

  insert into public.support_messages (id, ticket_id, company_id, ticket_user_id, sender_id, sender_role, sender_name, body)
  values (coalesce(p_id, gen_random_uuid()), t.id, p_company, me, me, 'user', t.user_name, b);
  return t;
end;
$$;

-- Mensagem em um atendimento. p_as_admin = true responde como equipe da plataforma (só superadmin);
-- a primeira resposta da equipe passa o atendimento para "Em atendimento".
create or replace function public.support_send(p_ticket uuid, p_body text, p_as_admin boolean default false, p_id uuid default null)
returns public.support_messages
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  b text;
  t public.support_tickets;
  m public.support_messages;
  my_name text := coalesce(private.support_my_name(), '');
begin
  if me is null then
    raise exception 'Entre na sua conta para falar com o suporte' using errcode = '42501';
  end if;
  b := private.support_body(p_body);
  select * into t from public.support_tickets s where s.id = p_ticket for update;
  if not found then
    raise exception 'Atendimento não encontrado' using errcode = 'P0002';
  end if;

  if p_as_admin then
    perform private.require_superadmin();
    insert into public.support_messages (id, ticket_id, company_id, ticket_user_id, sender_id, sender_role, sender_name, body)
    values (coalesce(p_id, gen_random_uuid()), t.id, t.company_id, t.user_id, me, 'admin', my_name, b)
    returning * into m;
    update public.support_tickets s set
      status = 'in_progress',
      resolved_at = null,
      assigned_to = coalesce(s.assigned_to, me),
      assigned_name = case when s.assigned_to is null then my_name else s.assigned_name end,
      last_message_at = m.created_at,
      last_message_preview = private.support_preview(b),
      last_sender = 'admin',
      user_unread = s.user_unread + 1,
      admin_unread = 0
    where s.id = t.id;
  else
    if t.user_id <> me or not private.is_member(t.company_id) then
      raise exception 'Atendimento não encontrado' using errcode = 'P0002';
    end if;
    if t.status = 'resolved' then
      raise exception 'Este atendimento foi resolvido. Inicie um novo atendimento para continuar.' using errcode = '55000';
    end if;
    insert into public.support_messages (id, ticket_id, company_id, ticket_user_id, sender_id, sender_role, sender_name, body)
    values (coalesce(p_id, gen_random_uuid()), t.id, t.company_id, me, me, 'user', my_name, b)
    returning * into m;
    update public.support_tickets s set
      last_message_at = m.created_at,
      last_message_preview = private.support_preview(b),
      last_sender = 'user',
      admin_unread = s.admin_unread + 1,
      user_unread = 0,
      user_name = coalesce(nullif(my_name, ''), s.user_name),
      company_name = coalesce((select c.name from public.companies c where c.id = s.company_id), s.company_name)
    where s.id = t.id;
  end if;
  return m;
end;
$$;

-- Zera o contador de não lidas do lado de quem está vendo a conversa.
create or replace function public.support_mark_read(p_ticket uuid, p_as_admin boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_as_admin then
    perform private.require_superadmin();
    update public.support_tickets s set admin_unread = 0 where s.id = p_ticket and s.admin_unread <> 0;
  else
    update public.support_tickets s set user_unread = 0
    where s.id = p_ticket and s.user_id = (select auth.uid()) and s.user_unread <> 0 and private.is_member(s.company_id);
  end if;
end;
$$;

-- Só o superadmin muda o status. Cada mudança deixa um aviso na conversa, que o usuário também vê.
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
    when p_status = 'in_progress' then 'A equipe do Vórtex CRM começou a cuidar deste atendimento'
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

revoke all on function private.support_preview(text), private.support_body(text), private.support_my_name() from public, anon, authenticated;
revoke all on function public.support_open(uuid, text, uuid), public.support_send(uuid, text, boolean, uuid),
  public.support_mark_read(uuid, boolean), public.support_set_status(uuid, text) from public, anon;
grant execute on function public.support_open(uuid, text, uuid), public.support_send(uuid, text, boolean, uuid),
  public.support_mark_read(uuid, boolean), public.support_set_status(uuid, text) to authenticated;

-- ---------- Tempo real ----------
-- O Realtime aplica as políticas acima: cada usuário recebe só os próprios atendimentos; o superadmin recebe todos.

alter publication supabase_realtime add table public.support_tickets, public.support_messages;
