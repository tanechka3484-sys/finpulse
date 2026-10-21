# FinPulse — статический сайт на веб-сервере Caddy.
# Сборка не нужна: в образ копируются только файлы сайта.
FROM caddy:2.10-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/
COPY css /srv/css
COPY js /srv/js

# Railway задаёт PORT сам; значение ниже — для локального запуска
ENV PORT=8080
EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
