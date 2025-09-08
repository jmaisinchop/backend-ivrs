import os
import uuid
import logging
from io import BytesIO
import wave

# --- Librerías de terceros ---
from piper.voice import PiperVoice
from pydub import AudioSegment
import paramiko
from redis import Redis
from rq import Worker

# --- Configuración de Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- 1. Configuración ---
MODEL_PATH = "piper_models/es_MX-claude-high.onnx"
CONFIG_PATH = "piper_models/es_MX-claude-high.onnx.json"
SFTP_HOST = '10.101.214.227'
SFTP_PORT = 22
SFTP_USER = 'root'
SFTP_PASS = '123456789a'
REMOTE_PATH = '/var/lib/asterisk/sounds/campanas'

# --- 2. Inicialización de servicios ---
logging.info("🚀 Inicializando worker...")

try:
    logging.info(f"Cargando modelo Piper desde: {MODEL_PATH}")
    voice = PiperVoice.load(MODEL_PATH, config_path=CONFIG_PATH)
    logging.info("✅ Modelo Piper cargado con éxito.")
except Exception as e:
    logging.error(f"❌ Error fatal: No se pudo cargar el modelo Piper. {e}")
    exit()

redis_conn = Redis(host='redis', port=6379, db=0)

# --- 3. Conexión SFTP Robusta y Persistente (LA MEJORA DE VELOCIDAD) ---
sftp_transport = None
sftp_client = None

def get_sftp_connection():
    global sftp_transport, sftp_client
    if sftp_transport and sftp_transport.is_active():
        return sftp_client # Reutiliza la conexión si está activa

    logging.warning("🔌 No hay conexión SFTP activa. Creando una nueva...")
    try:
        sftp_transport = paramiko.Transport((SFTP_HOST, SFTP_PORT))
        sftp_transport.connect(username=SFTP_USER, password=SFTP_PASS)
        sftp_client = paramiko.SFTPClient.from_transport(sftp_transport)
        try:
            sftp_client.chdir(REMOTE_PATH)
        except IOError:
            sftp_client.mkdir(REMOTE_PATH)
            sftp_client.chdir(REMOTE_PATH)
        logging.info(f"✅ Conexión SFTP establecida.")
        return sftp_client
    except Exception as e:
        logging.error(f"❌ Error fatal al conectar a SFTP: {e}")
        sftp_transport = sftp_client = None
        raise ConnectionError(f"No se pudo conectar a SFTP: {e}")

# --- 4. Función de Procesamiento del Worker ---
def process_tts(text):
    sftp = get_sftp_connection() # Obtiene la conexión optimizada
    logging.info(f"🎙️ Generando audio para: '{text[:40]}...'")

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
    audio = AudioSegment.from_wav(wav_buffer)
    audio = audio.set_frame_rate(8000).set_channels(1)
    gsm_buffer = BytesIO()
    audio.export(gsm_buffer, format='gsm')
    gsm_buffer.seek(0)

    # 3. Subir el archivo .gsm por SFTP
    filename = f"{uuid.uuid4().hex}.gsm"
    logging.info(f"📤 Subiendo '{filename}'...")
    sftp.putfo(gsm_buffer, filename)
    logging.info("✅ Archivo subido con éxito.")

    return {"filename": filename, "saved_to": f"{SFTP_HOST}:{REMOTE_PATH}/{filename}"}

# --- 5. Bucle Principal del Worker ---
if __name__ == '__main__':
    listen = ['tts']
    logging.info(f"\n🎧 Worker listo y escuchando la cola: {listen}...")
    w = Worker(listen, connection=redis_conn)
    w.work()
