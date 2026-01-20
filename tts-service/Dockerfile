FROM python:3.9-slim

WORKDIR /app

# Instala ffmpeg, datos de zona horaria Y AHORA CURL
RUN apt-get update && \
    apt-get install -y ffmpeg tzdata curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements_tts.txt .
RUN pip install --no-cache-dir -r requirements_tts.txt

COPY . .

EXPOSE 8000
