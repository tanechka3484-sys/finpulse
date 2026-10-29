# FinPulse — сайт и небольшой API-сервер на Node.js (без зависимостей).
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY certs ./certs
COPY index.html ./
COPY css ./css
COPY js ./js

ENV NODE_ENV=production
# Railway задаёт PORT сам; значение ниже — для локального запуска
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
