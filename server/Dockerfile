# demowright render service — container image for Google Cloud Run.
#
# Base on Microsoft's official Playwright image: it already ships chromium and
# every system library chromium needs. Do NOT roll your own node:slim + apt-get
# install of chromium deps, and do NOT `npx playwright install` here — the
# browser is already baked in for THIS image's Playwright version.
#
# IMPORTANT — pin this tag to the Playwright version your repo resolves to.
# The repo declares "playwright": "^1.45.0" but the installed/locked version is
# 1.61.0 (see package-lock.json). The base image tag MUST match the Playwright
# npm version, or chromium.launch() fails at the first real render with
# "Executable doesn't exist at /ms-playwright/...". If you bump Playwright,
# bump this tag in lockstep.
#
# ffmpeg is NOT installed via apt — it comes from the bundled ffmpeg-static npm
# dependency (a direct dep of the demowright package, used in src/render.js).
#
# --platform=linux/amd64 is REQUIRED: Cloud Run runs amd64 only, and
# ffmpeg-static resolves a per-arch binary at npm-install time. On Apple Silicon
# you must cross-build (this pin forces it); building arm64 yields an image that
# won't run on Cloud Run / ENOEXECs ffmpeg mid-render.
FROM --platform=linux/amd64 mcr.microsoft.com/playwright:v1.61.0-jammy

ENV NODE_ENV=production
# Cloud Run injects PORT; this is only a local-run default. The server reads
# process.env.PORT and binds 0.0.0.0 — never hardcode 8080.
ENV PORT=8080

WORKDIR /app

# --- Install the demowright package (the parent repo) and its runtime deps. ---
# The server imports ../src/index.js, which pulls in playwright + ffmpeg-static.
# Copy the root manifest first for layer caching, then install with the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Install the server's own deps (aws4fetch). ---
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --no-package-lock

# --- App source. Copy only what the service needs at runtime. ---
COPY src ./src
COPY server ./server

# The MS Playwright image provides a non-root 'pwuser'. Drop privileges and make
# the app dir owned by it so /app and the Playwright browser cache are writable.
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8080

CMD ["node", "server/index.js"]
