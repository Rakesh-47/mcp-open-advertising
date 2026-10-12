# Multi-stage Dockerfile for Cesteral MCP servers
# Build with: docker build --build-arg SERVER_NAME=dbm-mcp -t dbm-mcp .

# Pinned by digest for reproducible builds and supply-chain integrity. The bare
# `node:20-alpine` tag floats, so identical source could otherwise resolve to
# different OS packages on each rebuild. Digest is the multi-arch index for
# node:20-alpine; bump it deliberately when refreshing the base. Both the build
# stages and the runtime stage start from it.
#
# Checked 2026-10-12: this is still the newest node:20-alpine. Node 20 reached
# end of life on 2026-04-30 and the tag has not been rebuilt since 2026-04-15
# (Alpine 3.23.4, OpenSSL 3.5.6-r0), so no newer digest exists to move to. The
# runtime stage therefore takes the Alpine 3.23 security updates itself (see
# below). Moving to a supported Node line (CI already tests on 22) is the
# lasting fix.
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@10.34.1
WORKDIR /app

# Fetch every dependency into the pnpm store from the lockfile alone. `pnpm
# fetch` needs no package.json, so this stage lists no packages: adding a server
# needs no Dockerfile change, and the layer is cached until the lockfile changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Link the workspace from the fetched store (offline, still frozen to the
# lockfile), build all packages, then deploy a production-only bundle for the
# target server. `pnpm deploy` bundles workspace deps into a self-contained dir.
# pnpm 10 requires inject-workspace-packages for `deploy`; we pass it as a
# per-command config (not repo-wide .npmrc) so the install and local/CI
# installs are unaffected — only this deploy injects.
FROM deps AS builder
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm run build
# Declared after the build on purpose: every layer above is then identical for
# all servers, so one fleet build compiles the monorepo once and the other
# images reuse the cached layer.
ARG SERVER_NAME
RUN pnpm --filter "@cesteral/${SERVER_NAME}" --config.inject-workspace-packages=true deploy --prod /app/deploy

# Production image for specific server. Built from the node image, not from
# `base`: the server runs `node dist/index.js` and nothing else, so the runtime
# carries no package manager. `base` adds a global pnpm, and the node image
# ships npm, npx, corepack and yarn; each brings a dependency tree that the
# image scan in cloudbuild.yaml (Trivy, HIGH/CRITICAL, blocking) reports and
# that the server never loads.
#
# `apk upgrade` applies the Alpine 3.23 branch's fixes that the frozen node:20
# base lacks (on 2026-10-12: OpenSSL 3.5.6-r0 -> 3.5.9-r0, for CVE-2026-45447
# and CVE-2026-14456). A stable branch only takes security and bug fixes, but
# this does make the OS packages depend on build day, not on the digest alone.
FROM ${NODE_IMAGE} AS runner
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ARG SERVER_NAME
ENV NODE_ENV=production
ENV SERVER_NAME=${SERVER_NAME}

# pnpm deploy produces a self-contained directory:
#   node_modules/  — production deps only, workspace packages copied as files
#   dist/          — compiled server code
#   package.json
COPY --from=builder /app/deploy ./

# Expose port (will be overridden by Cloud Run)
EXPOSE 8080

# Health check for local dev and non-Cloud-Run deployments
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:8080/health || exit 1

# Run as non-root user for security
USER node

# Start the server
CMD ["node", "dist/index.js"]
