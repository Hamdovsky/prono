FROM node:20-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

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
RUN npm ci --only=production

COPY requirements.txt ./
RUN python3 -m venv /opt/venv && \
    . /opt/venv/bin/activate && \
    pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

COPY . .

COPY --from=frontend /app/dist ./dist

EXPOSE 3001

CMD python3 -m uvicorn core.fastapi_server:app --host 0.0.0.0 --port 8000 & \
    node --max-old-space-size=256 server.js
