FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-fastapi.txt .
RUN pip install --no-cache-dir -r requirements-fastapi.txt

COPY . .

RUN mkdir -p /app/logs /app/data

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/core:/app

EXPOSE 8000

STOPSIGNAL SIGTERM

CMD ["uvicorn", "core.fastapi_server:app", "--host", "0.0.0.0", "--port", "8000"]
