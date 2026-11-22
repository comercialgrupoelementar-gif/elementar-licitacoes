begin;
alter policy contratos_consultar on public.contratos_logistica
 using (not public.licitacoes_eh_mestre() and public.licitacoes_acesso_tela(grupo_id,array['logistica'],false));
alter policy contratos_incluir on public.contratos_logistica
 with check (not public.licitacoes_eh_mestre() and public.licitacoes_acesso_tela(grupo_id,array['logistica'],true)
  and (edital_id is null or exists(select 1 from public.editais e where e.id=contratos_logistica.edital_id and e.grupo_id=contratos_logistica.grupo_id)));
alter policy contratos_alterar on public.contratos_logistica
 using (not public.licitacoes_eh_mestre() and public.licitacoes_acesso_tela(grupo_id,array['logistica'],true))
 with check (not public.licitacoes_eh_mestre() and public.licitacoes_acesso_tela(grupo_id,array['logistica'],true));
commit;
