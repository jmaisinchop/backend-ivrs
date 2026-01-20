import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from redis import Redis
from rq import Queue

app = Flask(__name__)
CORS(app)

redis_conn = Redis(host='redis', port=6379)
q = Queue('tts', connection=redis_conn)


@app.route('/api/tts', methods=['POST'])
def enqueue_tts_task():
    """
    Recibe un texto en formato form-data, lo a??ade a la cola,
    y espera el resultado antes de responder.
    """
    text = request.form.get('text')
    if not text:
        return jsonify({"error": "Se requiere el campo 'text' en el form-data"}), 400

    try:
        job = q.enqueue('worker.process_tts', text, job_timeout='2m')

        timeout = 60  
        waited = 0
        interval = 0.5  

        while waited < timeout:
            job.refresh()  

            if job.is_finished:
                return jsonify(job.result), 200

            elif job.is_failed:
                return jsonify({"error": "El worker fall?? al procesar la tarea"}), 500

            time.sleep(interval)
            waited += interval

        return jsonify({"error": "Tiempo de espera agotado, la tarea tard?? demasiado"}), 504

    except Exception as e:
        return jsonify({"error": f"No se pudo conectar o encolar la tarea en Redis: {e}"}), 500
@app.route('/health')
def health_check():
    """Simple health check endpoint."""
    return jsonify({"status": "ok"}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)

