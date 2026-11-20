begin;
alter table public.editais add column etapa_proposta smallint not null default 0 check(etapa_proposta between 0 and 5);
alter table public.arquivos_empresa add column criado_em timestamptz not null default now();
grant update(validade) on public.arquivos_empresa to authenticated;
create policy validade_documento on public.arquivos_empresa for update to authenticated using (
  exists(select 1 from public.membros m where m.grupo_id=arquivos_empresa.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
);
create table public.historico_proposta (
  id bigint generated always as identity primary key,
  grupo_id uuid not null,
  edital_id uuid not null,
  origem smallint not null,
  destino smallint not null,
  responsavel text not null,
  ocorrido_em timestamptz not null default clock_timestamp(),
  foreign key(grupo_id,edital_id) references public.editais(grupo_id,id) on delete cascade
);
alter table public.historico_proposta enable row level security;
grant select on public.historico_proposta to authenticated;
create policy leitura_historico on public.historico_proposta for select to authenticated using (
  exists(select 1 from public.membros m where m.grupo_id=historico_proposta.grupo_id and m.usuario_id=auth.uid())
);
create function public.mover_proposta(p_edital uuid, p_origem smallint, p_destino smallint)
returns void language plpgsql security definer set search_path = '' as $$
declare proposta public.editais%rowtype;
begin
  select e.* into proposta from public.editais e join public.membros m on m.grupo_id=e.grupo_id
    where e.id=p_edital and m.usuario_id=auth.uid() and m.papel in ('admin','operador') for update of e;
  if not found or proposta.status <> 'Aprovado' then raise exception 'Proposta indisponível'; end if;
  if p_origem<>proposta.etapa_proposta or p_destino not between 0 and 5 or abs(p_destino-p_origem)<>1 then
    raise exception 'Atualize a tela e mova a proposta uma coluna por vez';
  end if;
  if p_destino>p_origem and p_destino>=2 and not exists (
    select 1 from public.itens i where i.grupo_id=proposta.grupo_id and i.edital_id=p_edital
  ) then raise exception 'Cadastre os itens da proposta'; end if;
  if p_destino>p_origem and p_destino>=3 and (
    not exists(select 1 from public.anexos_proposta a where a.grupo_id=proposta.grupo_id and a.edital_id=p_edital)
    or exists(select 1 from public.anexos_proposta a join public.arquivos_empresa d on d.id=a.arquivo_id
      where a.grupo_id=proposta.grupo_id and a.edital_id=p_edital and d.validade<(now() at time zone 'America/Sao_Paulo')::date)
  ) then raise exception 'Vincule documentos válidos antes de avançar'; end if;
  update public.editais set etapa_proposta=p_destino where id=p_edital;
  insert into public.historico_proposta(grupo_id,edital_id,origem,destino,responsavel)
    values(proposta.grupo_id,p_edital,p_origem,p_destino,coalesce(auth.jwt()->>'email',auth.uid()::text));
end $$;
revoke all on function public.mover_proposta(uuid,smallint,smallint) from public;
grant execute on function public.mover_proposta(uuid,smallint,smallint) to authenticated;
revoke update on public.editais from authenticated;
grant update(grupo_id,empresa_id,numero,orgao,modalidade,sessao,status,parecer,numero_pregao,edital_url,local_disputa,edital_pdf_nome,edital_pdf,objeto,modo_disputa) on public.editais to authenticated;
notify pgrst, 'reload schema';
commit;
