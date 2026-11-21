// Sayfold's Worker (wrangler.jsonc `main`). It serves the page's static files from dist/ as before, and
// /api/listen for live dictation (src/server/listen.ts), with the day's counter in one SQLite-backed
// Durable Object (src/server/meter.ts). Type-checked with the Workers types (src/server/tsconfig.json).
import { DurableObject } from "cloudflare:workers";
import { handle, type MeterApi, type Socket, type SpeechAi } from "./listen.ts";
import { MeterCore, sweepAndSchedule } from "./meter.ts";

interface Env {
  AI: Ai;
  METER: DurableObjectNamespace<Meter>;
  ASSETS: Fetcher;
}

/** The one counter for the whole site, called over RPC. */
export class Meter extends DurableObject<Env> {
  #core: MeterCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new MeterCore(ctx.storage.sql);
    // Earlier days' salts and counts go at midnight UTC even when nobody records: the alarm, set here on
    // the first start and again each time it runs, deletes them and sets the next one.
    void ctx.blockConcurrencyWhile(() => sweepAndSchedule(this.#core, ctx.storage));
  }
  alarm() {
    return sweepAndSchedule(this.#core, this.ctx.storage);
  }
  status(ip: string) {
    return this.#core.status(ip);
  }
  open(ip: string) {
    return this.#core.open(ip);
  }
  add(session: string, seconds: number) {
    return this.#core.add(session, seconds);
  }
  close(session: string) {
    this.#core.close(session);
  }
  exhausted() {
    this.#core.exhausted();
  }
}

export default {
  fetch(request, env, ctx) {
    return handle(request, {
      ai: env.AI as unknown as SpeechAi,
      meter: env.METER.get(env.METER.idFromName("sayfold")) as unknown as MeterApi,
      assets: env.ASSETS,
      pair: () => Object.values(new WebSocketPair()) as unknown as [Socket, Socket],
      upgrade: (client) => new Response(null, { status: 101, webSocket: client as unknown as WebSocket }),
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
} satisfies ExportedHandler<Env>;
