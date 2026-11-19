// The page's Content-Security-Policy. vite.config.ts puts it in the built page as a <meta> tag (the dev
// server goes without, as its live reload needs more). Requests may go only to Sayfold itself, to GitHub's
// API (where the visitor's own token sends their idea), and to the lab hub: its like counter and the
// shared analytics script, which sends to PostHog's EU host. Nothing else can be fetched, beaconed or
// loaded as an image, so the token and the text have nowhere else to go.

export const directives = {
  "default-src": ["'self'"],
  // WebAssembly may compile: the speech runtime is WebAssembly, and some browsers give a worker the page's policy.
  "script-src": ["'self'", "'wasm-unsafe-eval'", "https://lab.brightloopapps.com"],
  "connect-src": ["'self'", "https://api.github.com", "https://lab.brightloopapps.com", "https://eu.i.posthog.com"],
  "img-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
} as const satisfies Record<string, readonly string[]>;

export const CSP = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
