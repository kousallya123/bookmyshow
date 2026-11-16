# Lightweight dashboard image for Render (no Playwright — BMS blocks cloud IPs)
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV ROLE=dashboard
ENV PORT=10000

EXPOSE 10000

CMD ["node", "src/index.js"]
