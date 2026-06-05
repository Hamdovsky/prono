FROM node:20-slim

WORKDIR /app

# Install system dependencies for SQLite (Chromium removed for Render free tier — 512MB limit)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Build frontend
RUN npm run build

# Prune dev deps after build to shrink image
RUN npm prune --omit=dev

# Environment variables
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "--max-old-space-size=256", "server.js"]
