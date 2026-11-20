begin;
alter table public.catalogo alter column preco_venda_manual type numeric(16,4);
alter table public.itens alter column quantidade type numeric(15,4);
notify pgrst, 'reload schema';
commit;
