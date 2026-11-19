// Sayfold playtest: records a spoken clip in a real browser, turns it into text on the device and
// reviews it, at desktop (1280x900, dark) and phone (390x844, light) sizes, with both colour schemes
// screenshotted at each size.
//
// The microphone is fake and plays tests/fixtures/idea.wav, an original clip made with macOS `say`:
//   say -v Samantha -r 170 -o idea.aiff "New idea. Water the tomatoes every morning, and call the plumber on Friday."
//   afconvert -f WAVE -d LEI16@48000 -c 1 idea.aiff tests/fixtures/idea.wav
// First choice is Chromium's own fake capture device (--use-fake-device-for-media-stream with
// --use-file-for-fake-audio-capture). On macOS, a browser started by an app without microphone
// permission never answers getUserMedia, even for the fake device; the playtest then says so and
// plays the same clip through an in-page stand-in for getUserMedia instead.
//
// Every request is watched (pages and the speech worker): nothing may go anywhere but Sayfold's own
// origin and the lab hub's like API, which is mocked here (never the live one). On localhost the shared
// analytics script is never fetched; a separate run under a made-up *.brightloopapps.com address checks
// the usage events with the hub's built script and a stand-in PostHog.
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
const MAX_FILE = 25 * 1024 * 1024;
const LAB = "https://lab.brightloopapps.com";
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
/** Plays the clip into a MediaStream, standing in for getUserMedia (only used when the real fake device can't answer). */
function inPageMic(b64: string) {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
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
type Seen = { url: string; method: string; size?: number; status?: number };

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

async function openPage(name: string, opts, { likes = "ok" as "ok" | "down", init = null as null | (() => void) } = {}) {
  const ctx = await browser.newContext({ ...opts, permissions: ["clipboard-read", "clipboard-write", "microphone"] });
  await mockLikes(ctx, likes);
  if (micMode === "in-page") await ctx.addInitScript(inPageMic, WAV_B64);
  if (init) await ctx.addInitScript(init);
  const seen: Seen[] = [];
  // Context-wide, so the speech worker's requests are watched too.
  ctx.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:")) return;
    seen.push({ url: u, method: r.method() });
    if (new URL(u).origin === own || u.startsWith(`${LAB}/api/likes`)) return;
    fail(`${name}: request to somewhere other than Sayfold and the like API: ${u}`);
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
    fail(`${name}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
  await page.goto(base, { waitUntil: "load" });
  return { ctx, page, seen };
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

  // Keyboard: Tab from the text reaches Copy, then Record again. Enter on Copy copies title and text.
  await page.locator("#text").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"));
  assert.equal(await page.textContent("#toast"), "Copied the title and text");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Post office\n\nbuy stamps. Then post the letter. Tomorrow.");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "again");

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

// --- phone, light: the whole flow by touch -------------------------------------------------------
await check("phone", async () => {
  const { ctx, page } = await openPage("phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  assert.equal(await page.isVisible(".keys"), false, "the Space hint shows on a phone");
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
  for (const id of ["#copy", "#again"]) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${id} is ${b.width}x${b.height}`);
  }
  await noSideScroll(page, "phone review");
  await shots(page, "phone-review");
  await ctx.close();
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
// sends exactly $pageview, play_started and play_finished (with only its length bucket and backend), and
// no request holds anything that was said. With Do Not Track on, the script isn't even fetched.
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
  if (micMode === "in-page") await ctx.addInitScript(inPageMic, WAV_B64);
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
    await page.waitForTimeout(dnt ? 1500 : 4000);
    if (dnt) {
      assert.equal(r.scripts, 0, "the analytics script was fetched with Do Not Track on");
      assert.equal(r.events.length, 0, "events were sent with Do Not Track on");
      return;
    }
    assert.equal(r.scripts, 1, `the analytics script was fetched ${r.scripts} times`);
    const ours = (e) => Object.fromEntries(Object.entries(e.properties ?? {}).filter(([k]) => !k.startsWith("$") && !["token", "distinct_id", "project"].includes(k)));
    const seen = r.events.map((e) => `${e.event} ${JSON.stringify(ours(e))}`).sort();
    const wanted = ["$pageview {}", `play_finished ${JSON.stringify({ seconds_bucket: "0-9", backend })}`, "play_started {}"];
    assert.deepEqual(seen, wanted);
    for (const e of r.events) {
      const p = e.properties ?? {};
      assert.equal(p.project, "sayfold", `${e.event} is for ${p.project}`);
      assert.equal(p.$cookieless_mode, true, `${e.event} isn't marked cookieless`);
    }
    const said = ["tomato", "plumber", "friday", "new idea", "water"];
    for (const body of r.bodies) for (const w of said) assert.ok(!body.toLowerCase().includes(w), `analytics sent "${w}"`);
    const kept = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
    assert.deepEqual(kept.local.filter((k) => k !== "sayfold:like"), [], "analytics left localStorage");
    assert.deepEqual(kept.session, [], "analytics left sessionStorage");
    assert.deepEqual((await ctx.cookies()).map((c) => c.name), [], "cookies were set");
    console.log(`analytics: ${seen.join(", ")}; nothing said was sent, no cookies or storage`);
  });
  const allowed = new Set([host, new URL(LAB).hostname, ...(dnt ? [] : ["eu.i.posthog.com"])]);
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
