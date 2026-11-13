FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=10000

WORKDIR /app

# The upstream package is installed from its reviewed GitHub commit; Playwright
# then downloads the matching Chromium build plus its Debian runtime libraries.
# libatomic1 is needed by Playwright's bundled Node driver on slim Debian images.
COPY requirements.txt ./requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates libatomic1 \
    && pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium \
    && apt-get purge -y --auto-remove git \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip

COPY app.py ./app.py

EXPOSE 10000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
