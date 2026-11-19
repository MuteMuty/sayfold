# Sayfold

**Say an idea, get it as text.** Press record, say it, and review it as text you can edit and copy. The speech is turned into text in your browser, so your voice never leaves your device.

This is the first slice of a voice-to-idea inbox (lab#80). Next comes sending a reviewed idea to your own GitHub repo as an issue, straight from your browser with your own token. Until then, **Copy** puts the title and text on your clipboard.

## How it works

1. **Record.** Press the big button, or **Space** on a computer (the page says so where there's a keyboard). A live waveform and a clock show it's listening. A recording stops on its own at 2 minutes.
2. **Speech to text.** The first time you record, Sayfold loads its speech model (about 28 MB) and the speech runtime (about 15 to 17 MB) from this site, with a progress bar, while you talk. The model is kept in your browser's cache storage, so later visits start straight away. It runs in a Web Worker, so the page stays responsive: on WebGPU where the browser has it, otherwise on the CPU with WebAssembly. Long recordings are cut into parts of at most 20 seconds, in the pauses between words.
3. **Review.** The transcript and a title, taken from its first line or sentence, are both editable. The title follows the text until you write your own. **Copy** copies the title, a blank line and the text. **Record again** starts a new recording.

If the browser refuses the microphone, there's no microphone, another app holds it, or the browser can't record at all, the page says what happened and what to do.

## Privacy

- Your recording and its text live only in this tab's memory. Nothing you say or type is stored or sent anywhere, and both are gone when you leave the page.
- Every file the page needs (the page, the speech model, the speech runtime) comes from Sayfold's own address. The speech library is set up so it never contacts Hugging Face or a CDN.
- The only thing Sayfold keeps in your browser is the speech model, in cache storage, plus the random receipt for your like if you like it. No cookies.
- Sayfold counts page views, recordings started, and transcripts finished (with only the recording's length in buckets of seconds, and whether WebGPU or the CPU did the work), through the lab's shared analytics script, with no cookies. What you say, the transcript and the title are never sent. On localhost, `*.workers.dev` previews, and with Do Not Track or Global Privacy Control on, the script isn't even loaded. The [privacy note](https://lab.brightloopapps.com/privacy) lists what's counted.
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
| `src/core/` | Plain TypeScript, unit-tested: `time.ts` (the clock and the 2-minute cap), `resample.ts` (mono, and a windowed-sinc resampler down to 16 kHz), `segments.ts` (cutting long recordings in pauses), `title.ts` (the title from the first line, and what Copy copies), `mic.ts` (microphone problems in plain words), `progress.ts` (one progress bar over every file), `likes.ts` (the like heart). |
| `src/audio/` | `recorder.ts` (the microphone through an AudioWorklet, plus an AnalyserNode for the waveform) and `capture.worklet.ts` (hands raw samples to the page). |
| `src/stt/` | `worker.ts` (the Web Worker: picks WebGPU or the CPU, loads the model on first use, transcribes), `store.ts` (downloads the model once, checks it and keeps it in cache storage), `config.ts` (keeps the library on Sayfold's own origin), `ort.ts` (the onnxruntime build), `client.ts` (the page's side of the worker). |
| `src/analytics*.ts` | The usage events and their allow-list: `$pageview`, `play_started` when a recording starts and `play_finished` when its transcript is ready, with only `seconds_bucket` and `backend`. |
| `index.html`, `src/style.css` | One page, light and dark from the system, no web fonts. |

The page's own code is about 7 KB of JavaScript gzipped. The speech code (about 600 KB before compression, mostly transformers.js) loads only with the first recording.

## Run it

```sh
# needs Node 22.18 or newer (the tests run TypeScript directly)
npm install
npm run dev                         # local dev server
npm test                            # unit tests (node --test)
npm run build                       # typecheck, then build to dist/
```

The playtest records in a real browser with a fake microphone playing `tests/fixtures/idea.wav`, a clip made with macOS `say`, and checks the transcript has the words in it:

```sh
npx vite preview --port 4173 --strictPort &
node tests/playtest.ts http://localhost:4173
# PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave; falls back to Playwright's Chromium)
# PLAYTEST_OUT      screenshot folder (default: ./playtest-out)
# PLAYTEST_ONLY     run only the checks whose names start with this
# LAB_ANALYTICS_JS  the hub's built shared analytics script (default: ~/brightloop-lab/lab/hub/public/analytics/v1.js)
```

It uses Chromium's fake capture device when the browser can open it. On macOS a headless browser started by an app without microphone permission never gets an answer, even for the fake device, and the playtest then plays the same clip through an in-page stand-in for `getUserMedia` (and says so).

It checks, at 1280 by 900 and 390 by 844: nothing of the model loads before the first recording; Space and the button start and stop a recording, with a running clock and a live waveform; the transcript has the clip's words and a title from its first sentence; every model and runtime file comes from Sayfold's own origin, once, and none is over 25 MiB; the title follows the text until you change it; Copy (by keyboard) copies the title and text; Record again works without fetching anything; a later visit takes the model from the browser's cache; a browser without WebAssembly JSPI gets the plain WebAssembly runtime and still transcribes the clip, on the CPU; on a phone the Space hint is hidden, buttons are at least 44 px and nothing scrolls sideways; denied permission, no microphone and an unsupported browser each get their message; with the like API down the heart stays hidden and recording still works; nothing goes to any other origin but the mocked like API; and, under a made-up `*.brightloopapps.com` address with the hub's built script and a stand-in PostHog, a recording sends exactly `$pageview`, `play_started` and `play_finished` with no words in any request and no cookies or storage, and nothing at all with Do Not Track on. Screenshots of each state in light and dark go to `PLAYTEST_OUT`.

Made by [Erik Pahor](https://github.com/MuteMuty) at [BrightLoop Lab](https://lab.brightloopapps.com).
