-- Criar ou salvar um fluxo pelo painel dava "permission denied for function flow_trigger_types" desde a 0017: o gatilho
-- que calcula flows.trigger_types rodava com a permissão de quem salva, e a função que ele chama
-- (private.flow_trigger_types) não é liberada para o painel. Ele passa a rodar como dono (security definer), como os
-- outros gatilhos de private que chamam funções de private. Nenhuma função nova fica liberada para o painel.
alter function private.flow_trigger_types_set() security definer;
