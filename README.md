# The Haunted Trail 🎃

A Halloween coding hunt for **ColorStack Minerva**. Players walk a haunted trail through five Minerva rotation cities (San Francisco, Seoul, Hyderabad, Berlin, Buenos Aires), clearing 20 levels and 5 optional boss crypts.

- 10 puzzles (ciphers, riddles, "what does this print", a haunted-house BFS) and 15 coding problems with an in-browser editor (Python via Skulpt, JavaScript via a Web Worker), Run/Submit, and a test tape
- 1–3 stars per level, rank-ups with tech pioneers from each city, 4 hidden secret words
- Covens (teams): share progress, see who's on which level, and share code across devices
- Live leaderboard and a projector view (`#board`)

## How it runs

It's a single static `index.html` served by GitHub Pages. The leaderboard, covens and presence use [Supabase](https://supabase.com): every player gets an anonymous account, and row-level security (see `supabase/schema.sql`) lets each player write only their own row. The key in `index.html` is Supabase's public anon key, which is meant to be in client code.

## Resetting the board

In the Supabase SQL editor:

```sql
delete from public.teams;
delete from auth.users where is_anonymous = true;  -- cascades to players and drafts
```
