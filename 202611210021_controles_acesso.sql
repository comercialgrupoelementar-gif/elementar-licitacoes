begin;
alter table public.grupos add column acesso_modo text not null default 'ativo' check(acesso_modo in ('ativo','leitura','bloqueado')),
 add column acesso_ate date;
alter table public.membros add column acesso_habilitado boolean not null default true,
 add column acesso_ate date, add column alias_empresa text not null default '' check(length(alias_empresa)<=80);
create function public.licitacoes_acesso_empresa(empresa uuid, escrever boolean default false) returns boolean
language sql stable security definer set search_path='' as $acesso$
 select exists(select 1 from public.grupos g join public.membros m on m.grupo_id=g.id
 where g.id=empresa and m.usuario_id=auth.uid() and m.acesso_habilitado
 and g.acesso_modo<>'bloqueado' and (not escrever or g.acesso_modo='ativo')
 and (g.acesso_ate is null or g.acesso_ate >= (now() at time zone 'America/Sao_Paulo')::date)
 and (m.acesso_ate is null or m.acesso_ate >= (now() at time zone 'America/Sao_Paulo')::date));
$acesso$;
revoke all on function public.licitacoes_acesso_empresa(uuid,boolean) from public;
grant execute on function public.licitacoes_acesso_empresa(uuid,boolean) to authenticated;
create policy membros_acesso_vigente on public.membros as restrictive for select to authenticated using(public.licitacoes_acesso_empresa(grupo_id,false));
do $rules$
declare alvo record;
begin
 for alvo in select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='grupo_id' and not a.attisdropped
 where n.nspname='public' and c.relrowsecurity and c.relkind='r'
 and c.relname not in ('membros','gestao_comercial','chamados_clientes','aparencia_telas')
 loop
  execute format('create policy acesso_operacional_insert on public.%I as restrictive for insert to authenticated with check(public.licitacoes_acesso_empresa(grupo_id,true))',alvo.relname);
  execute format('create policy acesso_operacional_update on public.%I as restrictive for update to authenticated using(public.licitacoes_acesso_empresa(grupo_id,true)) with check(public.licitacoes_acesso_empresa(grupo_id,true))',alvo.relname);
  execute format('create policy acesso_operacional_delete on public.%I as restrictive for delete to authenticated using(public.licitacoes_acesso_empresa(grupo_id,true))',alvo.relname);
 end loop;
end;
$rules$;
do $guard$
declare alvo record; ddl text; original text;
begin
 for alvo in select * from (values
 ('public.mover_proposta(uuid,smallint,smallint)', 'where e.id=p_edital', 'where e.id=p_edital and public.licitacoes_acesso_empresa(e.grupo_id,true)'),
 ('public.anexar_proposta_assinada(uuid,text)', 'where e.id=p_edital', 'where e.id=p_edital and public.licitacoes_acesso_empresa(e.grupo_id,true)'),
 ('public.aplicar_custo_cotado(uuid,uuid,numeric,integer)', 'where c.id=p_cotacao', 'where c.id=p_cotacao and public.licitacoes_acesso_empresa(c.grupo_id,true)'),
 ('public.licitacoes_pode_gerenciar_equipe(uuid)', 'or exists (', 'or (public.licitacoes_acesso_empresa(cliente,true) and exists ('),
 ('public.licitacoes_adicionar_membro(uuid,text,text)', 'm.grupo_id=cliente and m.usuario_id=auth.uid()', 'm.grupo_id=cliente and public.licitacoes_acesso_empresa(cliente,true) and m.usuario_id=auth.uid()'),
 ('public.licitacoes_acessa_chamado(uuid)', 'public.licitacoes_eh_mestre() or exists (', 'public.licitacoes_eh_mestre() or (public.licitacoes_acesso_empresa(c.grupo_id,false) and exists (')
 ) regras(assinatura,busca,substituta)
 loop
  original:=pg_catalog.pg_get_functiondef(to_regprocedure(alvo.assinatura));
  ddl:=replace(original,alvo.busca,alvo.substituta);
  if ddl is null or ddl=original then raise exception 'Função incompatível: %',alvo.assinatura; end if;
  if alvo.assinatura like '%gerenciar_equipe%' then ddl:=replace(ddl,E'
 )',E'
 ))'); end if;
  if alvo.assinatura like '%acessa_chamado%' then ddl:=replace(ddl,E'
   )',E'
   ))'); end if;
  execute ddl;
 end loop;
end;
$guard$;
create function public.licitacoes_configuracao_acesso(empresa uuid) returns jsonb
language plpgsql security definer set search_path='' as $master$
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 return (select jsonb_build_object('modo',g.acesso_modo,'validade',g.acesso_ate,'usuarios',
  coalesce((select jsonb_agg(jsonb_build_object('id',m.usuario_id,'email',u.email,'papel',m.papel,'habilitado',m.acesso_habilitado,'validade',m.acesso_ate,'alias',m.alias_empresa) order by u.email)
  from public.membros m join auth.users u on u.id=m.usuario_id where m.grupo_id=g.id),'[]'::jsonb))
  from public.grupos g where g.id=empresa);
end;
$master$;
create function public.licitacoes_salvar_acesso(empresa uuid, modo text, validade date,
 integrante uuid default null, apelido text default '') returns void
language plpgsql security definer set search_path='' as $master$
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 if integrante is null then
  update public.grupos set acesso_modo=modo,acesso_ate=validade where id=empresa;
 else
  if modo not in ('ativo','bloqueado') then raise exception 'Situação inválida para usuário'; end if;
  update public.membros set acesso_habilitado=(modo='ativo'),acesso_ate=validade,alias_empresa=btrim(apelido)
  where grupo_id=empresa and usuario_id=integrante;
 end if;
 if not found then raise exception 'Cadastro não encontrado'; end if;
end;
$master$;
revoke all on function public.licitacoes_configuracao_acesso(uuid),public.licitacoes_salvar_acesso(uuid,text,date,uuid,text) from public;
grant execute on function public.licitacoes_configuracao_acesso(uuid),public.licitacoes_salvar_acesso(uuid,text,date,uuid,text) to authenticated;
create trigger auditar_acesso_empresa after update of acesso_modo,acesso_ate on public.grupos
for each row execute function controle_licitacoes.auditar_plataforma('id');
create trigger auditar_acesso_usuario after update of acesso_habilitado,acesso_ate,alias_empresa on public.membros
for each row execute function controle_licitacoes.auditar_plataforma('usuario_id');
notify pgrst,'reload schema';
commit;
