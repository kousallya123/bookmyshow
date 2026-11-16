# Dashboard-only image for Render (no Playwright browsers)
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm uninstall playwright --omit=dev || true

COPY . .

ENV NODE_ENV=production
ENV ROLE=dashboard
ENV PORT=10000

EXPOSE 10000

CMD ["node", "src/index.js"]
