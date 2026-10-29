# Event simulator

Runs a swarm of bot players against the live Supabase project, like a real event: mixed skill levels
(newbie → expert, idle, chaotic), covens, shared code, a late-join spike, and security probes.
A monitor measures how fast each update reaches the board and audits the final database.

```bash
cd stress && npm i @supabase/supabase-js@2.45.4
SUPABASE_ANON_KEY=... node sim.mjs --bots=80 --late=40 --minutes=60 --scale=8
```

Bots are named `🤖 …`; remove them afterwards with the host dashboard's **Reset board** (or SQL).
