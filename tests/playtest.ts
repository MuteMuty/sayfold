// Sayfold playtest: records a spoken clip in a real browser, turns it into text on the device and
// reviews it, at desktop (1280x900, dark) and phone (390x844, light) sizes, with both colour schemes
// screenshotted at each size.
//
// The microphone is fake and plays tests/fixtures/idea.wav, an original clip made with macOS `say`:
//   say -v Samantha -r 170 -o idea.aiff "New idea. Water the tomatoes every morning, and call the plumber on Friday."
//   afconvert -f WAVE -d LEI16@48000 -c 1 idea.aiff tests/fixtures/idea.wav
// A long recording (lab#95) plays tests/fixtures/long-idea.wav: 48 s of fifteen different sentences with
// thinking pauses between some of them, also made with `say` (the [[slnc]] marks are silences, in ms):
//   say -v Karen -r 230 -o long-idea.aiff "$(cat <<'EOF'
//   Long idea for the garden project. [[slnc 1500]] First, order three bags of compost from the farm shop.
//   The blue wheelbarrow has a flat wheel again. [[slnc 2500]] Ask Martin whether he can lend us his ladder on
//   Saturday. We should paint the fence green instead of brown. [[slnc 1200]] Plant the carrots near the
//   kitchen window, where the soil is soft. [[slnc 2000]] Buy a watering can with a long spout. Check the price
//   of solar lights at the hardware store. [[slnc 2500]] The pond needs cleaning before the frogs come back.
//   Move the herb pots to the sunny corner by the steps. [[slnc 1800]] Fix the gate latch so the dog cannot
//   get out. [[slnc 1000]] Put a bench under the apple tree for reading in the evening. [[slnc 2000]] Collect
//   rainwater in the old barrel behind the shed. Remember to cover the strawberries with a net against the
//   birds. [[slnc 1500]] Finally, send the photos to grandmother on Sunday.
//   EOF
//   )"
//   afconvert -f WAVE -d LEI16@16000 -c 1 long-idea.aiff tests/fixtures/long-idea.wav
// It always plays through the in-page stand-in, with a room's steady noise mixed in (LONG_SNR), as a phone
// on a table hears it: the pauses then aren't digital silence, which is what made the speech model stop early.
// First choice is Chromium's own fake capture device (--use-fake-device-for-media-stream with
// --use-file-for-fake-audio-capture). On macOS, a browser started by an app without microphone
// permission never answers getUserMedia, even for the fake device; the playtest then says so and
// plays the same clip through an in-page stand-in for getUserMedia instead.
//
// Every request is watched (pages and the speech worker): nothing may go anywhere but Sayfold's own
// origin, the lab hub's like API and GitHub's API, both mocked here (never the live ones, and never a
// real token). The made-up token must only ever reach api.github.com. On localhost the shared analytics
// script is never fetched; a separate run under a made-up *.brightloopapps.com address checks the usage
// events with the hub's built script and a stand-in PostHog.
//
// Usage: node tests/playtest.ts <baseUrl>
// Env:   PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave)
//        PLAYTEST_OUT      screenshot folder (default: ./playtest-out)
//        LAB_ANALYTICS_JS  the hub's built shared analytics script (default: the lab checkout's
//                          hub/public/analytics/v1.js; build it there with `npm run bundle`)
//        PLAYTEST_ONLY     run only the checks whose names start with this (e.g. "phone", "analytics")
// Exit:  0 = pass, 1 = fail (reasons printed)
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

const base = process.argv[2];
if (!base) {
  console.error("usage: node tests/playtest.ts <baseUrl>");
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.PLAYTEST_OUT || join(repo, "playtest-out");
const browserPath = process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const WAV = join(repo, "tests/fixtures/idea.wav");
const WAV_B64 = readFileSync(WAV).toString("base64");
const EXPECTED_WORDS = ["tomatoes", "plumber", "friday"];
/** A spoken list, said as the speech model hears it at a normal pace: it writes "Groceries for the weekend, list, milk,
 *  bread, eggs, and list, then call the bank." (see tests/fixtures/list-transcripts.json for how it was made). */
const LIST_WAV = readFileSync(join(repo, "tests/fixtures/list-commas.wav"));
const LIST_B64 = LIST_WAV.toString("base64");
const LIST_SECONDS = LIST_WAV.readUInt32LE(LIST_WAV.indexOf("data") + 4) / 32000;
const LONG = readFileSync(join(repo, "tests/fixtures/long-idea.wav"));
const LONG_B64 = LONG.toString("base64");
/** Its length: the data chunk's bytes, at 16 kHz in 16 bits. */
const LONG_SECONDS = LONG.readUInt32LE(LONG.indexOf("data") + 4) / 32000;
/** Speech to room noise, in dB, for the long recording. */
const LONG_SNR = 10;
/** Each sentence of the long recording, by three of its words: it's there when at least two are, so a misheard
 *  word ("solar mites") passes and a dropped sentence doesn't. No word belongs to two sentences. */
const LONG_SENTENCES = [
  ["long idea", "garden", "project"], ["bags", "compost", "farm shop"], ["blue", "flat", "wheel"], ["martin", "lend us", "saturday"],
  ["fence", "green", "instead"], ["carrots", "kitchen", "soil"], ["buy a", "watering", "long s"], ["price", "solar", "hardware"],
  ["needs cleaning", "frogs", "come back"], ["pots", "sunny", "corner"], ["latch", "dog", "get out"], ["apple tree", "reading", "evening"],
  ["rainwater", "barrel", "behind"], ["strawberries", "cover", "against"], ["photos", "grandmother", "sunday"],
];
const MISSING_NOTE = "Part of the recording may be missing. Check the text before sending.";
const MAX_FILE = 25 * 1024 * 1024;
const LAB = "https://lab.brightloopapps.com";
const GITHUB = "https://api.github.com";
/** A made-up token in the fine-grained shape: never a real one. */
const TOKEN = "github_pat_11PLAYTEST0000000000_notarealtokenatallnotarealtokenatall0000000";
const REPO = "lab-test/ideas";
const own = new URL(base).origin;
mkdirSync(out, { recursive: true });

declare global { interface Window { __sayfold?: any; labAnalytics?: any } }

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);
/** Run one named check; a thrown assertion becomes a failure line instead of ending the run. */
const only = process.env.PLAYTEST_ONLY;
async function check(name: string, fn: () => Promise<void>) {
  if (only && !name.startsWith(only)) return;
  try {
    await fn();
  } catch (e) {
    fail(`${name}: ${String(e.message).split("\n")[0]}`);
  }
}

const FAKE_DEVICE = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}%noloop`];
/** The browser, with Chromium's fake capture device playing the clip, or without it. */
const launch = (fakeDevice: boolean, extra: string[] = []) => {
  const args = [...(fakeDevice ? FAKE_DEVICE : []), "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu", ...extra];
  return chromium.launch({ executablePath: browserPath, args }).catch(() => chromium.launch({ args }));
};
let browser = await launch(true);

// --- the microphone ------------------------------------------------------------------------
/** Plays a clip into a MediaStream, standing in for getUserMedia (used when the real fake device can't answer, and
 *  for the long recording). With `snr`, a room's steady noise (seeded, so every run hears the same) is mixed in. */
function inPageMic({ b64, snr }: { b64: string; snr?: number }) {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    if (snr !== undefined) {
      const x = buf.getChannelData(0);
      const noise = new Float32Array(x.length);
      let seed = 11, b0 = 0, b1 = 0, b2 = 0, speech = 0, room = 0;
      for (let i = 0; i < x.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const w = seed / 0x7fffffff - 0.5;
        // Roughly pink: more rumble than hiss, as rooms are.
        b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
        noise[i] = b0 + b1 + b2 + w * 0.1848;
        speech += x[i] * x[i];
        room += noise[i] * noise[i];
      }
      const k = Math.sqrt(speech / room / 10 ** (snr / 10));
      for (let i = 0; i < x.length; i++) x[i] += noise[i] * k;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    await ctx.resume();
    src.start();
    return dest.stream;
  };
}

const micMode = await (async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(`${LAB}/**`, (r) => r.fulfill({ status: 204, headers: { "access-control-allow-origin": own } }));
  await page.goto(base);
  const answer = await page.evaluate(() =>
    Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), "ok"), (e) => `refused (${e.name})`),
      new Promise<string>((r) => setTimeout(() => r("no answer in 4 s"), 4000)),
    ]),
  );
  await ctx.close();
  if (answer === "ok") return "chromium" as const;
  console.log(`note: the browser's fake capture device gave ${answer}; playing the clip through an in-page getUserMedia stand-in instead`);
  // A capture that never answered leaves the browser's audio service stuck, so start afresh.
  await browser.close();
  browser = await launch(false);
  return "in-page" as const;
})();

// --- pages ---------------------------------------------------------------------------------
type Seen = { url: string; method: string; size?: number; status?: number; headers?: Record<string, string>; body?: string };

/** What the stand-in GitHub answers for each step: "ok", an HTTP status, "rate" (403, none left) or "down" (no answer). */
type GhAnswer = "ok" | number | "rate" | "down";
/** A stateful stand-in for api.github.com: the repo, its labels, and creating issues. */
async function mockGitHub(ctx, origin: string) {
  const gh = { repo: "ok" as GhAnswer, labels: "ok" as GhAnswer, issue: "ok" as GhAnswer, delay: 0, calls: [] as string[], auth: new Set<string>(), issues: [] as any[] };
  await ctx.route(`${GITHUB}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "retry-after, x-ratelimit-remaining, x-ratelimit-reset" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, accept" } });
    gh.calls.push(`${req.method()} ${url.pathname}${url.search}`);
    gh.auth.add(req.headers()["authorization"]);
    const json = (status: number, body: unknown, headers = {}) => route.fulfill({ status, headers: { ...cors, ...headers }, contentType: "application/json", body: JSON.stringify(body) });
    const answer = (mode: GhAnswer, ok: () => Promise<void>) => {
      if (mode === "down") return route.abort("failed");
      if (mode === "rate") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300) });
      if (typeof mode === "number") return json(mode, { message: "Stand-in error" });
      return ok();
    };
    if (req.headers()["authorization"] !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });
    if (req.method() === "GET" && url.pathname === `/repos/${REPO}`) return answer(gh.repo, () => json(200, { full_name: REPO, has_issues: true, private: true }));
    if (req.method() === "GET" && url.pathname === `/repos/${REPO}/labels`) {
      return answer(gh.labels, () => json(200, [{ name: "bug", color: "d73a4a" }, { name: "idea", color: "a2eeef" }, { name: "later", color: "fbca04" }]));
    }
    if (req.method() === "POST" && url.pathname === `/repos/${REPO}/issues`) {
      // A slow answer, for what the page does while an idea is on its way.
      if (gh.delay) await new Promise((r) => setTimeout(r, gh.delay));
      return answer(gh.issue, () => {
        gh.issues.push(JSON.parse(req.postData() || "{}"));
        const number = 41 + gh.issues.length;
        return json(201, { number, html_url: `https://github.com/${REPO}/issues/${number}` });
      });
    }
    fail(`GitHub stand-in: unexpected ${req.method()} ${url.pathname}`);
    return json(404, { message: "Not Found" });
  });
  return gh;
}

/** The made-up token went only to api.github.com, in the Authorization header. */
function tokenOnlyToGitHub(label: string, seen: Seen[]) {
  for (const r of seen) {
    const where = `${r.url} ${JSON.stringify(r.headers ?? {})} ${r.body ?? ""}`;
    if (!where.includes(TOKEN)) continue;
    if (new URL(r.url).origin !== GITHUB) fail(`${label}: the token went to ${r.url}`);
    else if (r.url.includes(TOKEN) || (r.body ?? "").includes(TOKEN)) fail(`${label}: the token was in a GitHub address or body`);
  }
}

/** A stateful stand-in for the hub's /api/likes: "ok" (12 likes) or "down". */
async function mockLikes(ctx, mode: "ok" | "down" = "ok") {
  const api = { total: 12, calls: 0 };
  await ctx.route(`${LAB}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    api.calls++;
    const cors = { "access-control-allow-origin": own, vary: "Origin", "cache-control": "no-store" };
    if (url.pathname.startsWith("/analytics/")) {
      fail(`the analytics script was fetched on ${own}`);
      return route.abort();
    }
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "POST, DELETE", "access-control-allow-headers": "content-type" } });
    if (mode === "down") return route.abort("failed");
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "GET" && url.pathname === "/api/likes") return json(200, { sayfold: { total: api.total, week: 2 }, inkchime: { total: 40, week: 9 } });
    if (url.pathname === "/api/likes/sayfold" && req.method() === "POST") {
      api.total++;
      return json(200, { receipt: "0123456789abcdef0123456789abcdef", total: api.total, week: 3 });
    }
    return json(404, { error: "Unknown." });
  });
  return api;
}

async function openPage(name: string, opts, { likes = "ok" as "ok" | "down", init = null as null | (() => void), quiet = null as null | RegExp, refused = [] as string[], mic = null as null | { b64: string; snr?: number } } = {}) {
  const ctx = await browser.newContext({ ...opts, permissions: ["clipboard-read", "clipboard-write", "microphone"] });
  await mockLikes(ctx, likes);
  const gh = await mockGitHub(ctx, own);
  ctx.on("requestfailed", (r) => {
    if (refused.includes(r.url()) && !/BLOCKED_BY_CSP|csp/i.test(r.failure()?.errorText ?? "")) fail(`${name}: ${r.url()} failed, but not by the policy: ${r.failure()?.errorText}`);
  });
  if (mic || micMode === "in-page") await ctx.addInitScript(inPageMic, mic ?? { b64: WAV_B64 });
  if (init) await ctx.addInitScript(init);
  const seen: Seen[] = [];
  // Context-wide, so the speech worker's requests are watched too.
  ctx.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:")) return;
    seen.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() ?? undefined });
    // A request the page's policy must refuse: it may only fail, blocked by the policy.
    if (refused.includes(u)) return void r.response().then((res) => res && fail(`${name}: ${u} wasn't refused`));
    if (new URL(u).origin === own || u.startsWith(`${LAB}/api/likes`) || new URL(u).origin === GITHUB) return;
    fail(`${name}: request to somewhere other than Sayfold, the like API and GitHub's API: ${u}`);
  });
  ctx.on("response", async (r) => {
    const entry = seen.findLast((s) => s.url === r.url() && s.status === undefined);
    if (!entry) return;
    entry.status = r.status();
    const len = Number(r.headers()["content-length"]);
    entry.size = Number.isFinite(len) && len > 0 ? len : undefined;
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (likes === "down" && /Failed to load resource/.test(m.text())) return;
    // GitHub's stand-in answers errors on purpose, and Chromium logs each one.
    if (/Failed to load resource: the server responded with a status of (4\d\d|5\d\d)/.test(m.text()) && gh.calls.length) return;
    if (/net::ERR_FAILED|net::ERR_INTERNET_DISCONNECTED/.test(m.text()) && gh.calls.length) return;
    if (quiet?.test(m.text())) return;
    fail(`${name}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
  await page.goto(base, { waitUntil: "load" });
  return { ctx, page, seen, gh };
}

const state = (page) => page.evaluate(() => window.__sayfold.state());
const waitState = (page, wanted: string[], timeout = 15000) =>
  page.waitForFunction((w) => w.includes(window.__sayfold.state()), wanted, { timeout });
const shot = async (page, name: string) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
/** Both colour schemes of what's on screen now. */
async function shots(page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(120);
    await shot(page, `${name}-${scheme}`);
  }
}
async function noSideScroll(page, label: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  if (sw > iw) fail(`${label}: the page scrolls sideways (${sw} > ${iw})`);
}
/** Pixels of the waveform canvas painted in the accent colour: the live trace. */
const waveInk = (page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#wave");
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = accent;
    probe.fillRect(0, 0, 1, 1);
    const [r, gr, b] = probe.getImageData(0, 0, 1, 1).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - r) < 24 && Math.abs(d[i + 1] - gr) < 24 && Math.abs(d[i + 2] - b) < 24) n++;
    return n;
  });

/** Record for `seconds` with `startStop` (Space or a click), then wait for the transcript or a problem. Returns the time Stop to result. */
async function record(page, label: string, seconds: number, startStop: () => Promise<void>) {
  await startStop();
  await waitState(page, ["recording"], 10000).catch(async () => {
    throw new Error(`recording never started (${await state(page)}: ${await page.textContent("#problem-title")})`);
  });
  await page.waitForTimeout(seconds * 1000);
  await startStop();
  const t0 = Date.now();
  await waitState(page, ["review", "problem"], 180000);
  return Date.now() - t0;
}

/** In the page: every microphone stream it gets, the most tracks live at once, and each state it shows, in order. */
function watchMic() {
  const w = window as any;
  w.__watch = { streams: [] as MediaStream[], maxLive: 0, states: [] as string[] };
  const md = navigator.mediaDevices;
  const ask = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await ask(c);
    w.__watch.streams.push(s);
    const live = w.__watch.streams.flatMap((x: MediaStream) => x.getTracks()).filter((t: MediaStreamTrack) => t.readyState === "live").length;
    w.__watch.maxLive = Math.max(w.__watch.maxLive, live);
    return s;
  };
  new MutationObserver(() => {
    const now = document.body?.dataset.state;
    if (now && w.__watch.states.at(-1) !== now) w.__watch.states.push(now);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
}
const liveTracks = (page) => page.evaluate(() => (window as any).__watch.streams.flatMap((s: MediaStream) => s.getTracks()).filter((t: MediaStreamTrack) => t.readyState === "live").length);

const modelRequests = (seen: Seen[]) => seen.filter((s) => new URL(s.url).origin === own && /\/models\/|\.wasm$/.test(new URL(s.url).pathname));

// --- desktop, dark: the whole flow by keyboard -------------------------------------------------
let coldMs = 0;
let desktopCtx;
await check("desktop", async () => {
  const { ctx, page, seen } = await openPage("desktop", { viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  desktopCtx = ctx;
  assert.equal(await page.title(), "Sayfold: say an idea, get it as text");
  assert.equal(await state(page), "idle");
  // Nothing of the model before the first recording.
  await page.waitForTimeout(800);
  assert.equal(modelRequests(seen).length, 0, `fetched on page load: ${modelRequests(seen).map((s) => s.url).join(", ")}`);
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("worker"))), false, "the speech worker started on page load");

  // The like heart, from the mocked API.
  await page.waitForSelector("#like:not([hidden])", { timeout: 5000 });
  assert.equal(await page.textContent("#like-n"), "12");
  assert.equal(await page.getAttribute("#like", "aria-label"), "Like Sayfold, 12 likes");

  // The footer, exactly.
  const foot = await page.evaluate(() => ({
    text: document.querySelector(".foot p").textContent.replace(/\s+/g, " ").trim(),
    links: [...document.querySelectorAll(".foot a")].map((a) => [a.textContent, a.getAttribute("href")]),
  }));
  assert.ok(foot.text.endsWith("Made by Erik Pahor at BrightLoop Lab. Source Privacy"), foot.text);
  assert.deepEqual(foot.links, [
    ["Erik Pahor", "https://github.com/MuteMuty"],
    ["BrightLoop Lab", "https://lab.brightloopapps.com"],
    ["Source", "https://github.com/MuteMuty/sayfold"],
    ["Privacy", "https://lab.brightloopapps.com/privacy"],
  ]);
  // The shortcut is offered on a desktop.
  assert.equal(await page.isVisible(".keys"), true, "the Space hint isn't shown on desktop");
  assert.match(await page.textContent("#rec-help"), /Up to 2 minutes/);
  assert.equal(await page.isVisible("text=Sayfold understands English."), true, "the English-only line isn't shown");
  await shots(page, "desktop-idle");
  await page.emulateMedia({ colorScheme: "dark" });

  // Space starts recording: a live waveform and a running clock.
  await page.keyboard.press("Space");
  await waitState(page, ["recording"], 10000);
  assert.equal(await page.textContent("#rec-label"), "Stop");
  assert.equal(await page.getAttribute("#rec", "aria-pressed"), "true");
  await page.waitForTimeout(1600);
  assert.ok((await page.textContent("#clock-now")) >= "0:01", `clock ${await page.textContent("#clock-now")}`);
  assert.ok((await waveInk(page)) > 50, "no live waveform drawn");
  assert.match(await page.textContent("#rec-help"), /Stops on its own at 2:00/);
  await shot(page, "desktop-recording-dark");
  await page.waitForTimeout(3900);
  await page.keyboard.press("Space");
  const t0 = Date.now();
  await waitState(page, ["working", "review", "problem"], 5000);
  if ((await state(page)) === "working") {
    await page.waitForTimeout(150);
    await shot(page, "desktop-working-dark");
    assert.match(await page.textContent("#work-label"), /Getting the speech model ready|Turning speech into text/);
  }
  await waitState(page, ["review", "problem"], 180000);
  coldMs = Date.now() - t0;
  if ((await state(page)) === "problem") throw new Error(`no transcript: ${await page.textContent("#problem-title")}`);

  // The review: the words that were said, a title from the first line, the cursor in the text.
  const text = await page.inputValue("#text");
  for (const w of EXPECTED_WORDS) assert.ok(text.toLowerCase().includes(w), `"${w}" missing from "${text}"`);
  assert.equal(await page.inputValue("#title"), "New idea");
  assert.equal(await page.isVisible("#missing"), false, "says part may be missing from a short clip that came through");
  assert.equal(await page.getAttribute("#text", "aria-describedby"), "text-hint");
  assert.match(await page.textContent("#text-hint"), /Say “list” to start a task list/);
  assert.equal(await page.isVisible("#preview"), false, "a list preview shows for text without a list");
  assert.equal(await page.evaluate(() => document.activeElement.id), "text");
  const backend = await page.evaluate(() => window.__sayfold.backend());
  assert.ok(backend === "webgpu" || backend === "wasm", backend);
  console.log(`desktop: "${text}" (${backend}, ${coldMs} ms from Stop on a cold load)`);
  await shots(page, "desktop-review");
  await page.emulateMedia({ colorScheme: "dark" });

  // Every model and runtime file came from here, once each, and fits the static-file limit.
  const files = modelRequests(seen);
  const onnx = files.filter((s) => s.url.endsWith(".onnx"));
  assert.equal(onnx.length, 2, `onnx requests: ${onnx.map((s) => s.url).join(", ")}`);
  assert.equal(new Set(files.map((s) => s.url)).size, files.length, "a model file was fetched twice");
  assert.equal(files.filter((s) => s.url.endsWith(".wasm")).length, 1, "one runtime .wasm");
  for (const f of files) {
    assert.equal(f.status, 200, `${f.url}: ${f.status}`);
    if (f.size !== undefined) assert.ok(f.size <= MAX_FILE, `${f.url} is ${f.size} bytes`);
  }

  // The title follows the text until you write your own.
  await page.fill("#text", "");
  await page.locator("#text").pressSequentially("buy stamps. Then post the letter.");
  assert.equal(await page.inputValue("#title"), "Buy stamps");
  await page.fill("#title", "Post office");
  await page.locator("#text").press("End");
  await page.locator("#text").pressSequentially(" Tomorrow.");
  assert.equal(await page.inputValue("#title"), "Post office");

  // Keyboard: Tab from the text reaches Send, then Copy, then Record again. Enter on Copy copies title and text.
  await page.locator("#text").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "send");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
  assert.equal(await page.textContent("#toast"), "Copied the title and text");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Post office\n\nbuy stamps. Then post the letter. Tomorrow.");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "again");

  // A title that is the whole text is copied once; with nothing to copy, Copy says so and copies nothing.
  const copied = async () => {
    await page.evaluate(() => document.querySelector("#toast").classList.remove("show"));
    await page.locator("#copy").click();
    await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
    return [await page.textContent("#toast"), await page.evaluate(() => navigator.clipboard.readText())];
  };
  await page.fill("#text", "Buy oat milk.");
  await page.fill("#title", "Buy oat milk");
  assert.deepEqual(await copied(), ["Copied the text", "Buy oat milk."]);
  await page.fill("#text", "");
  await page.fill("#title", "");
  assert.deepEqual(await copied(), ["There's nothing to copy yet", "Buy oat milk."]);
  await page.locator("#again").focus();

  // Record again (with the keyboard): the model is ready, so nothing more is fetched.
  const before = modelRequests(seen).length;
  await page.keyboard.press("Enter");
  await waitState(page, ["recording"], 10000);
  await page.waitForTimeout(5200);
  await page.keyboard.press("Space"); // the Stop button has focus: Space presses it, once
  await waitState(page, ["review", "problem"], 60000);
  if (micMode === "in-page" || (await state(page)) === "review") {
    assert.equal(await state(page), "review", `second recording: ${await page.textContent("#problem-title")}`);
    assert.match((await page.inputValue("#text")).toLowerCase(), /tomatoes/);
  }
  assert.equal(modelRequests(seen).length, before, "the second recording fetched model files again");
  await noSideScroll(page, "desktop");
});

// --- a later visit: the model comes from the browser's cache ---------------------------------------
await check("desktop, later visit", async () => {
  if (!desktopCtx) throw new Error("no desktop page to revisit");
  const page = await desktopCtx.newPage();
  const seen: string[] = [];
  desktopCtx.on("request", (r) => seen.push(r.url()));
  page.on("pageerror", (e) => fail(`later visit: page error: ${e.message}`));
  await page.goto(base, { waitUntil: "load" });
  const ms = await record(page, "later visit", 5.5, () => page.locator("#rec").click());
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  const model = seen.filter((u) => u.includes("/models/"));
  assert.equal(model.length, 0, `fetched again: ${model.join(", ")}`);
  console.log(`later visit: model files from the browser's cache, ${ms} ms from Stop (cold load: ${coldMs} ms)`);
  await desktopCtx.close();
});

// --- a browser without WebAssembly JSPI (Safari, Firefox): the plain runtime, on the CPU -------------------
// The speech worker is served with WebAssembly.Suspending removed, so Sayfold picks onnxruntime's plain
// WebAssembly build, as it does where JSPI doesn't exist.
await check("desktop, CPU", async () => {
  const { ctx, page, seen } = await openPage("desktop, CPU", { viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  let patched = 0;
  await ctx.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
    const res = await route.fetch();
    patched++;
    await route.fulfill({ response: res, body: `delete WebAssembly.Suspending;\n${await res.text()}` });
  });
  await record(page, "desktop, CPU", 5.5, () => page.locator("#rec").click());
  assert.equal(patched, 1, "the speech worker wasn't served without JSPI");
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  assert.equal(await page.evaluate(() => window.__sayfold.backend()), "wasm");
  const text = (await page.inputValue("#text")).toLowerCase();
  for (const w of EXPECTED_WORDS) assert.ok(text.includes(w), `"${w}" missing from "${text}"`);
  const wasm = modelRequests(seen).filter((s) => s.url.endsWith(".wasm")).map((s) => new URL(s.url).pathname);
  assert.equal(wasm.length, 1, wasm.join(", "));
  assert.match(wasm[0], /\/ort-wasm-simd-threaded-[\w-]+\.wasm$/, "not the plain WebAssembly runtime");
  console.log(`desktop, CPU: "${await page.inputValue("#text")}" (wasm, ${wasm[0]})`);
  await ctx.close();
});

// --- a long recording: every sentence, on WebGPU and on the CPU (lab#95) ---------------------------------
// 48 s of different sentences with thinking pauses, in a room's noise. Before lab#95, parts of up to 20 s
// lost their last sentences without a word on screen.
for (const cpu of [false, true]) {
  const label = `long recording${cpu ? ", CPU" : ""}`;
  await check(label, async () => {
    const { ctx, page } = await openPage(label, { viewport: { width: 1280, height: 900 }, colorScheme: "dark" }, { mic: { b64: LONG_B64, snr: LONG_SNR } });
    if (cpu) {
      await ctx.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: `delete WebAssembly.Suspending;\n${await res.text()}` });
      });
    }
    const ms = await record(page, label, LONG_SECONDS + 1, () => page.locator("#rec").click());
    assert.equal(await state(page), "review", await page.textContent("#problem-title"));
    const backend = await page.evaluate(() => window.__sayfold.backend());
    if (cpu) assert.equal(backend, "wasm");
    const said = await page.inputValue("#text");
    const text = said.toLowerCase();
    const lost = LONG_SENTENCES.map((ws, i) => [i + 1, ws.filter((w) => new RegExp(`\\b${w}`).test(text)).length] as const).filter(([, n]) => n < 2).map(([i]) => i);
    assert.deepEqual(lost, [], `sentence ${lost.join(", ")} of ${LONG_SENTENCES.length} missing from "${said}"`);
    assert.equal(await page.isVisible("#missing"), false, "says part may be missing, though every sentence is there");
    console.log(`${label}: all ${LONG_SENTENCES.length} sentences (${backend}, ${ms} ms from Stop for ${LONG_SECONDS.toFixed(1)} s)`);
    await ctx.close();
  });
}

// --- part of a recording came back short: the review says so, and keeps the text -------------------------
// The worker is served so that it reports a gap with its result, as it does when a part with speech in it
// came back empty or far too short (which the unit tests cover).
await check("gap note", async () => {
  for (const [size, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const { ctx, page } = await openPage(`gap note, ${size}`, { viewport, isMobile: mobile, hasTouch: mobile, colorScheme: "light" });
    await ctx.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
      const res = await route.fetch();
      const patch = "const __post = self.postMessage.bind(self); self.postMessage = (m, t) => __post(m && m.type === 'result' ? { ...m, gaps: true } : m, t);";
      await route.fulfill({ response: res, body: `${patch}\n${await res.text()}` });
    });
    await record(page, `gap note, ${size}`, 5.5, () => page.locator("#rec").click());
    assert.equal(await state(page), "review", await page.textContent("#problem-title"));
    assert.equal(await page.isVisible("#missing"), true, "no note that part may be missing");
    assert.equal((await page.textContent("#missing")).trim(), MISSING_NOTE);
    assert.equal(await page.getAttribute("#text", "aria-describedby"), "missing text-hint");
    assert.match((await page.inputValue("#text")).toLowerCase(), /tomatoes/, "the text wasn't kept");
    await noSideScroll(page, `gap note, ${size}`);
    await shots(page, `${size}-review-gap`);
    await ctx.close();
  }
});

// --- phone, light: the whole flow by touch -------------------------------------------------------
await check("phone", async () => {
  const { ctx, page } = await openPage("phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  assert.equal(await page.isVisible(".keys"), false, "the Space hint shows on a phone");
  assert.equal(await page.isVisible("text=Sayfold understands English."), true, "the English-only line isn't shown on a phone");
  const box = await page.locator("#rec").boundingBox();
  assert.ok(box.width >= 120 && box.height >= 120, `record button ${box.width}x${box.height}`);
  await noSideScroll(page, "phone idle");
  await shots(page, "phone-idle");
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("#rec").tap();
  await waitState(page, ["recording"], 10000);
  await page.waitForTimeout(1500);
  await shot(page, "phone-recording-light");
  await noSideScroll(page, "phone recording");
  await page.waitForTimeout(4000);
  await page.locator("#rec").tap();
  await waitState(page, ["review", "problem"], 180000);
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  const text = (await page.inputValue("#text")).toLowerCase();
  for (const w of EXPECTED_WORDS) assert.ok(text.includes(w), `"${w}" missing from "${text}"`);
  for (const id of ["#send", "#copy", "#again"]) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${id} is ${b.width}x${b.height}`);
  }
  await noSideScroll(page, "phone review");
  await shots(page, "phone-review");
  await ctx.close();
});

// --- the page's Content-Security-Policy -------------------------------------------------------------
await check("content security policy", async () => {
  const { ctx, page } = await openPage("content security policy", { viewport: { width: 1280, height: 900 } }, {
    quiet: /Content Security Policy|example\.invalid/,
    refused: ["https://example.invalid/x", "https://example.invalid/pixel.gif"],
  });
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', "content");
  assert.ok(csp, "no Content-Security-Policy in the built page");
  assert.match(csp, /(^|; )connect-src 'self' https:\/\/api\.github\.com https:\/\/lab\.brightloopapps\.com https:\/\/eu\.i\.posthog\.com(;|$)/, csp);
  // A request anywhere else is refused by the browser itself.
  const refused = await page.evaluate(() => new Promise<string>((done) => {
    addEventListener("securitypolicyviolation", (e) => done(`${e.violatedDirective} ${e.blockedURI}`), { once: true });
    fetch("https://example.invalid/x", { method: "POST", body: "secret" }).catch(() => {});
    setTimeout(() => done("not refused"), 3000);
  }));
  assert.match(refused, /^connect-src https:\/\/example\.invalid/);
  const img = await page.evaluate(() => new Promise<string>((done) => {
    addEventListener("securitypolicyviolation", (e) => done(e.violatedDirective), { once: true });
    new Image().src = "https://example.invalid/pixel.gif";
    setTimeout(() => done("not refused"), 3000);
  }));
  assert.equal(img, "img-src");
  await ctx.close();
});

// --- send to GitHub, by keyboard (desktop, dark) -------------------------------------------------------
// Connect with a github.com link and a made-up token, check the labels (`idea` chosen at first), send,
// and land on a link to the new issue. The token stays in memory only, and Forget token clears it.
const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.closest("label")?.textContent?.trim());
const dialogOpen = (page) => page.evaluate(() => document.querySelector<HTMLDialogElement>("#gh").open);
const chipState = (page) => page.$$eval("#chips input", (els: HTMLInputElement[]) => els.map((e) => `${e.value}${e.checked ? "*" : ""}`));

await check("send", async () => {
  const { ctx, page, seen, gh } = await openPage("send", { viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  assert.equal(await page.textContent("#gh-open-label"), "Connect GitHub");
  await record(page, "send", 5.5, () => page.keyboard.press("Space"));
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  const said = await page.inputValue("#text");
  assert.equal(await page.isVisible("#labels"), false, "labels show before connecting");
  assert.match(await page.textContent("#send-to"), /Connect a repo of yours first/);

  // Send, by keyboard, opens the setup.
  await page.locator("#text").focus();
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "send");
  await page.keyboard.press("Enter");
  assert.equal(await dialogOpen(page), true, "Send didn't open the GitHub setup");
  assert.equal(await focused(page), "gh-repo");
  assert.equal(await page.getAttribute("#gh-howto a", "href"), "https://github.com/settings/personal-access-tokens/new");
  assert.match(await page.textContent("#gh-howto"), /Issues.*Read and write/);
  assert.match(await page.textContent("#gh-keep"), /memory only/);
  assert.equal(await page.isChecked("#gh-remember"), false);

  // Not a repo: said beside the field, and nothing is asked of GitHub.
  await page.keyboard.type("just a name");
  await page.keyboard.press("Enter");
  assert.match(await page.textContent("#gh-repo-err"), /owner\/name/);
  assert.equal(await focused(page), "gh-repo");
  assert.equal(gh.calls.length, 0);
  await page.fill("#gh-repo", `https://github.com/${REPO}/issues`);
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "gh-token");
  await page.keyboard.type(TOKEN);
  await shots(page, "desktop-connect");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#gh").open, null, { timeout: 5000 });
  assert.deepEqual(gh.calls, [`GET /repos/${REPO}`, `GET /repos/${REPO}/labels?per_page=100`]);
  assert.deepEqual([...gh.auth], [`Bearer ${TOKEN}`]);
  assert.equal(await focused(page), "send", "focus isn't back on Send");
  assert.equal(await page.textContent("#gh-open-label"), REPO);
  assert.match(await page.textContent("#send-to"), new RegExp(`As an issue in ${REPO}`));
  assert.deepEqual(await chipState(page), ["bug", "idea*", "later"]);
  const kept = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), token: document.querySelector<HTMLInputElement>("#gh-token").value }));
  assert.ok(!kept.local.includes("github_pat") && !kept.session.includes("github_pat"), "the token was stored without Remember");
  assert.equal(kept.token, "", "the token stayed in the form");

  // Pick `later` too, by keyboard: Shift+Tab from Send reaches the last chip.
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).value), "later");
  await page.keyboard.press("Space");
  assert.deepEqual(await chipState(page), ["bug", "idea*", "later*"]);
  await page.keyboard.press("Tab");
  await shots(page, "desktop-review-connected");
  await page.emulateMedia({ colorScheme: "dark" });

  // Send: the issue has the title, the transcript as its body, and the chosen labels.
  await page.keyboard.press("Enter");
  await waitState(page, ["sent"], 5000);
  assert.deepEqual(gh.issues, [{ title: "New idea", body: said.trim(), labels: ["idea", "later"] }]);
  assert.equal(await page.getAttribute("#sent-link", "href"), `https://github.com/${REPO}/issues/42`);
  assert.equal(await page.textContent("#sent-link"), `issue #42 in ${REPO}`);
  assert.equal(await focused(page), "next");
  await noSideScroll(page, "desktop sent");
  await shots(page, "desktop-sent");
  await page.emulateMedia({ colorScheme: "dark" });

  // Record the next idea, by keyboard; the labels chosen last time stay chosen.
  await page.keyboard.press("Enter");
  await waitState(page, ["recording"], 10000);
  await page.waitForTimeout(5200);
  await page.keyboard.press("Space");
  await waitState(page, ["review", "problem"], 60000);
  if (micMode === "in-page" || (await state(page)) === "review") {
    assert.equal(await state(page), "review");
    assert.deepEqual(await chipState(page), ["bug", "idea*", "later*"]);
  }

  // The header shows the repo; Forget token clears it from memory (and storage) in one click.
  await page.locator("#gh-open").focus();
  await page.keyboard.press("Enter");
  assert.equal(await dialogOpen(page), true);
  assert.match(await page.textContent("#gh-on"), new RegExp(REPO));
  assert.match(await page.textContent("#gh-on-keep"), /memory only/);
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "gh-forget");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.__sayfold.connected()), false);
  assert.match(await page.textContent("#gh-note"), /Token forgotten/);
  assert.equal(await page.inputValue("#gh-token"), "");
  await page.keyboard.press("Escape");
  assert.equal(await dialogOpen(page), false);
  assert.equal(await page.textContent("#gh-open-label"), "Connect GitHub");
  assert.equal(await page.isVisible("#labels"), false);
  tokenOnlyToGitHub("send", seen);
  await ctx.close();
});

// --- send to GitHub on a phone: GitHub's errors, offline, and Remember on this device -------------------
await check("send, phone", async () => {
  const { ctx, page, seen, gh } = await openPage("send, phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  // The footer: the like pill centred against the credit, and Source and Privacy on one line.
  await page.waitForSelector("#like:not([hidden])", { timeout: 5000 });
  const foot = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const [like, made, source, privacy] = [document.querySelector("#like"), document.querySelector(".made"), ...document.querySelectorAll(".more a")].map(box);
    return { like: like.top + like.height / 2, made: made.top + made.height / 2, source: source.top, privacy: privacy.top };
  });
  assert.ok(Math.abs(foot.like - foot.made) <= 1.5, `the like pill isn't centred on the footer text (${foot.like} vs ${foot.made})`);
  assert.ok(Math.abs(foot.source - foot.privacy) <= 1, "Privacy wrapped onto a line of its own");

  await record(page, "send, phone", 5.5, () => page.locator("#rec").tap());
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  const said = await page.inputValue("#text");
  await page.locator("#send").tap();
  assert.equal(await dialogOpen(page), true);
  await page.fill("#gh-repo", REPO);
  await page.fill("#gh-token", TOKEN);
  await noSideScroll(page, "phone connect");
  await shots(page, "phone-connect");
  await page.emulateMedia({ colorScheme: "light" });

  // Connecting: each of GitHub's refusals is said in plain words, and the form keeps what was typed.
  const connectCases: [Partial<Record<"repo" | "labels", GhAnswer>>, RegExp][] = [
    [{ repo: 404 }, /can't find lab-test\/ideas with this token/],
    [{ repo: 401 }, /didn't accept this token/],
    [{ repo: "ok", labels: 403 }, /can see lab-test\/ideas but not its issues/],
    [{ repo: "rate", labels: "ok" }, /limit on requests was reached. Try again in about 5 minutes/],
    [{ repo: "down" }, /Couldn't reach GitHub/],
  ];
  for (const [answers, message] of connectCases) {
    Object.assign(gh, answers);
    await page.locator("#gh-connect").tap();
    await page.waitForFunction(() => document.querySelector("#gh-err").textContent !== "" && !document.querySelector<HTMLButtonElement>("#gh-connect").disabled, null, { timeout: 5000 });
    assert.match(await page.textContent("#gh-err"), message);
    assert.equal(await dialogOpen(page), true);
    assert.equal(await page.inputValue("#gh-token"), TOKEN);
  }
  await shot(page, "phone-connect-error-light");
  Object.assign(gh, { repo: "ok", labels: "ok" });
  await page.locator("#gh-remember").tap();
  assert.match(await page.textContent("#gh-keep"), /until you press Forget token/);
  await page.locator("#gh-connect").tap();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#gh").open, null, { timeout: 5000 });
  const stored = await page.evaluate(() => localStorage.getItem("sayfold:github"));
  assert.deepEqual(JSON.parse(stored), { repo: REPO, token: TOKEN });
  for (const id of ["#send", "#copy", "#again"]) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b.height >= 44, `${id} is ${b.height} high`);
  }
  await noSideScroll(page, "phone review connected");
  await shots(page, "phone-review-connected");
  await page.emulateMedia({ colorScheme: "light" });

  // Sending: every refusal is said in plain words, and the text stays.
  const sendCases: [GhAnswer, RegExp, boolean][] = [
    [401, /didn't accept this token/, true],
    [403, /can't create issues in lab-test\/ideas/, true],
    [404, /can't find lab-test\/ideas/, true],
    [410, /Issues are turned off in lab-test\/ideas/, false],
    [422, /didn't accept this issue/, false],
    ["rate", /limit on requests was reached/, false],
    [502, /isn't answering properly/, false],
    ["down", /Couldn't reach GitHub/, false],
  ];
  for (const [answer, message, reconnect] of sendCases) {
    gh.issue = answer;
    await page.locator("#send").tap();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#send-problem").hidden && !document.querySelector<HTMLButtonElement>("#send").disabled, null, { timeout: 5000 });
    const text = await page.textContent("#send-problem-text");
    assert.match(text, message, String(answer));
    assert.match(text, /Your text is still here/);
    assert.equal(await page.isVisible("#send-reconnect"), reconnect, `${answer}: Connect again`);
    assert.equal(await focused(page), "send", `${answer}: focus isn't back on Send`);
    assert.equal(await state(page), "review");
    assert.equal(await page.inputValue("#text"), said, "the text changed");
    if (answer === 403) await shot(page, "phone-send-error-light");
  }
  assert.equal(gh.issues.length, 0);

  // Offline: Send waits, says so, and comes back by itself.
  await ctx.setOffline(true);
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("#send").disabled);
  assert.equal(await page.textContent("#send"), "Waiting for a connection…");
  await shot(page, "phone-offline-light");
  await ctx.setOffline(false);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#send").disabled);
  assert.equal(await page.textContent("#send"), "Send to GitHub");
  assert.equal(await page.inputValue("#text"), said);

  // Offline while an idea is on its way: "You're offline" goes by itself when the connection is back.
  Object.assign(gh, { issue: "down", delay: 800 });
  await page.locator("#send").tap();
  await ctx.setOffline(true);
  await page.waitForFunction(() => /offline/.test(document.querySelector("#send-problem-text").textContent), null, { timeout: 5000 });
  assert.equal(await focused(page), "send-problem-text", "focus isn't on the problem while Send waits");
  await ctx.setOffline(false);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#send-problem").hidden, null, { timeout: 3000 }).catch(() => {
    throw new Error("the offline message stayed after the connection came back");
  });
  gh.delay = 0;

  gh.issue = "ok";
  await page.locator("#send").tap();
  await waitState(page, ["sent"], 5000);
  assert.deepEqual(gh.issues, [{ title: "New idea", body: said.trim(), labels: ["idea"] }]);
  await noSideScroll(page, "phone sent");
  await shots(page, "phone-sent");

  // Remembered: a later visit is still connected, until Forget token clears memory and storage at once.
  await page.reload({ waitUntil: "load" });
  assert.equal(await page.evaluate(() => window.__sayfold.connected()), true);
  assert.equal(await page.textContent("#gh-open-label"), REPO);
  await page.locator("#gh-open").tap();
  assert.match(await page.textContent("#gh-on-keep"), /remembered on this device/);
  await page.locator("#gh-forget").tap();
  assert.equal(await page.evaluate(() => localStorage.getItem("sayfold:github")), null);
  assert.equal(await page.evaluate(() => window.__sayfold.connected()), false);
  tokenOnlyToGitHub("send, phone", seen);
  await ctx.close();
});

// --- a slow send: nothing can start a recording until GitHub answers, and the microphone always ends ----------
await check("send race", async () => {
  const { ctx, page, gh } = await openPage("send race", { viewport: { width: 390, height: 844 }, colorScheme: "light" }, { init: watchMic });
  await record(page, "send race", 3, () => page.locator("#rec").click());
  assert.equal(await state(page), "review", await page.textContent("#problem-title"));
  // owner/name with a trailing slash connects, as the same slash on a github.com link does.
  await page.locator("#send").click();
  await page.fill("#gh-repo", `${REPO}/`);
  await page.fill("#gh-token", TOKEN);
  await page.locator("#gh-connect").click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#gh").open, null, { timeout: 5000 }).catch(async () => {
    throw new Error(`"${REPO}/" didn't connect: ${await page.textContent("#gh-repo-err")}`);
  });
  assert.equal(await page.textContent("#gh-open-label"), REPO);

  gh.delay = 2500;
  await page.locator("#send").click();
  await page.waitForTimeout(300);
  for (const id of ["#again", "#copy"]) assert.equal(await page.isDisabled(id), true, `${id} can be pressed while sending`);
  await page.locator("#again").click({ force: true });
  await page.locator("#copy").click({ force: true });
  await waitState(page, ["sent"], 6000);
  const states: string[] = await page.evaluate(() => (window as any).__watch.states);
  assert.deepEqual(states.slice(states.lastIndexOf("review")), ["review", "sent"], `states after Send: ${states.join(" > ")}`);
  assert.equal(gh.issues.length, 1);
  assert.equal(await liveTracks(page), 0, "a microphone track is still live after sending");

  // The next idea records with one microphone, and lets it go at Stop.
  gh.delay = 0;
  await record(page, "send race, next", 2, () => page.locator(":is(#next, #rec):visible").click());
  assert.equal(await liveTracks(page), 0, "a microphone track is still live after the next idea");
  assert.equal(await page.evaluate(() => (window as any).__watch.maxLive), 1, "two microphone tracks were live at once");
  await ctx.close();
});

// --- a spoken list: previewed live from the text, and sent as a GitHub task list ----------------------------
await check("spoken list", async () => {
  for (const [size, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const label = `spoken list, ${size}`;
    // On the desktop, a list really said: the speech model writes it with commas, not full stops.
    const spoken = !mobile;
    const { ctx, page, seen, gh } = await openPage(label, { viewport, isMobile: mobile, hasTouch: mobile, colorScheme: "light" }, spoken ? { mic: { b64: LIST_B64 } } : {});
    const press = (sel: string) => (mobile ? page.locator(sel).tap() : page.locator(sel).click());
    const items = () => page.$$eval("#preview li", (els) => els.map((e) => e.textContent));
    const paras = () => page.$$eval("#preview-body p", (els) => els.map((e) => e.textContent));
    await record(page, label, spoken ? LIST_SECONDS + 1 : 5.5, () => press("#rec"));
    assert.equal(await state(page), "review", await page.textContent("#problem-title"));
    if (spoken) {
      const said = await page.inputValue("#text");
      assert.equal(await page.isVisible("#preview"), true, `no preview for the spoken list "${said}"`);
      assert.deepEqual(await items(), ["Milk", "Bread", "Eggs"], said);
      assert.deepEqual(await paras(), ["Groceries for the weekend:", "Then call the bank."], said);
      assert.equal(await page.inputValue("#title"), "Groceries for the weekend");
      console.log(`${label}: "${said}" (${await page.evaluate(() => window.__sayfold.backend())})`);
      await shots(page, `${size}-review-spoken-list`);
      await page.emulateMedia({ colorScheme: "light" });
    } else assert.equal(await page.isVisible("#preview"), false, "a list preview shows for the clip, which has no list");

    // Said as a list: the preview shows the items, and follows the text as it's edited, typed lines too.
    await page.fill("#text", "Groceries for the weekend. List. Milk. Bread.");
    assert.equal(await page.isVisible("#preview"), true, "no preview for a spoken list");
    assert.deepEqual(await items(), ["Milk", "Bread"]);
    assert.equal(await page.inputValue("#title"), "Groceries for the weekend");
    await page.locator("#text").press("End");
    await page.locator("#text").pressSequentially(" eggs.");
    assert.deepEqual(await items(), ["Milk", "Bread", "Eggs"]);
    await page.locator("#text").press("Enter");
    await page.locator("#text").pressSequentially("oat milk");
    assert.deepEqual(await items(), ["Milk", "Bread", "Eggs", "Oat milk"]);
    assert.deepEqual(await paras(), ["Groceries for the weekend."]);
    await noSideScroll(page, label);
    await shots(page, `${size}-review-list`);
    await page.emulateMedia({ colorScheme: "light" });

    // Copy copies what Send sends: the title, a blank line, and the body with its task list.
    const body = "Groceries for the weekend.\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs\n- [ ] Oat milk";
    await page.evaluate(() => document.querySelector("#toast").classList.remove("show"));
    await press("#copy");
    await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
    assert.equal(await page.textContent("#toast"), "Copied the title and text");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `Groceries for the weekend\n\n${body}`);

    // "list" inside a sentence is just a word, and the preview goes.
    const typed = await page.inputValue("#text");
    await page.fill("#text", "My shopping list is long.");
    assert.equal(await page.isVisible("#preview"), false, "a preview for \"list\" inside a sentence");
    await page.fill("#text", typed);
    assert.equal(await page.isVisible("#preview"), true);

    // Sent: the body has the task list, and the title is the words before it.
    await press("#send");
    await page.fill("#gh-repo", REPO);
    await page.fill("#gh-token", TOKEN);
    await press("#gh-connect");
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#gh").open, null, { timeout: 5000 });
    await press("#send");
    await waitState(page, ["sent"], 5000);
    assert.deepEqual(gh.issues, [
      { title: "Groceries for the weekend", body, labels: ["idea"] },
    ]);
    tokenOnlyToGitHub(label, seen);
    await ctx.close();
  }
});

// --- when recording can't happen ------------------------------------------------------------------
const problemCases: [string, () => void, RegExp, boolean][] = [
  ["permission denied", () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")); }, /can't use your microphone/, true],
  ["no microphone", () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Requested device not found", "NotFoundError")); }, /No microphone found/, true],
  ["unsupported browser", () => { Object.defineProperty(Navigator.prototype, "mediaDevices", { get: () => undefined }); }, /This browser can't record here/, false],
];
for (const [label, init, title, retry] of problemCases) {
  await check(label, async () => {
    const { ctx, page, seen } = await openPage(label, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" }, { init });
    if (retry) {
      await page.locator("#rec").click();
      await waitState(page, ["problem"], 5000);
    } else assert.equal(await state(page), "problem", "an unsupported browser should say so on load");
    assert.match(await page.textContent("#problem-title"), title);
    assert.equal(await page.isVisible("#rec"), false, "the record button still shows");
    assert.equal(await page.isVisible("#retry"), retry);
    if (retry) assert.equal(await page.evaluate(() => document.activeElement.id), "retry", "Try again isn't focused");
    assert.equal(modelRequests(seen).length, 0, "the model loaded though nothing was recorded");
    await shot(page, `problem-${label.replace(/ /g, "-")}-light`);
    await ctx.close();
  });
}

// --- the like API down: the heart stays hidden and recording doesn't wait ---------------------------------
await check("likes down", async () => {
  const { ctx, page } = await openPage("likes down", { viewport: { width: 1280, height: 900 } }, { likes: "down" });
  await page.waitForTimeout(800);
  assert.equal(await page.isVisible("#like"), false);
  await page.locator("#rec").click();
  await waitState(page, ["recording"], 10000);
  await page.locator("#rec").click();
  await ctx.close();
});

// --- usage events (lab#71) ----------------------------------------------------------------------------
// Sayfold under a made-up sayfold.playtest.brightloopapps.com, which the browser resolves to the local server
// (so the speech worker and the audio worklet reach it too) and treats as secure, with the hub's
// built script served from LAB_ANALYTICS_JS (never the live one) and PostHog answered here. A recording
// sent to (a stand-in) GitHub sends exactly $pageview, play_started, play_finished (with only its length
// bucket and backend) and idea_sent (with nothing at all), and no analytics request holds anything that
// was said, the repo, the token or a label. With Do Not Track on, the script isn't even fetched.
const ANALYTICS_JS = process.env.LAB_ANALYTICS_JS || join(homedir(), "brightloop-lab/lab/hub/public/analytics/v1.js");

function decodeEvents(body: Buffer | null) {
  if (!body?.length) return [];
  let text = body[0] === 0x1f ? gunzipSync(body).toString() : body.toString();
  if (text.startsWith("data=")) text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString();
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : (v.batch ?? [v]);
}

async function analytics(dnt: boolean) {
  const label = dnt ? "analytics, Do Not Track" : "analytics";
  if (only && !label.startsWith(only)) return;
  let script: Buffer;
  try {
    script = readFileSync(ANALYTICS_JS);
  } catch {
    return fail(`${label}: no shared script at ${ANALYTICS_JS}: build it in the lab's hub with npm run bundle, or set LAB_ANALYTICS_JS`);
  }
  const host = "sayfold.playtest.brightloopapps.com";
  const { hostname, port } = new URL(base);
  const site = `http://${host}${port ? `:${port}` : ""}`;
  const hostBrowser = await launch(micMode === "chromium", [`--host-resolver-rules=MAP ${host} ${hostname}`, `--unsafely-treat-insecure-origin-as-secure=${site}`]);
  const probe = await hostBrowser.newPage();
  const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
  await probe.close();
  const ctx = await hostBrowser.newContext({ viewport: { width: 1280, height: 900 }, userAgent, permissions: ["microphone"] });
  await ctx.addInitScript((dnt) => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
    Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => (dnt ? "1" : null), configurable: true });
    // Brave turns Global Privacy Control on by default; this run is about Do Not Track alone.
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => false, configurable: true });
  }, dnt);
  if (micMode === "in-page") await ctx.addInitScript(inPageMic, { b64: WAV_B64 });
  const r = { events: [] as any[], bodies: [] as string[], scripts: 0, hosts: new Set<string>() };
  await ctx.route(`${LAB}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/analytics/v1.js") {
      r.scripts++;
      return route.fulfill({ contentType: "text/javascript", body: script });
    }
    if (url.pathname === "/api/likes") return route.fulfill({ headers: { "access-control-allow-origin": site }, contentType: "application/json", body: JSON.stringify({ sayfold: { total: 3, week: 1 } }) });
    fail(`${label}: the page asked ${url.href}`);
    return route.abort();
  });
  await ctx.route((u) => /(^|\.)posthog\.com$/.test(u.hostname), async (route) => {
    const req = route.request();
    if (new URL(req.url()).hostname !== "eu.i.posthog.com") {
      fail(`${label}: analytics contacted ${req.url()}`);
      return route.abort();
    }
    r.bodies.push(req.url(), req.postDataBuffer()?.toString("latin1") ?? "");
    try {
      const sent = decodeEvents(req.postDataBuffer());
      r.events.push(...sent);
      r.bodies.push(JSON.stringify(sent));
    } catch (e) {
      fail(`${label}: couldn't read what analytics sent: ${e.message}`);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"Ok"}' });
  });
  const gh = await mockGitHub(ctx, site);
  ctx.on("request", (q) => {
    const u = new URL(q.url());
    if (u.protocol.startsWith("http")) r.hosts.add(u.hostname);
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`${label}: page error: ${e.message}`));
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && fail(`${label}: console ${m.type()}: ${m.text()}`));
  await page.goto(`${site}/`, { waitUntil: "load" });
  await check(label, async () => {
    await record(page, label, 5.5, () => page.locator("#rec").click());
    assert.equal(await state(page), "review", await page.textContent("#problem-title"));
    const backend = await page.evaluate(() => window.__sayfold.backend());
    // Connect and send it to GitHub's stand-in, with the `later` label too.
    await page.locator("#send").click();
    await page.fill("#gh-repo", REPO);
    await page.fill("#gh-token", TOKEN);
    await page.locator("#gh-connect").click();
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#gh").open, null, { timeout: 5000 });
    await page.locator("#chips label", { hasText: "later" }).click();
    await page.locator("#send").click();
    await waitState(page, ["sent"], 5000);
    assert.equal(gh.issues.length, 1);
    await page.waitForTimeout(dnt ? 1500 : 4000);
    if (dnt) {
      assert.equal(r.scripts, 0, "the analytics script was fetched with Do Not Track on");
      assert.equal(r.events.length, 0, "events were sent with Do Not Track on");
      return;
    }
    assert.equal(r.scripts, 1, `the analytics script was fetched ${r.scripts} times`);
    const ours = (e) => Object.fromEntries(Object.entries(e.properties ?? {}).filter(([k]) => !k.startsWith("$") && !["token", "distinct_id", "project"].includes(k)));
    const seen = r.events.map((e) => `${e.event} ${JSON.stringify(ours(e))}`).sort();
    const wanted = ["$pageview {}", "idea_sent {}", `play_finished ${JSON.stringify({ seconds_bucket: "0-9", backend })}`, "play_started {}"];
    assert.deepEqual(seen, wanted);
    for (const e of r.events) {
      const p = e.properties ?? {};
      assert.equal(p.project, "sayfold", `${e.event} is for ${p.project}`);
      assert.equal(p.$cookieless_mode, true, `${e.event} isn't marked cookieless`);
    }
    const said = ["tomato", "plumber", "friday", "new idea", "water"];
    for (const body of r.bodies) for (const w of said) assert.ok(!body.toLowerCase().includes(w), `analytics sent "${w}"`);
    const github = ["github_pat", TOKEN, "lab-test", "later", "a2eeef", "fbca04", "api.github.com"];
    for (const body of r.bodies) for (const w of github) assert.ok(!body.includes(w), `analytics sent "${w}"`);
    const kept = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
    assert.deepEqual(kept.local.filter((k) => k !== "sayfold:like"), [], "analytics left localStorage");
    assert.deepEqual(kept.session, [], "analytics left sessionStorage");
    assert.deepEqual((await ctx.cookies()).map((c) => c.name), [], "cookies were set");
    console.log(`analytics: ${seen.join(", ")}; nothing said, no repo, token or label was sent, no cookies or storage`);
  });
  const allowed = new Set([host, new URL(LAB).hostname, new URL(GITHUB).hostname, ...(dnt ? [] : ["eu.i.posthog.com"])]);
  for (const x of r.hosts) if (!allowed.has(x)) fail(`${label}: the page contacted ${x}`);
  await hostBrowser.close();
}
await analytics(false);
await analytics(true);

await browser.close();
if (failures.length) {
  console.log(`\nFAIL (${failures.length})`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS (microphone: ${micMode === "chromium" ? "Chromium's fake capture device" : "in-page stand-in"}; screenshots in ${out})`);
