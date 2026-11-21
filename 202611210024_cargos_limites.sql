begin;
create table public.cargos_empresa (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null references public.grupos(id) on delete cascade,
 nome text not null check (length(btrim(nome)) between 2 and 80),
 regras jsonb not null,
 unique(grupo_id,id),
 unique(grupo_id,nome)
);
alter table public.membros add column cargo_id uuid;
alter table public.membros add foreign key(grupo_id,cargo_id) references public.cargos_empresa(grupo_id,id);
alter table public.grupos add column limites_telas jsonb not null default '{}';
alter table public.cargos_empresa enable row level security;
revoke all on public.cargos_empresa from anon,authenticated;
create function public.licitacoes_regras_validas(regras jsonb) returns boolean
language sql immutable set search_path='' as $f$
select case when jsonb_typeof(regras)='object' then not exists (
 select 1 from jsonb_each_text(regras) as e(tela,nivel)
 where tela not in ('painel','orgaos','catalogo','cotacoes','orcamento','editais','propostas','documentacao','propostaPronta','disputa','acompanhamento','finalizados','logistica','financeiro','configuracoes','aplicativo','ajuda')
 or nivel is null or nivel not in ('bloqueado','consulta','operacao')
) else false end;
$f$;
alter table public.cargos_empresa add check(public.licitacoes_regras_validas(regras));
alter table public.grupos add check(public.licitacoes_regras_validas(limites_telas));
create function public.licitacoes_acesso_tela(empresa uuid,telas text[],escrita boolean) returns boolean
language sql stable security definer set search_path='' as $f$
 select public.licitacoes_acesso_empresa(empresa,escrita) and exists (
  select 1 from public.grupos g join public.membros m on m.grupo_id=g.id
  left join public.cargos_empresa c on c.grupo_id=g.id and c.id=m.cargo_id
  cross join unnest(telas) t(tela)
  where g.id=empresa and m.usuario_id=auth.uid()
  and coalesce(g.limites_telas->>t.tela,'operacao') in ('operacao',case when not escrita then 'consulta' end)
  and (c.id is null or m.papel='admin' or coalesce(c.regras->>t.tela,'bloqueado') in ('operacao',case when not escrita then 'consulta' end))
  and (not escrita or m.papel in ('operador','admin'))
 );
$f$;
create function public.licitacoes_minhas_telas(empresa uuid) returns jsonb
language sql stable security definer set search_path='' as $f$
 select jsonb_object_agg(tela,case when public.licitacoes_acesso_tela(empresa,array[tela],true) then 'operacao'
 when public.licitacoes_acesso_tela(empresa,array[tela],false) then 'consulta' else 'bloqueado' end)
 from unnest(array['painel','orgaos','catalogo','cotacoes','orcamento','editais','propostas','documentacao','propostaPronta','disputa','acompanhamento','finalizados','logistica','financeiro','configuracoes','aplicativo','ajuda']) as t(tela);
$f$;
create function public.licitacoes_painel_cargos(empresa uuid) returns jsonb
language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 return (select jsonb_build_object(
 'limites',g.limites_telas,
 'cargos',coalesce((select jsonb_agg(to_jsonb(c) order by c.nome) from public.cargos_empresa c where c.grupo_id=g.id),'[]'::jsonb),
 'integrantes',coalesce((select jsonb_agg(jsonb_build_object('id',m.usuario_id,'cargo_id',m.cargo_id,'papel',m.papel,'email',u.email) order by u.email)
 from public.membros m join auth.users u on u.id=m.usuario_id where m.grupo_id=g.id),'[]'::jsonb)
 ) from public.grupos g where g.id=empresa);
end;
$f$;
create function public.licitacoes_gravar_cargo(empresa uuid,nome_cargo text,regras_cargo jsonb,cargo uuid default null) returns void
language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 if cargo is null then
 insert into public.cargos_empresa(grupo_id,nome,regras) values(empresa,btrim(nome_cargo),regras_cargo);
 else
 update public.cargos_empresa set nome=btrim(nome_cargo),regras=regras_cargo where grupo_id=empresa and id=cargo;
 if not found then raise exception 'Cargo não encontrado'; end if;
 end if;
end;
$f$;
create function public.licitacoes_atribuir_cargo(empresa uuid,integrante uuid,cargo uuid) returns void
language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 update public.membros set cargo_id=cargo where grupo_id=empresa and usuario_id=integrante and papel in ('operador','leitor');
 if not found then raise exception 'Selecione um operador ou leitor desta empresa'; end if;
end;
$f$;
create function public.licitacoes_gravar_limites(empresa uuid,regras_telas jsonb) returns void
language plpgsql security definer set search_path='' as $f$
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 update public.grupos set limites_telas=regras_telas where id=empresa;
 if not found then raise exception 'Empresa não encontrada'; end if;
end;
$f$;
revoke all on function public.licitacoes_acesso_tela(uuid,text[],boolean),public.licitacoes_minhas_telas(uuid),public.licitacoes_painel_cargos(uuid),public.licitacoes_gravar_cargo(uuid,text,jsonb,uuid),public.licitacoes_atribuir_cargo(uuid,uuid,uuid),public.licitacoes_gravar_limites(uuid,jsonb) from public;
grant execute on function public.licitacoes_acesso_tela(uuid,text[],boolean),public.licitacoes_minhas_telas(uuid),public.licitacoes_painel_cargos(uuid),public.licitacoes_gravar_cargo(uuid,text,jsonb,uuid),public.licitacoes_atribuir_cargo(uuid,uuid,uuid),public.licitacoes_gravar_limites(uuid,jsonb) to authenticated;
alter policy criar_aparencia on public.aparencia_telas with check (public.licitacoes_eh_mestre() or (public.licitacoes_pode_gerenciar_equipe(grupo_id) and public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true)));
alter policy editar_aparencia on public.aparencia_telas using (public.licitacoes_eh_mestre() or (public.licitacoes_pode_gerenciar_equipe(grupo_id) and public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true))) with check (public.licitacoes_eh_mestre() or (public.licitacoes_pode_gerenciar_equipe(grupo_id) and public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true)));
do $f$
declare r record;
begin
 for r in select * from (values
 ('catalogo',array['catalogo','cotacoes','orcamento','propostas','financeiro'],array['catalogo','financeiro']),
 ('orgaos_compradores',array['orgaos','editais','orcamento'],array['orgaos']),
 ('empresas',array['configuracoes','editais','propostas','propostaPronta','orcamento'],array['configuracoes']),
 ('editais',array['painel','editais','propostas','propostaPronta','documentacao','disputa','acompanhamento','finalizados','logistica'],array['editais','propostas']),
 ('itens',array['painel','propostas','propostaPronta','disputa','acompanhamento','finalizados','logistica'],array['propostas']),
 ('documentos',array['documentacao','propostas','propostaPronta'],array['documentacao']),
 ('arquivos_empresa',array['documentacao','propostaPronta','propostas'],array['documentacao']),
 ('disputas',array['painel','disputa','acompanhamento','finalizados','logistica'],array['disputa']),
 ('acompanhamentos',array['acompanhamento','finalizados','logistica'],array['acompanhamento']),
 ('historico_proposta',array['propostas','propostaPronta'],array['propostas']),
 ('propostas_assinadas',array['propostas','propostaPronta'],array['propostas'])
 ) as cfg(tabela,leitura,escrita)
 loop
  if to_regclass('public.'||r.tabela) is null then continue; end if;
  execute format('create policy cargo_leitura on public.%I as restrictive for select to authenticated using(public.licitacoes_acesso_tela(grupo_id,%L::text[],false))',r.tabela,r.leitura);
  execute format('create policy cargo_insercao on public.%I as restrictive for insert to authenticated with check(public.licitacoes_acesso_tela(grupo_id,%L::text[],true))',r.tabela,r.escrita);
  execute format('create policy cargo_edicao on public.%I as restrictive for update to authenticated using(public.licitacoes_acesso_tela(grupo_id,%L::text[],true)) with check(public.licitacoes_acesso_tela(grupo_id,%L::text[],true))',r.tabela,r.escrita,r.escrita);
  execute format('create policy cargo_exclusao on public.%I as restrictive for delete to authenticated using(public.licitacoes_acesso_tela(grupo_id,%L::text[],true))',r.tabela,r.escrita);
 end loop;
end;
$f$;
create policy cargo_cotacoes_leitura on public.cotacoes as restrictive for select to authenticated using(public.licitacoes_acesso_tela(grupo_id,case when tipo='orcamento' then array['orcamento'] else array['cotacoes','financeiro'] end,false));
create policy cargo_cotacoes_insercao on public.cotacoes as restrictive for insert to authenticated with check(public.licitacoes_acesso_tela(grupo_id,case when tipo='orcamento' then array['orcamento'] else array['cotacoes'] end,true));
create policy cargo_cotacoes_edicao on public.cotacoes as restrictive for update to authenticated using(public.licitacoes_acesso_tela(grupo_id,case when tipo='orcamento' then array['orcamento'] else array['cotacoes'] end,true)) with check(public.licitacoes_acesso_tela(grupo_id,case when tipo='orcamento' then array['orcamento'] else array['cotacoes'] end,true));
create policy cargo_cotacoes_exclusao on public.cotacoes as restrictive for delete to authenticated using(public.licitacoes_acesso_tela(grupo_id,case when tipo='orcamento' then array['orcamento'] else array['cotacoes'] end,true));
do $guard$
declare r record; ddl text; updated text;
begin
 for r in select * from (values
 ('public.mover_proposta(uuid,smallint,smallint)','public.licitacoes_acesso_empresa(e.grupo_id,true)','public.licitacoes_acesso_tela(e.grupo_id,array[''propostas''],true)'),
 ('public.anexar_proposta_assinada(uuid,text)','public.licitacoes_acesso_empresa(e.grupo_id,true)','public.licitacoes_acesso_tela(e.grupo_id,array[''propostas''],true)'),
 ('public.aplicar_custo_cotado(uuid,uuid,numeric,integer)','public.licitacoes_acesso_empresa(c.grupo_id,true)','public.licitacoes_acesso_tela(c.grupo_id,array[''financeiro'',''cotacoes''],true)')
 ) as cfg(assinatura,antes,depois)
 loop
  ddl:=pg_get_functiondef(to_regprocedure(r.assinatura));
  updated:=replace(ddl,r.antes,r.depois);
  if updated is null or ddl=updated then raise exception 'Função incompatível: %',r.assinatura; end if;
  execute updated;
 end loop;
end;
$guard$;
create trigger auditar_cargos after insert or update on public.cargos_empresa for each row execute function controle_licitacoes.auditar_plataforma('id');
create trigger auditar_atribuicao_cargos after update of cargo_id on public.membros for each row execute function controle_licitacoes.auditar_plataforma('usuario_id');
create trigger auditar_limites_telas after update of limites_telas on public.grupos for each row execute function controle_licitacoes.auditar_plataforma('id');
notify pgrst,'reload schema';
commit;
