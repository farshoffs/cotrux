FROM node:22-alpine
WORKDIR /app

COPY services/signal/package.json ./services/signal/package.json
RUN cd services/signal && npm install --omit=dev

COPY services/signal/server.js ./services/signal/server.js
COPY apps/controller ./apps/controller

ENV PORT=8787
EXPOSE 8787
CMD ["node", "services/signal/server.js"]
