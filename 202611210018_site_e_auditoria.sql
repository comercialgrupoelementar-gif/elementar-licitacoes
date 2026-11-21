begin;
create table public.interesses_comerciais (
 id uuid primary key default gen_random_uuid(),
 nome text not null,
 empresa text not null,
 email text not null,
 interesse text not null check (interesse in ('demonstracao','contratacao')),
 situacao text not null default 'Novo' check (situacao in ('Novo','Em contato','Convertido','Encerrado')),
 criado_em timestamptz not null default now()
);
create index interesses_email_data on public.interesses_comerciais(email,criado_em);
alter table public.interesses_comerciais enable row level security;
revoke all on public.interesses_comerciais from anon, authenticated;
grant select, update(situacao) on public.interesses_comerciais to authenticated;
create policy interesses_mestre on public.interesses_comerciais for all to authenticated
using (public.licitacoes_eh_mestre()) with check (public.licitacoes_eh_mestre());
create function public.licitacoes_solicitar_contato(p_nome text,p_empresa text,p_email text,p_interesse text)
returns void language plpgsql security definer set search_path='' as $rpc$
declare email_limpo text := lower(btrim(p_email));
begin
 if p_nome is null or p_empresa is null or email_limpo is null or p_interesse is null
    or length(btrim(p_nome)) not between 2 and 120 or length(btrim(p_empresa)) not between 2 and 150
    or length(email_limpo)>254 or email_limpo !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or p_interesse not in ('demonstracao','contratacao') then
   raise exception 'Confira o nome, a empresa e o e-mail.' using errcode='22023';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(email_limpo,0));
 if exists(select 1 from public.interesses_comerciais where email=email_limpo and criado_em > now()-interval '10 minutes') then
   return;
 end if;
 insert into public.interesses_comerciais(nome,empresa,email,interesse)
 values (btrim(p_nome),btrim(p_empresa),email_limpo,p_interesse);
end;
$rpc$;
revoke all on function public.licitacoes_solicitar_contato(text,text,text,text) from public;
grant execute on function public.licitacoes_solicitar_contato(text,text,text,text) to anon,authenticated;
create table public.auditoria_plataforma (
 id bigint generated always as identity primary key,
 ocorrido_em timestamptz not null default now(),
 usuario_id uuid,
 recurso text not null,
 acao text not null,
 registro uuid not null
);
alter table public.auditoria_plataforma enable row level security;
revoke all on public.auditoria_plataforma from anon, authenticated;
grant select on public.auditoria_plataforma to authenticated;
create policy auditoria_mestre on public.auditoria_plataforma for select to authenticated using(public.licitacoes_eh_mestre());
create function controle_licitacoes.auditar_plataforma() returns trigger
language plpgsql security definer set search_path='' as $audit$
begin
 insert into public.auditoria_plataforma(usuario_id,recurso,acao,registro)
 values(auth.uid(),tg_table_name,tg_op,(to_jsonb(new)->>tg_argv[0])::uuid);
 return new;
end;
$audit$;
revoke all on function controle_licitacoes.auditar_plataforma() from public;
create trigger auditar_gestao after insert or update on public.gestao_comercial
for each row execute function controle_licitacoes.auditar_plataforma('id');
create trigger auditar_interesse after update on public.interesses_comerciais
for each row execute function controle_licitacoes.auditar_plataforma('id');
create trigger auditar_aparencia after insert or update on public.aparencia_telas
for each row execute function controle_licitacoes.auditar_plataforma('grupo_id');
notify pgrst, 'reload schema';
commit;
