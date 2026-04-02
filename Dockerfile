FROM node:20-alpine

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser \
    NODE_OPTIONS=--max-old-space-size=1024 \
    NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-arabic \
    libreoffice \
    ttf-dejavu \
    fontconfig \
    udev \
    wget \
 && fc-cache -fv

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p \
    /app/logs \
    /app/uploads \
    /app/uploads/temp \
    /app/uploads/pdfs \
    /app/uploads/chat \
    /app/assets

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

CMD ["node", "server.js"]
