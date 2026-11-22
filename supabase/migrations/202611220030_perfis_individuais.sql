begin;
alter table public.membros add column regras_individuais jsonb not null default '{}'
  check(public.licitacoes_regras_validas(regras_individuais));

create or replace function public.licitacoes_acesso_tela(empresa uuid,telas text[],escrita boolean) returns boolean
language sql stable security definer set search_path='' as $f$
 select public.licitacoes_acesso_empresa(empresa,escrita) and exists (
  select 1 from public.grupos g join public.membros m on m.grupo_id=g.id
  left join public.cargos_empresa c on c.grupo_id=g.id and c.id=m.cargo_id
  cross join unnest(telas) t(tela)
  where g.id=empresa and m.usuario_id=auth.uid()
  and coalesce(g.limites_telas->>t.tela,'operacao') in ('operacao',case when not escrita then 'consulta' end)
  and (coalesce(m.regras_individuais->>t.tela,
     case when c.id is null or m.papel='admin' then 'operacao' else coalesce(c.regras->>t.tela,'bloqueado') end)
     in ('operacao',case when not escrita then 'consulta' end))
  and (not escrita or m.papel in ('operador','admin'))
 );
$f$;

create or replace function public.licitacoes_painel_cargos(empresa uuid) returns jsonb
language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 return (select jsonb_build_object(
 'limites',g.limites_telas,
 'cargos',coalesce((select jsonb_agg(to_jsonb(c) order by c.nome) from public.cargos_empresa c where c.grupo_id=g.id),'[]'::jsonb),
 'integrantes',coalesce((select jsonb_agg(jsonb_build_object('id',m.usuario_id,'cargo_id',m.cargo_id,'regras_individuais',m.regras_individuais,'papel',m.papel,'email',u.email) order by u.email)
 from public.membros m join auth.users u on u.id=m.usuario_id where m.grupo_id=g.id),'[]'::jsonb)
 ) from public.grupos g where g.id=empresa);
end;
$f$;

create function public.licitacoes_gravar_regras_individuais(empresa uuid, integrante uuid, regras jsonb)
returns void language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 update public.membros set regras_individuais=regras where grupo_id=empresa and usuario_id=integrante;
 if not found then raise exception 'Usuário não encontrado nesta empresa'; end if;
end;
$f$;
revoke all on function public.licitacoes_gravar_regras_individuais(uuid,uuid,jsonb) from public;
grant execute on function public.licitacoes_gravar_regras_individuais(uuid,uuid,jsonb) to authenticated;
create trigger auditar_regras_individuais after update of regras_individuais on public.membros
 for each row execute function controle_licitacoes.auditar_plataforma('usuario_id');
commit;
