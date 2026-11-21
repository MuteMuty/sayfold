// Everything about the live-dictation backend that may need changing, in one place (lab#109).
// Workers AI retires models without much notice, so the model id lives here and nowhere else.
import { BYTES_PER_SECOND } from "../listen/protocol.ts";

/** Workers AI streaming speech to text (Deepgram Flux), over a WebSocket from the AI binding. */
export const SPEECH_MODEL = "@cf/deepgram/flux";
/** Words Flux should expect: the lab's project names, which it otherwise hears as "After steps" or "Ink chime". */
export const KEYTERMS = ["Afterstep", "Inkchime", "Sayfold", "BrightLoop"];
/**
 * Opts every request out of Deepgram's Model Improvement Program (Flux's `mip_opt_out`, false by default),
 * so what a visitor says is never used for training. Deepgram then keeps it only while processing it.
 */
export const MIP_OPT_OUT = true;

// The day's cap. The account is on Workers AI's free allowance: 10,000 neurons a day, shared by the whole
// account, and refused (never billed) past that. Sayfold stops a little before, and the page uses the
// in-browser model until midnight UTC. Neurons are estimated from each recording's seconds of audio or of
// time connected, whichever is more, so a recording that holds Flux without talking still counts.
//
// Opting out of the Model Improvement Program doesn't change the estimate: Workers AI lists one Flux price,
// and neither its docs nor Deepgram's give another for opted-out requests (checked 21 Nov 2026). If Workers
// AI ever counts more than this, it refuses at the account's 10,000, and QUOTA_REFUSAL closes the day.

/** Flux's price per minute of audio, in US dollars (Workers AI pricing, 20 Nov 2026: 700 neurons a minute). */
export const FLUX_USD_PER_MINUTE = 0.0077;
/** What 1,000 neurons cost, in US dollars. */
export const USD_PER_1000_NEURONS = 0.011;
/** About 11.7 neurons a second, so about 700 a minute. */
export const NEURONS_PER_AUDIO_SECOND = (FLUX_USD_PER_MINUTE / 60 / USD_PER_1000_NEURONS) * 1000;
/** The estimate at which the server stops taking audio for the rest of the UTC day. */
export const DAILY_NEURON_CAP = 9000;
/**
 * Workers AI's refusal once the account's free allocation for the day is used up, which other projects on
 * the account can do before Sayfold's own estimate gets there. Its errors page gives it as code 3036, "You
 * have used up your daily free allocation of 10,000 neurons". It closes the day as the cap does. Any other
 * error (3040 "Capacity temporarily exceeded", say) falls back for that recording only.
 */
export const QUOTA_REFUSAL = /\b3036\b|daily free allocation/i;

// Per visitor, by a salted hash of the IP address and the day only (the salt is new every UTC day).

/** Recordings a visitor may have open at once. */
export const VISITOR_OPEN_SESSIONS = 1;
/** Seconds a visitor may stream in a UTC day (audio or time connected, whichever is more). */
export const VISITOR_SECONDS_PER_DAY = 3 * 60;
/** The longest one recording may be, in seconds of audio and in time connected. */
export const SESSION_MAX_SECONDS = 2 * 60;

/** How often a recording reports to the counter, in seconds (of audio, or of time connected). */
export const REPORT_EVERY_SECONDS = 1;
/** The largest audio frame taken: one second. The page sends much smaller ones. */
export const MAX_FRAME_BYTES = BYTES_PER_SECOND;
/** A recording that sends no audio for this long is closed (`idle`): the page streams its microphone, silence included. */
export const IDLE_SECONDS = 10;
/** After the last audio, how long to wait for Flux's final words before closing. */
export const DRAIN_MS = 3000;
/** An open recording that hasn't reported for this long is taken as gone (its Worker stopped without saying). */
export const STALE_SESSION_MS = (SESSION_MAX_SECONDS + 60) * 1000;

/** Pages that may open the WebSocket: Sayfold's launch and preview addresses, and local development. */
export const ORIGINS = ["https://sayfold.brightloopapps.com", "https://sayfold.erko-erka1.workers.dev"];
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
