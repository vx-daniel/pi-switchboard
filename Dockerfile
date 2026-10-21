# syntax=docker/dockerfile:1
#
# pi-switchboard, built from this repository's source (#60). One lockfile pins the proxy, pi and
# every dependency, so the login and the server always run the same pi.
#
# Build: docker build -t pi-switchboard .
# Run:   see compose.yaml and README.md ("Docker").

# Digest-pinned: a rebuild must not change the runtime silently. The digest is the multi-platform
# index (linux/amd64 and linux/arm64, among others). Bump the tag and the digest together.
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# The build output is JavaScript, so it is built once, on the builder's own platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No install scripts: `prepare` installs Git hooks, and no dependency may run code at build.
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm exec vp pack

# Production dependencies are installed on the target platform: some ship per-platform binaries.
FROM ${NODE_IMAGE} AS dependencies
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Source maps, type declarations and TypeScript sources are never executed: about half of the
# dependencies' size on disk (163 MB to 79 MB measured on 2026-10-21), for 10 MB less to pull.
# Markdown stays, as some licenses ship as LICENSE.md. The runtime stage copies node_modules from
# here, so the deleted files never reach the image.
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts && \
    find node_modules/.pnpm -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \) -delete

FROM ${NODE_IMAGE}
# pi keeps its login in PI_CODING_AGENT_DIR, the one writable place (a volume); the proxy reads
# its own proxy-config.json from there too. `pi` is on PATH for the login command.
ENV HOME=/home/node \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_SWITCHBOARD_HOST=0.0.0.0 \
    PI_SWITCHBOARD_PORT=4141 \
    NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
# Owned by root and read-only to the node user: only the volume is the proxy's to write.
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/pi-switchboard-entrypoint
# Docker initializes a new named volume from this directory, ownership included. The node user is
# UID 1000, as in the earlier number-5 images, so their login volumes keep working.
RUN mkdir -p /home/node/.pi/agent && chown -R node:node /home/node/.pi
USER node
EXPOSE 4141
# /healthz is the proxy's unauthenticated liveness check: the process listens and pi's model
# runtime loaded. It does not prove a login exists, so the container is healthy before one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PI_SWITCHBOARD_PORT}/healthz`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["pi-switchboard-entrypoint"]
