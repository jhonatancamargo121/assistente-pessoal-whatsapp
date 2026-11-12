FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg + utilitários + Edge TTS (Python) + poppler (pdftotext p/ ler PDFs)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tar python3 python3-pip poppler-utils \
  && pip3 install --break-system-packages edge-tts \
  && rm -rf /var/lib/apt/lists/*

# ── Piper TTS (offline, gratuito) + voz PT-BR ──
# Binário oficial (x86_64) e modelo de voz pt_BR-faber-medium
RUN set -eux; \
  mkdir -p /opt/piper /app/voices; \
  curl -fsSL -o /tmp/piper.tar.gz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz; \
  tar -xzf /tmp/piper.tar.gz -C /opt; \
  rm /tmp/piper.tar.gz; \
  curl -fsSL -o /app/voices/pt_BR-faber-medium.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx?download=true; \
  curl -fsSL -o /app/voices/pt_BR-faber-medium.onnx.json \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json?download=true
ENV PIPER_BIN=/opt/piper/piper \
    PIPER_MODEL=/app/voices/pt_BR-faber-medium.onnx \
    LD_LIBRARY_PATH=/opt/piper

COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY templates ./templates
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server.js"]
