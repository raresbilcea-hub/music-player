-- Keep public chart lookup readable while blocking direct writes from browser roles.
-- The backend writes through its server-side Supabase credential, which bypasses RLS.

alter table public.chord_charts enable row level security;

drop policy if exists "Public can read chord charts" on public.chord_charts;

create policy "Public can read chord charts"
  on public.chord_charts
  for select
  to anon, authenticated
  using (true);
