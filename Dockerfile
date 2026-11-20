# The public test server (Render free web service, or any Docker host): the web app and the API in one container.
# Visitors bring their own API key and scripts; see CLIFFCUT_PUBLIC in server/app.py.
FROM node:22-slim AS web
WORKDIR /w
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 user
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn httpx python-multipart anthropic
COPY --chown=user promo ./promo
COPY --chown=user server ./server
COPY --chown=user providers.json ./providers.json
COPY --chown=user samples ./samples
COPY --from=web --chown=user /w/dist ./web/dist
RUN mkdir -p runs uploads && chown user runs uploads
USER user
ENV CLIFFCUT_PUBLIC=1
EXPOSE 7860
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-7860}"]
