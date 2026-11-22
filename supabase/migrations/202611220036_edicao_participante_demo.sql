begin;
alter policy empresa_demo_update on public.empresas
 using (grupo_id<>'4df12050-8638-4906-ae91-f0fb199f266d' or public.licitacoes_demo_editar_participantes(grupo_id))
 with check (grupo_id<>'4df12050-8638-4906-ae91-f0fb199f266d' or public.licitacoes_demo_editar_participantes(grupo_id));
commit;
