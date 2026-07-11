FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip build-essential curl \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && python3 -m pip install --no-cache-dir --break-system-packages \
       xgboost optuna scikit-learn numpy pandas scipy joblib requests beautifulsoup4 lxml \
    && python3 -c "import xgboost, sklearn; print('ML stack OK')" \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

COPY . .
RUN npm run build

RUN mkdir -p /app/logs /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/core:/app

EXPOSE 8080

STOPSIGNAL SIGTERM

CMD ["node", "--expose-gc", "--max-old-space-size=512", "server.js"]
