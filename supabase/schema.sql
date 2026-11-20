-- FamilySplit: схема облачной синхронизации для Supabase.
-- Выполните целиком в Supabase → SQL Editor → New query → Run.
--
-- Модель доступа: таблица закрыта для прямого чтения/записи (RLS без политик),
-- работать с ней можно только через две функции ниже, и только зная id
-- мероприятия (32 hex-символа = 128 бит случайности, передаётся в ссылке).
-- Перечислить чужие мероприятия невозможно.

create table if not exists public.fs_events (
  id          text primary key check (id ~ '^[0-9a-f]{32}$'),
  doc         jsonb not null,
  rev         integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.fs_events enable row level security;
-- Политик нет намеренно: anon не может делать select/insert/update напрямую.

-- Получить мероприятие. Если p_since_rev = текущей ревизии, документ не передаётся
-- (экономим трафик при опросе).
create or replace function public.fs_get_event(p_id text, p_since_rev integer default 0)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case
    when e.rev > coalesce(p_since_rev, 0) then jsonb_build_object('rev', e.rev, 'doc', e.doc)
    else jsonb_build_object('rev', e.rev)
  end
  from public.fs_events e
  where e.id = p_id;
$$;

-- Сохранить мероприятие с оптимистичной блокировкой.
-- p_rev — ревизия, на основе которой клиент делал слияние (0 — новое мероприятие).
-- Возвращает новую ревизию или -1 при конфликте (клиент заберёт свежую версию,
-- сольёт со своей и повторит).
create or replace function public.fs_put_event(p_id text, p_doc jsonb, p_rev integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_rev integer;
begin
  if p_id !~ '^[0-9a-f]{32}$' then
    raise exception 'bad id';
  end if;
  if pg_column_size(p_doc) > 1000000 then
    raise exception 'document too large';
  end if;

  if coalesce(p_rev, 0) = 0 then
    insert into public.fs_events (id, doc) values (p_id, p_doc)
    on conflict (id) do nothing
    returning rev into new_rev;
    return coalesce(new_rev, -1);
  end if;

  update public.fs_events
     set doc = p_doc, rev = rev + 1, updated_at = now()
   where id = p_id and rev = p_rev
  returning rev into new_rev;
  return coalesce(new_rev, -1);
end;
$$;

revoke all on public.fs_events from anon, authenticated;
grant execute on function public.fs_get_event(text, integer) to anon, authenticated;
grant execute on function public.fs_put_event(text, jsonb, integer) to anon, authenticated;
