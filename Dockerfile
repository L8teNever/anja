FROM nginx:1.27-alpine

# Version wird vom GitHub-Workflow gesetzt (1.0.<run_number>), lokal "dev"
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY upload.js /etc/nginx/upload.js
# Unveraenderte Vorlage; der Start kopiert sie frisch nach /usr/share/nginx/html
COPY public/ /opt/anja/public/
COPY docker-entrypoint.sh /docker-entrypoint.d/40-anja-version.sh

RUN chmod +x /docker-entrypoint.d/40-anja-version.sh \
 && sed -i '1i load_module modules/ngx_http_js_module.so;' /etc/nginx/nginx.conf \
 && date +%s > /opt/anja/build-id \
 && mkdir -p /videos

# 360-Videos (.mp4/.webm, optional gleichnamiges .jpg als Vorschaubild) per Volume nach /videos
VOLUME ["/videos"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
