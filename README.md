# Sayfold

**Say an idea, get it as text, send it to your repo.** Press record, say it, review it as text you can edit, and send it to your own GitHub repo as an issue. The speech is turned into text in your browser, so your voice never leaves your device, and the text goes straight from your browser to GitHub with your own token. Sayfold has no server.

It's a voice-to-idea inbox (lab#80): GitHub is the API, so the issues are there for you, or for agents, to pick up.

Sayfold understands English. Its speech model is English only, and garbles other languages, so for now it doesn't offer any.

## How it works

1. **Record.** Press the big button, or **Space** on a computer (the page says so where there's a keyboard). A live waveform and a clock show it's listening. A recording stops on its own at 2 minutes.
2. **Speech to text.** The first time you record, Sayfold loads its speech model (about 28 MB) and the speech runtime (about 15 to 17 MB) from this site, with a progress bar, while you talk. The model is kept in your browser's cache storage, so later visits start straight away. It runs in a Web Worker, so the page stays responsive: on WebGPU where the browser has it, otherwise on the CPU with WebAssembly. Sayfold finds where you're speaking, leaves out long silences, and gives the model parts of at most 10 seconds, cut in the pauses (see [Long recordings](#long-recordings)).
3. **Review.** If part of the recording may be missing from the text, the page says so above the buttons. The transcript and a title, taken from its first line or sentence, are both editable. The title follows the text until you write your own. **Copy** copies the title, a blank line and the text (just once when the title is the whole text, and it says so when there's nothing to copy). **Record again** starts a new recording.
4. **Send to GitHub.** The first time, **Send to GitHub** (or **Connect GitHub** at the top) asks for:
   - the repo, as `owner/name` or its github.com link;
   - a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for that one repo, with one permission: **Issues: Read and write**. The page says how to make one.

   Sayfold checks with GitHub that the token can see the repo and its issues (`GET /repos/{owner}/{repo}`, then its labels) and says plainly what's wrong if not. The repo's labels then show as chips, with `idea` chosen when the repo has it. **Send to GitHub** creates the issue (`POST /repos/{owner}/{repo}/issues`) with the title, the transcript as its body and the chosen labels, then links to it, with **Record the next idea**. If GitHub says no (a bad token, no access, issues turned off, a rejected issue, its rate limit, or no connection), the page says what's wrong and the text stays. Offline, the button says it's waiting for a connection and comes back by itself.

If the browser refuses the microphone, there's no microphone, another app holds it, or the browser can't record at all, the page says what happened and what to do.

## Long recordings

Moonshine tiny stops early when a clip holds long silences in a noisy room: a part that starts or pauses in quiet can come back empty, and a long part with a few thinking pauses loses its last sentences (lab#95). Up to then, Sayfold cut recordings into parts of up to 20 seconds and joined whatever came back, so on a long take with pauses the end of an idea could vanish without a word. Measured on 4 voices with 1 to 3 second pauses and room noise (15 sentences each), the 20-second parts dropped up to four sentences at the end of a part on some takes, on WebGPU and on the CPU.

So now (`src/core/segments.ts`, `src/core/transcript.ts`):

- **Speech, not silence.** Each 20 ms of audio is compared with the room's own quiet. Long silences before, between and after the speech are left out, apart from 0.2 seconds either side of it. Where speech and room can't be told apart, nothing is left out.
- **Parts of at most 10 seconds.** A pause of a second or more always ends a part. Shorter pauses keep sentences together up to 10 seconds, and speech without a pause is cut in the quietest moment of the last few seconds. Parts never overlap and every bit of speech is in one, so no word is lost or doubled at a cut. Of the settings measured (parts of 6 to 20 seconds, with and without the cut at long pauses, on the same 180 sentences), 10 seconds with the cut kept the most: 179 of 180, the one miss a misheard word, against 177 for the old 20-second parts. The model also had a quarter less audio to work through.
- **A second try.** A part that comes back far too short (fewer than 0.8 words a second of speech, where people say 2 to 3) is tried once more joined to the part before it (or after it, for the first). In a noisy room the model sometimes can't start on a sentence cold, but carries on into it from the one before. The joined text replaces both only when it has more words.
- **Never silently.** If a part is still too short, the review screen says "Part of the recording may be missing. Check the text before sending." The text that did come through is kept.

A short clip is one part, asked once, as before.

## Privacy

- Your recording never leaves your device: it lives only in this tab's memory and is gone when you leave the page. So does the text, until you press **Send to GitHub**.
- **Where the text goes:** only to your own GitHub repo, straight from your browser to GitHub's API (`api.github.com`), when you press Send. Sayfold has no server, and nothing you say or type is stored or sent anywhere else.
- **Where the token goes:** only to `api.github.com`, in the `Authorization` header of those requests. It's kept in this tab's memory, gone when you close it, unless you tick **Remember on this device**: then it's kept in this browser's localStorage (`sayfold:github`, with the repo's name) until you press **Forget token**, which clears it from memory and storage in one click. Use a fine-grained token limited to the one repo, with Issues as its only permission.
- The page's Content-Security-Policy lets it reach only its own address, `https://api.github.com`, and the lab hub's like counter and analytics (`https://lab.brightloopapps.com`, `https://eu.i.posthog.com`). The browser refuses anything else, so the token and the text have nowhere else to go.
- Every file the page needs (the page, the speech model, the speech runtime) comes from Sayfold's own address. The speech library is set up so it never contacts Hugging Face or a CDN.
- What Sayfold keeps in your browser: the speech model, in cache storage, the random receipt for your like if you like it, and your token only if you ask it to remember it. No cookies.
- Sayfold counts page views, recordings started, transcripts finished (with only the recording's length in buckets of seconds, and whether WebGPU or the CPU did the work) and ideas sent (with nothing else at all), through the lab's shared analytics script, with no cookies. What you say, the transcript, the title, the repo, the labels, the token and whether you have one are never sent. On localhost, `*.workers.dev` previews, and with Do Not Track or Global Privacy Control on, the script isn't even loaded. The [privacy note](https://lab.brightloopapps.com/privacy) lists what's counted.
- The heart in the footer likes Sayfold, with the live count from the lab's anonymous like counter. It stays hidden until the count loads and recording never waits for it.

## The speech model

| | |
|---|---|
| Model | [Moonshine tiny](https://huggingface.co/UsefulSensors/moonshine-tiny) by Useful Sensors, English, 27M parameters: a Whisper-class model about the size of Whisper tiny, made for short live speech. |
| Files | The ONNX conversion by onnx-community, [`onnx-community/moonshine-tiny-ONNX`](https://huggingface.co/onnx-community/moonshine-tiny-ONNX/tree/a6da1241cd305dcd64eab1edbd615f2bb9aabb95), pinned to revision `a6da1241cd305dcd64eab1edbd615f2bb9aabb95`, 8-bit quantized: `encoder_model_quantized.onnx` (7.9 MB) and `decoder_model_merged_quantized.onnx` (20.2 MB), plus the tokenizer and config files. |
| Licence | MIT (Moonshine). |
| Where | Committed under `public/models/moonshine-tiny-a6da124/`, with SHA-256 checksums in `src/stt/model.ts` (the `.onnx` ones are Hugging Face's own). The unit tests check every file against them. `node scripts/fetch-model.ts` fetches them again. |

Why not Whisper: Whisper tiny's smallest decoder file is 29 MB, over the 25 MiB limit for one static file on Cloudflare Workers. Moonshine tiny fits in two files well under it.

The speech runtime is [transformers.js](https://github.com/huggingface/transformers.js) 4.3.2 (Apache 2.0) on [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT). Its default WebGPU build has a 27 MB WebAssembly file, so Sayfold gives it a smaller one instead (`src/stt/ort.ts`): the JSPI build (16.8 MB, WebGPU and CPU) where the browser supports WebAssembly JSPI (current Chrome and Edge), and the plain WebAssembly build (14.3 MB, CPU) elsewhere. Both are copied from `node_modules` into the build, and no file the site serves is over 25 MiB.

## How it's built

| Part | What it does |
|---|---|
| `src/core/` | Plain TypeScript, unit-tested: `time.ts` (the clock and the 2-minute cap), `resample.ts` (mono, and a windowed-sinc resampler down to 16 kHz), `segments.ts` (finding speech, cutting it into parts in the pauses, and spotting a part that came back too short), `transcript.ts` (the parts' text in order, with one more try for a part that came back short), `title.ts` (the title from the first line, and what Copy copies), `mic.ts` (microphone problems in plain words), `progress.ts` (one progress bar over every file), `likes.ts` (the like heart), `github.ts` (reading the repo you typed, the requests to GitHub's API with plain `fetch`, its labels, and its answers in plain words), `token.ts` (the token in memory, or on this device when asked, and forgetting it). |
| `src/audio/` | `recorder.ts` (the microphone through an AudioWorklet, plus an AnalyserNode for the waveform) and `capture.worklet.ts` (hands raw samples to the page). |
| `src/stt/` | `worker.ts` (the Web Worker: picks WebGPU or the CPU, loads the model on first use, transcribes), `store.ts` (downloads the model once, checks it and keeps it in cache storage), `config.ts` (keeps the library on Sayfold's own origin), `ort.ts` (the onnxruntime build), `client.ts` (the page's side of the worker). |
| `src/analytics*.ts` | The usage events and their allow-list: `$pageview`, `play_started` when a recording starts, `play_finished` when its transcript is ready, with only `seconds_bucket` and `backend`, and `idea_sent`, with no properties. |
| `src/csp.ts` | The Content-Security-Policy, which `vite.config.ts` puts in the built page as a `<meta>` tag (the dev server goes without it). |
| `index.html`, `src/style.css` | One page, light and dark from the system, no web fonts. The GitHub setup is a native `<dialog>`, and the labels are real checkboxes. |

The page's own code is about 11 KB of JavaScript gzipped. The speech code (about 600 KB before compression, mostly transformers.js) loads only with the first recording.

## Run it

```sh
# needs Node 22.18 or newer (the tests run TypeScript directly)
npm install
npm run dev                         # local dev server
npm test                            # unit tests (node --test)
npm run build                       # typecheck, then build to dist/
```

The playtest records in a real browser with a fake microphone playing `tests/fixtures/idea.wav`, a clip made with macOS `say`, and checks the transcript has the words in it. A second clip, `tests/fixtures/long-idea.wav`, is 48 seconds of fifteen different sentences with thinking pauses (also made with `say`, the command is in `tests/playtest.ts`), played with a room's noise mixed in. GitHub's API is a stand-in inside the playtest (Playwright routes), with a made-up token: it never uses a real token or the live API.

```sh
npx vite preview --port 4173 --strictPort &
node tests/playtest.ts http://localhost:4173
# PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave; falls back to Playwright's Chromium)
# PLAYTEST_OUT      screenshot folder (default: ./playtest-out)
# PLAYTEST_ONLY     run only the checks whose names start with this
# LAB_ANALYTICS_JS  the hub's built shared analytics script (default: ~/brightloop-lab/lab/hub/public/analytics/v1.js)
```

It uses Chromium's fake capture device when the browser can open it. On macOS a headless browser started by an app without microphone permission never gets an answer, even for the fake device, and the playtest then plays the same clip through an in-page stand-in for `getUserMedia` (and says so).

It checks, at 1280 by 900 and 390 by 844: nothing of the model loads before the first recording; Space and the button start and stop a recording, with a running clock and a live waveform; the page says Sayfold understands English; the transcript has the clip's words and a title from its first sentence, with no note that anything is missing; every model and runtime file comes from Sayfold's own origin, once, and none is over 25 MiB; the title follows the text until you change it; Copy (by keyboard) copies the title and text; Record again works without fetching anything; a later visit takes the model from the browser's cache; a browser without WebAssembly JSPI gets the plain WebAssembly runtime and still transcribes the clip, on the CPU; the long recording comes back with every one of its fifteen sentences, on WebGPU and on the CPU; when the worker reports that part may be missing, the review says so, at both sizes, and keeps the text; on a phone the Space hint is hidden, buttons are at least 44 px and nothing scrolls sideways; denied permission, no microphone and an unsupported browser each get their message; with the like API down the heart stays hidden and recording still works; nothing goes to any other origin but the mocked like API; and, under a made-up `*.brightloopapps.com` address with the hub's built script and a stand-in PostHog, a recording sent to GitHub sends exactly `$pageview`, `play_started`, `play_finished` and `idea_sent`, with no words, repo, token or label in any request and no cookies or storage, and nothing at all with Do Not Track on.

For GitHub it checks: the built page carries the Content-Security-Policy, and the browser refuses a fetch or an image anywhere else; by keyboard alone, Send opens the setup, a wrong repo is caught before asking GitHub, a github.com link connects, the labels show with `idea` chosen, another label is ticked, and Send creates the issue with the title, the transcript and both labels, then links to issue #42 and records the next idea; without Remember nothing is stored, and Forget token disconnects; on a phone, a missing repo, a bad token, a token without Issues, GitHub's rate limit and no connection each get their message while connecting, and 401, 403, 404, 410, 422, the rate limit, 502 and no connection each get theirs while sending, with the text kept; offline, Send waits and comes back by itself; Remember keeps the connection for a later visit and Forget token clears memory and storage; the made-up token only ever reaches `api.github.com`; and the phone footer keeps Source and Privacy together, with the like pill centred. Screenshots of each state in light and dark go to `PLAYTEST_OUT`.

Made by [Erik Pahor](https://github.com/MuteMuty) at [BrightLoop Lab](https://lab.brightloopapps.com).
