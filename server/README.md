# demowright render service — deploy your own in ~5 minutes

A small, **self-hostable** HTTP service that wraps [demowright](../README.md):
`POST` a demo config, it renders the MP4(s) with Playwright + ffmpeg and uploads
them to **your** Cloudflare R2 bucket, then returns the public URL(s).

- **Compute:** Google Cloud Run (scale-to-zero — you pay only while a render runs).
- **Storage + CDN:** Cloudflare R2 (10 GB free, **$0 egress**).
- **Your keys, your box:** voiceover API keys are **bring-your-own**, passed
  per-request and set as env only for that one render — never logged, never
  persisted, never returned.

Target cost: **~$0/month** on the free tiers for personal / light use.

> **Self-host security model.** The demo config is *your own code* on *your own*
> container (single-tenant), so executing it is fine — there's no shared RCE
> surface and the service does **not** sandbox the config. The real risks it
> engineers against are: API-key leakage via logs/responses, cross-request key
> bleed (hence **`--concurrency=1` is mandatory**), an open endpoint (the gate
> fails closed if `SERVICE_API_KEY` is unset), and over-broad cloud credentials
> (use a **bucket-scoped** R2 token).

---

## 0. Prereqs (one time)

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

You'll also need a Cloudflare account with R2 enabled, and Docker installed
locally (build context is the repo root — see §3). No local Docker? build in the
cloud with `gcloud builds submit` (§3) — `gcloud run deploy --source .` does
**not** work here (it can't use `server/Dockerfile`).

---

## 1. Create the R2 bucket + a scoped token (Cloudflare dashboard)

1. **R2 → Create bucket** → name it e.g. `demowright-renders`.
2. **Bucket → Settings → Public access**: enable the **Public Development URL**
   (zero-config, gives you `R2_PUBLIC_BASE_URL`, e.g.
   `https://pub-xxxx.r2.dev`) **or** connect a **custom domain** (prettier
   permanent links, needs a DNS record). For the 5-minute path, use the public
   dev URL. For production traffic, prefer a custom domain — the `r2.dev`
   subdomain is rate-limited and not meant for sustained load.
3. **R2 → Manage R2 API Tokens → Create Account API Token**:
   - Permission: **Object Read & Write**
   - Scope: **this one bucket** (`demowright-renders`) — *not* all buckets,
     *not* the global Cloudflare API key. A leak then exposes one bucket, not
     the account.
   - Copy the **Access Key ID**, **Secret Access Key**, and the **Account ID**.

The S3-compatible endpoint the service signs against is
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. That host is **not** publicly
browsable — public links come from the separate **`R2_PUBLIC_BASE_URL`** above.
Keep the two distinct.

---

## 2. Set your values (edit this block, then paste it into your shell)

Everything below references these `$VARS`, so you only edit them here.

```bash
# --- GCP / Artifact Registry ---
export PROJECT_ID="your-gcp-project"
export REGION="europe-west1"          # pick a region near you / your R2 bucket
export REPO="demowright"              # Artifact Registry repo name
export SERVICE="demowright-render"    # Cloud Run service name
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/demowright-render:latest"

# --- Service gate (generate a strong random secret) ---
export SERVICE_API_KEY="$(openssl rand -hex 32)"   # save this — callers need it

# --- Cloudflare R2 (from section 1) ---
export R2_ACCOUNT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export R2_ACCESS_KEY_ID="xxxxxxxxxxxxxxxxxxxx"
export R2_SECRET_ACCESS_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export R2_BUCKET="demowright-renders"
export R2_PUBLIC_BASE_URL="https://pub-xxxx.r2.dev"   # or https://demos.example.com

# --- Optional: server-default voice keys (callers can omit voiceKeys then) ---
# export OPENAI_API_KEY="sk-..."
# export ELEVENLABS_API_KEY="..."
```

> **Never commit real values.** See [`.env.example`](./.env.example). Pass them
> via `--set-env-vars` (below) or, for hardening, Secret Manager + `--set-secrets`.

---

## 3. Build & push the image to Artifact Registry

> **Build context = repo ROOT** (the Dockerfile copies the parent
> `package.json` + `src/`). Run these from the **repository root**, pointing
> `-f` at `server/Dockerfile`.

```bash
# (idempotent — fine to re-run; ignore the "already exists" error)
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" \
  || true

# auth docker to Artifact Registry (once per machine)
gcloud auth configure-docker "$REGION-docker.pkg.dev"

# build from the repo root, push. --platform=linux/amd64 is REQUIRED on Apple
# Silicon — Cloud Run runs amd64 only and ffmpeg-static is per-arch, so an arm64
# image won't deploy / ENOEXECs ffmpeg mid-render.
docker build --platform=linux/amd64 -f server/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
```

> **No local Docker?** Do **not** use `gcloud run deploy --source .` here — with
> `--source`, Cloud Run only auto-detects `./Dockerfile` at the context root (not
> `server/Dockerfile`) and silently falls back to Buildpacks, which can't add
> chromium/ffmpeg → a broken image. Build in the cloud instead with
> `gcloud builds submit` + a tiny `cloudbuild.yaml` that runs
> `docker build -f server/Dockerfile .`, then deploy with `--image "$IMAGE"` (§4).

---

## 4. Deploy to Cloud Run

```bash
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --execution-environment=gen2 \
  --concurrency=1 \
  --cpu=2 \
  --memory=4Gi \
  --timeout=3600 \
  --min-instances=0 \
  --max-instances=3 \
  --allow-unauthenticated \
  --set-env-vars="SERVICE_API_KEY=$SERVICE_API_KEY,R2_ACCOUNT_ID=$R2_ACCOUNT_ID,R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY,R2_BUCKET=$R2_BUCKET,R2_PUBLIC_BASE_URL=$R2_PUBLIC_BASE_URL"
```

Grab the service URL it prints (or `gcloud run services describe "$SERVICE"
--region "$REGION" --format='value(status.url)'`):

```bash
export SERVICE_URL="https://demowright-render-xxxxxxxx-ew.a.run.app"
```

### Why these flags (don't change them blindly)

| Flag | Value | Why |
|---|---|---|
| `--execution-environment` | `gen2` | needed for the up-to-3600s timeout, better `/tmp` + gVisor/chromium compat |
| `--concurrency` | `1` | **security control, not perf:** one render per container = no cross-request BYO-key bleed. Raising it breaks isolation. |
| `--cpu` / `--memory` | `2` / `4Gi` | chromium headless + the ffmpeg vertical blur-fill need real headroom; `1Gi`/`1cpu` OOMs or stalls mid-render (you still pay for the failed run) |
| `--timeout` | `3600` | gen2 max; a TTS-narrated render can take minutes |
| `--min-instances` | `0` | scale-to-zero — **this is the entire $0 story.** Do *not* set `1` "to fix cold starts"; a warm instance bills CPU/memory 24/7. |
| `--max-instances` | `3` | caps cost / blast radius on a personal project |
| `--allow-unauthenticated` | — | simplest path; the endpoint is still gated by `SERVICE_API_KEY`. For defense-in-depth use `--no-allow-unauthenticated` + Cloud Run IAM instead (see hardening below). |

**Cold start** (~8–25 s on first hit after idle) is expected for a ~1.8 GB
chromium image and is noise next to a multi-minute render. Don't pay to hide it.

**Hardening (optional):** swap `--allow-unauthenticated` for
`--no-allow-unauthenticated` and grant `roles/run.invoker` to specific callers,
and migrate the env secrets to Secret Manager with `--set-secrets` instead of
`--set-env-vars`.

---

## 5. Smoke test

**Health (no auth):**

```bash
curl "$SERVICE_URL/health"
# -> {"ok":true,"version":"0.1.0"}
```

**A real render** (a minimal public-site demo — no auth/voice, so it works on a
fresh deploy with zero edits beyond `$SERVICE_URL` and `$SERVICE_API_KEY`):

```bash
curl -sS "$SERVICE_URL/render" \
  -H "Authorization: Bearer $SERVICE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "demo": {
      "name": "smoke",
      "url": "https://example.com",
      "formats": ["landscape"],
      "steps": [
        { "type": "caption", "text": "demowright render service", "duration": 2200 },
        { "type": "highlight", "selector": "h1", "duration": 1500 },
        { "type": "endcard", "title": "demowright", "subtitle": "demo as code", "duration": 2200 }
      ]
    }
  }' | jq -r '.outputs[].url'
# -> https://pub-xxxx.r2.dev/renders/<id>/landscape.mp4   (open it — that's your video)
```

---

## API contract

### `GET /health`

No auth. Returns `200 { "ok": true, "version": "<server version>" }`. Cheap — it
does not start a browser or touch R2. Used by Cloud Run probes and the smoke
test. (Keep it unauthenticated — gating it breaks startup probes.)

### `POST /render`

**Headers**

- `Authorization: Bearer <SERVICE_API_KEY>` (or `X-Service-Key` / `X-API-Key`)
- `Content-Type: application/json`

**Body**

```jsonc
{
  "demo":    { /* a demowright demo object — same shape as a config file's
                  default export, minus the defineDemo() wrapper. See ../README.md
                  and ../examples/local-demo.config.js */ },
  "formats": ["landscape", "square", "vertical"],   // optional; default ["landscape"]
  "music":   "https://.../track.mp3",               // optional background track (url or path)
  "voiceKeys": {                                    // optional; BYO keys for THIS render
    "OPENAI_API_KEY": "sk-...",
    "ELEVENLABS_API_KEY": "..."
  }
}
```

- `voiceKeys` maps **env-var NAME → value** (not provider → key) because the
  demowright voice providers read `process.env[OPENAI_API_KEY]` /
  `[ELEVENLABS_API_KEY]` *by name*. Only allowlisted names are accepted
  (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY` by default; extend via
  `ALLOWED_KEY_ENVS`). Anything else → `400`.
- **Precedence:** per-request `voiceKeys` > deploy-time env defaults
  (`OPENAI_API_KEY` / `ELEVENLABS_API_KEY` set on the service). A caller who set
  defaults at deploy time can omit `voiceKeys`.

**Success — `200`**

```json
{
  "ok": true,
  "outputs": [
    { "format": "landscape", "url": "https://pub-xxxx.r2.dev/renders/<id>/landscape.mp4", "bytes": 1234567 }
  ],
  "durationMs": 48213
}
```

**Errors** (the body is never echoed back; upstream errors are scrubbed of
key-shaped tokens before they ever hit logs or responses)

| Status | Body | When |
|---|---|---|
| `401` | `{ "ok": false, "error": "unauthorized" }` | missing/wrong `SERVICE_API_KEY` |
| `413` | `{ "ok": false, "error": "payload too large" }` | body over `MAX_BODY_BYTES` |
| `400` | `{ "ok": false, "error": "<validation message>" }` | bad JSON / unknown field / invalid demo |
| `504` | `{ "ok": false, "error": "render timed out" }` | render exceeded `RENDER_TIMEOUT_MS` |
| `500` | `{ "ok": false, "error": "render failed" }` | anything else (never leaks the underlying message) |

---

## Environment variables

| Name | Required | What it is | Example |
|---|---|---|---|
| `SERVICE_API_KEY` | **yes** | Bearer gate for `/render`. **Server refuses to boot if unset** (fail-closed). | `openssl rand -hex 32` |
| `R2_ACCOUNT_ID` | **yes** | Cloudflare account id in the S3 endpoint host | `a1b2c3...` |
| `R2_ACCESS_KEY_ID` | **yes** | Scoped R2 token access key (Object R/W, one bucket) | `…` |
| `R2_SECRET_ACCESS_KEY` | **yes** | The token's secret | `…` |
| `R2_BUCKET` | **yes** | Bucket name | `demowright-renders` |
| `R2_PUBLIC_BASE_URL` | **yes** | Public base for returned links (r2.dev URL or custom domain). **Not** the S3 endpoint. | `https://pub-xxxx.r2.dev` |
| `OPENAI_API_KEY` | no | Server-default OpenAI TTS key (fallback when caller omits `voiceKeys`) | `sk-...` |
| `ELEVENLABS_API_KEY` | no | Server-default ElevenLabs key | `…` |
| `ALLOWED_KEY_ENVS` | no | Comma list of *extra* env names callers may set via `voiceKeys` | `OPENAI_API_KEY,ELEVENLABS_API_KEY` |
| `MAX_BODY_BYTES` | no | Max request body (rejected pre-parse with `413`) | `2000000` (default) |
| `RENDER_TIMEOUT_MS` | no | Render wall-clock cap (keep under Cloud Run's 3600 s) | `3000000` (default) |
| `PORT` | injected | Cloud Run sets this; the server reads it and binds `0.0.0.0`. Never hardcode `8080`. | `8080` |

> **Never commit real keys.** Keep them in `--set-env-vars` / Secret Manager, not
> in the repo. The service never logs, persists, or returns API keys, and the R2
> upload uses only the `R2_*` credentials.

---

## BYO-keys flow (how key isolation works)

1. A request may carry `voiceKeys` (allowlisted env names → values).
2. The server sets those names onto `process.env` **immediately before** the
   render, snapshotting any prior value.
3. `recordDemo` runs; the voice providers read the keys by name.
4. In a `finally` block the server **restores/deletes** the keys and
   **force-removes** the per-request temp dir — on success, error, *and* timeout.

This is safe **only** under `--concurrency=1` (one in-flight render per
container, so no other request can observe the transient env). The server logs
this invariant at startup. **Do not raise concurrency.**

---

## Costs — does it really stay free?

**For personal / light use: yes, $0.** At the default `--cpu=2 --memory=4Gi` the
binding constraint is **GiB-seconds** (you're billed cpu + memory for the full
render duration). Cloud Run's perpetual free tier (~180k vCPU-s + ~360k GiB-s /
month) works out to roughly:

| Avg render length | Free renders / month (≈) |
|---|---|
| ~2 min (typical web demo) | ~750 |
| ~5 min | ~300 |
| ~15 min (long, web-search / TTS) | ~100 |

- **Beyond the free tier it's not $0 — but it's pennies:** ≈ **1–2¢ per 5-min
  render** (`$0.000024`/vCPU-s + `$0.0000025`/GiB-s). e.g. 1,000 × 5-min
  renders/month ≈ **~$12/mo**. Crucially there's **no egress bill** (see R2).
- **Stretch the free tier:** drop to `--memory=2Gi` if your demos don't use the
  vertical blur-fill (≈ doubles the free render count); keep demos short; keep
  `--min-instances=0`.
- **Cloudflare R2:** 10 GB free + **$0 egress** (the lever that beats S3/GCS,
  where egress would dominate). Two caveats: renders **accumulate forever** →
  set an **R2 Object Lifecycle rule** (e.g. delete `renders/` after N days) so
  storage doesn't creep past 10 GB; and for shared/real traffic serve via a
  **custom domain**, not the rate-limited `r2.dev` URL.
- **Artifact Registry:** first 0.5 GB free; one ~1.8 GB image ≈ a few ¢/mo.

**Self-host upshot:** each user runs this on *their own* GCP + CF account, so the
free tier is *theirs* — for the project author it's always $0. (LLM/TTS API spend
is separate and bring-your-own.)

> **Afraid of a surprise bill?** Two hard guardrails: set a **GCP Budget alert**
> (Billing → Budgets — e.g. \$1/mo → email) and deploy with `--max-instances=1`.
> And remember: **nothing bills until you actually `gcloud run deploy` and send
> renders.** The code in this repo — and an un-deployed service — cost **$0**.

---

## Going async (optional, not built)

The MVP is synchronous (`POST /render` runs the render and returns the URL),
which is fine within Cloud Run gen2's 3600 s request timeout. For renders longer
than a comfortable sync window, the upgrade is **Google Cloud Tasks** (free tier:
1M dispatches/mo): `/render` enqueues a job and returns `202 { jobId }`, a worker
hits an internal render endpoint, the client polls or gets a webhook. Cloud Tasks
keeps the $0 story (unlike Cloudflare Queues, which forces the $5/mo Workers Paid
plan). Described here for direction — **not** scaffolded.

> **Why not "all on Cloudflare"?** Workers can't run the native chromium/ffmpeg
> binaries and cap CPU well under a multi-minute render, and Queues/Durable
> Objects would force the paid Workers plan. The cheapest correct split is
> **GCP = compute (Cloud Run), Cloudflare = storage/CDN (R2)**.
