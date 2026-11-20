# syntax=docker/dockerfile:1

# ---- web build ----
FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- server build ----
FROM node:22-slim AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    STATIC_DIR=/app/public \
    PORT=8080
WORKDIR /app
COPY --from=server-build --chown=node:node /app/server/package.json ./package.json
COPY --from=server-build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/server/dist ./dist
COPY --from=web-build --chown=node:node /app/web/dist ./public
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
