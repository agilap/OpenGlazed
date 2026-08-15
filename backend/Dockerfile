# OpenGlazed backend — fully local RAG API.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install prod deps only (devDeps not needed at runtime)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Drop root for a slightly safer default; the app only needs its port.
RUN addgroup -S glazed && adduser -S glazed -G glazed \
  && chown -R glazed:glazed /app
USER glazed

EXPOSE 3000
CMD ["node", "src/server.js"]
