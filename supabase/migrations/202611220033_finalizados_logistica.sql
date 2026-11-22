begin;
create unique index contratos_logistica_origem_unica on public.contratos_logistica(edital_id)
 where edital_id is not null and dados->>'origem'='acompanhamento';

create function controle_licitacoes.enviar_processo_logistica(ac public.acompanhamentos, validar_documentos boolean)
returns void language plpgsql security definer set search_path='' as $fn$
declare itens jsonb; dados_edital record; contrato_ref text; ata_ref text;
begin
 select e.numero,e.orgao into strict dados_edital from public.editais e where e.id=ac.edital_id and e.grupo_id=ac.grupo_id;
 select jsonb_agg(jsonb_build_object('id',i.id,'nome',concat_ws(' · ',i.codigo,case when i.usar_descricao_interna then coalesce(nullif(i.descricao_interna,''),i.descricao) else i.descricao end,i.unidade),
   'quantidade',i.quantidade,'preco',nullif(r.resultado->>'preco_final','')::numeric) order by i.codigo)
 into itens from public.itens i
 join public.disputas d on d.edital_id=i.edital_id and d.grupo_id=i.grupo_id and d.etapa=2
 cross join lateral (select coalesce(d.resultados->i.id::text,'{}')||coalesce(ac.ajustes->i.id::text,'{}') as resultado) r
 where i.edital_id=ac.edital_id and i.grupo_id=ac.grupo_id and r.resultado->>'situacao'='Ganhamos';
 if itens is null then return; end if;
 if exists(select 1 from jsonb_array_elements(itens) i where coalesce((i->>'preco')::numeric,0)<=0 or coalesce((i->>'quantidade')::numeric,0)<=0) then
  if validar_documentos then raise exception 'Confira a quantidade e o preço final de todos os itens ganhos antes de finalizar'; end if;
  return;
 end if;
 select max(nome) filter (where tipo='Contrato'),max(nome) filter (where tipo='ARP') into contrato_ref,ata_ref
 from public.acompanhamento_arquivos where acompanhamento_id=ac.id and grupo_id=ac.grupo_id;
 if validar_documentos and contrato_ref is null and ata_ref is null then raise exception 'Anexe o contrato ou a ata de registro de preços antes de finalizar'; end if;
 insert into public.contratos_logistica(grupo_id,edital_id,dados)
 select ac.grupo_id,ac.edital_id,jsonb_build_object('numero',dados_edital.numero,'orgao',dados_edital.orgao,'origem','acompanhamento',
  'responsavel','','fim','','fim_arp','','arp','','documento',concat_ws(' · ',contrato_ref,ata_ref),
  'itens',itens,'ordens','[]'::jsonb,'solicitacoes','[]'::jsonb,'historico','[]'::jsonb,'acao','Itens ganhos recebidos de Processos Finalizados')
 where not exists(select 1 from public.contratos_logistica c where c.edital_id=ac.edital_id)
 on conflict do nothing;
end;
$fn$;
revoke all on function controle_licitacoes.enviar_processo_logistica(public.acompanhamentos,boolean) from public;
create function controle_licitacoes.ao_finalizar_enviar_logistica() returns trigger language plpgsql security definer set search_path='' as $fn$
begin
 if new.finalizado_em is not null then perform controle_licitacoes.enviar_processo_logistica(new,true); end if;
 return new;
end;
$fn$;
create trigger acompanhamento_envia_logistica after update of finalizado_em on public.acompanhamentos
 for each row when (old.finalizado_em is null and new.finalizado_em is not null) execute function controle_licitacoes.ao_finalizar_enviar_logistica();
do $fn$
declare ac public.acompanhamentos;
begin
 for ac in select * from public.acompanhamentos where finalizado_em is not null loop
  perform controle_licitacoes.enviar_processo_logistica(ac,false);
 end loop;
end;
$fn$;

update public.cargos_empresa c set regras=c.regras||jsonb_build_object('finalizados','consulta')
 where c.grupo_id='4df12050-8638-4906-ae91-f0fb199f266d' and c.nome='Administrador 01' and not c.regras ? 'finalizados';

create table public.logistica_solicitacao_arquivos (
 id uuid primary key default gen_random_uuid(),
 contrato_id uuid not null references public.contratos_logistica(id),
 nome text not null check (length(btrim(nome)) between 1 and 200),
 pdf text not null check (length(pdf) between 8 and 6990508 and pdf like 'JVBERi0%'),
 criado_em timestamptz not null default now()
);
alter table public.logistica_solicitacao_arquivos enable row level security;
revoke all on public.logistica_solicitacao_arquivos from anon,authenticated;
grant select,insert(contrato_id,nome,pdf) on public.logistica_solicitacao_arquivos to authenticated;
create policy logistica_anexos_consultar on public.logistica_solicitacao_arquivos for select to authenticated
 using (exists(select 1 from public.contratos_logistica c where c.id=contrato_id));
create policy logistica_anexos_incluir on public.logistica_solicitacao_arquivos for insert to authenticated
 with check (exists(select 1 from public.contratos_logistica c where c.id=contrato_id
  and not c.dados ? 'encerramento' and public.licitacoes_acesso_tela(c.grupo_id,array['logistica'],true)));
notify pgrst,'reload schema';
commit;
