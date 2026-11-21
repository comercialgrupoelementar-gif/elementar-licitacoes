begin;
create table public.notificacoes_lidas (
 usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 evento text not null check (evento ~ '^(chamado|mensagem|solucao):[0-9a-f-]{36}$'),
 primary key(usuario_id,evento)
);
alter table public.notificacoes_lidas enable row level security;
revoke all on public.notificacoes_lidas from anon,authenticated;
grant select,insert(evento) on public.notificacoes_lidas to authenticated;
create policy ler_notificacoes_proprias on public.notificacoes_lidas for select to authenticated using(usuario_id=auth.uid());
create policy marcar_notificacoes_proprias on public.notificacoes_lidas for insert to authenticated with check(usuario_id=auth.uid());
notify pgrst,'reload schema';
commit;
