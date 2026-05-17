FROM node:20-slim

WORKDIR /app

# Install system dependencies for Puppeteer and SQLite
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Environment variables
ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 3001

CMD ["node", "--max-old-space-size=2048", "server.js"]
