# syntax=docker/dockerfile:1
# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install locked deps (including devDependencies — typescript is needed to build).
COPY package.json package-lock.json ./
# --ignore-scripts: the root postinstall would run `npm run build` before sources exist.
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy sources and compile. `npm run build` = tsc.
COPY tsconfig.json ./
COPY adapters ./adapters
COPY config ./config
COPY core ./core
COPY flows ./flows
COPY image ./image
COPY memory ./memory
COPY middleware ./middleware
COPY routes ./routes
COPY routing ./routing
COPY safety ./safety
COPY tools ./tools
COPY utils ./utils
COPY voice ./voice
COPY server.ts ./server.ts
RUN npm run build && npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080

# dumb-init: proper PID 1 signal handling (SIGTERM → graceful shutdown).
# wget: cheap healthcheck below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as the built-in unprivileged node user.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health/live" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
