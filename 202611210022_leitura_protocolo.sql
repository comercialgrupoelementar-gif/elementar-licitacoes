begin;
alter policy chamados_leitura on public.chamados_clientes using (
 public.licitacoes_eh_mestre() or (public.licitacoes_acesso_empresa(grupo_id,false) and
 (aberto_por=auth.uid() or exists(select 1 from public.membros m where m.grupo_id=chamados_clientes.grupo_id and m.usuario_id=auth.uid() and m.papel='admin')))
);
commit;
