// Everything about the live-dictation backend that may need changing, in one place (lab#109).
// Workers AI retires models without much notice, so the model id lives here and nowhere else.
import { BYTES_PER_SECOND } from "../listen/protocol.ts";

/** Workers AI streaming speech to text (Deepgram Flux), over a WebSocket from the AI binding. */
export const SPEECH_MODEL = "@cf/deepgram/flux";
/** Words Flux should expect: the lab's project names, which it otherwise hears as "After steps" or "Ink chime". */
export const KEYTERMS = ["Afterstep", "Inkchime", "Sayfold", "BrightLoop"];

// The day's cap. The account is on Workers AI's free allowance: 10,000 neurons a day, shared by the whole
// account, and refused (never billed) past that. Sayfold stops a little before, and the page uses the
// in-browser model until midnight UTC. Neurons are estimated from the seconds of audio streamed.

/** Flux's price per minute of audio, in US dollars (Workers AI pricing, 20 Nov 2026). */
export const FLUX_USD_PER_MINUTE = 0.0077;
/** What 1,000 neurons cost, in US dollars. */
export const USD_PER_1000_NEURONS = 0.011;
/** About 11.7 neurons a second, so about 700 a minute. */
export const NEURONS_PER_AUDIO_SECOND = (FLUX_USD_PER_MINUTE / 60 / USD_PER_1000_NEURONS) * 1000;
/** The estimate at which the server stops taking audio for the rest of the UTC day. */
export const DAILY_NEURON_CAP = 9000;

// Per visitor, by a salted hash of the IP address and the day only (the salt is new every UTC day).

/** Recordings a visitor may have open at once. */
export const VISITOR_OPEN_SESSIONS = 1;
/** Seconds of audio a visitor may stream in a UTC day. */
export const VISITOR_SECONDS_PER_DAY = 3 * 60;
/** The longest one recording may be, in seconds of audio and in time connected. */
export const SESSION_MAX_SECONDS = 2 * 60;

/** How often a recording reports its audio to the counter, in seconds of audio. */
export const REPORT_EVERY_SECONDS = 1;
/** The largest audio frame taken: one second. The page sends much smaller ones. */
export const MAX_FRAME_BYTES = BYTES_PER_SECOND;
/** After the last audio, how long to wait for Flux's final words before closing. */
export const DRAIN_MS = 3000;
/** An open recording that hasn't reported for this long is taken as gone (its Worker stopped without saying). */
export const STALE_SESSION_MS = (SESSION_MAX_SECONDS + 60) * 1000;

/** Pages that may open the WebSocket: Sayfold's launch and preview addresses, and local development. */
export const ORIGINS = ["https://sayfold.brightloopapps.com", "https://sayfold.erko-erka1.workers.dev"];
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
