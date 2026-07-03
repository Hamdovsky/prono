FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements-fastapi.txt ./
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements-fastapi.txt 2>&1 || \
    (echo "=== First pip failed, retrying without version pins ===" && \
     sed -i 's/==.*//' requirements-fastapi.txt && \
     pip install --no-cache-dir -r requirements-fastapi.txt)

COPY core/ /app/core/
COPY inference/ /app/inference/
COPY scripts/ /app/scripts/
COPY models/ /app/models/
COPY data/ /app/data/

ENV PYTHONPATH=/app/core:/app

EXPOSE 8000

STOPSIGNAL SIGTERM

CMD ["uvicorn", "core.fastapi_server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "30"]
