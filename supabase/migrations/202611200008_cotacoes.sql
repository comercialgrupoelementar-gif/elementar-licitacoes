begin;
create table public.cotacoes (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos,
  empresa_id uuid not null,
  titulo text not null check (length(btrim(titulo)) between 1 and 200),
  fornecedor text not null check (length(btrim(fornecedor)) between 1 and 200),
  email text,
  observacao text,
  etapa smallint not null default 0 check (etapa between 0 and 2),
  itens jsonb not null default '[]' check (jsonb_typeof(itens)='array' and jsonb_array_length(itens)<=1000),
  historico jsonb not null default '[]',
  revisao integer not null default 0,
  criado_em timestamptz not null default now(),
  foreign key (grupo_id,empresa_id) references public.empresas(grupo_id,id)
);
alter table public.cotacoes enable row level security;
revoke all on public.cotacoes from anon, authenticated;
grant select on public.cotacoes to authenticated;
grant insert(grupo_id,empresa_id,titulo,fornecedor,email,observacao), update(empresa_id,titulo,fornecedor,email,observacao,etapa,itens) on public.cotacoes to authenticated;
create policy leitura_cotacoes on public.cotacoes for select to authenticated using (
  exists (select from public.membros m where m.grupo_id=cotacoes.grupo_id and m.usuario_id=auth.uid())
);
create policy criar_cotacao on public.cotacoes for insert to authenticated with check (
  exists (select from public.membros m where m.grupo_id=cotacoes.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
);
create policy editar_cotacao on public.cotacoes for update to authenticated using (
  exists (select from public.membros m where m.grupo_id=cotacoes.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
);
create function public.registrar_etapa_cotacao() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.historico=jsonb_build_array(jsonb_build_object('destino',0,'usuario',auth.jwt()->>'email','data',clock_timestamp()));
    return new;
  end if;
  if new.etapa<>old.etapa then
    if abs(new.etapa-old.etapa)<>1 then raise exception 'Mova a cotação uma coluna por vez'; end if;
    if new.etapa>old.etapa and jsonb_array_length(new.itens)=0 then raise exception 'Inclua pelo menos um item do catálogo'; end if;
    new.historico=old.historico || jsonb_build_array(jsonb_build_object('origem',old.etapa,'destino',new.etapa,'usuario',auth.jwt()->>'email','data',clock_timestamp()));
  end if;
  new.revisao=old.revisao+1;
  return new;
end $$;
create trigger registrar_etapa_cotacao before insert or update on public.cotacoes
for each row execute function public.registrar_etapa_cotacao();

create function public.aplicar_custo_cotado(p_cotacao uuid,p_item uuid,p_custo_esperado numeric,p_revisao integer)
returns void language plpgsql security definer set search_path='' as $$
declare cot public.cotacoes%rowtype;
declare item jsonb;
declare pos integer;
declare valor numeric;
begin
  select c.* into cot from public.cotacoes c join public.membros m on m.grupo_id=c.grupo_id
    where c.id=p_cotacao and m.usuario_id=auth.uid() and m.papel in ('admin','operador') for update of c;
  if not found or cot.etapa<>2 or cot.revisao<>p_revisao then raise exception 'Atualize a tela e confira novamente a cotação enviada'; end if;
  select e.value,(e.ordinality-1)::integer into item,pos from jsonb_array_elements(cot.itens) with ordinality e
    where e.value->>'catalogo_id'=p_item::text;
  if not found or item->>'preco' is null or item->>'aplicado_em' is not null then raise exception 'Preço indisponível para aplicar'; end if;
  valor=(item->>'preco')::numeric;
  update public.catalogo set custo=valor where id=p_item and grupo_id=cot.grupo_id and custo=p_custo_esperado;
  if not found then raise exception 'O custo do catálogo mudou. Atualize a tela e confira novamente'; end if;
  update public.cotacoes set itens=jsonb_set(itens,array[pos::text,'aplicado_em'],to_jsonb(clock_timestamp())) where id=cot.id;
end $$;
revoke all on function public.aplicar_custo_cotado(uuid,uuid,numeric,integer) from public;
grant execute on function public.aplicar_custo_cotado(uuid,uuid,numeric,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
