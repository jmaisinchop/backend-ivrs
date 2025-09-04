    FROM python:3.9-slim

    WORKDIR /app

    # Instala ffmpeg y los datos de zona horaria
    RUN apt-get update && \
        apt-get install -y ffmpeg tzdata && \
        rm -rf /var/lib/apt/lists/*

    COPY requirements_tts.txt .
    RUN pip install --no-cache-dir -r requirements_tts.txt

    COPY . .
    
