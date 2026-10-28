FROM node:20-alpine

# Chromium renders the invoice / medical report PDFs (puppeteer uses the system browser).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
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
    ttf-dejavu \
    fontconfig \
    wget \
 && fc-cache -fv

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

RUN mkdir -p /app/logs /app/uploads/private /app/assets \
 && chown -R node:node /app/logs /app/uploads /app/assets

USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

CMD ["node", "server.js"]
