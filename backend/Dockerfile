FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN addgroup -S glazed && adduser -S glazed -G glazed \
  && chown -R glazed:glazed /app
USER glazed

EXPOSE 3000
CMD ["node", "src/server.js"]
