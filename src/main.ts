import "./style.css";
import { Recorder, type Recording } from "./audio/recorder.ts";
import { Speech } from "./stt/client.ts";
import { clock, MAX_SECONDS } from "./core/time.ts";
import { titleFrom, clipboardText } from "./core/title.ts";
import { micProblem, unsupported, MESSAGES, type Problem } from "./core/mic.ts";
import { LoadProgress, megabytes } from "./core/progress.ts";
import { MODEL } from "./stt/model.ts";
import { Likes, likeLabel, shortCount } from "./core/likes.ts";
import { loadAnalytics, track } from "./analytics.ts";
import { EVENTS, playEvents, PROJECT, type Backend } from "./analytics-events.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

type State = "idle" | "starting" | "recording" | "working" | "review" | "problem";
let state: State = "idle";

const recBtn = $<HTMLButtonElement>("#rec");
const recLabel = $("#rec-label");
const clockNow = $("#clock-now");
const wave = $<HTMLCanvasElement>("#wave");
const workLabel = $("#work-label");
const workNote = $("#work-note");
const barFill = $("#bar-fill");
const problemTitle = $("#problem-title");
const problemBody = $("#problem-body");
const retryBtn = $<HTMLButtonElement>("#retry");
const titleIn = $<HTMLInputElement>("#title");
const textIn = $<HTMLTextAreaElement>("#text");

function setState(next: State) {
  state = next;
  document.body.dataset.state = next;
  recLabel.textContent = next === "recording" ? "Stop" : "Record";
  recBtn.setAttribute("aria-pressed", String(next === "recording"));
  recBtn.disabled = next === "starting";
}

const sayEl = $("#say");
/** Tell screen readers what just changed. */
function say(text: string) {
  sayEl.textContent = "";
  requestAnimationFrame(() => (sayEl.textContent = text));
}

let toastTimer = 0;
function toast(text: string) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}

// --- usage events (sent through the lab's shared script; nothing said or typed is ever sent) ---
const plays = playEvents(track);

// --- problems ------------------------------------------------------------------------------
type PageProblem = Problem | "model" | "transcribe" | "empty";
const PAGE_MESSAGES: Record<"model" | "transcribe" | "empty", { title: string; body: string }> = {
  model: {
    title: "The speech model didn't load",
    body: "It comes from this site the first time you record. Check your connection, then try again. Your recording is still here.",
  },
  transcribe: {
    title: "That recording couldn't be turned into text",
    body: "Something went wrong on this device. Try again, or record it once more.",
  },
  empty: {
    title: "No words came through",
    body: "Sayfold heard only silence. Check that the right microphone is on and not muted, then record again.",
  },
};
let problem: PageProblem | null = null;

function showProblem(p: PageProblem) {
  problem = p;
  const m = p in PAGE_MESSAGES ? PAGE_MESSAGES[p as keyof typeof PAGE_MESSAGES] : MESSAGES[p as Problem];
  problemTitle.textContent = m.title;
  problemBody.textContent = m.body;
  const canRetry = p !== "insecure" && p !== "browser";
  retryBtn.hidden = !canRetry;
  retryBtn.textContent = p === "empty" ? "Record again" : "Try again";
  setState("problem");
  if (canRetry) retryBtn.focus();
}

retryBtn.addEventListener("click", () => {
  if (problem === "model" || problem === "transcribe") void transcribe();
  else void start();
});

// --- the speech model ------------------------------------------------------------------------
const progress = new LoadProgress(MODEL.bytes);
let backend: Backend | null = null;

function showLoad() {
  if (speech.ready) return;
  workLabel.textContent = "Getting the speech model ready";
  const total = progress.total;
  workNote.textContent = total
    ? `${megabytes(progress.loaded)} of ${megabytes(total)}. First time only: after this, your browser keeps it.`
    : "First time only: after this, your browser keeps it.";
  barFill.style.width = `${Math.round(progress.fraction * 100)}%`;
  document.body.dataset.bar = "known";
}

const speech = new Speech({
  progress(file, loaded, total, done) {
    if (done) progress.done(file);
    else progress.update(file, loaded, total);
    if (state === "working") showLoad();
  },
  ready(b) {
    backend = b;
    if (state === "working") showTranscribing();
  },
  part(done, of) {
    showTranscribing(of > 1 ? `Part ${done + 1} of ${of}` : "");
    if (of > 1) {
      barFill.style.width = `${Math.round((done / of) * 100)}%`;
      document.body.dataset.bar = "known";
    }
  },
});

function showTranscribing(note = "") {
  workLabel.textContent = "Turning speech into text";
  workNote.textContent = note || "On this device. Nothing is uploaded.";
  if (!note) document.body.dataset.bar = "busy";
}

// --- recording -------------------------------------------------------------------------------
let recorder: Recorder | null = null;
let last: Recording | null = null;
let levels: number[] = [];

async function start() {
  if (state === "starting" || state === "recording" || state === "working") return;
  setState("starting");
  say("Asking for the microphone");
  // First use: the model starts loading now, while you talk.
  speech.load();
  try {
    recorder = await Recorder.start(() => void stop(true));
  } catch (e) {
    recorder = null;
    showProblem(micProblem(e));
    return;
  }
  last = null;
  levels = [];
  plays.started();
  setState("recording");
  say("Recording. Press Stop when you're done.");
  recBtn.focus();
  requestAnimationFrame(frame);
}

async function stop(capped = false) {
  if (state !== "recording" || !recorder) return;
  const r = recorder;
  recorder = null;
  setState("working");
  last = await r.stop();
  if (capped) toast(`Stopped at ${clock(MAX_SECONDS)}, the limit for one recording.`);
  await transcribe();
}

async function transcribe() {
  if (!last) return;
  setState("working");
  if (speech.ready) showTranscribing();
  else showLoad();
  say(speech.ready ? "Turning speech into text" : "Getting the speech model ready");
  const rec = last;
  try {
    const result = await speech.transcribe(rec.samples, rec.rate);
    backend = result.backend;
    if (!result.text.trim()) {
      plays.abandoned();
      showProblem("empty");
      return;
    }
    plays.finished(rec.seconds, result.backend);
    showReview(result.text.trim());
  } catch (e) {
    console.warn("Sayfold: transcription failed:", e);
    // The recording stays, so Try again doesn't need a new one.
    showProblem((e as { stage?: string }).stage === "load" ? "model" : "transcribe");
  }
}

// --- review ----------------------------------------------------------------------------------
/** The title follows the first line until you write your own. */
let titleFollows = true;

function showReview(text: string) {
  textIn.value = text;
  titleIn.value = titleFrom(text);
  titleFollows = true;
  setState("review");
  say("Your idea is ready to review");
  textIn.focus();
  textIn.setSelectionRange(text.length, text.length);
}

textIn.addEventListener("input", () => {
  if (titleFollows) titleIn.value = titleFrom(textIn.value);
});
titleIn.addEventListener("input", () => {
  titleFollows = titleIn.value.trim() === "";
});

$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(clipboardText(titleIn.value, textIn.value));
    toast("Copied the title and text");
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
});

$("#again").addEventListener("click", () => void start());

recBtn.addEventListener("click", () => {
  if (state === "recording") void stop();
  else void start();
});

// Space starts and stops a recording from anywhere on the page, except where it types or presses something.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, a, input, textarea, select, [contenteditable]")) return;
  if (state === "idle" || state === "recording") {
    e.preventDefault();
    if (state === "recording") void stop();
    else void start();
  }
});

// --- the clock and the live waveform -----------------------------------------------------------
const BARS = 56;
let colours = { live: "", rest: "" };
const readColours = () => {
  const css = getComputedStyle(document.documentElement);
  colours = { live: css.getPropertyValue("--accent").trim(), rest: css.getPropertyValue("--line-strong").trim() };
};
readColours();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  readColours();
  draw();
});

function draw() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = wave.clientWidth;
  const h = wave.clientHeight;
  if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(h * dpr)) {
    wave.width = Math.round(w * dpr);
    wave.height = Math.round(h * dpr);
  }
  const g = wave.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const gap = w / BARS;
  const bar = Math.max(2, gap * 0.45);
  const shown = levels.slice(-BARS);
  for (let i = 0; i < BARS; i++) {
    const v = shown[i - (BARS - shown.length)];
    const live = v !== undefined;
    const height = Math.max(bar, (live ? Math.sqrt(v) : 0) * (h - 4));
    g.fillStyle = live ? colours.live : colours.rest;
    g.beginPath();
    g.roundRect(i * gap + (gap - bar) / 2, (h - height) / 2, bar, height, bar / 2);
    g.fill();
  }
}

let lastBar = 0;
function frame(now: number) {
  if (state !== "recording" || !recorder) return;
  clockNow.textContent = clock(recorder.seconds);
  const level = recorder.loudness();
  recBtn.style.setProperty("--level", level.toFixed(3));
  // About 16 bars a second, so the trace scrolls at an even pace whatever the frame rate.
  if (now - lastBar > 60) {
    levels.push(level);
    if (levels.length > BARS) levels.shift();
    lastBar = now;
  }
  draw();
  requestAnimationFrame(frame);
}

new ResizeObserver(() => draw()).observe(wave);

// --- what this browser can do ------------------------------------------------------------------
const lacking = unsupported({
  isSecureContext: window.isSecureContext,
  getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
  AudioContext: "AudioContext" in window,
  AudioWorklet: "AudioWorkletNode" in window,
  Worker: "Worker" in window,
  WebAssembly: typeof WebAssembly === "object",
});
if (lacking) showProblem(lacking);
else setState("idle");

// --- likes -----------------------------------------------------------------------------------
// A heart with the live count from the lab hub (see core/likes.ts). It stays hidden until the
// count loads and recording never waits for it.
const likeBtn = $<HTMLButtonElement>("#like");
let likeStore: Storage | null = null;
try {
  likeStore = window.localStorage;
} catch {
  // Storage blocked: a like still works within this page.
}
const likes = new Likes({
  fetch: (...a) => fetch(...a),
  storage: likeStore,
  onChange(s) {
    likeBtn.hidden = !s.ready;
    likeBtn.setAttribute("aria-pressed", String(s.liked));
    likeBtn.setAttribute("aria-label", likeLabel(s.count));
    if (s.busy) likeBtn.setAttribute("aria-busy", "true");
    else likeBtn.removeAttribute("aria-busy");
    $("#like-n").textContent = shortCount(s.count);
  },
  onNote: toast,
});
likeBtn.addEventListener("click", () => {
  if (!likes.state.liked && !likes.state.busy) {
    likeBtn.classList.remove("pop");
    void likeBtn.offsetWidth; // restart the animation
    likeBtn.classList.add("pop");
  }
  void likes.toggle();
});
void likes.load();
// The shared analytics script comes once the page is idle, and only where it may send.
loadAnalytics(PROJECT, EVENTS);

// A read-only look inside for the playtest: the page's state, never anything recorded.
declare global {
  interface Window { __sayfold?: { state(): State; backend(): Backend | null; seconds(): number | null; modelReady(): boolean } }
}
window.__sayfold = {
  state: () => state,
  backend: () => backend,
  seconds: () => last?.seconds ?? null,
  modelReady: () => speech.ready,
};
