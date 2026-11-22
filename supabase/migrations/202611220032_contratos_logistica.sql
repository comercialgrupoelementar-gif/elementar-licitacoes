begin;
create table public.contratos_logistica (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null references public.grupos(id),
 edital_id uuid references public.editais(id),
 versao integer not null default 0,
 dados jsonb not null check (jsonb_typeof(dados)='object'
  and jsonb_typeof(dados->'itens')='array' and jsonb_typeof(dados->'ordens')='array'
  and jsonb_typeof(dados->'solicitacoes')='array' and jsonb_typeof(dados->'historico')='array'),
 atualizado_em timestamptz not null default now()
);
create index contratos_logistica_grupo on public.contratos_logistica(grupo_id);
alter table public.contratos_logistica enable row level security;
revoke all on public.contratos_logistica from anon, authenticated;
grant select, insert, update (dados, versao) on public.contratos_logistica to authenticated;
create policy contratos_consultar on public.contratos_logistica for select to authenticated
 using (public.licitacoes_eh_mestre() or public.licitacoes_acesso_tela(grupo_id,array['logistica'],false));
create policy contratos_incluir on public.contratos_logistica for insert to authenticated
 with check (public.licitacoes_acesso_tela(grupo_id,array['logistica'],true)
  and (edital_id is null or exists(select 1 from public.editais e where e.id=contratos_logistica.edital_id and e.grupo_id=contratos_logistica.grupo_id)));
create policy contratos_alterar on public.contratos_logistica for update to authenticated
 using (public.licitacoes_eh_mestre() or public.licitacoes_acesso_tela(grupo_id,array['logistica'],true))
 with check (public.licitacoes_eh_mestre() or public.licitacoes_acesso_tela(grupo_id,array['logistica'],true));
create function controle_licitacoes.auditar_contrato_logistica() returns trigger
language plpgsql set search_path='' as $fn$
declare evento jsonb; item jsonb; ordem jsonb; linha jsonb; remessa jsonb; reservado numeric; previsto numeric;
begin
 if tg_op='UPDATE' then
  if public.licitacoes_eh_mestre() and (new.dados-'alertas'-'acao') is distinct from (old.dados-'alertas'-'acao') then
   raise exception 'O Mestre Gerenciador pode ajustar somente os alertas do contrato';
  end if;
  if new.versao<>old.versao+1 then raise exception 'Versão do contrato desatualizada'; end if;
  if old.dados ? 'encerramento' then raise exception 'Contrato encerrado'; end if;
 end if;
 for item in select value from jsonb_array_elements(new.dados->'itens') loop
  if coalesce((item->>'quantidade')::numeric,0)<=0 or coalesce((item->>'preco')::numeric,0)<=0 then
   raise exception 'Quantidade contratada e preço unitário precisam ser positivos';
  end if;
  select coalesce(sum((l->>'quantidade')::numeric-coalesce((l->>'cancelada')::numeric,0)),0)
   into reservado from jsonb_array_elements(new.dados->'ordens') o cross join lateral jsonb_array_elements(o->'itens') l
   where l->>'id'=item->>'id';
  if reservado > (item->>'quantidade')::numeric then raise exception 'Ordens excedem o saldo contratado'; end if;
 end loop;
 for ordem in select value from jsonb_array_elements(new.dados->'ordens') loop
  for linha in select value from jsonb_array_elements(ordem->'itens') loop
   if not exists(select 1 from jsonb_array_elements(new.dados->'itens') i where i->>'id'=linha->>'id') then
    raise exception 'Item da ordem não pertence ao contrato';
   end if;
   previsto:=(linha->>'quantidade')::numeric-coalesce((linha->>'cancelada')::numeric,0);
   if previsto is null or previsto<0 or coalesce((linha->>'cancelada')::numeric,0)<0 then raise exception 'Quantidade da ordem inválida'; end if;
   reservado:=0;
   for remessa in select value from jsonb_array_elements(linha->'remessas') loop
    if coalesce((remessa->>'entregue')::numeric,0)<=0 or coalesce((remessa->>'aceita')::numeric,-1)<0
       or (remessa->>'aceita')::numeric>(remessa->>'entregue')::numeric then raise exception 'Quantidade da remessa inválida'; end if;
    reservado:=reservado+case when (remessa->>'conferida')::boolean then (remessa->>'aceita')::numeric else (remessa->>'entregue')::numeric end;
   end loop;
   if reservado>previsto then raise exception 'Entregas excedem a quantidade solicitada'; end if;
  end loop;
 end loop;
 evento:=jsonb_build_object('em',now(),'usuario',auth.uid(),'acao',left(coalesce(new.dados->>'acao','Contrato cadastrado'),160));
 new.dados:=jsonb_set(new.dados-'acao','{historico}',
  (case when tg_op='UPDATE' then old.dados->'historico' else '[]'::jsonb end)||evento);
 new.atualizado_em:=now();
 return new;
end;
$fn$;
create trigger contrato_logistica_historico before insert or update on public.contratos_logistica
for each row execute function controle_licitacoes.auditar_contrato_logistica();
alter table public.notificacoes_lidas drop constraint notificacoes_lidas_evento_check;
alter table public.notificacoes_lidas add check (evento ~ '^((chamado|mensagem|solucao):[0-9a-f-]{36}|logistica:[0-9a-f-]{36}:[0-9]{1,10}:[0-9a-f]{1,8})$');
commit;
