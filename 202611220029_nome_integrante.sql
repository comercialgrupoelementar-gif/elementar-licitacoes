begin;
create function public.licitacoes_renomear_integrante(empresa uuid,integrante uuid,nome text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then
  raise exception 'Acesso restrito à administração' using errcode='42501';
 end if;
 if nome is null or length(btrim(nome)) not between 2 and 80 then
  raise exception 'Informe um nome de 2 a 80 caracteres';
 end if;
 update public.membros set alias_empresa=btrim(nome)
 where grupo_id=empresa and usuario_id=integrante;
 if not found then raise exception 'Integrante não encontrado'; end if;
end;
$$;
revoke all on function public.licitacoes_renomear_integrante(uuid,uuid,text) from public,anon;
grant execute on function public.licitacoes_renomear_integrante(uuid,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
