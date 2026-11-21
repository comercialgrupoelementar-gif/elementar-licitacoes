begin;
alter table public.chamados_clientes
 add column protocolo bigint generated always as identity unique,
 add column contato_nome text not null default '' check (length(contato_nome)<=120),
 add column contato_email text not null default '' check (length(contato_email)<=254),
 add column contato_whatsapp text not null default '' check (length(contato_whatsapp)<=40),
 add column contato_cargo text not null default '' check (length(contato_cargo)<=120);
grant insert(contato_nome,contato_email,contato_whatsapp,contato_cargo) on public.chamados_clientes to authenticated;
create function public.licitacoes_acessa_chamado(chamado uuid) returns boolean
language sql stable security definer set search_path='' as $access$
 select exists (
  select 1 from public.chamados_clientes c where c.id=chamado and (
   public.licitacoes_eh_mestre() or exists (
    select 1 from public.membros m where m.grupo_id=c.grupo_id and m.usuario_id=auth.uid()
     and (c.aberto_por=auth.uid() or m.papel='admin')
   )
  )
 );
$access$;
revoke all on function public.licitacoes_acessa_chamado(uuid) from public;
grant execute on function public.licitacoes_acessa_chamado(uuid) to authenticated;
alter policy chamados_leitura on public.chamados_clientes using (public.licitacoes_acessa_chamado(id));
create table public.chamado_mensagens (
 id uuid primary key default gen_random_uuid(),
 chamado_id uuid not null references public.chamados_clientes(id),
 autor_id uuid not null default auth.uid(),
 autor_nome text not null default '',
 suporte boolean not null default false,
 enviada_em timestamptz not null default now(),
 texto text not null default '' check(length(texto)<=5000),
 anexo_caminho text,
 anexo_nome text check(length(anexo_nome)<=255),
 check (length(btrim(texto))>0 or anexo_caminho is not null),
 check ((anexo_caminho is null)=(anexo_nome is null)),
 check (anexo_caminho is null or split_part(anexo_caminho,'/',1)=chamado_id::text)
);
create index chamado_mensagens_ordem on public.chamado_mensagens(chamado_id,enviada_em,id);
alter table public.chamado_mensagens enable row level security;
revoke all on public.chamado_mensagens from anon,authenticated;
grant select,insert(chamado_id,texto,anexo_caminho,anexo_nome) on public.chamado_mensagens to authenticated;
create policy mensagens_leitura on public.chamado_mensagens for select to authenticated
using(public.licitacoes_acessa_chamado(chamado_id));
create policy mensagens_envio on public.chamado_mensagens for insert to authenticated
with check(autor_id=auth.uid() and public.licitacoes_acessa_chamado(chamado_id) and
 (anexo_caminho is null or split_part(anexo_caminho,'/',2)=auth.uid()::text));
create function controle_licitacoes.identificar_mensagem() returns trigger
language plpgsql security definer set search_path='' as $sender$
begin
 new.suporte:=public.licitacoes_eh_mestre();
 select left(coalesce(nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'username',''),split_part(u.email,'@',1),'Usuário'),120)
 into new.autor_nome from auth.users u where u.id=auth.uid();
 return new;
end;
$sender$;
revoke all on function controle_licitacoes.identificar_mensagem() from public;
create trigger identificar_mensagem before insert on public.chamado_mensagens for each row execute function controle_licitacoes.identificar_mensagem();
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chamados-anexos','chamados-anexos',false,10485760,array['application/pdf','image/png','image/jpeg','image/webp','text/plain']);
create policy chamados_anexo_leitura on storage.objects for select to authenticated using (
 bucket_id='chamados-anexos' and public.licitacoes_acessa_chamado(
 case when split_part(name,'/',1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(name,'/',1)::uuid end)
);
create policy chamados_anexo_envio on storage.objects for insert to authenticated with check (
 bucket_id='chamados-anexos' and split_part(name,'/',2)=auth.uid()::text and public.licitacoes_acessa_chamado(
 case when split_part(name,'/',1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(name,'/',1)::uuid end)
);
notify pgrst,'reload schema';
commit;
