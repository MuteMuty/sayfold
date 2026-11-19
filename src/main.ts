import "./style.css";
import { Recorder, type Recording } from "./audio/recorder.ts";
import { Speech } from "./stt/client.ts";
import { clock, MAX_SECONDS } from "./core/time.ts";
import { titleFrom, copyNote } from "./core/title.ts";
import { micProblem, unsupported, MESSAGES, type Problem } from "./core/mic.ts";
import { LoadProgress, megabytes } from "./core/progress.ts";
import { MODEL } from "./stt/model.ts";
import { Likes, likeLabel, shortCount } from "./core/likes.ts";
import { loadAnalytics, track } from "./analytics.ts";
import { EVENTS, playEvents, PROJECT, type Backend } from "./analytics-events.ts";
import { connect, send, issueFrom, parseRepo, preselected, repoName, sendButton, tokenProblem, type GitHubProblem, type Label } from "./core/github.ts";
import { GitHubLink } from "./core/token.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

type State = "idle" | "starting" | "recording" | "working" | "review" | "problem" | "sent";
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
  hideSendProblem();
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
  // The last frame drawn may have been just before the cap: end on the recording's real length (2:00 at the cap).
  clockNow.textContent = clock(last.seconds);
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
  renderSend();
  if (link.current && !labels) void loadLabels();
}

textIn.addEventListener("input", () => {
  if (titleFollows) titleIn.value = titleFrom(textIn.value);
});
titleIn.addEventListener("input", () => {
  titleFollows = titleIn.value.trim() === "";
});

$("#copy").addEventListener("click", async () => {
  const note = copyNote(titleIn.value, textIn.value);
  if (!note.text) return toast(note.message);
  try {
    await navigator.clipboard.writeText(note.text);
    toast(note.message);
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
});

$("#again").addEventListener("click", () => void start());
$("#next").addEventListener("click", () => void start());

recBtn.addEventListener("click", () => {
  if (state === "recording") void stop();
  else void start();
});

// Space starts and stops a recording from anywhere on the page, except where it types or presses something.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || ghDialog.open) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, a, input, textarea, select, [contenteditable]")) return;
  if (state === "idle" || state === "recording" || state === "sent") {
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

// --- GitHub: connect, labels, send -----------------------------------------------------------------
// GitHub is the API: the visitor's own fine-grained token, limited to one repo, sends the idea straight
// from this browser to api.github.com as an issue (core/github.ts). The token stays in this tab's memory,
// unless they tick "Remember on this device" (core/token.ts). The page's Content-Security-Policy lets
// nothing else be reached (src/csp.ts).
let localStore: Storage | null = null;
try {
  localStore = window.localStorage;
} catch {
  // Storage blocked: a like, and a token, still work within this page.
}
const link = new GitHubLink(localStore);
/** The connected repo's labels (null until loaded), and the ones chosen for the next idea. */
let labels: Label[] | null = null;
let chosen = new Set<string>();
let sending = false;
const online = () => navigator.onLine !== false;

const ghDialog = $<HTMLDialogElement>("#gh");
const ghForm = $<HTMLFormElement>("#gh-form");
const ghRepo = $<HTMLInputElement>("#gh-repo");
const ghToken = $<HTMLInputElement>("#gh-token");
const ghRemember = $<HTMLInputElement>("#gh-remember");
const ghConnect = $<HTMLButtonElement>("#gh-connect");
const ghErr = $("#gh-err");
const sendBtn = $<HTMLButtonElement>("#send");
const labelsBox = $<HTMLFieldSetElement>("#labels");
const chips = $("#chips");
const sendProblem = $("#send-problem");
const sendProblemText = $("#send-problem-text");
let opener: HTMLElement | null = null;
let checking = false;

/** The header button, the line under Send, and the connected view in the dialog. */
function renderLink() {
  const c = link.current;
  const name = c ? repoName(c.repo) : "";
  $("#gh-open-label").textContent = c ? name : "Connect GitHub";
  $("#gh-open").setAttribute("aria-label", c ? `GitHub: sending to ${name}` : "Connect GitHub");
  document.body.dataset.github = c ? "on" : "off";
  $("#send-to").textContent = c ? `As an issue in ${name}.` : "Connect a repo of yours first. The idea becomes an issue there.";
  const repoLink = $<HTMLAnchorElement>("#gh-on-repo");
  repoLink.textContent = name;
  repoLink.href = c ? `https://github.com/${name}/issues` : "https://github.com";
  $("#gh-on-keep").textContent = link.remembered
    ? "Your token is remembered on this device until you forget it."
    : "Your token is kept in this tab's memory only, and gone when you close it.";
  renderLabels();
  renderSend();
}

function renderLabels() {
  const list = link.current ? labels ?? [] : [];
  chips.replaceChildren(
    ...list.map((l) => {
      const chip = document.createElement("label");
      chip.className = "chip";
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: l.name, checked: chosen.has(l.name) });
      box.addEventListener("change", () => (box.checked ? chosen.add(l.name) : chosen.delete(l.name)));
      const dot = document.createElement("span");
      dot.className = "chip-dot";
      if (l.color) dot.style.setProperty("--c", l.color);
      const text = document.createElement("span");
      text.textContent = l.name;
      chip.append(box, dot, text);
      return chip;
    }),
  );
  labelsBox.hidden = list.length === 0;
}

function renderSend() {
  const b = sendButton({ online: online(), busy: sending });
  sendBtn.textContent = b.label;
  sendBtn.disabled = b.disabled;
  sendBtn.toggleAttribute("aria-busy", sending);
  ghConnect.textContent = checking ? "Checking…" : online() ? "Connect" : "Waiting for a connection…";
  ghConnect.disabled = checking || !online();
}

function showSendProblem(p: GitHubProblem) {
  sendProblem.hidden = false;
  sendProblemText.textContent = `${p.message} Your text is still here.`;
  $("#send-reconnect").hidden = !p.reconnect;
}
function hideSendProblem() {
  sendProblem.hidden = true;
  sendProblemText.textContent = "";
}

function setLabels(list: Label[]) {
  const known = new Set(list.map((l) => l.name));
  const kept = [...chosen].filter((n) => known.has(n));
  labels = list;
  // `idea` at first; after that, whatever was chosen last time, as long as the repo still has it.
  chosen = new Set(kept.length || chosen.size ? kept : preselected(list));
  renderLabels();
}

/** A remembered connection reads the repo's labels when the first idea is ready to review. */
async function loadLabels() {
  const c = link.current;
  if (!c) return;
  const r = await connect((...a) => fetch(...a), c.repo, c.token, { online });
  if (link.current !== c) return;
  if (r.ok) {
    setLabels(r.labels);
  } else if (state === "review") showSendProblem(r.problem);
}

function openGitHub(mode: "form" | "on" = link.current ? "on" : "form") {
  opener = document.activeElement as HTMLElement | null;
  ghDialog.dataset.mode = mode;
  ghDialog.setAttribute("aria-labelledby", mode === "on" ? "gh-on-h" : "gh-h");
  if (mode === "form") {
    if (link.current && !ghRepo.value) ghRepo.value = repoName(link.current.repo);
    ghRemember.checked = link.remembered;
    renderKeep();
  }
  renderLink();
  if (!ghDialog.open) ghDialog.showModal();
  (mode === "on" ? $("#gh-done") : ghRepo.value ? ghToken : ghRepo).focus();
}

function closeGitHub() {
  ghDialog.close();
}
ghDialog.addEventListener("close", () => {
  for (const id of ["#gh-repo-err", "#gh-token-err", "#gh-err", "#gh-note"]) $(id).textContent = "";
  ghToken.value = "";
  // Back where the visitor was, or on Send once they've connected from it.
  const back = opener?.isConnected && !opener.closest("dialog") && getComputedStyle(opener).display !== "none" ? opener : null;
  back?.focus();
});

const renderKeep = () => {
  $("#gh-keep").textContent = ghRemember.checked
    ? "Kept in this browser's storage on this device until you press Forget token. Anyone using this device could use it."
    : "Kept in this tab's memory only, and gone when you close it.";
};
ghRemember.addEventListener("change", renderKeep);
// A field's own error goes as soon as it's edited.
for (const [field, err] of [[ghRepo, "#gh-repo-err"], [ghToken, "#gh-token-err"]] as const) {
  field.addEventListener("input", () => {
    $(err).textContent = "";
    field.removeAttribute("aria-invalid");
  });
}

ghForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (checking || !online()) return;
  const repo = parseRepo(ghRepo.value);
  const tokenErr = tokenProblem(ghToken.value);
  $("#gh-repo-err").textContent = repo ? "" : "Enter the repo as owner/name, or paste its github.com link.";
  $("#gh-token-err").textContent = tokenErr ?? "";
  ghErr.textContent = "";
  $("#gh-note").textContent = "";
  ghRepo.setAttribute("aria-invalid", String(!repo));
  ghToken.setAttribute("aria-invalid", String(!!tokenErr));
  if (!repo) return ghRepo.focus();
  if (tokenErr) return ghToken.focus();
  const token = ghToken.value.trim();
  checking = true;
  renderSend();
  const r = await connect((...a) => fetch(...a), repo, token, { online });
  checking = false;
  renderSend();
  if (!r.ok) {
    ghErr.textContent = r.problem.message;
    (r.problem.kind === "token" ? ghToken : r.problem.kind === "missing" ? ghRepo : ghConnect).focus();
    return;
  }
  const changed = !link.current || repoName(link.current.repo) !== repoName(r.repo);
  link.set({ repo: r.repo, token }, ghRemember.checked);
  if (changed) chosen = new Set();
  setLabels(r.labels);
  ghRepo.value = repoName(r.repo);
  hideSendProblem();
  renderLink();
  if (state === "review") opener = sendBtn;
  closeGitHub();
  say(`Connected to ${repoName(r.repo)}. Ideas you send become issues there.`);
});

$("#gh-cancel").addEventListener("click", closeGitHub);
$("#gh-done").addEventListener("click", closeGitHub);
$("#gh-open").addEventListener("click", () => openGitHub());
$("#send-reconnect").addEventListener("click", () => openGitHub("form"));

// Forget token: out of this tab's memory and off this device, in one click.
$("#gh-forget").addEventListener("click", () => {
  link.forget();
  labels = null;
  chosen = new Set();
  ghToken.value = "";
  hideSendProblem();
  openGitHub("form");
  ghErr.textContent = "";
  $("#gh-note").textContent = "Token forgotten. It's gone from this tab and this device.";
});

sendBtn.addEventListener("click", async () => {
  const c = link.current;
  if (!c) return openGitHub("form");
  if (sending || !online()) return;
  const issue = issueFrom(titleIn.value, textIn.value, [...chosen].filter((n) => labels?.some((l) => l.name === n)));
  if (!issue) {
    sendProblem.hidden = false;
    sendProblemText.textContent = "There's nothing to send yet. Say or type your idea first.";
    $("#send-reconnect").hidden = true;
    return;
  }
  hideSendProblem();
  sending = true;
  renderSend();
  say("Sending to GitHub");
  const r = await send((...a) => fetch(...a), c.repo, c.token, issue, { online });
  sending = false;
  renderSend();
  if (!r.ok) {
    showSendProblem(r.problem);
    return;
  }
  track("idea_sent");
  const a = $<HTMLAnchorElement>("#sent-link");
  a.href = r.url;
  a.textContent = r.number ? `issue #${r.number} in ${repoName(c.repo)}` : `an issue in ${repoName(c.repo)}`;
  setState("sent");
  say(`Sent to GitHub as ${a.textContent}`);
  $("#next").focus();
});

// Sending waits while the browser is offline, and the button comes back by itself with the connection.
addEventListener("online", renderSend);
addEventListener("offline", renderSend);
renderLink();

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
const likes = new Likes({
  fetch: (...a) => fetch(...a),
  storage: localStore,
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
  interface Window { __sayfold?: { state(): State; backend(): Backend | null; seconds(): number | null; modelReady(): boolean; connected(): boolean } }
}
window.__sayfold = {
  state: () => state,
  backend: () => backend,
  seconds: () => last?.seconds ?? null,
  modelReady: () => speech.ready,
  connected: () => link.current !== null,
};
