# Multi-stage Dockerfile for Cesteral MCP servers
# Build with: docker build --build-arg SERVER_NAME=dbm-mcp -t dbm-mcp .

# Pinned by digest for reproducible builds and supply-chain integrity. The bare
# `node:20-alpine` tag floats, so identical source could otherwise resolve to
# different OS packages on each rebuild. Digest is the multi-arch index for
# node:20-alpine; bump it deliberately when refreshing the base.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
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
ARG SERVER_NAME
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter "@cesteral/${SERVER_NAME}" --config.inject-workspace-packages=true deploy --prod /app/deploy

# Production image for specific server
FROM base AS runner
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
