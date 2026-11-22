begin;
create function public.licitacoes_demo_editar_participantes(empresa uuid) returns boolean
language sql stable security definer set search_path='' as $fn$
 select empresa='4df12050-8638-4906-ae91-f0fb199f266d'
 and auth.jwt()->>'email'='demo@example.com'
 and public.licitacoes_acesso_tela(empresa,array['configuracoes'],false)
 and public.licitacoes_acesso_empresa(empresa,true)
 and exists(select 1 from public.membros m where m.grupo_id=empresa and m.usuario_id=auth.uid() and m.papel='operador');
$fn$;
revoke all on function public.licitacoes_demo_editar_participantes(uuid) from public;
grant execute on function public.licitacoes_demo_editar_participantes(uuid) to authenticated;
alter policy cargo_insercao on public.empresas with check (
 public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true) or public.licitacoes_demo_editar_participantes(grupo_id));
alter policy cargo_edicao on public.empresas using (
 public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true) or public.licitacoes_demo_editar_participantes(grupo_id))
 with check (public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true) or public.licitacoes_demo_editar_participantes(grupo_id));
do $fn$
begin
 if exists(select 1 from pg_policies where schemaname='public' and tablename='empresas' and policyname='empresa_demo_insert') then
  alter policy empresa_demo_insert on public.empresas with check (
   grupo_id<>'4df12050-8638-4906-ae91-f0fb199f266d' or
   (auth.jwt()->>'email'='demo@example.com' and (public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true)
   or public.licitacoes_demo_editar_participantes(grupo_id))));
 end if;
end
$fn$;
commit;
