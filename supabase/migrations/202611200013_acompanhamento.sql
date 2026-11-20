begin;
create table public.acompanhamentos (
 id uuid primary key default gen_random_uuid(), grupo_id uuid not null, edital_id uuid not null unique,
 ajustes jsonb not null default '{}' check(jsonb_typeof(ajustes)='object'),
 versao integer not null default 0, finalizado_em timestamptz,
 unique(grupo_id,id), foreign key(grupo_id,edital_id) references public.editais(grupo_id,id)
);
create table public.acompanhamento_arquivos (
 id uuid primary key default gen_random_uuid(), grupo_id uuid not null, acompanhamento_id uuid not null,
 nome text not null check(length(btrim(nome)) between 1 and 200),
 tipo text not null check(tipo in ('Ata','Documento do processo','Proposta assinada','Contrato','ARP')),
 pdf text not null check(length(pdf) between 8 and 6990508 and pdf like 'JVBERi0%'),
 versao integer not null, criado_em timestamptz not null default clock_timestamp(),
 foreign key(grupo_id,acompanhamento_id) references public.acompanhamentos(grupo_id,id)
);
do $$
declare t text;
begin
 foreach t in array array['acompanhamentos','acompanhamento_arquivos'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy leitura on public.%I for select to authenticated using (exists(select 1 from public.membros m where m.grupo_id=%I.grupo_id and m.usuario_id=auth.uid()))',t,t);
  execute format('create policy cadastro on public.%I for insert to authenticated with check (exists(select 1 from public.membros m where m.grupo_id=%I.grupo_id and m.usuario_id=auth.uid() and m.papel in (''admin'',''operador'')))',t,t);
 end loop;
end $$;
grant insert(grupo_id,edital_id),update(ajustes,finalizado_em) on public.acompanhamentos to authenticated;
grant insert(grupo_id,acompanhamento_id,nome,tipo,pdf,versao) on public.acompanhamento_arquivos to authenticated;
create policy editar on public.acompanhamentos for update to authenticated using (
 exists(select 1 from public.membros m where m.grupo_id=acompanhamentos.grupo_id and m.usuario_id=auth.uid() and m.papel in ('admin','operador'))
);
create function public.validar_acompanhamento() returns trigger language plpgsql set search_path='' as $$
declare resultados jsonb;
begin
 if tg_op='UPDATE' then
  if old.finalizado_em is not null then raise exception 'Processo já arquivado'; end if;
  if new.ajustes is distinct from old.ajustes then new.versao=old.versao+1; end if;
 end if;
 select d.resultados into resultados from public.disputas d where d.grupo_id=new.grupo_id and d.edital_id=new.edital_id and d.etapa=2 for share;
 if not found then raise exception 'Envie a disputa para acompanhamento primeiro'; end if;
 if new.finalizado_em is not null then
  if exists(select 1 from public.itens i where i.grupo_id=new.grupo_id and i.edital_id=new.edital_id and coalesce(new.ajustes->(i.id::text)->>'situacao',resultados->(i.id::text)->>'situacao')='Ganhamos')
   and not exists(select 1 from public.acompanhamento_arquivos a where a.acompanhamento_id=new.id and a.grupo_id=new.grupo_id and a.tipo='Proposta assinada' and a.versao=new.versao)
  then raise exception 'Anexe a proposta readequada assinada desta versão antes de finalizar'; end if;
  new.finalizado_em=clock_timestamp();
 end if;
 return new;
end $$;
create trigger validar_acompanhamento before insert or update on public.acompanhamentos for each row execute function public.validar_acompanhamento();
create function public.validar_arquivo_acompanhamento() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.acompanhamentos a where a.id=new.acompanhamento_id and a.grupo_id=new.grupo_id and a.finalizado_em is null and a.versao=new.versao for share)
 then raise exception 'Atualize a tela antes de anexar o arquivo'; end if;
 return new;
end $$;
create trigger validar_arquivo_acompanhamento before insert on public.acompanhamento_arquivos for each row execute function public.validar_arquivo_acompanhamento();
create function public.proteger_disputa_em_acompanhamento() returns trigger language plpgsql set search_path='' as $
begin
 if old.etapa=2 and new.etapa<>2 and exists(select 1 from public.acompanhamentos a where a.edital_id=old.edital_id and a.grupo_id=old.grupo_id)
 then raise exception 'Edite os resultados no acompanhamento deste processo'; end if;
 return new;
end $;
create trigger proteger_disputa_em_acompanhamento before update on public.disputas for each row execute function public.proteger_disputa_em_acompanhamento();
notify pgrst, 'reload schema';
commit;
