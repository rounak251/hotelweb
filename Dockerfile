FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY index.html index.html
COPY js/ js/

RUN useradd --system --create-home --uid 10001 app && chown -R app:app /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/api/health',timeout=3)"

CMD ["sh", "-c", "exec gunicorn --chdir backend app:app --bind 0.0.0.0:${PORT:-8000} --workers 2 --threads 4 --access-logfile -"]
