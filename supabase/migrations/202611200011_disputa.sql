begin;
create table public.disputas (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null,
 edital_id uuid not null unique,
 etapa smallint not null default 0 check (etapa between 0 and 2),
 margem_minima numeric(7,4) not null default 20 check(margem_minima>=0 and margem_minima<100),
 alerta numeric(7,4) not null default 3 check(alerta>=0 and margem_minima+alerta<100),
 resultados jsonb not null default '{}' check(jsonb_typeof(resultados)='object'),
 revisao integer not null default 0,
 historico jsonb not null default '[]',
 foreign key(grupo_id,edital_id) references public.editais(grupo_id,id) on delete cascade
);
alter table public.disputas enable row level security;
revoke all on public.disputas from anon,authenticated;
grant select on public.disputas to authenticated;
grant insert(grupo_id,edital_id,margem_minima,alerta),update(etapa,margem_minima,alerta,resultados) on public.disputas to authenticated;
create policy leitura_disputa on public.disputas for select to authenticated using (
 exists(select 1 from public.membros m where m.grupo_id=disputas.grupo_id and m.usuario_id=auth.uid())
);
create policy cadastro_disputa on public.disputas for insert to authenticated with check (
 exists(select 1 from public.membros m where m.grupo_id=disputas.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
 and exists(select 1 from public.editais e where e.id=disputas.edital_id and e.grupo_id=disputas.grupo_id and e.etapa_proposta=5 and e.status='Aprovado')
);
create policy edicao_disputa on public.disputas for update to authenticated using (
 exists(select 1 from public.membros m where m.grupo_id=disputas.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
);
create function public.registrar_disputa() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then return new; end if;
 if old.etapa=2 and row(old.margem_minima,old.alerta,old.resultados) is distinct from row(new.margem_minima,new.alerta,new.resultados)
 then raise exception 'Reabra a disputa antes de alterar os dados'; end if;
 if old.etapa<>new.etapa then
  if abs(old.etapa-new.etapa)<>1 then raise exception 'Mova a disputa uma coluna por vez'; end if;
  if new.etapa=2 and (not exists(select 1 from public.itens i where i.edital_id=new.edital_id and i.grupo_id=new.grupo_id)
    or exists(select 1 from public.itens i where i.edital_id=new.edital_id and i.grupo_id=new.grupo_id
      and coalesce(new.resultados->(i.id::text)->>'situacao','') not in ('Ganhamos','Perdemos','Sem vencedor')))
  then raise exception 'Registre o resultado final de todos os itens antes de enviar'; end if;
  new.historico=old.historico || jsonb_build_array(jsonb_build_object('origem',old.etapa,'destino',new.etapa,'usuario',coalesce(auth.jwt()->>'email',auth.uid()::text),'data',clock_timestamp()));
 end if;
 new.revisao=old.revisao+1;
 return new;
end $$;
create trigger registrar_disputa before update on public.disputas for each row execute function public.registrar_disputa();
notify pgrst, 'reload schema';
commit;
