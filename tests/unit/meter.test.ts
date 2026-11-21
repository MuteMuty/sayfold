// The live-dictation counter (src/server/meter.ts), on a real SQLite database as the Durable Object has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MeterCore, nextUtcMidnight, sweepAndSchedule, utcDay } from "../../src/server/meter.ts";
import {
  DAILY_NEURON_CAP, NEURONS_PER_AUDIO_SECOND, SESSION_MAX_SECONDS, STALE_SESSION_MS, VISITOR_SECONDS_PER_DAY,
} from "../../src/server/config.ts";
import { dump, memorySql } from "./server-fakes.ts";

const NOON = Date.UTC(2026, 10, 21, 12, 0, 0);
const IP = "203.0.113.7";

function meter(start = NOON) {
  const sql = memorySql();
  const clock = { now: start };
  return { core: new MeterCore(sql, () => clock.now), db: sql.db, clock };
}
async function openOk(core: MeterCore, ip = IP) {
  const r = await core.open(ip);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
}
/** Streams `seconds` of audio into a session, a second at a time as the Worker reports it. */
function stream(core: MeterCore, session: string, seconds: number) {
  let last = core.add(session, 0);
  for (let s = 0; s < seconds; s++) last = core.add(session, 1);
  return last;
}

test("the config: Flux at $0.0077 a minute is about 11.7 neurons a second, so the 9,000 cap is about 12.9 minutes", () => {
  assert.ok(Math.abs(NEURONS_PER_AUDIO_SECOND - 11.6667) < 0.001);
  assert.equal(DAILY_NEURON_CAP, 9000);
  assert.equal(VISITOR_SECONDS_PER_DAY, 180);
  assert.equal(SESSION_MAX_SECONDS, 120);
  assert.equal(utcDay(Date.UTC(2026, 10, 21, 23, 59, 59)), "2026-11-21");
  assert.equal(utcDay(Date.UTC(2026, 10, 22, 0, 0, 0)), "2026-11-22");
});

test("open: a new visitor gets a session of up to 2 minutes, and the day starts available", async () => {
  const { core } = meter();
  assert.deepEqual(await core.status(IP), { available: true });
  const r = await openOk(core);
  assert.match(r.session, /^[0-9a-f-]{36}$/);
  assert.equal(r.seconds, SESSION_MAX_SECONDS);
});

test("open: one open session per visitor; another visitor isn't affected; closing frees it", async () => {
  const { core } = meter();
  const first = await openOk(core);
  assert.deepEqual(await core.open(IP), { ok: false, reason: "busy" });
  await openOk(core, "198.51.100.4");
  core.close(first.session);
  await openOk(core);
});

test("open: a session that stopped reporting (its Worker went away) stops counting as open", async () => {
  const { core, clock } = meter();
  const first = await openOk(core);
  clock.now += STALE_SESSION_MS - 1000;
  core.add(first.session, 1); // still alive
  clock.now += STALE_SESSION_MS - 1000;
  assert.deepEqual(await core.open(IP), { ok: false, reason: "busy" });
  clock.now += 2000;
  await openOk(core);
});

test("visitor limit: 3 minutes of audio a day, then visitor-limit for that visitor only", async () => {
  const { core } = meter();
  const a = await openOk(core);
  assert.deepEqual(stream(core, a.session, 120), { ok: true });
  core.close(a.session);
  const b = await openOk(core);
  assert.equal(b.seconds, 60, "only what's left of the day's 3 minutes");
  assert.deepEqual(stream(core, b.session, 59), { ok: true });
  assert.deepEqual(core.add(b.session, 1), { ok: false, reason: "visitor-limit" });
  core.close(b.session);
  assert.deepEqual(await core.open(IP), { ok: false, reason: "visitor-limit" });
  assert.deepEqual(await core.status(IP), { available: false });
  assert.deepEqual(await core.status("198.51.100.4"), { available: true });
  await openOk(core, "198.51.100.4");
});

test("an unknown session (closed, or from before a restart) is told to stop", async () => {
  const { core } = meter();
  assert.deepEqual(core.add("00000000-0000-4000-8000-000000000000", 1), { ok: false, reason: "error" });
});

test("the daily cap: each second adds its estimate; at 9,000 everyone is told, nothing new opens, status is unavailable", async () => {
  const { core, db } = meter();
  // Enough visitors to reach the cap within their own limits (9,000 neurons is about 771 seconds).
  const sessions: string[] = [];
  for (let v = 0; v < 7; v++) sessions.push((await openOk(core, `192.0.2.${v}`)).session);
  for (let v = 0; v < 7; v++) {
    for (let s = 0; s < 120; s++) {
      const r = core.add(sessions[v], 1);
      const total = (v * 120 + s + 1) * NEURONS_PER_AUDIO_SECOND;
      if (total < DAILY_NEURON_CAP) assert.deepEqual(r, { ok: true }, `at ${total} neurons`);
      else assert.deepEqual(r, { ok: false, reason: "cap" }, `at ${total} neurons`);
    }
  }
  const neurons = (db.prepare("SELECT neurons FROM days").get() as { neurons: number }).neurons;
  assert.ok(Math.abs(neurons - 840 * NEURONS_PER_AUDIO_SECOND) < 1e-6, "every second was counted");
  // Another open session hears about it at its next report, even with no new audio.
  assert.deepEqual(core.add(sessions[0], 0), { ok: false, reason: "cap" });
  assert.deepEqual(await core.status("192.0.2.99"), { available: false });
  assert.deepEqual(await core.open("192.0.2.99"), { ok: false, reason: "cap" });
});

test("midnight UTC: the cap and the visitor limits reset, and earlier days' salts and counts are deleted", async () => {
  const { core, db, clock } = meter(Date.UTC(2026, 10, 21, 23, 50, 0));
  const sessions: string[] = [];
  for (let v = 0; v < 5; v++) sessions.push((await openOk(core, `192.0.2.${v}`)).session);
  for (const s of sessions) stream(core, s, 180);
  for (const s of sessions) core.close(s);
  assert.deepEqual(await core.status("192.0.2.0"), { available: false });
  assert.deepEqual(await core.open("192.0.2.99"), { ok: false, reason: "cap" });
  const before = dump(db);
  assert.equal(before.salts.length, 1);
  assert.equal(before.visitors.length, 5);

  clock.now = Date.UTC(2026, 10, 21, 23, 59, 59, 999);
  assert.deepEqual(await core.status("192.0.2.99"), { available: false }, "not a moment early");
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  assert.deepEqual(await core.status("192.0.2.0"), { available: true });
  const r = await openOk(core, "192.0.2.0");
  assert.equal(r.seconds, SESSION_MAX_SECONDS, "the visitor's minutes are back");

  const after = dump(db);
  assert.deepEqual(after.salts.map((s) => s.day), ["2026-11-22"]);
  assert.notEqual(after.salts[0].salt, before.salts[0].salt, "a new random salt for the new day");
  assert.deepEqual(after.days, [], "yesterday's neuron count is gone (and no audio yet today)");
  assert.deepEqual(after.visitors, [], "yesterday's visitor counts are gone");
  assert.equal(after.sessions.length, 1);
  assert.notEqual(after.sessions[0].visitor, before.visitors[0].visitor, "the same IP hashes differently on a new day");
});

test("the visitor hash is HMAC-SHA-256 of the IP and the day under the day's random salt, and the IP is never kept", async () => {
  const { core, db } = meter();
  await openOk(core);
  const { salts, sessions } = dump(db);
  assert.equal(salts.length, 1);
  const salt = String(salts[0].salt);
  assert.match(salt, /^[0-9a-f]{64}$/, "32 random bytes");
  const expected = createHmac("sha256", Buffer.from(salt, "hex")).update(`${IP}|2026-11-21`).digest("hex");
  assert.equal(sessions[0].visitor, expected);
  assert.ok(!JSON.stringify(dump(db)).includes(IP));
  assert.ok(!JSON.stringify(dump(db)).includes("203.0.113"));
});

test("a second meter on the same storage (a restarted Durable Object) keeps the day's salt and counts", async () => {
  const sql = memorySql();
  const clock = { now: NOON };
  const first = new MeterCore(sql, () => clock.now);
  const a = await first.open(IP);
  assert.equal(a.ok, true);
  const again = new MeterCore(sql, () => clock.now);
  assert.deepEqual(await again.open(IP), { ok: false, reason: "busy" }, "same salt, so the same visitor");
});

test("Workers AI refusing for the day (the account's allowance, used up elsewhere) closes the rest of the UTC day", async () => {
  const { core, clock } = meter(Date.UTC(2026, 10, 21, 23, 0, 0));
  const open = await openOk(core, "198.51.100.1");
  assert.deepEqual(core.add(open.session, 1), { ok: true }, "far below Sayfold's own cap");
  core.exhausted();
  assert.deepEqual(await core.status(IP), { available: false });
  assert.deepEqual(await core.open(IP), { ok: false, reason: "cap" });
  assert.deepEqual(core.add(open.session, 0), { ok: false, reason: "cap" }, "an open recording hears at its next report");
  core.exhausted(); // twice is the same as once
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  assert.deepEqual(await core.status(IP), { available: true }, "back at midnight UTC");
  await openOk(core);
});

test("nextUtcMidnight: the start of the next UTC day, never the current moment", () => {
  assert.equal(nextUtcMidnight(Date.UTC(2026, 10, 21, 12, 0, 0)), Date.UTC(2026, 10, 22));
  assert.equal(nextUtcMidnight(Date.UTC(2026, 10, 21, 23, 59, 59, 999)), Date.UTC(2026, 10, 22));
  assert.equal(nextUtcMidnight(Date.UTC(2026, 10, 22)), Date.UTC(2026, 10, 23));
  assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 8)), Date.UTC(2027, 0, 1));
});

test("the midnight alarm: with no traffic at all, earlier days' salts and counts are deleted and the next alarm is set", async () => {
  const { core, db, clock } = meter(Date.UTC(2026, 10, 21, 23, 50, 0));
  const alarms: number[] = [];
  const storage = { setAlarm: async (ms: number) => void alarms.push(ms) };
  // The Durable Object starts: it sweeps and sets the alarm for the coming midnight.
  await sweepAndSchedule(core, storage);
  assert.deepEqual(alarms, [Date.UTC(2026, 10, 22)]);
  for (let v = 0; v < 3; v++) {
    const r = await openOk(core, `192.0.2.${v}`);
    stream(core, r.session, 30);
    core.close(r.session);
  }
  clock.now = Date.UTC(2026, 10, 21, 23, 59, 0);
  const stuck = await openOk(core, "192.0.2.9"); // a recording whose Worker went away without closing it
  core.add(stuck.session, 1);
  const before = dump(db);
  assert.equal(before.salts.length, 1);
  assert.equal(before.days.length, 1);
  assert.equal(before.visitors.length, 4);

  // Before midnight, the alarm (if it fired early) keeps today's rows.
  clock.now = Date.UTC(2026, 10, 21, 23, 59, 59, 999);
  await sweepAndSchedule(core, storage);
  assert.deepEqual(dump(db).salts, before.salts);

  // The alarm at midnight UTC: nobody has asked for anything since.
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  await sweepAndSchedule(core, storage);
  const after = dump(db);
  assert.deepEqual(after.salts, [], "yesterday's salt is gone, and none is made until someone comes");
  assert.deepEqual(after.days, []);
  assert.deepEqual(after.visitors, []);
  assert.equal(alarms.at(-1), Date.UTC(2026, 10, 23), "and the next midnight is set");
  assert.equal(after.sessions.length, 1, "a recording open across midnight isn't cut off");

  // A recording left open at midnight goes once it's stale, at the next alarm.
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 0) + STALE_SESSION_MS;
  await sweepAndSchedule(core, storage);
  assert.deepEqual(dump(db).sessions, []);
});

test("the midnight alarm: when the sweep fails, the next midnight is still set", async () => {
  const sql = memorySql();
  const clock = { now: Date.UTC(2026, 10, 21, 23, 50, 0) };
  const core = new MeterCore(sql, () => clock.now);
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 1);
  const broken = { exec: () => { throw new Error("SQLITE_BUSY"); } };
  (core as unknown as { sql: unknown }).sql = broken;
  const alarms: number[] = [];
  await sweepAndSchedule(core, { setAlarm: async (ms: number) => void alarms.push(ms) }, () => clock.now);
  assert.deepEqual(alarms, [Date.UTC(2026, 10, 23)]);
  // And once storage works again, the next alarm sweeps as usual.
  (core as unknown as { sql: unknown }).sql = sql;
  clock.now = Date.UTC(2026, 10, 23, 0, 0, 0);
  await sweepAndSchedule(core, { setAlarm: async (ms: number) => void alarms.push(ms) }, () => clock.now);
  assert.deepEqual(alarms.at(-1), Date.UTC(2026, 10, 24));
});

test("the midnight alarm: the in-memory key for yesterday's salt goes with it", async () => {
  const { core, db, clock } = meter(Date.UTC(2026, 10, 21, 23, 50, 0));
  await openOk(core);
  const yesterday = String(dump(db).sessions[0].visitor);
  clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  await sweepAndSchedule(core, { setAlarm: () => {} });
  // Today the same IP is someone new: a new salt, so a new hash (not yesterday's cached key).
  const r = await openOk(core);
  const row = dump(db).sessions.find((s) => s.id === r.session)!;
  assert.notEqual(row.visitor, yesterday);
  const salt = String(dump(db).salts[0].salt);
  assert.equal(row.visitor, createHmac("sha256", Buffer.from(salt, "hex")).update(`${IP}|2026-11-22`).digest("hex"));
});
