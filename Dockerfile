FROM python:3.10-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (cached layer)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir \
        fastapi \
        uvicorn[standard] \
        pydantic \
        psycopg2-binary \
        redis \
        aioredis \
        httpx

# Copy application code
COPY core/ /app/core/
COPY inference/ /app/inference/
COPY models/ /app/models/

# Set Python path so imports work correctly
ENV PYTHONPATH=/app/core:/app

EXPOSE 8000

# Graceful shutdown
STOPSIGNAL SIGTERM

CMD ["uvicorn", "core.fastapi_server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-keep-alive", "30"]
