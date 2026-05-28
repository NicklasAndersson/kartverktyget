# syntax=docker/dockerfile:1.7

# =============================================================================
# Stage 1: builder — installerar pnpm-deps och bygger api + web + shared.
# =============================================================================
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# Aktivera pnpm via corepack (versionen plockas från package.json#packageManager)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

# Workspaces-manifest först → bättre Docker-cache
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Installera alla beroenden (devDeps behövs för tsc/vite). Skippa Playwrights
# Chromium-nedladdning under install – browsern installeras i runtime-imagen.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Källkod
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/shared packages/shared

# Bygg shared först (api+web importerar dist), sedan api (tsc) och web (vite)
# @kvg/shared exporterar TS-källa direkt (ingen build-step). Bygg api + web.
RUN pnpm --filter @kvg/api run build \
 && pnpm --filter @kvg/web run build

# Produktionsberoenden för runtime-imagen (api behöver dem; web är statisk)
RUN pnpm deploy --filter @kvg/api --prod /tmp/api-deploy \
 && cp -r apps/api/dist /tmp/api-deploy/dist


# =============================================================================
# Stage 2: runtime — Playwright-image (Chromium + system-deps redan inbakat).
# =============================================================================
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    KVG_STYLES_DIR=/app/web/styles \
    KVG_DATA_DIR=/data

WORKDIR /app

# API-server (dist + node_modules) och byggd web-frontend
COPY --from=builder /tmp/api-deploy /app/api
COPY --from=builder /app/apps/web/dist /app/web/dist
# Stilar finns redan i web/dist/styles via Vite-publika mappen, men vi
# behåller även en separat referens (samma innehåll) för enkelhet.
COPY --from=builder /app/apps/web/public/styles /app/web/styles
# Render-pagens HTML följer med via /app/api/dist/render/page (tsc kopierar inte
# HTML automatiskt; vi tar med originalet från källan).
COPY --from=builder /app/apps/api/src/render/page /app/api/dist/render/page

# Volym för att mounta lokala .pmtiles-filer
VOLUME ["/data"]

EXPOSE 8080

# Hälsokoll: /health-endpointen returnerar { ok: true }
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "/app/api/dist/server.js"]
