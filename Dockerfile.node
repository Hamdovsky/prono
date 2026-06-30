FROM node:18-alpine

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

COPY package.json package-lock.json* ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev && npm cache clean --force

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV SERVER_PORT=3001

EXPOSE 3001

STOPSIGNAL SIGTERM

CMD ["node", "--expose-gc", "--max-old-space-size=384", "server.js"]
