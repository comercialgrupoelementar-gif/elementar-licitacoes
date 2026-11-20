begin;
create table public.arquivos_empresa (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null,
  empresa_id uuid not null,
  nome text not null check (length(nome) between 1 and 240),
  validade date,
  conteudo text not null check (length(conteudo) between 4 and 6990508),
  unique(grupo_id,empresa_id,id),
  foreign key(grupo_id,empresa_id) references public.empresas(grupo_id,id)
);

alter table public.editais add constraint editais_grupo_empresa_id unique(grupo_id,empresa_id,id);
create table public.anexos_proposta (
  grupo_id uuid not null,
  empresa_id uuid not null,
  edital_id uuid not null,
  arquivo_id uuid not null,
  primary key(grupo_id,edital_id,arquivo_id),
  foreign key(grupo_id,empresa_id,edital_id) references public.editais(grupo_id,empresa_id,id) on delete cascade,
  foreign key(grupo_id,empresa_id,arquivo_id) references public.arquivos_empresa(grupo_id,empresa_id,id)
);

do $$
declare tabela text;
begin
  foreach tabela in array array['arquivos_empresa','anexos_proposta'] loop
    execute format('alter table public.%I enable row level security',tabela);
    execute format('grant select, insert on public.%I to authenticated',tabela);
    execute format('create policy leitura on public.%I for select to authenticated using (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid())))',tabela,tabela);
    execute format('create policy cadastro on public.%I for insert to authenticated with check (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid()) and m.papel in (''admin'',''operador'')))',tabela,tabela);
  end loop;
end $$;

grant delete on public.anexos_proposta to authenticated;
create policy desvincular on public.anexos_proposta for delete to authenticated using (
  exists (select 1 from public.membros m where m.grupo_id = anexos_proposta.grupo_id and m.usuario_id = (select auth.uid()) and m.papel in ('admin','operador'))
);
commit;
