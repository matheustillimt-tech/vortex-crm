-- Arquivos do cabeçalho dos templates (imagem, vídeo ou documento). O bucket é público porque a Meta baixa o arquivo
-- pelo link duas vezes: ao criar o template (o servidor manda como exemplo) e a cada envio do bloco Template WhatsApp.
-- Caminho: <company_id>/<arquivo>. Só membros da empresa com o módulo Conexões enviam, e só na pasta dela; pelo painel
-- ninguém lista, troca nem apaga arquivos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('template-media', 'template-media', true, 16777216, array['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "membros enviam arquivos de template da empresa" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'template-media'
    and ((storage.foldername(name))[1])::uuid = any ((select private.companies_with_module('conexoes'))::uuid[])
  );
