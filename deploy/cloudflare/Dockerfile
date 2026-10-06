# The Cloudflare Containers image — the scheduled-job deploy (docs/cloudflare.md).
#
# Installs the *released* package from PyPI, not a checkout: the supported
# install is `uv tool install openoutreach`, and the build context for this
# image is deploy/cloudflare/, which holds no Python sources. Bump
# OPENOUTREACH_VERSION to move the deploy forward.
#
# Differences from compose/openoutreach/Dockerfile (the VM image):
#  - no gosu / UID remap — Cloudflare runs containers without root, so this
#    image pre-creates its user and writable directories at build time instead
#    of remapping at runtime (the VM entrypoint's chown trick needs root)
#  - curl + zstd + tar for the R2 state sync in container-start
#  - ENTRYPOINT is the state-sync wrapper, not the compose entrypoint

ARG OPENOUTREACH_VERSION=0.1.60

# ── Stage 1: a venv holding the released package and its dependencies ──
FROM python:3.12-slim-bookworm AS deps
ARG OPENOUTREACH_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN pip install uv
RUN uv venv /opt/venv \
    && VIRTUAL_ENV=/opt/venv uv pip install --no-cache "openoutreach==${OPENOUTREACH_VERSION}"

# openoutsend (0.1.36–0.1.39) builds OpenAI-style models with `OpenAIModel`, a
# pydantic-ai 1.x name that no 2.x release has — and it requires pydantic-ai 2.x,
# so every openai/openai_compatible model fails with an ImportError (follow-ups
# and replies then fail silently, counted per deal). Rename it to the 2.x class
# until the sender ships the fix; the import check fails the build if the patch
# stops applying.
RUN F=$(/opt/venv/bin/python -c "import cold_outreach.core.llm as m; print(m.__file__)") \
    && sed -i 's/\bOpenAIModel\b/OpenAIChatModel/g' "$F" \
    && /opt/venv/bin/python -c "from cold_outreach.core.llm import build_llm_model as b; b('openai_compatible:probe', 'k', 'http://llm.internal/v1')"

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime
COPY --from=deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl zstd tar \
    && rm -rf /var/lib/apt/lists/*

# Non-root, with pre-created writable state. The platform gives the process
# no root at runtime, so everything the job writes to must already be owned
# (or open) when the image is built.
RUN useradd -m -u 1000 ubuntu
ARG APP_HOME=/app
WORKDIR ${APP_HOME}
RUN mkdir -p /app/data \
    && chmod -R a+rwX /app /home/ubuntu

COPY container-start shim.py /
RUN chmod +x /container-start

# The CRM is not in the image: container-start downloads it from R2 before the
# job and uploads it back after. HOME is persisted the same way, which is what
# keeps the model caches from re-downloading on every cold start.
ENV OPENOUTREACH_DB=/app/data/db.sqlite3
ENV HOME=/home/ubuntu

USER ubuntu
ENTRYPOINT ["/container-start"]
