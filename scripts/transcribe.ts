// What the speech model really writes for a clip: plays each WAV into Sayfold's page through a stand-in
// microphone, as the playtest does, and prints the transcript the review screen shows. The spoken-list
// fixtures in tests/fixtures/list-transcripts.json were made with it (lab#80).
//
// Usage: node scripts/transcribe.ts <baseUrl> [--cpu] [--snr <dB>] <clip.wav>...
//   --cpu   serve the speech worker without WebAssembly JSPI, so it runs on the CPU (as in Safari or Firefox)
//   --snr   mix in a room's steady noise at this speech-to-noise ratio, as the playtest's long recording does
// Env:    PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave; falls back to Playwright's Chromium)
// Prints one line of JSON per clip: { clip, backend, text }.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const base = args.shift();
const cpu = args.includes("--cpu");
const snrAt = args.indexOf("--snr");
const snr = snrAt >= 0 ? Number(args[snrAt + 1]) : undefined;
const clips = args.filter((a, i) => !a.startsWith("--") && (snrAt < 0 || i !== snrAt + 1));
if (!base || !clips.length) {
  console.error("usage: node scripts/transcribe.ts <baseUrl> [--cpu] [--snr <dB>] <clip.wav>...");
  process.exit(2);
}

/** Plays a clip into a MediaStream in place of getUserMedia, with a room's seeded noise when `snr` is given. */
function inPageMic({ b64, snr }: { b64: string; snr?: number }) {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const buf = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    if (snr !== undefined) {
      const x = buf.getChannelData(0);
      const noise = new Float32Array(x.length);
      let seed = 11, b0 = 0, b1 = 0, b2 = 0, speech = 0, room = 0;
      for (let i = 0; i < x.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const w = seed / 0x7fffffff - 0.5;
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

const flags = ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu"];
const browser = await chromium
  .launch({ executablePath: process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", args: flags })
  .catch(() => chromium.launch({ args: flags }));
for (const clip of clips) {
  const wav = readFileSync(clip);
  // The data chunk's bytes, in 16-bit mono at the file's own rate.
  const seconds = wav.readUInt32LE(wav.indexOf("data") + 4) / (wav.readUInt32LE(24) * 2);
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  // The like counter and analytics stay away: only the page and its model are needed.
  await ctx.route("https://lab.brightloopapps.com/**", (r) => r.abort());
  if (cpu) {
    await ctx.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: `delete WebAssembly.Suspending;\n${await res.text()}` });
    });
  }
  await ctx.addInitScript(inPageMic, { b64: wav.toString("base64"), snr });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  await page.locator("#rec").click();
  await page.waitForFunction(() => window.__sayfold!.state() === "recording", null, { timeout: 10000 });
  await page.waitForTimeout((seconds + 1) * 1000);
  await page.locator("#rec").click();
  await page.waitForFunction(() => ["review", "problem"].includes(window.__sayfold!.state()), null, { timeout: 180000 });
  const backend = await page.evaluate(() => window.__sayfold!.backend());
  console.log(JSON.stringify({ clip: basename(clip), backend, text: await page.inputValue("#text") }));
  await ctx.close();
}
await browser.close();
