do $$
begin
 if exists(select 1 from pg_policies where schemaname='public' and tablename='empresas' and policyname='empresa_demo_insert') then
  alter policy empresa_demo_insert on public.empresas with check (
   grupo_id <> '4df12050-8638-4906-ae91-f0fb199f266d'
   or (grupo_id = '4df12050-8638-4906-ae91-f0fb199f266d' and (select auth.jwt()->>'email') = 'demo@example.com'
       and public.licitacoes_acesso_tela(grupo_id,array['configuracoes'],true))
  );
 end if;
end $$;
