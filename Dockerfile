FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV REDISMS_DISABLE_POSTINSTALL=true
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps

COPY requirements.txt ./
RUN python3 -m venv /opt/venv && \
    . /opt/venv/bin/activate && \
    pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

COPY . .

EXPOSE 8000

# FastAPI inference only — the Node/Express server runs in its own service
# (Dockerfile.production). Starting `node server.js` here duplicated every
# cron job across two Render instances. No frontend build needed (FastAPI
# serves no static assets).
CMD python3 -m uvicorn core.fastapi_server:app --host 0.0.0.0 --port 8000
