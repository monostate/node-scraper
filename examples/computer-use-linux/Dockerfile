# Minimal Linux image for computer-use mode: Xvfb + Chromium + xdotool + x11vnc.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb xdotool x11vnc imagemagick ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY example.mjs ./
ENV BNCA_CHROME_NO_SANDBOX=1 BNCA_CHROME_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
CMD ["node", "example.mjs"]
