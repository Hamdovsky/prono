FROM python:3.11

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements-fastapi.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements-fastapi.txt

COPY core/ /app/core/
COPY inference/ /app/inference/
COPY models/ /app/models/
COPY data/ /app/data/

ENV PYTHONPATH=/app/core:/app

EXPOSE 8000

STOPSIGNAL SIGTERM

CMD ["uvicorn", "core.fastapi_server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-keep-alive", "30"]
