# Lara – Bowling in Mixed Reality (eigene Website, unabhaengig von Anja)
FROM nginx:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /opt/lara/public/
COPY docker-entrypoint.sh /docker-entrypoint.d/40-lara-version.sh
RUN chmod +x /docker-entrypoint.d/40-lara-version.sh && date +%s > /opt/lara/build-id
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
