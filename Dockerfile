FROM mcr.microsoft.com/playwright:v1.65.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=10000
ENV PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0

EXPOSE 10000

CMD ["node", "src/index.js"]
