begin;
alter table public.catalogo
  add column imposto_compra_unitario numeric(14,4) not null default 0 check (imposto_compra_unitario >= 0),
  add column imposto_venda_pct numeric(7,4) not null default 0 check (imposto_venda_pct >= 0),
  add column preco_venda_manual numeric(14,2) check (preco_venda_manual >= 0),
  add constraint catalogo_margem_imposto_venda check (margem + imposto_venda_pct < 100);
notify pgrst, 'reload schema';
commit;
