begin;
create table public.chamados_clientes (
 id uuid primary key default gen_random_uuid(),
 grupo_id uuid not null references public.grupos(id),
 aberto_por uuid not null default auth.uid(),
 criado_em timestamptz not null default now(),
 assunto text not null check (length(btrim(assunto)) between 3 and 180),
 descricao text not null check (length(btrim(descricao)) between 5 and 5000),
 situacao text not null default 'Aberto' check (situacao in ('Aberto','Em atendimento','Resolvido')),
 resposta text not null default '' check (length(resposta)<=5000),
 atualizado_em timestamptz,
 check (situacao <> 'Resolvido' or length(btrim(resposta))>0)
);
create index chamados_clientes_grupo on public.chamados_clientes(grupo_id,criado_em desc);
alter table public.chamados_clientes enable row level security;
revoke all on public.chamados_clientes from anon,authenticated;
grant select,insert(grupo_id,assunto,descricao),update(situacao,resposta) on public.chamados_clientes to authenticated;
create policy chamados_leitura on public.chamados_clientes for select to authenticated using (
 public.licitacoes_eh_mestre() or exists(select 1 from public.membros m where m.grupo_id=chamados_clientes.grupo_id and m.usuario_id=auth.uid())
);
create policy chamados_cliente_abre on public.chamados_clientes for insert to authenticated with check (
 not public.licitacoes_eh_mestre() and aberto_por=auth.uid() and exists (
 select 1 from public.membros m where m.grupo_id=chamados_clientes.grupo_id and m.usuario_id=auth.uid()
 )
);
create policy chamados_mestre_atende on public.chamados_clientes for update to authenticated
using(public.licitacoes_eh_mestre()) with check(public.licitacoes_eh_mestre());
create function controle_licitacoes.marcar_atendimento() returns trigger
language plpgsql set search_path='' as $stamp$
begin
 new.atualizado_em:=now();
 return new;
end;
$stamp$;
create trigger marcar_atendimento before update on public.chamados_clientes
for each row execute function controle_licitacoes.marcar_atendimento();
create trigger auditar_atendimento after update on public.chamados_clientes
for each row execute function controle_licitacoes.auditar_plataforma('id');
notify pgrst,'reload schema';
commit;
