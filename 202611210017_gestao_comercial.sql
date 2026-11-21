begin;
create table public.gestao_comercial (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos(id),
  tipo text not null check (tipo in ('assinatura','cobranca','suporte')),
  titulo text not null check (length(btrim(titulo)) between 1 and 180),
  situacao text not null,
  valor numeric(15,4) not null default 0 check (valor >= 0),
  prazo date not null,
  observacao text not null default '' check (length(observacao) <= 4000),
  check (
    (tipo='assinatura' and situacao in ('Ativa','Em avaliação','Suspensa','Cancelada')) or
    (tipo='cobranca' and situacao in ('Pendente','Recebida','Cancelada')) or
    (tipo='suporte' and situacao in ('Aberto','Em atendimento','Resolvido') and valor=0)
  )
);
create unique index gestao_assinatura_unica on public.gestao_comercial(grupo_id) where tipo='assinatura';
alter table public.gestao_comercial enable row level security;
revoke all on public.gestao_comercial from anon, authenticated;
grant select, insert, update on public.gestao_comercial to authenticated;
create policy gestao_mestre on public.gestao_comercial for all to authenticated
using (public.licitacoes_eh_mestre()) with check (public.licitacoes_eh_mestre());
notify pgrst, 'reload schema';
commit;
