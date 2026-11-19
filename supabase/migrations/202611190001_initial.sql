begin;
create table public.grupos (
 id uuid primary key default gen_random_uuid(),
 nome text not null check (length(trim(nome)) > 0)
);
create table public.membros (
 grupo_id uuid references public.grupos on delete cascade,
 usuario_id uuid references auth.users on delete cascade,
 papel text not null check (papel in ('admin','operador','leitor')),
 primary key (grupo_id,usuario_id)
);
alter table public.grupos enable row level security;
alter table public.membros enable row level security;
create policy membro_proprio on public.membros for select to authenticated using (usuario_id = (select auth.uid()));
create policy grupo_membro on public.grupos for select to authenticated using (
 exists(select 1 from public.membros m where m.grupo_id = grupos.id and m.usuario_id = (select auth.uid()))
);
grant select on public.grupos, public.membros to authenticated;

create table public.empresas (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null references public.grupos,
 nome text not null,
 cnpj text not null check(cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
 porte text not null check(porte in ('MEI','MEI Caminhoneiro','ME','EPP','Demais')),
 unique (grupo_id,cnpj), unique (grupo_id,id)
);
create table public.editais (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null references public.grupos,
 empresa_id uuid,
 numero text not null,
 orgao text not null,
 modalidade text not null,
 sessao date,
 status text not null default 'Captado' check(status in ('Captado','Em análise','Aprovado','Reprovado')),
 parecer text not null default '',
 unique(grupo_id,id),
 foreign key(grupo_id,empresa_id) references public.empresas(grupo_id,id),
 check(status <> 'Aprovado' or empresa_id is not null)
);
create table public.itens (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null,
 edital_id uuid not null,
 codigo text not null,
 descricao text not null,
 quantidade numeric(14,3) not null check(quantidade > 0),
 embalagem numeric(14,3) not null check(embalagem > 0),
 custo_embalagem numeric(14,4) not null check(custo_embalagem >= 0),
 margem numeric(7,4) not null check(margem >= 0 and margem < 100),
 preco_unitario numeric generated always as (round(custo_embalagem / embalagem / (1 - margem / 100), 2)) stored,
 unique(grupo_id,edital_id,codigo),
 foreign key(grupo_id,edital_id) references public.editais(grupo_id,id)
);
create table public.documentos (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null,
 edital_id uuid not null,
 nome text not null,
 validade date,
 conferido boolean not null default false,
 foreign key(grupo_id,edital_id) references public.editais(grupo_id,id)
);

do $$
declare tabela text;
begin
 foreach tabela in array array['empresas','editais','itens','documentos'] loop
  execute format('alter table public.%I enable row level security', tabela);
  execute format('grant select, insert, update on public.%I to authenticated', tabela);
  execute format('create policy leitura on public.%I for select to authenticated using (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid())))', tabela, tabela);
  execute format('create policy cadastro on public.%I for insert to authenticated with check (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid()) and m.papel in (''admin'',''operador'')))', tabela, tabela);
  execute format('create policy edicao on public.%I for update to authenticated using (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid()) and m.papel in (''admin'',''operador''))) with check (exists (select 1 from public.membros m where m.grupo_id = %I.grupo_id and m.usuario_id = (select auth.uid()) and m.papel in (''admin'',''operador'')))', tabela, tabela, tabela);
 end loop;
end $$;
commit;
