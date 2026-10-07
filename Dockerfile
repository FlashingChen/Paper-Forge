# syntax=docker/dockerfile:1

# A deployment may reuse a verified compatible Python runtime image.
# The default builds the same dependencies directly from source.
ARG PREVIEW_DEPS_IMAGE=preview-base
FROM node:22-alpine AS preview-base
ENV PAPERFORGE_VENV=/opt/venv
RUN apk add --no-cache python3 py3-pip bash
WORKDIR /app
COPY scripts/setup-venv.sh ./scripts/setup-venv.sh
RUN chmod +x ./scripts/setup-venv.sh && ./scripts/setup-venv.sh

FROM ${PREVIEW_DEPS_IMAGE} AS preview-runtime

FROM node:22-alpine AS builder

ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1 \
    PAPERFORGE_VENV=/opt/venv

RUN apk add --no-cache python3 py3-pip bash

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --from=preview-runtime /opt/venv /opt/venv

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PAPERFORGE_PYTHON=/opt/venv/bin/python \
    PAPERFORGE_JOBS_DIR=/data/jobs \
    PAPERFORGE_DB_PATH=/data/paperforge.db \
    PAPERFORGE_EXECUTOR=node

# Python is retained only for the existing DOCX preview service. No pi runtime.
RUN apk add --no-cache python3 bash su-exec curl
ENV PAPERFORGE_CONTROL_ONLY=1

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

COPY --from=builder /app/.next/standalone ./
# The standalone trace omits public Next entry points used by the separately
# bundled dispatcher (auth/config imports next/headers outside a route bundle).
COPY --from=builder /app/node_modules/next ./node_modules/next
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

COPY --from=builder /app/.execution/dispatcher.cjs ./.execution/dispatcher.cjs

COPY --from=builder /app/scripts/docx_preview.py ./scripts/docx_preview.py

# Next's trace can still copy files referenced by the local-development runner.
# They belong exclusively to Dockerfile.agent in the deployed architecture.
RUN rm -rf /app/agent /app/reference \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 10001 --ingroup nodejs --home /home/paperforge paperforge \
 && mkdir -p /data/jobs /home/paperforge \
 && chown -R paperforge:nodejs /data /home/paperforge /app \
 && chmod 0775 /data/jobs

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/control-start.sh /usr/local/bin/control-start.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/control-start.sh

VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/control-start.sh"]
