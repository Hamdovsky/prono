FROM node:20-slim

WORKDIR /app

# Native build deps for better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# CRITICAL: skip Chromium (400MB) and Redis binary downloads
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV REDISMS_DISABLE_POSTINSTALL=true
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV REDISMS_DISABLE_POSTINSTALL=true

# Build frontend only if dist is missing (pre-built dist can be committed)
RUN if [ ! -f dist/index.html ]; then npm run build; fi
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "--max-old-space-size=256", "server.js"]
