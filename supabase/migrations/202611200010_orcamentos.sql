begin;
alter table public.cotacoes
  add column tipo text not null default 'fornecedor' check (tipo in ('fornecedor','orcamento')),
  add column orgao_id uuid references public.orgaos_compradores(id),
  add column pdf_assinado text check (pdf_assinado is null or (length(pdf_assinado) between 8 and 6990508 and pdf_assinado like 'JVBERi0%')),
  add column assinado_em timestamptz;
grant insert(tipo,orgao_id), update(orgao_id,pdf_assinado) on public.cotacoes to authenticated;
create function public.validar_orcamento_assinado() returns trigger language plpgsql set search_path='' as $$
begin
 if new.tipo <> 'orcamento' then
  if new.orgao_id is not null or new.pdf_assinado is not null then raise exception 'Campos exclusivos do orçamento'; end if;
  return new;
 end if;
 if not exists(select 1 from public.orgaos_compradores o where o.id=new.orgao_id and o.grupo_id=new.grupo_id)
 then raise exception 'Selecione um órgão comprador do seu cadastro'; end if;
 if tg_op='UPDATE' then
  if row(new.titulo,new.empresa_id,new.orgao_id,new.fornecedor,new.observacao,new.itens) is distinct from row(old.titulo,old.empresa_id,old.orgao_id,old.fornecedor,old.observacao,old.itens) then
   if old.etapa=2 then raise exception 'Volte para Revisão antes de editar'; end if;
   new.pdf_assinado=null;
  end if;
  if new.pdf_assinado is distinct from old.pdf_assinado then
   if new.pdf_assinado is not null and old.etapa<>1 then raise exception 'Anexe o PDF assinado na Revisão'; end if;
   new.assinado_em=case when new.pdf_assinado is null then null else clock_timestamp() end;
  end if;
 end if;
 if new.etapa=2 and (new.pdf_assinado is null or new.assinado_em is null) then raise exception 'Anexe o orçamento assinado antes de marcar como enviado'; end if;
 if new.etapa=2 and exists(select 1 from jsonb_array_elements(new.itens) i where i->>'preco' is null)
 then raise exception 'Informe o preço de todos os itens'; end if;
 return new;
end $$;
create trigger validar_orcamento_assinado before insert or update on public.cotacoes for each row execute function public.validar_orcamento_assinado();
notify pgrst, 'reload schema';
commit;
