begin;
create function public.licitacoes_vincular_integrante(cliente uuid,email_membro text,papel_membro text,nome_usuario text,cargo uuid)
returns void language plpgsql security definer set search_path='' as $body$
begin
 if not public.licitacoes_pode_gerenciar_equipe(cliente) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 if nome_usuario is null or length(btrim(nome_usuario)) not between 2 and 80 then raise exception 'Informe um nome de 2 a 80 caracteres'; end if;
 perform public.licitacoes_adicionar_membro(cliente,email_membro,papel_membro);
 update public.membros m set alias_empresa=btrim(nome_usuario),cargo_id=cargo
 from auth.users u where m.grupo_id=cliente and m.usuario_id=u.id and lower(u.email)=lower(btrim(email_membro));
 if not found then raise exception 'Integrante não encontrado'; end if;
end;
$body$;
revoke all on function public.licitacoes_vincular_integrante(uuid,text,text,text,uuid) from public,anon;
grant execute on function public.licitacoes_vincular_integrante(uuid,text,text,text,uuid) to authenticated;
create function public.licitacoes_nomes_equipe(empresa uuid) returns jsonb
language plpgsql security definer set search_path='' as $body$
begin
 if not public.licitacoes_pode_gerenciar_equipe(empresa) then raise exception 'Acesso restrito à administração' using errcode='42501'; end if;
 return coalesce((select jsonb_object_agg(m.usuario_id,jsonb_build_object('nome',m.alias_empresa,'cargo',c.nome))
 from public.membros m left join public.cargos_empresa c on c.grupo_id=m.grupo_id and c.id=m.cargo_id
 where m.grupo_id=empresa),'{}'::jsonb);
end;
$body$;
revoke all on function public.licitacoes_nomes_equipe(uuid) from public,anon;
grant execute on function public.licitacoes_nomes_equipe(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
