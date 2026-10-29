-- The Haunted Trail: players, covens and shared code drafts.
-- Every player is an anonymous Supabase user; they can only write their own rows.

create table if not exists public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  doc jsonb not null,
  updated_at timestamptz not null default now(),
  constraint players_doc_size check (pg_column_size(doc) < 65536)
);

create table if not exists public.teams (
  code text primary key check (code ~ '^[A-Z0-9]{4}$'),
  doc jsonb not null,
  founder uuid not null default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teams_doc_size check (pg_column_size(doc) < 4096)
);

create table if not exists public.drafts (
  team_id text not null references public.teams(code) on delete cascade,
  puzzle_id text not null check (puzzle_id ~ '^[a-z0-9]{2,4}$'),
  doc jsonb not null,
  by_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (team_id, puzzle_id),
  constraint drafts_doc_size check (pg_column_size(doc) < 40000)
);

alter table public.players enable row level security;
alter table public.teams   enable row level security;
alter table public.drafts  enable row level security;

-- players: everyone reads the board; you write only your own row
create policy "players read"   on public.players for select using (true);
create policy "players insert" on public.players for insert to authenticated with check (id = auth.uid());
create policy "players update" on public.players for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- teams: everyone reads coven names; anyone signed in can found one (as themselves)
create policy "teams read"   on public.teams for select using (true);
create policy "teams insert" on public.teams for insert to authenticated with check (founder = auth.uid());
-- members can rename their own coven (the code and founder stay fixed)
create policy "teams update" on public.teams for update to authenticated
  using (exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = teams.code))
  with check (exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = teams.code));

-- drafts: only members of that coven read or write its shared code
create policy "drafts read" on public.drafts for select to authenticated
  using (exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = drafts.team_id));
create policy "drafts insert" on public.drafts for insert to authenticated
  with check (by_id = auth.uid() and exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = drafts.team_id));
create policy "drafts update" on public.drafts for update to authenticated
  using (exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = drafts.team_id))
  with check (by_id = auth.uid() and exists (select 1 from public.players p where p.id = auth.uid() and p.doc->>'teamId' = drafts.team_id));

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger players_touch before update on public.players for each row execute function public.touch_updated_at();
create trigger drafts_touch  before update on public.drafts  for each row execute function public.touch_updated_at();

-- live updates for the board and coven names
alter publication supabase_realtime add table public.players, public.teams;
