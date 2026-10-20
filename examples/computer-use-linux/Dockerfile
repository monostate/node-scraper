# Minimal Linux image for computer-use mode: Xvfb + Chromium + xdotool + x11vnc.
# Debian 13 (trixie): Lightpanda 1.0.x Linux binaries need glibc >= 2.38 (bookworm has 2.36)
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb xdotool x11vnc imagemagick ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY example.mjs ./
ENV BNCA_CHROME_NO_SANDBOX=1 BNCA_CHROME_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
CMD ["node", "example.mjs"]
