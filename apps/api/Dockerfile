# The API needs a process, not a function. See docs/deploy.md — it holds a
# Postgres LISTEN connection, serves SSE for the length of a shift, and keeps
# voice session state in memory across a call. None of that survives a
# serverless invocation.

FROM node:22-slim AS build
WORKDIR /repo

# Manifests first, so a dependency install is cached independently of source.
COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @resqai/api --include-workspace-root

COPY packages/schema packages/schema
COPY apps/api apps/api
RUN npm run build --workspace @resqai/schema \
 && npm run build --workspace @resqai/api

FROM node:22-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
# Production dependencies only. PGlite is a devDependency and is not shipped:
# it exists so the test suite needs no database server.
RUN npm ci --omit=dev --workspace @resqai/api --include-workspace-root \
 && npm cache clean --force

COPY --from=build /repo/packages/schema/dist packages/schema/dist
COPY --from=build /repo/apps/api/dist apps/api/dist

# Not root. A process that only needs to open sockets and read its own code has
# no reason to be able to write to the image.
USER node

EXPOSE 5000

# Liveness only. Readiness is GET /ready, which reports database reachability,
# usable channels and whether live updates are connected — point the platform's
# readiness probe there and read it after a deploy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "apps/api/dist/index.js"]
