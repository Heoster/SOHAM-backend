# SOHAM in production — industry-readiness guide

This document covers what "industry ready" means for this service and what
exactly exists in the repo vs what your infrastructure must provide. No
hand-waving: load balancing cannot be done inside the application process —
it is an infrastructure concern. What the app *can* do, it does.

---

## 1. Architecture

```
                    ┌─────────────────────────────┐
   Browser / app    │  Cloudflare (DNS + WAF +    │
 ──────────────────▶│  TLS + rate limiting)       │
                    └──────────────┬──────────────┘
                                   │  HTTPS
                    ┌──────────────▼──────────────┐
                    │  Load balancer              │
                    │  (Render / Fly / your LB)   │
                    └──────┬────────┬─────────────┘
                     ┌─────▼──┐ ┌───▼────┐ ┌──────▼─┐
                     │ SOHAM  │ │ SOHAM  │ │ SOHAM  │   stateless nodes
                     │ node 1 │ │ node 2 │ │ node 3 │
                     └──┬──┬──┘ └──┬──┬──┘ └───┬──┬─┘
                        │  │       │  │        │  │
              ┌─────────┘  │       │  └───┬────┘  │
              │   ┌────────┴───┐   │      │       │
        ┌─────▼───▼─┐   ┌──────▼───▼─┐   ┌▼───────▼───┐
        │ Supabase  │   │  Upstash   │   │   AI       │
        │ Postgres  │   │  Vector    │   │  providers │
        │ (memory)  │   │  + Redis   │   │  (Groq…)   │
        └───────────┘   │ (rate-lim/ │   └────────────┘
                        │   RAG)     │
                        └────────────┘
```

Every node is stateless — chat history, memory, and rate-limit counters live
in Supabase/Upstash, not in process memory. That is what makes horizontal
scaling safe. The **only** per-process state was the rate limiter, which now
runs on Upstash Redis when configured (see §4).

## 2. What this repo ships (application layer)

Security & hardening (all active, all verified in CI/smoke tests):

- Security headers on every response (`middleware/security-headers.ts`):
  nosniff, DENY framing, strict referrer policy, permissions-policy, CSP,
  HSTS (production), `Cache-Control: no-store` on dynamic responses
- **Constant-time Bearer comparison** (`utils/auth.ts`) — SHA-256 pre-hash +
  `timingSafeEqual`, used by the API auth middleware and the health report
- **Production fail-fast**: the process refuses to boot when `SOHAM_API_KEY`
  is unset (it used to boot and silently 401 everything)
- **CORS fail-closed in production**: empty `ALLOWED_ORIGINS` in prod → browser
  origins denied (previously it silently allowed every origin)
- Per-IP **rate limiting** with route-tier budgets (chat 20/min, ai 30, image
  10, voice 20, memory 60; 60 elsewhere) — in-memory single-instance, or
  **Upstash Redis sliding window** when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are
  set (shared across all instances; 1.5s timeout, fail-open to in-memory)
- 1 MB body limit (20 MB only for PDF/image/image-generation routes)
- Request timeouts per route tier via `withTimeout` (60/120/…; SSE exempt)
- 405/404 JSON handlers, global error handler that never leaks internals in prod
- Structured JSON logs with request IDs (`X-Request-ID` honored/propagated)
- Graceful shutdown with idle-keep-alive drain (`closeIdleConnections`) +
  15s force-exit backstop
- **Compression** (gzip/deflate) for JSON; SSE excluded
- **Minimal public `/api/health`** — liveness payload only; the full report
  (which credentials are configured, memory, model catalog) requires
  `Authorization: Bearer`. Cheap unauthenticated probes for LBs:
  `/api/health/live` (liveness) and `/api/health/ready` (readiness, 200 only
  when ≥1 model is serviceable)
- zod input validation on tool inputs; output sanitizer for model markup
- `npm audit` clean at high severity (zod v4; `qs` moderate advisory remains
  — transitive via Express, no fix released; body-size caps mitigate)

Delivery & ops:

- `Dockerfile` (multi-stage, non-root `node` user, `dumb-init` for PID 1
  signal handling, built-in `HEALTHCHECK` on `/api/health/live`)
- `.dockerignore`, `docker-compose.yml` (local prod-like run)
- `render.yaml` (Render blueprint): locked `npm ci` build, liveness
  health-check path, optional Upstash Redis keys, commented scaling notes
- CI: typecheck + build + test suites on Node 20

## 3. Load balancing (infrastructure layer — do this on your host)

**Render (your current host).** Render gives every web service a load
balancer, but the **free plan runs a single instance** — there is nothing to
balance across. To get real horizontal scaling:

1. Upgrade to a paid plan and set `numInstances: 2+` (see the commented block
   in `render.yaml`), or attach Render's autoscaling.
2. Before setting `numInstances > 1`:
   - set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (sync: false
     keys already declared in `render.yaml`) — otherwise each instance
     enforces its own rate limit and the effective cap is ×N;
   - set `ALLOWED_ORIGINS` explicitly (production now defaults to deny-all
     browser origins without it).
3. Keep `healthCheckPath: /api/health/live` (already configured) — Render
   will route around instances that fail it.

**In front of Render: Cloudflare (recommended).** Put the domain behind
Cloudflare (proxy on) — you get DNS, edge TLS, HTTP/2-3, WAF rules, bot
management, and optional edge rate limiting (e.g. block >30 req/min per IP on
`/api/*` ahead of your origin limiter). Point `ALLOWED_ORIGINS` at the public
origin you actually serve.

**Any container host (Fly.io, ECS, Cloud Run, Kubernetes).** The included
Dockerfile runs anywhere; put the platform's LB in front, wire the probes:

| Probe | Endpoint | Meaning |
|---|---|---|
| liveness | `GET /api/health/live` | process alive? restart if not |
| readiness | `GET /api/health/ready` | route traffic? 503 ⇒ no models serviceable |
| startup | `GET /api/health/live` | after boot |

Zero-downtime deploys: the platform drains by stopping new connections and
waiting for the process; our shutdown handler stops accepting, drops idle
keep-alive sockets, and exits ≤15s. Behind Render/Cloudflare, in-flight SSE
streams still get cut on deploy — clients should reconnect (exponential
backoff), which the UI spec already covers.

## 4. Rate limiting in detail

- Single instance: in-memory sliding window, LRU-capped at 10k keys — fine.
- Multi instance: set the two `UPSTASH_REDIS_REST_*` vars → limits become
  global (same sliding-window semantics, shared across instances).
- Failure modes: Redis unreachable/slower than 1.5s → that request falls
  back to in-memory (logged as a warning). Availability > strictness; if you
  would rather fail closed, that is a one-line change — ask.
- Upstash Redis speaks REST here; a plain `redis://` URL will NOT work.

## 5. Security checklist (operate-time)

- [ ] `SOHAM_API_KEY` — long random value (`openssl rand -hex 32`), stored in
      Render env, never in git. Rotating it invalidates every client.
- [ ] Supabase **service role** key only on the server; anon key never
      sufficient for admin paths. Enable RLS on every table the app writes.
- [ ] Upstash tokens scoped: Vector token read/write limited to the index;
      Redis token limited to the rate-limit database.
- [ ] `ALLOWED_ORIGINS` — exact origins only (`https://app.yourdomain.com`),
      no `*`.
- [ ] HTTPS only end-to-end (Cloudflare → Render does this). HSTS is already
      set in production.
- [ ] Rotate provider keys (Groq/Google/OpenRouter) on any suspicion of leak;
      they are only read from env.
- [ ] Review Render logs weekly for `Unauthorized request` / `CORS blocked`
      bursts — that's your abuse signal.
- [ ] Keep `npm audit` clean: CI installs via `npm ci`; run `npm audit` on
      every release. Current status: 0 high/critical (see §2).

## 6. Observability

- Every request logs one JSON line: method, path, ip, requestId, latency —
  ship Render logs to your log drain (Datadog/Better Stack/Logtail) with the
  platform's log-stream feature.
- `X-Request-ID` is honored from clients and returned — propagate it from
  your frontend to correlate user reports with server logs.
- `/api/health/ready` status code is the cheapest SLO signal: scrape it;
  alert if 503 for >2 min.
- Not yet built (deliberately): Prometheus `/metrics`, per-route latency
  histograms, OpenTelemetry tracing. See §8.

## 7. Release & rollback checklist

1. CI green (typecheck + build + suites) → Render auto-deploys
   (`autoDeployTrigger: checksPass`).
2. Post-deploy: `curl -s https://<host>/api/health/live` (200) and
   `/api/health/ready` (200 once providers are up); then one authenticated
   end-to-end `/api/chat/stream`.
3. Rollback: Render → previous deploy → "Rollback". All state lives in
   Supabase/Upstash, so code-only rollback is safe.
4. Runbook for incidents: (a) elevated 5xx → check `/api/health/ready` and
   provider keys; (b) 429s legit → consider raising limits or edge limiting;
   (c) provider outage → the fallback chain + stall cooldown (PR #21) handles
   it; (d) suspected abuse → rotate `SOHAM_API_KEY`, tighten
   `ALLOWED_ORIGINS`.

## 8. Honest limits / what remains

- **Load balancing, TLS termination, WAF, autoscaling are infrastructure and
  cannot be shipped inside this repo.** The app is now ready to sit behind
  them; your Render/Cloudflare plan must actually put them there (free tier =
  1 instance; paid = 2+).
- **SSE through some LBs** (buffering proxies) can break token streaming —
  Cloudflare (no buffering on proxied SSE from Render is generally fine) and
  Render itself pass SSE; if you front it yourself, disable response buffering.
- Single shared API key (no per-user auth, no JWT, no OAuth). For multi-user
  SaaS you need real accounts (Supabase Auth) + per-user rate limits keyed on
  user id — not implemented yet.
- No metrics/tracing pipeline and no alerting — logs + readiness only.
- Distributed rate limiter needs Upstash Redis; not configured yet in your
  Render env (keys are declared in `render.yaml` as `sync: false`).
- `qs` moderate advisory is unpatched upstream (Express dependency).
- The Docker image is not slimmed beyond dev-dep pruning (typescript stays
  because it sits in `dependencies`); moving build-only deps to
  `devDependencies` is a safe follow-up.
- I could not build the Dockerfile here (no Docker in this sandbox). It is
  statically reviewed, mirrors the CI build path, and should be built once in
  your CI/registry before relying on it.
