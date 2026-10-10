-- =====================================================================
-- あさよみ(朝の配信アプリ: 今日の雑学5選・今日のニュース8選)
-- Supabase プロジェクト gzayrjlhruhvklsidraw に相乗り。テーブルは asayomi_ で始める。
--
-- 中身(記事)   : asayomi_days / asayomi_items   … 毎朝 Claude の定期タスクが asayomi_publish() で入れる
-- 使った記録   : asayomi_state                  … 既読・保存・復習カード・設定。端末から asayomi_state_sync() で1件ずつ
-- ToDo連携     : asayomi_todo_add()             … gtasks_queue に積む(Apps Script が Google ToDo へ転送)
-- 表はどれも公開キーから「読むだけ」。書き込みは関数だけが行う。
-- =====================================================================

create sequence if not exists public.asayomi_rev_seq;
create sequence if not exists public.asayomi_state_rev_seq;

create table if not exists public.asayomi_meta (
  key text primary key,
  value jsonb not null
);
insert into public.asayomi_meta(key, value) values ('epoch', to_jsonb('1'::text))
  on conflict (key) do nothing;

create table if not exists public.asayomi_days (
  kind text not null check (kind in ('trivia', 'news')),
  date date not null,
  data jsonb not null default '{}'::jsonb,
  rev bigint not null default nextval('public.asayomi_rev_seq'),
  updated_at timestamptz not null default now(),
  primary key (kind, date)
);

create table if not exists public.asayomi_items (
  kind text not null check (kind in ('trivia', 'news')),
  date date not null,
  n int not null check (n between 1 and 20),
  data jsonb not null,
  svg text,
  rev bigint not null default nextval('public.asayomi_rev_seq'),
  updated_at timestamptz not null default now(),
  primary key (kind, date, n)
);
create index if not exists asayomi_items_rev_idx on public.asayomi_items(rev);
create index if not exists asayomi_days_rev_idx on public.asayomi_days(rev);

create table if not exists public.asayomi_state (
  id text primary key check (char_length(id) between 1 and 200),
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null,
  rev bigint not null default nextval('public.asayomi_state_rev_seq'),
  device text
);
create index if not exists asayomi_state_rev_idx on public.asayomi_state(rev);

create table if not exists public.asayomi_todo_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  title text not null,
  queue_id bigint
);

alter table public.asayomi_meta enable row level security;
alter table public.asayomi_days enable row level security;
alter table public.asayomi_items enable row level security;
alter table public.asayomi_state enable row level security;
alter table public.asayomi_todo_log enable row level security;

drop policy if exists asayomi_days_read on public.asayomi_days;
create policy asayomi_days_read on public.asayomi_days for select to anon, authenticated using (true);
drop policy if exists asayomi_items_read on public.asayomi_items;
create policy asayomi_items_read on public.asayomi_items for select to anon, authenticated using (true);
-- 週次バックアップ(backup-supabase.ps1)が公開キーで読めるように、記録も読むだけは開けておく
drop policy if exists asayomi_state_read on public.asayomi_state;
create policy asayomi_state_read on public.asayomi_state for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.asayomi_meta, public.asayomi_days, public.asayomi_items,
  public.asayomi_state, public.asayomi_todo_log from anon, authenticated;

-- ---------------------------------------------------------------------
-- 毎朝の中身を入れる(定期タスク専用。公開キーからは呼べない)
--   p = { "kind": "trivia"|"news", "date": "YYYY-MM-DD", "day": {...}, "items": [ {..., "svg": "..."} ] }
--   同じ日付をもう一度送ると上書き。items は分けて送ってもよい(各要素に "n" を付ける)。
-- ---------------------------------------------------------------------
create or replace function public.asayomi_publish(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_kind text := p->>'kind';
  v_date date;
  v_items jsonb := coalesce(p->'items', '[]'::jsonb);
  v_day jsonb := p->'day';
  it jsonb;
  i int := 0;
  v_n int;
  v_svg text;
  v_count int;
  v_warn jsonb := '[]'::jsonb;
begin
  if v_kind is null or v_kind not in ('trivia', 'news') then
    raise exception 'kind は "trivia" か "news" にしてください';
  end if;
  begin
    v_date := (p->>'date')::date;
  exception when others then
    raise exception 'date は "YYYY-MM-DD" の形にしてください';
  end;
  if v_date is null then raise exception 'date がありません'; end if;
  if jsonb_typeof(v_items) <> 'array' then raise exception 'items は配列にしてください'; end if;
  if jsonb_array_length(v_items) = 0 and (v_day is null or jsonb_typeof(v_day) <> 'object') then
    raise exception '中身が空です(items も day もありません)';
  end if;

  for it in select value from jsonb_array_elements(v_items) loop
    i := i + 1;
    if jsonb_typeof(it) <> 'object' then raise exception 'items[%] がオブジェクトではありません', i; end if;
    v_n := coalesce(nullif(it->>'n', '')::int, i);
    if coalesce(it->>'title', '') = '' then raise exception 'items[%] に title がありません', i; end if;
    v_svg := nullif(it->>'svg', '');
    if v_svg is not null and v_svg ~* '(<\s*script|<\s*foreignobject|<\s*iframe|<\s*image|javascript:|\son[a-z]+\s*=)' then
      v_svg := null;
      v_warn := v_warn || to_jsonb(format('items[%s] の svg に使えない記述があったので外しました', i));
    end if;
    insert into public.asayomi_items(kind, date, n, data, svg, rev, updated_at)
    values (v_kind, v_date, v_n, (it - 'svg' - 'n'), v_svg, nextval('public.asayomi_rev_seq'), now())
    on conflict (kind, date, n) do update
      set data = excluded.data,
          svg = coalesce(excluded.svg, public.asayomi_items.svg),
          rev = excluded.rev,
          updated_at = excluded.updated_at;
  end loop;

  select count(*) into v_count from public.asayomi_items where kind = v_kind and date = v_date;

  insert into public.asayomi_days(kind, date, data, rev, updated_at)
  values (v_kind, v_date,
          coalesce(case when jsonb_typeof(v_day) = 'object' then v_day end, '{}'::jsonb) || jsonb_build_object('count', v_count),
          nextval('public.asayomi_rev_seq'), now())
  on conflict (kind, date) do update
    set data = (case when jsonb_typeof(v_day) = 'object' then v_day else public.asayomi_days.data end)
               || jsonb_build_object('count', v_count),
        rev = excluded.rev,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true, 'kind', v_kind, 'date', v_date, 'items', v_count, 'warnings', v_warn,
    'url', 'https://neitianguang209-oss.github.io/asayomi/#/' || v_kind || '/' || v_date::text);
end;
$$;

-- 雑学: これまでに出したテーマの一覧(重複を避けるために定期タスクが最初に読む)
create or replace function public.asayomi_trivia_history()
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select coalesce(string_agg(block, E'\n\n' order by date), '')
  from (
    select date,
           '## ' || date::text || E'\n' ||
           string_agg(n::text || '. ' || coalesce(nullif(data->>'history', ''),
                      coalesce(data->>'genreLabel', '') || '：' || coalesce(data->>'title', '') ||
                      case when coalesce(data->>'keyword', '') <> '' then '（' || (data->>'keyword') || '）' else '' end),
                      E'\n' order by n) as block
    from public.asayomi_items
    where kind = 'trivia'
    group by date
  ) t;
$$;

-- ニュース: 直近に出した見出し(重複回避)と、続いている話題の名前(「流れ」をつなぐため)
create or replace function public.asayomi_news_context(p_days int default 8)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select
    E'# 直近の見出し(同じニュースは出さない。続報は新しい進展だけ)\n' ||
    coalesce((
      select string_agg(block, E'\n\n' order by date)
      from (
        select date,
               '## ' || date::text || E'\n' ||
               string_agg(n::text || '. ' || coalesce(data->>'title', '') ||
                          case when coalesce(data->>'thread', '') <> '' then ' 〔話題: ' || (data->>'thread') || '〕' else '' end ||
                          case when jsonb_typeof(data->'keywords') = 'array'
                               then ' [keywords: ' || (select string_agg(k, ', ') from jsonb_array_elements_text(data->'keywords') k) || ']'
                               else '' end,
                          E'\n' order by n) as block
        from public.asayomi_items
        where kind = 'news' and date >= (now() at time zone 'Asia/Tokyo')::date - greatest(coalesce(p_days, 8), 1)
        group by date
      ) t
    ), '(まだありません)') ||
    E'\n\n# 続いている話題の名前(同じ話の続きなら thread に同じ名前をそのまま使う)\n' ||
    coalesce((
      select string_agg(thread || '（' || cnt || '回・最後 ' || last::text || '）', E'\n' order by last desc, cnt desc)
      from (
        select data->>'thread' as thread, count(*) as cnt, max(date) as last
        from public.asayomi_items
        where kind = 'news' and coalesce(data->>'thread', '') <> ''
          and date >= (now() at time zone 'Asia/Tokyo')::date - 60
        group by 1
      ) s
    ), '(まだありません)');
$$;

-- ---------------------------------------------------------------------
-- アプリが読む
-- ---------------------------------------------------------------------
-- 前回より後に変わった分だけ(イラスト抜きの軽い形)。p_since は前回もらった rev。
create or replace function public.asayomi_pull(p_since bigint default 0, p_limit int default 150)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_epoch text;
  v_rev bigint;
  v_since bigint := greatest(coalesce(p_since, 0), 0);
  v_lim int := least(greatest(coalesce(p_limit, 150), 1), 400);
  v_items jsonb;
  v_days jsonb;
  v_last bigint;
  v_total int;
begin
  select value #>> '{}' into v_epoch from public.asayomi_meta where key = 'epoch';
  select greatest(coalesce((select max(rev) from public.asayomi_items), 0),
                  coalesce((select max(rev) from public.asayomi_days), 0)) into v_rev;
  if v_since > v_rev then v_since := 0; end if;   -- クラウド側が作り直された: 全部を送り直す

  select count(*) into v_total from public.asayomi_items where rev > v_since and rev <= v_rev;

  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'date', date, 'n', n, 'data', data,
                                               'art', svg is not null, 'rev', rev) order by rev), '[]'::jsonb),
         max(rev)
    into v_items, v_last
    from (select * from public.asayomi_items where rev > v_since and rev <= v_rev order by rev limit v_lim) u;

  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'date', date, 'data', data, 'rev', rev) order by rev), '[]'::jsonb)
    into v_days
    from public.asayomi_days where rev > v_since and rev <= v_rev;

  return jsonb_build_object(
    'epoch', v_epoch,
    'rev', case when v_total > v_lim then v_last else v_rev end,
    'more', v_total > v_lim,
    'full', v_since = 0,
    'days', v_days,
    'items', v_items);
end;
$$;

-- 1日分をイラスト込みで。p_date を省くとその種類の最新日。
create or replace function public.asayomi_day(p_kind text, p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_date date := p_date;
  v_day jsonb;
  v_rev bigint;
  v_items jsonb;
begin
  if v_date is null then
    select max(date) into v_date from public.asayomi_days where kind = p_kind;
  end if;
  if v_date is null then return null; end if;
  select data, rev into v_day, v_rev from public.asayomi_days where kind = p_kind and date = v_date;
  if v_day is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('n', n, 'data', data, 'svg', svg, 'rev', rev) order by n), '[]'::jsonb)
    into v_items from public.asayomi_items where kind = p_kind and date = v_date;
  return jsonb_build_object('kind', p_kind, 'date', v_date, 'day', v_day, 'rev', v_rev, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------------
-- 使った記録(既読・保存・復習カード・設定)の同期。新しい方が勝つ。消しても行は残す。
-- ---------------------------------------------------------------------
create or replace function public.asayomi_state_sync(
  p_changes jsonb default '[]'::jsonb, p_since bigint default null, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  c jsonb;
  n int := 0;
  v_id text;
  v_ts timestamptz;
  v_del boolean;
  v_rev bigint;
  v_since bigint;
  v_rows jsonb;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'p_changes は配列にしてください';
  end if;
  if jsonb_array_length(p_changes) > 3000 then
    raise exception '一度に送れるのは3000件までです';
  end if;

  for c in select value from jsonb_array_elements(p_changes) loop
    v_id := c->>'id';
    if v_id is null or char_length(v_id) = 0 or char_length(v_id) > 200 then continue; end if;
    if pg_column_size(c) > 20000 then continue; end if;
    begin
      v_ts := (c->>'updatedAt')::timestamptz;
    exception when others then
      v_ts := now();
    end;
    if v_ts is null or v_ts > now() + interval '1 day' then v_ts := now(); end if;
    v_del := coalesce(c->>'deleted', 'false') = 'true';

    insert into public.asayomi_state(id, data, deleted, updated_at, rev, device)
    values (v_id, case when v_del then null else c->'data' end, v_del, v_ts,
            nextval('public.asayomi_state_rev_seq'), left(p_device, 120))
    on conflict (id) do update
      set data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at,
          rev = excluded.rev, device = excluded.device
      where excluded.updated_at > public.asayomi_state.updated_at;
    if found then n := n + 1; end if;
  end loop;

  if p_since is null then
    return jsonb_build_object('applied', n);
  end if;

  select coalesce(max(rev), 0) into v_rev from public.asayomi_state;
  v_since := p_since;
  if v_since < 0 or v_since > v_rev then v_since := 0; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'data', data, 'deleted', deleted,
                                               'updatedAt', updated_at, 'rev', rev) order by rev), '[]'::jsonb)
    into v_rows
    from public.asayomi_state where rev > v_since and rev <= v_rev;

  return jsonb_build_object('applied', n, 'rev', v_rev, 'full', v_since = 0, 'records', v_rows);
end;
$$;

-- ---------------------------------------------------------------------
-- 「あとで調べる」を Google ToDo へ(gtasks_queue に積む。Apps Script が5分おきに転送)
-- ---------------------------------------------------------------------
create or replace function public.asayomi_todo_add(p_title text, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_title text := left(btrim(coalesce(p_title, '')), 200);
  v_cnt int;
  v_id bigint;
begin
  if v_title = '' then raise exception 'タイトルが空です'; end if;
  select count(*) into v_cnt from public.asayomi_todo_log where created_at > now() - interval '24 hours';
  if v_cnt >= 40 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  if exists (select 1 from public.asayomi_todo_log
             where title = v_title and created_at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  insert into public.gtasks_queue(list_name, title, notes)
  values ('To Doリスト', v_title, nullif(left(coalesce(p_notes, ''), 2000), ''))
  returning id into v_id;
  insert into public.asayomi_todo_log(title, queue_id) values (v_title, v_id);
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- 権限: 中身を入れる関数と履歴を読む関数は公開キーから呼べない
revoke execute on function public.asayomi_publish(jsonb) from public, anon, authenticated;
revoke execute on function public.asayomi_trivia_history() from public, anon, authenticated;
revoke execute on function public.asayomi_news_context(int) from public, anon, authenticated;
grant execute on function public.asayomi_pull(bigint, int) to anon, authenticated;
grant execute on function public.asayomi_day(text, date) to anon, authenticated;
grant execute on function public.asayomi_state_sync(jsonb, bigint, text) to anon, authenticated;
grant execute on function public.asayomi_todo_add(text, text) to anon, authenticated;
