# ---- dependencies (better-sqlite3 is a native module) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---- final image ----
FROM node:22-alpine
WORKDIR /app

LABEL org.opencontainers.image.title="stackmoor" \
      org.opencontainers.image.description="Simple web UI for Docker Compose stacks" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Docker CLI and compose plugin (static binaries from the official image).
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# restic for backups (static binary from the official image).
COPY --from=restic/restic:0.19.1 /usr/bin/restic /usr/local/bin/restic

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Version shown in the panel; set by CI from the git tag (e.g. 0.1.1) or "edge".
ARG VERSION=dev
ENV APP_VERSION=${VERSION}

ENV NODE_ENV=production \
    PORT=5001 \
    DATA_DIR=/app/data \
    STACKS_DIR=/opt/stacks

EXPOSE 5001
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:5001/api/state >/dev/null || exit 1

CMD ["node", "src/server.js"]
