begin;

create table controle_licitacoes.permissoes_cadastro (
  grupo_id uuid not null,
  usuario_id uuid not null,
  recurso text not null check (recurso in ('catalogo','orgaos_compradores')),
  acao text not null check (acao in ('visualizar','cadastrar','editar','excluir')),
  permitido boolean not null,
  primary key (grupo_id,usuario_id,recurso,acao),
  foreign key (grupo_id,usuario_id) references public.membros(grupo_id,usuario_id) on delete cascade
);
alter table controle_licitacoes.permissoes_cadastro enable row level security;

create function public.licitacoes_permite_cadastro(cliente uuid, recurso text, acao text)
returns boolean language sql stable security definer set search_path=''
as $$
  select coalesce((
    select case when m.papel='admin' then true else coalesce(p.permitido,true) end
    from public.membros m
    left join controle_licitacoes.permissoes_cadastro p
      on p.grupo_id=m.grupo_id and p.usuario_id=m.usuario_id
      and p.recurso=$2 and p.acao=$3
    where m.grupo_id=$1 and m.usuario_id=auth.uid()
  ),false)
$$;

create function public.licitacoes_permissoes_cadastro(cliente uuid, integrante uuid)
returns table(recurso text,acao text,permitido boolean)
language plpgsql stable security definer set search_path=''
as $$
begin
  if not public.licitacoes_pode_gerenciar_equipe(cliente) then
    raise exception 'Acesso restrito à administração' using errcode='42501';
  end if;
  return query select p.recurso,p.acao,p.permitido
  from controle_licitacoes.permissoes_cadastro p
  where p.grupo_id=cliente and p.usuario_id=integrante;
end $$;

create function public.licitacoes_salvar_permissoes_cadastro(cliente uuid, integrante uuid, permissoes jsonb)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if not public.licitacoes_pode_gerenciar_equipe(cliente) then
    raise exception 'Acesso restrito à administração' using errcode='42501';
  end if;
  perform 1 from public.membros m where m.grupo_id=cliente and m.usuario_id=integrante
    and m.papel in ('operador','leitor') and integrante<>auth.uid()
    and not exists(select 1 from controle_licitacoes.mestres where usuario_id=integrante)
    for update;
  if not found then raise exception 'Conta protegida ou integrante não encontrado'; end if;
  if permissoes is null or jsonb_typeof(permissoes)<>'array' or jsonb_array_length(permissoes)>8 then
    raise exception 'Permissões inválidas';
  end if;
  delete from controle_licitacoes.permissoes_cadastro p
    where p.grupo_id=cliente and p.usuario_id=integrante;
  insert into controle_licitacoes.permissoes_cadastro(grupo_id,usuario_id,recurso,acao,permitido)
    select cliente,integrante,p.recurso,p.acao,p.permitido
    from jsonb_to_recordset(permissoes) p(recurso text,acao text,permitido boolean);
end $$;

revoke all on function public.licitacoes_permite_cadastro(uuid,text,text),
  public.licitacoes_permissoes_cadastro(uuid,uuid),
  public.licitacoes_salvar_permissoes_cadastro(uuid,uuid,jsonb) from public,anon;
grant execute on function public.licitacoes_permite_cadastro(uuid,text,text),
  public.licitacoes_permissoes_cadastro(uuid,uuid),
  public.licitacoes_salvar_permissoes_cadastro(uuid,uuid,jsonb) to authenticated;

do $$
declare recurso text;
begin
  foreach recurso in array array['catalogo','orgaos_compradores'] loop
    execute format('create policy permissao_visualizar on public.%I as restrictive for select to authenticated using (public.licitacoes_permite_cadastro(grupo_id,%L,%L))',recurso,recurso,'visualizar');
    execute format('create policy permissao_cadastrar on public.%I as restrictive for insert to authenticated with check (public.licitacoes_permite_cadastro(grupo_id,%L,%L))',recurso,recurso,'cadastrar');
    execute format('create policy permissao_editar on public.%I as restrictive for update to authenticated using (public.licitacoes_permite_cadastro(grupo_id,%L,%L)) with check (public.licitacoes_permite_cadastro(grupo_id,%L,%L))',recurso,recurso,'editar',recurso,'editar');
    execute format('create policy permissao_excluir on public.%I as restrictive for delete to authenticated using (public.licitacoes_permite_cadastro(grupo_id,%L,%L))',recurso,recurso,'excluir');
  end loop;
end $$;
-- Mantém a restrição também quando o catálogo é alterado por uma RPC SECURITY DEFINER.
create function controle_licitacoes.verificar_edicao_catalogo()
returns trigger language plpgsql security definer set search_path=''
as $
begin
  if auth.uid() is not null and (
    not public.licitacoes_permite_cadastro(old.grupo_id,'catalogo','editar')
    or not public.licitacoes_permite_cadastro(new.grupo_id,'catalogo','editar')
  ) then
    raise exception 'Edição do catálogo bloqueada para esta conta' using errcode='42501';
  end if;
  return new;
end $;
revoke all on function controle_licitacoes.verificar_edicao_catalogo() from public,anon,authenticated;
create trigger verificar_edicao_catalogo before update on public.catalogo
for each row execute function controle_licitacoes.verificar_edicao_catalogo();
notify pgrst, 'reload schema';
commit;
