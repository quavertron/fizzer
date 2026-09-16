# syntax=docker/dockerfile:1

# Test/build script edits do not change the installed dependency tree.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS dependency-manifests
WORKDIR /manifests
COPY package.json ./
COPY client/package.json ./client/
RUN node -e 'const fs = require("fs"); for (const file of ["package.json", "client/package.json"]) { const manifest = JSON.parse(fs.readFileSync(file)); delete manifest.scripts; fs.writeFileSync(file, JSON.stringify(manifest)); }'

# Client bundle: isolated install keeps Electron and Playwright out of the server image.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS client-build
WORKDIR /client
COPY --from=dependency-manifests /manifests/client/package.json ./
COPY client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY client/ ./
COPY docs/user-guide.md /docs/user-guide.md
RUN npm run build

# The native QMD semantic worker remains a supervised specialization beneath
# the Elixir service. Keep its exact pinned production dependency tree.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS qmd-deps
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /app
COPY --from=dependency-manifests /manifests/package.json ./
COPY --from=dependency-manifests /manifests/client/package.json ./client/
COPY package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Compile an OTP release with ERTS included so the runtime image does not need
# Mix, Hex, source code, or a host Elixir installation.
FROM elixir:1.20.2-slim@sha256:e500da1777164f9be05f7ffc0fe06cdb692f453bf7d651755e72310ec8a92eed AS elixir-build
ARG TARGETARCH
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git
ENV MIX_ENV=prod \
    ERL_FLAGS="+JMsingle true"
WORKDIR /build/backend_elixir
RUN mix local.hex --force && mix local.rebar --force
COPY backend_elixir/mix.exs backend_elixir/mix.lock ./
RUN --mount=type=cache,id=cascade-elixir-build-1.20.2-${TARGETARCH},target=/build/backend_elixir/_build,sharing=locked \
    --mount=type=cache,target=/root/.hex \
    --mount=type=cache,target=/root/.cache/rebar3 \
    mix deps.get --only prod && mix deps.compile
COPY backend_elixir/ ./
RUN --mount=type=cache,id=cascade-elixir-build-1.20.2-${TARGETARCH},target=/build/backend_elixir/_build,sharing=locked \
    mix compile --warnings-as-errors && \
    rm -rf _build/prod/rel/cascade_elixir && mix release && \
    rm -rf /build/release-artifact && \
    cp -a _build/prod/rel/cascade_elixir /build/release-artifact

FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS runner
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 libssl3 libncurses6 lksctp-tools

WORKDIR /app
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CASCADE_NETWORK_MODE=1 \
    CASCADE_NODE_ROOT=/app \
    CASCADE_CLIENT_DIST_DIR=/app/client/dist \
    CASCADE_VAULTS_BASE_DIR=/data/.cascade/vaults \
    CASCADE_QMD_DIR=/data/.cascade/qmd \
    HOME=/data \
    RELEASE_DISTRIBUTION=none

COPY --chown=node:node --from=qmd-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=elixir-build /build/release-artifact ./release
COPY --chown=node:node --from=client-build /client/dist ./client/dist
COPY --chown=node:node scripts/check-elixir-data-compat.mjs ./scripts/check-elixir-data-compat.mjs
COPY --chown=node:node loadtest_elixir ./loadtest_elixir
COPY --chown=node:node deploy/preflight-client.mjs ./deploy/preflight-client.mjs
COPY --chown=node:node deploy/authenticated-live-smoke.mjs ./deploy/authenticated-live-smoke.mjs
COPY --chown=node:node deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --chown=node:node package.json package-lock.json ./

USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["start"]

# Revision metadata must not invalidate dependency and artifact layers.
ARG CASCADE_REVISION=uncommitted
LABEL org.opencontainers.image.revision="${CASCADE_REVISION}" \
      io.cascade.backend="elixir" \
      io.cascade.release-policy="verify-then-promote"
