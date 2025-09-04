# worker.py

import os
import uuid
import time
import traceback
from io import BytesIO
import wave

# --- Librerías de terceros ---
from piper.voice import PiperVoice
from pydub import AudioSegment
import paramiko
from redis import Redis
from rq import Queue, Worker

# --- 1. Configuración ---
MODEL_PATH = "piper_models/es_MX-claude-high.onnx"
CONFIG_PATH = "piper_models/es_MX-claude-high.onnx.json"
SFTP_HOST = '10.101.214.227'
SFTP_PORT = 22
SFTP_USER = 'root'
SFTP_PASS = '123456789a'
REMOTE_PATH = '/var/lib/asterisk/sounds/campanas'

# --- 2. Inicialización de servicios ---
print("🚀 Inicializando worker...")

# Cargar el modelo de voz una sola vez al iniciar el worker
try:
    print(f"Cargando modelo Piper desde: {MODEL_PATH}")
    voice = PiperVoice.load(MODEL_PATH, config_path=CONFIG_PATH)
    print("✅ Modelo Piper cargado con éxito.")
except Exception as e:
    print(f"❌ Error fatal: No se pudo cargar el modelo Piper. {e}")
    exit()

# Conectar a Redis usando el nombre del servicio de Docker Compose
redis_conn = Redis(host='redis', port=6379, db=0)


def process_tts(text):
    """
    Genera un audio .gsm 8kHz mono usando Piper y pydub
    y lo sube por SFTP.
    """
    transport = None
    sftp_client = None

    try:
        # Conectar a SFTP por cada trabajo para evitar timeouts
        print(f"Conectando a SFTP en {SFTP_HOST}...")
        transport = paramiko.Transport((SFTP_HOST, SFTP_PORT))
        transport.connect(username=SFTP_USER, password=SFTP_PASS)
        sftp_client = paramiko.SFTPClient.from_transport(transport)

        try:
            sftp_client.chdir(REMOTE_PATH)
        except IOError:
            print(f"Directorio remoto no encontrado, creando '{REMOTE_PATH}'...")
            sftp_client.mkdir(REMOTE_PATH)
            sftp_client.chdir(REMOTE_PATH)
        print(f"✅ Conexión SFTP establecida. Directorio actual: {REMOTE_PATH}")

        print(f"🎙️ Generando audio para el texto: '{text[:30]}...'")

        # 1. Generar audio WAV en memoria con Piper
        audio_generator = voice.synthesize(text)
        pcm_audio_bytes = b"".join(chunk.audio_int16_bytes for chunk in audio_generator)

        wav_buffer = BytesIO()
        with wave.open(wav_buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(voice.config.sample_rate)
            wav_file.writeframes(pcm_audio_bytes)
        wav_buffer.seek(0)

        # 2. Convertir el WAV a formato GSM con pydub
        print("Convirtiendo a GSM 8kHz mono con pydub...")
        audio = AudioSegment.from_wav(wav_buffer)
        audio = audio.set_frame_rate(8000).set_channels(1)

        gsm_buffer = BytesIO()
        audio.export(gsm_buffer, format='gsm')
        gsm_buffer.seek(0)

        # 3. Subir el archivo .gsm por SFTP desde memoria
        filename = f"{uuid.uuid4().hex}.gsm"
        print(f"📤 Subiendo '{filename}' a {SFTP_HOST}...")
        sftp_client.putfo(gsm_buffer, filename)
        print("✅ Archivo subido con éxito.")

        return {"filename": filename, "saved_to": f"{SFTP_HOST}:{REMOTE_PATH}/{filename}"}

    finally:
        # Asegurarse de cerrar siempre la conexión SFTP
        if sftp_client:
            sftp_client.close()
            print("SFTP client closed.")
        if transport:
            transport.close()
            print("SFTP transport closed.")


# --- 3. Bucle principal para procesar trabajos ---
if __name__ == '__main__':
    listen = ['tts']
    print(f"\n🎧 Worker listo y escuchando la cola: {listen}...")
    # Crea una instancia de Worker y le dice que empiece a trabajar.
    # Esto maneja el bucle de escucha de forma más robusta que un `while True`.
    w = Worker(listen, connection=redis_conn)
    w.work()