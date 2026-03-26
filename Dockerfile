# ================================================================
# PicoClaw — Single Container Serverless Agent
# Multi-stage build: compiles TypeScript inside Docker,
# no local Node.js required.
# ================================================================

# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir \
    requests \
    numpy \
    pandas \
    matplotlib

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g \
    agent-browser \
    @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

COPY --from=builder /build/dist/ ./dist/
COPY container/skills/ /app/built-in-skills/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN mkdir -p \
    /data/memory/.claude/skills \
    /data/store \
    /etc/claude-code

RUN chown -R node:node /app /data /home/node /etc/claude-code
USER node

ENV NODE_ENV=production
ENV PORT=9000
ENV MAX_EXECUTION_MS=300000

ARG BUILD_VERSION=unknown
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=${BUILD_VERSION}
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}

LABEL org.opencontainers.image.source="https://github.com/breakcafe/picoclaw"
LABEL org.opencontainers.image.description="Serverless-first Claude Agent runtime"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${BUILD_VERSION}"

ARG ENABLE_LAMBDA_ADAPTER=false
USER root
RUN if [ "$ENABLE_LAMBDA_ADAPTER" = "true" ]; then \
      mkdir -p /opt/extensions && \
      curl -Lo /opt/extensions/lambda-adapter \
        https://github.com/awslabs/aws-lambda-web-adapter/releases/latest/download/lambda-adapter-x86_64 && \
      chmod +x /opt/extensions/lambda-adapter; \
    fi
USER node

EXPOSE ${PORT}
ENTRYPOINT ["/app/entrypoint.sh"]
