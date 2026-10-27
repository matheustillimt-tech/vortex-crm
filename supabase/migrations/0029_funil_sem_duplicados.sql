-- Funil: uma pessoa = um contato = um card. Une contatos repetidos (mesmo WhatsApp com ou sem o 9, mesmo @, mesmo id do
-- Instagram, mesmo e-mail) e cards repetidos no quadro do funil, e impede card repetido novo.
-- Avisos que chegam ao mesmo tempo (scripts de histórico, DM da automação e rotina de cliques) criavam a mesma pessoa
-- duas vezes. Só adiciona (e apaga os contatos e cards repetidos depois de passar tudo para o que fica).

-- Chave do WhatsApp: só dígitos, com o 9 dos celulares do Brasil (55 + DDD + 8 dígitos ganha o 9)
create or replace function private.chave_telefone(p text) returns text language sql immutable as $$
  select case
    when d is null or length(d) < 10 then null
    when length(d) <= 11 then private.chave_telefone('55' || d)
    when length(d) = 12 and d like '55%' and substr(d, 5, 1) in ('6', '7', '8', '9') then substr(d, 1, 4) || '9' || substr(d, 5)
    else d end
  from (select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') d) x;
$$;

-- Passa tudo do contato repetido para o que fica e apaga o repetido
create or replace function private.unir_contatos(p_fica uuid, p_sai uuid) returns void language plpgsql security definer set search_path = '' as $$
declare
  f public.contacts;
  s public.contacts;
begin
  if p_fica = p_sai then return; end if;
  select * into f from public.contacts where id = p_fica;
  select * into s from public.contacts where id = p_sai;
  if f.id is null or s.id is null or f.company_id <> s.company_id then return; end if;

  update public.chats set contact_id = p_fica where contact_id = p_sai;
  update public.kanban_cards set contact_id = p_fica where contact_id = p_sai;
  update public.flow_runs set contact_id = p_fica where contact_id = p_sai;
  update public.flow_jobs set contact_id = p_fica where contact_id = p_sai;
  update public.funil_eventos set contact_id = p_fica where contact_id = p_sai;
  update public.sales set contact_id = p_fica where contact_id = p_sai;
  update public.webhook_events set contact_id = p_fica where contact_id = p_sai;
  -- o id do Instagram é único por empresa: sai do repetido antes de ir para o que fica
  update public.contacts set instagram_id = null where id = p_sai;

  update public.contacts set
    name = case when (coalesce(f.name, '') = '' or f.name ~ '^[@+]' ) and coalesce(s.name, '') !~ '^[@+]' and coalesce(s.name, '') <> '' then s.name else f.name end,
    phone = case when coalesce(regexp_replace(f.phone, '\D', '', 'g'), '') = '' then s.phone else f.phone end,
    email = case when coalesce(f.email, '') = '' then coalesce(s.email, '') else f.email end,
    instagram_id = coalesce(f.instagram_id, s.instagram_id),
    instagram_username = coalesce(f.instagram_username, s.instagram_username),
    instagram_profile = coalesce(f.instagram_profile, s.instagram_profile),
    avatar_url = coalesce(f.avatar_url, s.avatar_url),
    avatar_at = coalesce(f.avatar_at, s.avatar_at),
    connection_id = coalesce(f.connection_id, s.connection_id),
    labels = (select coalesce(array_agg(distinct l), '{}') from unnest(coalesce(f.labels, '{}') || coalesce(s.labels, '{}')) l),
    fields = coalesce(s.fields, '{}'::jsonb) || coalesce(f.fields, '{}'::jsonb),
    status = case when f.status = 'ativo' or s.status = 'ativo' then 'ativo' else f.status end
  where id = p_fica;

  delete from public.contacts where id = p_sai;
end;
$$;

-- Une os repetidos do funil: contatos da empresa e cards do quadro. Devolve quantos uniu.
create or replace function public.funil_unir_duplicados(p_funil uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  fu public.funis;
  par record;
  n_contatos int := 0;
  n_cards int := 0;
  ordem text[] := array['comentou', 'clicou', 'cadastrou', 'grupo', 'aula', 'pitch', 'oferta', 'recusado', 'pix', 'comprou'];
  c record;
  fica public.kanban_cards;
  hist jsonb;
  det jsonb;
begin
  select * into fu from public.funis where id = p_funil;
  if fu.id is null then return jsonb_build_object('erro', 'funil não encontrado'); end if;

  -- 1) contatos repetidos: o mais antigo fica. Uma chave por vez (WhatsApp, @, id do Instagram, e-mail).
  for par in
    with k as (
      select id, created_at, 'tel:' || private.chave_telefone(phone) chave from public.contacts where company_id = fu.company_id and private.chave_telefone(phone) is not null
      union all select id, created_at, 'ig:' || lower(instagram_username) from public.contacts where company_id = fu.company_id and coalesce(instagram_username, '') <> ''
      union all select id, created_at, 'igid:' || instagram_id from public.contacts where company_id = fu.company_id and instagram_id is not null
      union all select id, created_at, 'mail:' || lower(email) from public.contacts where company_id = fu.company_id and coalesce(email, '') ~ '@'
    ), g as (
      select chave, (array_agg(id order by created_at, id))[1] fica, array_agg(id order by created_at, id) ids from k group by chave having count(distinct id) > 1
    )
    select g.fica, x.sai from g, unnest(g.ids[2:]) x(sai) where x.sai <> g.fica
  loop
    -- um mesmo contato pode aparecer em mais de uma chave: só une se os dois ainda existem
    if exists (select 1 from public.contacts where id = par.fica) and exists (select 1 from public.contacts where id = par.sai) then
      perform private.unir_contatos(par.fica, par.sai);
      n_contatos := n_contatos + 1;
    end if;
  end loop;

  -- 2) cards repetidos da mesma pessoa no quadro: fica o mais avançado, com a data mais antiga de cada etapa
  for c in select contact_id from public.kanban_cards where kanban_id = fu.kanban_id and contact_id is not null group by contact_id having count(*) > 1 loop
    select k.* into fica from public.kanban_cards k
      where k.kanban_id = fu.kanban_id and k.contact_id = c.contact_id
      order by coalesce(array_position(ordem, (select e.key from jsonb_each_text(fu.colunas) e where e.value = k.column_id limit 1)), 0) desc, k.created_at
      limit 1;
    select coalesce(jsonb_object_agg(etapa, quando), '{}'::jsonb) into hist from (
      select e.key etapa, min(e.value) quando from public.kanban_cards k, jsonb_each_text(coalesce(k.extra -> 'funil', '{}'::jsonb)) e
      where k.kanban_id = fu.kanban_id and k.contact_id = c.contact_id group by e.key) h;
    select coalesce(jsonb_object_agg(etapa, d), '{}'::jsonb) into det from (
      select distinct on (e.key) e.key etapa, e.value d from public.kanban_cards k, jsonb_each(coalesce(k.extra -> 'detalhes', '{}'::jsonb)) e
      where k.kanban_id = fu.kanban_id and k.contact_id = c.contact_id order by e.key, (k.id = fica.id) desc) dd;
    delete from public.kanban_cards where kanban_id = fu.kanban_id and contact_id = c.contact_id and id <> fica.id;
    update public.kanban_cards set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('funil', hist, 'detalhes', det) where id = fica.id;
    n_cards := n_cards + 1;
  end loop;

  return jsonb_build_object('contatos_unidos', n_contatos, 'pessoas_com_cards_unidos', n_cards);
end;
$$;

revoke all on function public.funil_unir_duplicados(uuid) from public, anon, authenticated;
grant execute on function public.funil_unir_duplicados(uuid) to service_role;
revoke all on function private.unir_contatos(uuid, uuid) from public, anon, authenticated;

-- Une o que já existe em todos os funis e trava card repetido novo (um card por pessoa no quadro do funil)
select public.funil_unir_duplicados(id) from public.funis;
create unique index if not exists kanban_cards_funil_uma_pessoa on public.kanban_cards (kanban_id, contact_id) where (extra ? 'funil') and contact_id is not null;
