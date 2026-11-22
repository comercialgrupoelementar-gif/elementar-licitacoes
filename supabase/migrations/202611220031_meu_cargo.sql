begin;
create function public.licitacoes_meu_cargo(empresa uuid) returns text
language sql stable security definer set search_path='' as $fn$
 select c.nome
 from public.membros m join public.cargos_empresa c on c.grupo_id=m.grupo_id and c.id=m.cargo_id
 where m.grupo_id=empresa and m.usuario_id=auth.uid() and public.licitacoes_acesso_empresa(empresa,false);
$fn$;
revoke all on function public.licitacoes_meu_cargo(uuid) from public;
grant execute on function public.licitacoes_meu_cargo(uuid) to authenticated;
commit;
