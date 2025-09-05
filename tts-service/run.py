import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from redis import Redis
from rq import Queue

# 1. Crear la variable 'app' que Gunicorn est?? buscando
app = Flask(__name__)
CORS(app)

# 2. Conexi??n a Redis
# 'redis' es el nombre del servicio en docker-compose.yml
redis_conn = Redis(host='redis', port=6379)
q = Queue('tts', connection=redis_conn)


# 3. Definir la ruta de la API
@app.route('/api/tts', methods=['POST'])
def enqueue_tts_task():
    """
    Recibe un texto en formato form-data, lo a??ade a la cola,
    y espera el resultado antes de responder.
    """
    # --- CAMBIO AQU??: Usamos request.form en lugar de request.get_json() ---
    text = request.form.get('text')
    if not text:
        return jsonify({"error": "Se requiere el campo 'text' en el form-data"}), 400

    try:
        # Encola la tarea usando la variable 'text' que obtuvimos del formulario.
        job = q.enqueue('worker.process_tts', text, job_timeout='2m')

        # --- L??GICA DE ESPERA (POLLING) ---
        timeout = 60  # Segundos m??ximos de espera
        waited = 0
        interval = 0.5  # Segundos entre cada verificaci??n

        while waited < timeout:
            job.refresh()  # Actualiza el estado del job desde Redis

            if job.is_finished:
                # El job termin?? con ??xito, devuelve su resultado
                return jsonify(job.result), 200

            elif job.is_failed:
                # El job fall??, devuelve un error de servidor
                return jsonify({"error": "El worker fall?? al procesar la tarea"}), 500

            # Espera un poco antes de volver a preguntar
            time.sleep(interval)
            waited += interval

        # Si el bucle termina, es porque se agot?? el tiempo de espera
        return jsonify({"error": "Tiempo de espera agotado, la tarea tard?? demasiado"}), 504

    except Exception as e:
        return jsonify({"error": f"No se pudo conectar o encolar la tarea en Redis: {e}"}), 500
@app.route('/health')
def health_check():
    """Simple health check endpoint."""
    return jsonify({"status": "ok"}), 200

# La siguiente secci??n es solo para pruebas locales sin Docker/Gunicorn.
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)

