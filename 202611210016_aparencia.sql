begin;
create table public.aparencia_telas (
 grupo_id uuid not null references public.grupos(id) on delete cascade,
 tela text not null check (tela ~ '^[a-zA-Z]{1,40}$'),
 ajustes jsonb not null check (jsonb_typeof(ajustes)='object' and octet_length(ajustes::text)<2048),
 primary key(grupo_id,tela)
);
alter table public.aparencia_telas enable row level security;
revoke all on public.aparencia_telas from anon,authenticated;
grant select,insert,update on public.aparencia_telas to authenticated;
create policy ler_aparencia on public.aparencia_telas for select to authenticated using (
 public.licitacoes_eh_mestre() or exists(select 1 from public.membros m where m.grupo_id=aparencia_telas.grupo_id and m.usuario_id=auth.uid())
);
create policy criar_aparencia on public.aparencia_telas for insert to authenticated with check(public.licitacoes_eh_mestre());
create policy editar_aparencia on public.aparencia_telas for update to authenticated using(public.licitacoes_eh_mestre()) with check(public.licitacoes_eh_mestre());
notify pgrst,'reload schema';
commit;
