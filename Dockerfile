FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docs ./docs
COPY replacement-data/build ./replacement-data/build
COPY README.md LICENSE ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV HOST=0.0.0.0 PORT=8080 UDP_HOST=0.0.0.0 UDP_PORT=7777 DATA_DIR=/app/data REPLACEMENT_CONTENT_DIR=/app/replacement-data/build/Android/data/com.mattel.HWInfiniteLoop/files/private-content
EXPOSE 8080/tcp
EXPOSE 7777/udp

CMD ["node", "src/index.js"]
