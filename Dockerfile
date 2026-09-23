# syntax=docker/dockerfile:1

# GeoAttend Pro backend image.
#
# Uses the Debian-based "bookworm" tag rather than "alpine": bcrypt, sharp,
# and onnxruntime-node all ship prebuilt binaries for glibc (Debian/Ubuntu)
# platforms; alpine's musl libc frequently forces a slow, sometimes-failing
# from-source rebuild of these instead. build-essential + python3 are kept
# as a fallback for the rare case a prebuilt binary isn't available for the
# target platform (e.g. building for linux/arm64) and npm falls back to
# compiling from source.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# w600k_r50.onnx (~174MB) is gitignored -- see .gitignore and
# models/README.md -- because it's over GitHub's 100MB per-file push limit.
# Downloaded here at build time instead, using the exact command
# models/README.md documents, so the image is self-contained and Face
# Verification works without a manual post-deploy step. If you'd rather not
# bake ~174MB into the image, delete this RUN block and mount the file into
# the container instead (e.g. a volume at /app/models); the app already
# handles a missing model file with a clear setup error rather than
# crashing (see services/faceService.js), so nothing else breaks either way.
RUN if [ ! -f models/w600k_r50.onnx ]; then \
      curl -L -o /tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip && \
      unzip -o /tmp/buffalo_l.zip w600k_r50.onnx -d models/ && \
      rm /tmp/buffalo_l.zip; \
    fi

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/api/health || exit 1

CMD ["node", "server.js"]
