# Full monitor on Render — uses Safari TLS client (no Playwright / no local PC needed)
FROM node:20-bookworm-slim

WORKDIR /app

# Native tls-client needs openssl/ca certs
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV ROLE=all
ENV CHECK_MODE=tls
ENV PORT=10000
ENV UV_THREADPOOL_SIZE=16

EXPOSE 10000

CMD ["node", "src/index.js"]
