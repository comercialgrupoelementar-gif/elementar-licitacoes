begin;
create policy criar_configuracoes_demo on public.aparencia_telas for insert to authenticated with check (grupo_id = '4df12050-8638-4906-ae91-f0fb199f266d' and (select auth.jwt()->>'email') = 'demo@example.com' and public.licitacoes_acesso_tela(grupo_id, array['configuracoes'], true));
create policy editar_configuracoes_demo on public.aparencia_telas for update to authenticated using (grupo_id = '4df12050-8638-4906-ae91-f0fb199f266d' and (select auth.jwt()->>'email') = 'demo@example.com' and public.licitacoes_acesso_tela(grupo_id, array['configuracoes'], true)) with check (grupo_id = '4df12050-8638-4906-ae91-f0fb199f266d' and (select auth.jwt()->>'email') = 'demo@example.com' and public.licitacoes_acesso_tela(grupo_id, array['configuracoes'], true));
commit;
