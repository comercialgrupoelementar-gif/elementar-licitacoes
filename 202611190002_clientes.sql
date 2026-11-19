begin;
create schema if not exists controle_licitacoes;
revoke all on schema controle_licitacoes from public;
create table controle_licitacoes.mestres (
 usuario_id uuid primary key references auth.users(id) on delete cascade
);
alter table controle_licitacoes.mestres enable row level security;

create or replace function public.licitacoes_eh_mestre()
returns boolean language sql stable security definer set search_path = ''
as $$
 select exists(select 1 from controle_licitacoes.mestres where usuario_id = auth.uid())
$$;

create or replace function public.licitacoes_clientes()
returns table(id uuid, nome text, integrantes bigint)
language plpgsql security definer set search_path = ''
as $$
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 return query select g.id,g.nome,count(m.usuario_id) from public.grupos g
 left join public.membros m on m.grupo_id=g.id group by g.id order by g.nome,g.id;
end $$;

create or replace function public.licitacoes_criar_cliente(nome_cliente text, email_admin text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare conta uuid; cliente uuid;
begin
 if not public.licitacoes_eh_mestre() then raise exception 'Acesso restrito ao Mestre Gerenciador' using errcode='42501'; end if;
 if nome_cliente is null or length(trim(nome_cliente)) not between 1 and 120 then raise exception 'Informe o nome do cliente'; end if;
 select id into strict conta from auth.users where lower(email)=lower(trim(email_admin)) and email_confirmed_at is not null;
 insert into public.grupos(nome) values(trim(nome_cliente)) returning id into cliente;
 insert into public.membros(grupo_id,usuario_id,papel) values(cliente,conta,'admin');
 return cliente;
exception when no_data_found then raise exception 'O administrador precisa ter uma conta confirmada no Supabase Auth';
end $$;

create or replace function public.licitacoes_equipe(cliente uuid)
returns table(usuario_id uuid, email text, papel text)
language plpgsql security definer set search_path = ''
as $$
begin
 if not exists(select 1 from public.membros m where m.grupo_id=cliente and m.usuario_id=auth.uid() and m.papel='admin') then
  raise exception 'Acesso restrito ao administrador da empresa' using errcode='42501';
 end if;
 return query select m.usuario_id,u.email::text,m.papel from public.membros m
 join auth.users u on u.id=m.usuario_id where m.grupo_id=cliente order by u.email;
end $$;

create or replace function public.licitacoes_adicionar_membro(cliente uuid, email_membro text, papel_membro text)
returns void language plpgsql security definer set search_path = ''
as $$
declare conta uuid;
begin
 if not exists(select 1 from public.membros m where m.grupo_id=cliente and m.usuario_id=auth.uid() and m.papel='admin') then
  raise exception 'Acesso restrito ao administrador da empresa' using errcode='42501';
 end if;
 if papel_membro is null or papel_membro not in ('operador','leitor') then raise exception 'Selecione operador ou leitor'; end if;
 select id into strict conta from auth.users where lower(email)=lower(trim(email_membro)) and email_confirmed_at is not null;
 insert into public.membros(grupo_id,usuario_id,papel) values(cliente,conta,papel_membro);
exception
 when no_data_found then raise exception 'O integrante precisa ter uma conta confirmada';
 when unique_violation then raise exception 'Esta conta já faz parte da empresa';
end $$;

revoke all on function public.licitacoes_eh_mestre(), public.licitacoes_clientes(), public.licitacoes_criar_cliente(text,text), public.licitacoes_equipe(uuid), public.licitacoes_adicionar_membro(uuid,text,text) from public, anon;
grant execute on function public.licitacoes_eh_mestre(), public.licitacoes_clientes(), public.licitacoes_criar_cliente(text,text), public.licitacoes_equipe(uuid), public.licitacoes_adicionar_membro(uuid,text,text) to authenticated;
commit;
