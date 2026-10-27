-- Resultado de cada bloco em cada execução de fluxo, para o editor mostrar Sucessos / Alertas / Erros em todos os blocos
-- (como o bloco Início já mostra para o fluxo inteiro).
--   flow_runs.steps: [{ n: id do bloco, s: 'ok' | 'alert' | 'error', r?: motivo, at }], na ordem em que a execução passou.
--   O motor (functions/_shared/flow.ts) junta os passos de cada trecho (até parar numa espera) e grava de uma vez.
-- Execuções de antes desta migração ficam com [] (os blocos começam a contar a partir dela).

alter table public.flow_runs add column if not exists steps jsonb not null default '[]'::jsonb;

-- Só o servidor grava (a execução pode voltar depois de uma espera: os passos novos entram no fim).
create or replace function public.flow_run_steps_add(p_run uuid, p_steps jsonb)
returns void language sql security definer set search_path = '' as $$
  update public.flow_runs set steps = steps || coalesce(p_steps, '[]'::jsonb) where id = p_run and jsonb_typeof(p_steps) = 'array';
$$;
revoke all on function public.flow_run_steps_add(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.flow_run_steps_add(uuid, jsonb) to service_role;

-- Soma por bloco (mesma regra do flow_run_stats: o membro só lê as execuções da própria empresa, pela RLS de flow_runs).
-- last_reason: o motivo do alerta/erro mais recente daquele bloco.
create or replace function public.flow_node_stats(p_flow uuid)
returns table (node_id text, status text, total bigint, last_reason text, last_at timestamptz) language sql stable set search_path = '' as $$
  select s ->> 'n', s ->> 's', count(*),
         (array_agg(s ->> 'r' order by s ->> 'at' desc) filter (where s ->> 'r' is not null))[1],
         max(s ->> 'at')::timestamptz
    from public.flow_runs r, jsonb_array_elements(r.steps) s
   where r.flow_id = p_flow and jsonb_typeof(r.steps) = 'array'
   group by 1, 2;
$$;
revoke all on function public.flow_node_stats(uuid) from public, anon;
grant execute on function public.flow_node_stats(uuid) to authenticated;

-- Reverter:
--   drop function public.flow_node_stats(uuid), public.flow_run_steps_add(uuid, jsonb);
--   alter table public.flow_runs drop column steps;
