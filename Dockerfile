# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

# Native-module build deps (better-sqlite3 requires python + make + g++)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

# Copy only production deps from build stage
COPY --from=build /app/node_modules ./node_modules

# Copy application source
COPY . .

# Data volume – SQLite DB and sessions live here
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
