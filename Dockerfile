ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY packages/web packages/web
ARG VITE_WC_PROJECT_ID=
ENV VITE_WC_PROJECT_ID=${VITE_WC_PROJECT_ID}
RUN npm run build -w @msa/web && find packages/web/dist -name '*.map' -delete

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @msa/server && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT_API=8787 \
    LOKHUS_BIND=0.0.0.0 \
    LOKHUS_MODE=hosted \
    LOKHUS_TRUST_PROXY=1
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY scripts/reset-login.ts scripts/sqlite-to-postgres.ts scripts/
COPY --from=build /app/packages/web/dist packages/web/dist
RUN ln -sfn ../../packages/core node_modules/@msa/core \
  && mkdir -p data && chown node:node data \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
VOLUME /app/data
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT_API || 8787}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/src/index.ts"]
