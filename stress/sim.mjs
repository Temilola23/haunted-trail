// Full-event simulation for The Haunted Trail: a swarm of bot players + a monitor.
// Every bot behaves like the real page: anonymous sign-in, a players row it rewrites on each change,
// live subscriptions to players/teams, coven presence, coven code drafts.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const URL = "https://glmcrzggvmnhyexkznjm.supabase.co";
const KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith("--" + k + "=")); return a ? a.split("=")[1] : d; };
const N_START = +arg("bots", 80), N_LATE = +arg("late", 40), EVENT_MIN = +arg("minutes", 60), SCALE = +arg("scale", 8);
const REAL_MS = EVENT_MIN * 60000 / SCALE, T0 = Date.now(), END = T0 + REAL_MS;
const simMin = () => (Date.now() - T0) * SCALE / 60000;
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const expo = mean => -Math.log(1 - Math.random()) * mean;
const pick = a => a[Math.floor(Math.random() * a.length)];

// ---- game data (matches the page) ----
const LV = [
  { pts: 100, t: ["l1a:a", "l1b:a", "l1c:a", "l1d:a"], boss: "b1", bp: 250 },
  { pts: 150, t: ["l2a:a", "l2b:a", "l2c:c", "l2d:a"], boss: "b2", bp: 350 },
  { pts: 200, t: ["l3a:a", "l3b:a", "l3c:a", "l3d:c"], boss: "b3", bp: 450 },
  { pts: 300, t: ["l4a:c", "l4b:c", "l4c:c", "l4d:c"], boss: "b4", bp: 600 },
  { pts: 400, t: ["l5a:c", "l5b:c", "l5c:c", "l5d:c"], boss: "b5", bp: 800 },
];
const P = {}; LV.forEach((L, li) => { L.t.forEach(x => { const [id, k] = x.split(":"); P[id] = { li, pts: L.pts, code: k === "c", boss: false }; }); P[L.boss] = { li, pts: L.bp, code: true, boss: true }; });
const EASY_CODE = new Set(["l2c", "l3d", "l4a", "l4b", "l5d", "b1"]);
const scoreOf = st => { let s = 0; for (const id in st.solved) s += st.hints[id] ? Math.round(P[id].pts / 2) : P[id].pts; return s + Object.keys(st.eggs).length * 75; };
const solvedIn = (st, li) => LV[li].t.filter(x => st.solved[x.split(":")[0]]).length;
const rankOf = st => { let r = 0; for (let i = 0; i < 5; i++) { if (solvedIn(st, i) >= 3) r = i + 1; else break; } return r; };
const unlocked = (st, li) => li === 0 || solvedIn(st, li - 1) >= 3;

// ---- skill profiles: what they can solve, how fast (sim minutes), success odds, hint habits ----
const PROFILES = {
  newbie:  { w: 28, can: id => !P[id].code,                                      mean: 4.5, succ: .55, hint: .5 },
  learner: { w: 27, can: id => !P[id].code || EASY_CODE.has(id),                 mean: 3.2, succ: .65, hint: .3 },
  solid:   { w: 22, can: id => !["b4", "b5"].includes(id),                       mean: 2.2, succ: .75, hint: .15 },
  expert:  { w: 10, can: () => true,                                             mean: 1.3, succ: .85, hint: .05 },
  chaotic: { w: 7,  can: id => !P[id].code || EASY_CODE.has(id),                 mean: 2.5, succ: .6,  hint: .3, chaos: true },
  idle:    { w: 6,  can: () => false,                                            mean: 99,  succ: 0,   hint: 0 },
};
const profileList = Object.entries(PROFILES).flatMap(([k, v]) => Array(v.w).fill(k));

// ---- metrics ----
const M = { polls: 0, visible: [], signin: [], write: [], rt: [], errors: {}, writes: 0, writeErr: 0, seen: 0, attacks: [], solves: 0, hints: 0, covens: 0, drafts: 0, presence: 0, reconnects: 0 };
const err = (k, e) => { M.errors[k] = (M.errors[k] || 0) + 1; if (M.errors[k] <= 3) console.log("  ! " + k + ":", (e && (e.message || e.code || JSON.stringify(e))) || e); };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); };
const pending = new Map(); // `${id}:${lastAt}` -> write time (for realtime latency)

const BOTS = [], TEAMS = {};
let botN = 0;
const NAMES = ["Null", "Recursive", "Async", "Binary", "Segfault", "Lambda", "Phantom", "Cursed", "Hollow", "Undefined"];
const NAMES2 = ["Banshee", "Pointer", "Pumpkin", "Wraith", "Goblin", "Specter", "Bat", "Lich", "Ghoul", "Witch"];

class Bot {
  constructor(profile) {
    this.n = ++botN; this.profile = profile; this.P = PROFILES[profile];
    this.alias = `🤖 ${pick(NAMES)} ${pick(NAMES2)} ${this.n}`;
    this.S = { solved: {}, hints: {}, eggs: {}, tries: {} }; this.teamId = ""; this.joinedAt = Date.now();
    this.sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 20 } } });
    this.view = new Map(); // what this bot's "page" sees on the board
  }
  body() { return { alias: this.alias, teamId: this.teamId, score: scoreOf(this.S), rank: rankOf(this.S), solvedCount: Object.keys(this.S.solved).length, solved: this.S.solved, hints: this.S.hints, eggs: this.S.eggs, tries: this.S.tries, joinedAt: this.joinedAt, lastAt: Date.now() }; }
  async start() {
    const t = Date.now(); const { data, error } = await this.sb.auth.signInAnonymously();
    if (error) { err("signin", error); return false; }
    M.signin.push(Date.now() - t); this.uid = data.user.id;
    this.ch = this.sb.channel("p" + this.n).on("postgres_changes", { event: "*", schema: "public", table: "players" }, p => { if (p.new && p.new.id) this.view.set(p.new.id, p.new.doc); })
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => {}).subscribe();
    await this.save();
    this.since = null;
    this.poll = setInterval(async () => {
      let q = this.sb.from("players").select("id,doc,updated_at").limit(2000);
      if (this.since) q = q.gte("updated_at", this.since);
      const { data, error } = await q; M.polls++;
      if (error) { err("poll", error); return; }
      for (const r of data) { this.view.set(r.id, r.doc); if (!this.since || r.updated_at > this.since) this.since = r.updated_at; }
    }, 5000 + Math.random() * 1000);
    return true;
  }
  async save() {
    const doc = this.body(), t = Date.now(); M.writes++;
    pending.set(this.uid + ":" + doc.lastAt, t);
    const { error } = await this.sb.from("players").upsert({ id: this.uid, doc });
    if (error) { M.writeErr++; err("write", error); if (error.message && /JWT|token/i.test(error.message)) err("auth-expired", error); }
    else M.write.push(Date.now() - t);
  }
  union() {
    if (!this.teamId) return this.S;
    const u = { solved: { ...this.S.solved }, hints: { ...this.S.hints }, eggs: { ...this.S.eggs } };
    for (const b of BOTS) if (b !== this && b.teamId === this.teamId) { Object.assign(u.solved, b.S.solved); Object.assign(u.eggs, b.S.eggs); for (const k in b.S.hints) u.hints[k] = Math.max(u.hints[k] || 0, b.S.hints[k]); }
    return u;
  }
  async joinCoven(code) {
    const { data, error } = await this.sb.from("teams").select("doc").eq("code", code).maybeSingle();
    if (error || !data) { err("coven-join", error || "missing"); return; }
    this.teamId = code; await this.save();
    if (this.room) await this.sb.removeChannel(this.room);
    this.room = this.sb.channel("coven-" + code.toLowerCase(), { config: { presence: { key: this.uid } } });
    this.room.on("presence", { event: "sync" }, () => {}).subscribe(async st => { if (st === "SUBSCRIBED") { await this.room.track({ uid: this.uid, alias: this.alias, on: null }); M.presence++; } });
  }
  async foundCoven() {
    const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; const code = Array.from({ length: 4 }, () => pick(ABC)).join("");
    const { error } = await this.sb.from("teams").upsert({ code, doc: { name: `🤖 Coven ${code}` } });
    if (error) { err("coven-create", error); return null; }
    TEAMS[code] = this.uid; M.covens++; await this.joinCoven(code); return code;
  }
  async play() {
    while (Date.now() < END) {
      const think = expo(this.P.mean) * 60000 / SCALE;
      await sleep(Math.min(think, END - Date.now()));
      if (Date.now() >= END) break;
      if (this.P.chaos && Math.random() < .25) { await this.chaos(); continue; }
      const st = this.union();
      const options = Object.keys(P).filter(id => !st.solved[id] && unlocked(st, P[id].li) && this.P.can(id));
      if (!options.length) continue;
      // prefer the lowest open city, like real players
      const minLi = Math.min(...options.map(id => P[id].li));
      const id = Math.random() < .8 ? pick(options.filter(x => P[x].li === minLi)) : pick(options);
      if (this.room) this.room.track({ uid: this.uid, alias: this.alias, on: id }).catch(() => {});
      if (Math.random() < this.P.hint && !this.S.hints[id]) { this.S.hints[id] = 1; M.hints++; await this.save(); }
      if (P[id].code && this.teamId && Math.random() < .3) await this.draft(id);
      if (Math.random() < this.P.succ) {
        this.S.solved[id] = Date.now(); M.solves++;
        if (Math.random() < .08) { const e = pick(["e1", "e2", "e3", "e4"]); this.S.eggs[e] = Date.now(); }
        await this.save();
      } else { this.S.tries[id] = (this.S.tries[id] || 0) + 1; }
    }
  }
  async draft(id) {
    if (Math.random() < .5) { const { error } = await this.sb.from("drafts").upsert({ team_id: this.teamId, puzzle_id: id, by_id: this.uid, doc: { code: "def f():\n    return 42\n", lang: "py", by: this.alias, byId: this.uid, at: Date.now() } }); if (error) err("draft-write", error); else M.drafts++; }
    else { const { error } = await this.sb.from("drafts").select("doc").eq("team_id", this.teamId).eq("puzzle_id", id).maybeSingle(); if (error) err("draft-read", error); }
  }
  async chaos() {
    const r = Math.random();
    if (r < .25) { this.alias = `🤖 Renamed ${this.n}-${Math.floor(rnd(0, 99))}`; await this.save(); }
    else if (r < .5) { // leave or hop covens
      if (this.teamId) { this.teamId = ""; if (this.room) { await this.sb.removeChannel(this.room); this.room = null; } await this.save(); }
      else { const codes = Object.keys(TEAMS); if (codes.length) await this.joinCoven(pick(codes)); }
    } else if (r < .75) { // "refresh the page": drop and re-open live connections
      M.reconnects++; await this.sb.removeAllChannels(); this.room = null;
      this.ch = this.sb.channel("p" + this.n + "r" + M.reconnects).on("postgres_changes", { event: "*", schema: "public", table: "players" }, p => { if (p.new && p.new.id) this.view.set(p.new.id, p.new.doc); }).subscribe();
      if (this.teamId) await this.joinCoven(this.teamId);
    } else await attack(this, true);
  }
}

// ---- attacks: every one of these must be refused ----
async function attack(bot, quiet) {
  const victim = pick(BOTS.filter(b => b !== bot && b.uid)); const res = [];
  const expectFail = async (name, fn, check) => { const out = await fn(); let ok = !!out.error; if (check) ok = await check(out); res.push([name, ok]); M.attacks.push([name, ok]); if (!ok) console.log("  !! ATTACK SUCCEEDED:", name); };
  if (victim) await expectFail("overwrite another player", () => bot.sb.from("players").upsert({ id: victim.uid, doc: { alias: "HACKED", score: 999999 } }));
  await expectFail("oversized doc", () => bot.sb.from("players").upsert({ id: bot.uid, doc: { ...bot.body(), junk: "x".repeat(70000) } }));
  await expectFail("bad coven code", () => bot.sb.from("teams").upsert({ code: "hack!", doc: { name: "x" } }));
  const foreign = Object.keys(TEAMS).find(c => c !== bot.teamId);
  if (foreign) await expectFail("write into another coven's drafts", () => bot.sb.from("drafts").upsert({ team_id: foreign, puzzle_id: "l4a", doc: { code: "pwned" } }));
  if (foreign) await expectFail("read another coven's drafts", () => bot.sb.from("drafts").select("doc").eq("team_id", foreign), async o => !o.error && o.data.length === 0);
  await expectFail("change the event timer", () => bot.sb.from("event").update({ doc: { endsAt: 1 } }).eq("id", 1).select(), async o => !!o.error || (o.data || []).length === 0);
  await expectFail("reset the board", () => bot.sb.rpc("admin_reset_board"));
  if (victim) await expectFail("remove another player", () => bot.sb.rpc("admin_remove_player", { pid: victim.uid }));
  if (victim) await expectFail("delete another player's row", () => bot.sb.from("players").delete().eq("id", victim.uid).select(), async o => !!o.error || (o.data || []).length === 0);
  await expectFail("make yourself admin", () => bot.sb.from("admins").insert({ user_id: bot.uid }));
  if (!quiet) res.forEach(([n, ok]) => console.log(`   ${ok ? "✓ blocked" : "✗ ALLOWED"}  ${n}`));
}

// ---- monitor: a spectator like the big screen ----
const mon = createClient(URL, KEY, { auth: { persistSession: false } });
const monView = new Map(); let monEvents = 0, monSince = null;
const seenWrite = (id, doc) => { const k = id + ":" + doc.lastAt, t = pending.get(k); if (t) { M.visible.push(Date.now() - t); pending.delete(k); } };
setInterval(async () => {
  let q = mon.from("players").select("id,doc,updated_at").limit(2000); if (monSince) q = q.gte("updated_at", monSince);
  const { data } = await q; if (!data) return;
  for (const r of data) { monView.set(r.id, r.doc); seenWrite(r.id, r.doc); if (!monSince || r.updated_at > monSince) monSince = r.updated_at; }
}, 5000);
mon.channel("monitor").on("postgres_changes", { event: "*", schema: "public", table: "players" }, p => {
  monEvents++; if (!p.new || !p.new.id) return; monView.set(p.new.id, p.new.doc);
  const k = p.new.id + ":" + p.new.doc.lastAt, t = pending.get(k); if (t) { M.rt.push(Date.now() - t); M.seen++; } seenWrite(p.new.id, p.new.doc);
}).subscribe(s => console.log("monitor realtime:", s));

function boardTop(view, n = 5) {
  const groups = {};
  for (const [id, d] of view) { const k = d.teamId ? "t:" + d.teamId : "p:" + id; (groups[k] = groups[k] || []).push(d); }
  return Object.entries(groups).map(([k, ds]) => { const u = { solved: {}, hints: {}, eggs: {} }; ds.forEach(d => { Object.assign(u.solved, d.solved || {}); Object.assign(u.eggs, d.eggs || {}); for (const h in d.hints || {}) u.hints[h] = Math.max(u.hints[h] || 0, d.hints[h]); }); return { k, name: k.startsWith("t:") ? k.slice(2) + " (" + ds.length + ")" : ds[0].alias, score: scoreOf(u), rank: rankOf(u) }; })
    .sort((a, b) => b.score - a.score).slice(0, n);
}
function report(tag) {
  const live = BOTS.filter(b => b.uid).length;
  console.log(`\n[${tag}] sim ${simMin().toFixed(1)}/${EVENT_MIN} min · bots ${live} · writes ${M.writes} (${M.writeErr} err) · write p50/p95/p99 ${pct(M.write, 50)}/${pct(M.write, 95)}/${pct(M.write, 99)} ms · realtime ${M.seen}/${M.writes} · on board ${M.visible.length}/${M.writes} p95 ${pct(M.visible, 95)} ms · solves ${M.solves} hints ${M.hints} covens ${M.covens} drafts ${M.drafts}`);
  console.log("  board:", boardTop(monView).map(r => `${r.name} ${r.score}`).join(" | "));
}

// ---- run ----
console.log(`Simulating a ${EVENT_MIN}-minute event at ${SCALE}x (${(REAL_MS / 60000).toFixed(1)} real minutes): ${N_START} bots + ${N_LATE} late joiners`);
await sleep(1500);
async function spawn(n, spreadMs) {
  const made = [];
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    await sleep(Math.random() * spreadMs);
    const b = new Bot(pick(profileList)); BOTS.push(b);
    if (await b.start()) made.push(b);
  }));
  return made;
}
const first = await spawn(N_START, 45000);            // everyone opens the link in the first ~6 sim minutes
console.log(`signed in ${first.length}/${N_START} · sign-in p50/p95 ${pct(M.signin, 50)}/${pct(M.signin, 95)} ms`);
// covens: ~45% of players team up in 2-4s
const pool = first.filter(b => b.profile !== "idle").sort(() => Math.random() - .5);
const teamers = pool.slice(0, Math.floor(pool.length * .45));
for (let i = 0; i < teamers.length;) {
  const size = Math.min(teamers.length - i, Math.floor(rnd(2, 5))); const founder = teamers[i];
  const code = await founder.foundCoven();
  if (code) await Promise.all(teamers.slice(i + 1, i + size).map(b => b.joinCoven(code)));
  i += size;
}
console.log(`covens formed: ${M.covens} with ${teamers.length} members`);
console.log("\nSecurity probes from a random player:"); await attack(pick(first), false);
const timer = setInterval(() => report("status"), 30000);
const plays = first.map(b => b.play().catch(e => err("play", e)));
// late-join spike at sim minute 20: a whole second room arrives at once
setTimeout(async () => { console.log("\n>> late-join spike: " + N_LATE + " players in ~10s"); const late = await spawn(N_LATE, 10000); late.forEach(b => plays.push(b.play().catch(e => err("play", e)))); console.log(`>> late joiners signed in ${late.length}/${N_LATE}`); }, Math.max(0, 20 * 60000 / SCALE - (Date.now() - T0)));
await sleep(END - Date.now() + 2000);
await Promise.all(plays); clearInterval(timer);
await sleep(6000);
report("final");

// ---- consistency audit: database vs what bots wrote vs what live viewers saw ----
const { data: rows, error } = await mon.from("players").select("id,doc").limit(1000);
if (error) console.log("final read failed", error.message);
const db = new Map(rows.map(r => [r.id, r.doc]));
let lost = 0, stale = 0, bad = 0, viewerLag = 0;
for (const b of BOTS) {
  if (!b.uid) continue; const d = db.get(b.uid);
  if (!d) { lost++; continue; }
  if (canon(d.solved) !== canon(b.S.solved)) stale++;
  if (d.score !== scoreOf(b.S) || d.rank !== rankOf(b.S)) bad++;
}
const sampleViewers = BOTS.filter(b => b.uid).slice(0, 15);
for (const v of sampleViewers) for (const b of BOTS) if (b.uid && db.get(b.uid) && v.view.get(b.uid) && canon(v.view.get(b.uid).solved) !== canon(db.get(b.uid).solved)) viewerLag++;
const att = M.attacks.length, blocked = M.attacks.filter(a => a[1]).length;
const summary = {
  simulated: `${EVENT_MIN} min event at ${SCALE}x`, bots: BOTS.filter(b => b.uid).length, profiles: Object.fromEntries(Object.keys(PROFILES).map(k => [k, BOTS.filter(b => b.profile === k).length])),
  signin_ms: { p50: pct(M.signin, 50), p95: pct(M.signin, 95), max: pct(M.signin, 100) },
  writes: M.writes, write_errors: M.writeErr, write_ms: { p50: pct(M.write, 50), p95: pct(M.write, 95), p99: pct(M.write, 99), max: pct(M.write, 100) },
  realtime_delivered_pct: +(100 * M.seen / M.writes).toFixed(1),
  visible_on_board_pct: +(100 * M.visible.length / M.writes).toFixed(1), visible_ms: { p50: pct(M.visible, 50), p95: pct(M.visible, 95), p99: pct(M.visible, 99), max: pct(M.visible, 100) },
  within_1s_pct: +(100 * M.visible.filter(x => x <= 1000).length / M.writes).toFixed(1), within_7s_pct: +(100 * M.visible.filter(x => x <= 7000).length / M.writes).toFixed(1), polls: M.polls, realtime_ms: { p50: pct(M.rt, 50), p95: pct(M.rt, 95), p99: pct(M.rt, 99) }, monitor_events: monEvents,
  solves: M.solves, hints: M.hints, covens: M.covens, drafts: M.drafts, presence_joins: M.presence, reconnects: M.reconnects,
  final_rows_missing: lost, final_rows_stale: stale, score_or_rank_mismatch: bad, live_viewer_mismatches: viewerLag,
  attacks: `${blocked}/${att} blocked`, errors: M.errors,
  ranks: [0, 1, 2, 3, 4, 5].map(r => BOTS.filter(b => b.uid && rankOf(b.union()) === r).length),
  top10: boardTop(db.size ? db : monView, 10),
};
console.log("\n===== SUMMARY =====\n" + JSON.stringify(summary, null, 2));
fs.writeFileSync(new globalThis.URL("./summary.json", import.meta.url), JSON.stringify({ ...summary, t0: new Date(T0).toISOString() }, null, 2));
BOTS.forEach(b => clearInterval(b.poll));
await Promise.all(BOTS.map(b => b.sb.removeAllChannels().catch(() => {})));
await mon.removeAllChannels();
process.exit(0);
