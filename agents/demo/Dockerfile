# Public multi-architecture Python image, immutable manifest (2026-11-05).
FROM python:3.14-slim-bookworm@sha256:e6f981aeb339e6ead5e5e87e14c55b715ac76d6b2a710b86d70ca69c7f2399ce
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock.txt && rm /tmp/requirements.lock.txt
COPY setup-runtime.py /tmp/setup-runtime.py
RUN python /tmp/setup-runtime.py --source-root /opt/hermes-public && rm /tmp/setup-runtime.py \
    && HERMES_HOME=/tmp/hermes-import-check HERMES_DISABLE_LAZY_INSTALLS=1 python -I -B -c "import sys;sys.path.insert(0,'/opt/hermes-public');from run_agent import AIAgent" \
    && rm -rf /tmp/hermes-import-check \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin quietledger \
    && mkdir -p /var/lib/quiet-ledger-hermes /app/agents/demo \
    && chown 1000:1000 /var/lib/quiet-ledger-hermes && chmod 700 /var/lib/quiet-ledger-hermes
COPY worker.py company-brief.md client.persona.md accountant.persona.md /app/agents/demo/
ENV QUIET_LEDGER_HERMES_SOURCE=/opt/hermes-public \
    QUIET_LEDGER_HERMES_STATE=/var/lib/quiet-ledger-hermes \
    QUIET_LEDGER_WORKER_TOKEN_FILE=/run/secrets/worker-token \
    QUIET_LEDGER_MODEL_CREDENTIAL_FILE=/run/secrets/model-credential \
    QUIET_LEDGER_MODEL=glm-5.3-flash \
    QUIET_LEDGER_MODEL_BASE_URL=https://gateway.trytokenfactory.dev/v1 \
    QUIET_LEDGER_CONTAINER_BOUNDARY=1 HERMES_DISABLE_LAZY_INSTALLS=1
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4420/health',timeout=2).close()"
ENTRYPOINT ["python", "-I", "-B", "/app/agents/demo/worker.py"]
CMD ["--host", "0.0.0.0", "--port", "4420"]
