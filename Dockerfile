FROM node:20-slim AS build

WORKDIR /app

# Only native build deps needed (g++/make for better-sqlite3)
RUN apt-get update && apt-get install -y \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Prevent Chromium download (saves ~400MB on free tier)
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install

COPY . .

# Build frontend
RUN npm run build

# Prune dev deps to reduce size
RUN npm prune --omit=dev

# ── Runtime stage ──
FROM node:20-slim

WORKDIR /app

# Runtime only: minimal image (build deps in build stage)
COPY --from=build /app /app

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

EXPOSE 3001

CMD ["node", "--max-old-space-size=256", "server.js"]
