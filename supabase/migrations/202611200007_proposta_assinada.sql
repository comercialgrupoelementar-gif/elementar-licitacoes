begin;
create table public.propostas_assinadas (
  edital_id uuid primary key,
  grupo_id uuid not null,
  empresa_id uuid not null,
  pdf text not null check (length(pdf) between 8 and 6990508 and pdf like 'JVBERi0%'),
  anexado_em timestamptz not null default clock_timestamp(),
  foreign key(grupo_id,empresa_id,edital_id) references public.editais(grupo_id,empresa_id,id) on delete cascade
);
alter table public.propostas_assinadas enable row level security;
grant select on public.propostas_assinadas to authenticated;
create policy ler_assinatura on public.propostas_assinadas for select to authenticated using (
  exists (select 1 from public.membros m where m.grupo_id=propostas_assinadas.grupo_id and m.usuario_id=auth.uid())
);
create function public.anexar_proposta_assinada(p_edital uuid,p_pdf text) returns void
language plpgsql security definer set search_path='' as $$
declare proposta public.editais%rowtype;
begin
  select e.* into proposta from public.editais e join public.membros m on m.grupo_id=e.grupo_id
    where e.id=p_edital and m.usuario_id=auth.uid() and m.papel in ('admin','operador') for update of e;
  if not found or proposta.etapa_proposta<>4 or proposta.status<>'Aprovado' or proposta.empresa_id is null then
    raise exception 'Anexe o PDF assinado na Conferência 02';
  end if;
  insert into public.propostas_assinadas(edital_id,grupo_id,empresa_id,pdf)
    values(proposta.id,proposta.grupo_id,proposta.empresa_id,p_pdf)
    on conflict(edital_id) do update set pdf=excluded.pdf, anexado_em=clock_timestamp();
end $$;
revoke all on function public.anexar_proposta_assinada(uuid,text) from public;
grant execute on function public.anexar_proposta_assinada(uuid,text) to authenticated;
create function public.validar_assinatura_proposta() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.etapa_proposta=5 and old.etapa_proposta<>5 and not exists (
    select 1 from public.propostas_assinadas a where a.edital_id=new.id and a.empresa_id=new.empresa_id
  ) then raise exception 'Anexe a proposta em PDF assinada na Conferência 02 antes de enviar para disputa'; end if;
  if (old.etapa_proposta>=4 and new.etapa_proposta<4) or new.empresa_id is distinct from old.empresa_id then
    delete from public.propostas_assinadas where edital_id=old.id;
  end if;
  return new;
end $$;
revoke all on function public.validar_assinatura_proposta() from public;
create trigger validar_assinatura_proposta before update of etapa_proposta,empresa_id on public.editais
for each row execute function public.validar_assinatura_proposta();
notify pgrst, 'reload schema';
commit;
