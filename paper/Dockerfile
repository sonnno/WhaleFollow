# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY scripts/precompress-web.js ./scripts/precompress-web.js
RUN npm run web:build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && mkdir -p /var/lib/whalefollow && chown node:node /var/lib/whalefollow
COPY server ./server
COPY config/DBsettings.js config/index.js config/paper.example.json ./config/
COPY scripts/db-init.js ./scripts/db-init.js
COPY deploy/*.js ./deploy/
COPY --from=build /app/web/dist ./web/dist
RUN chmod -R a+rX /app/server /app/config /app/deploy /app/web /app/scripts /app/package.json
USER node
EXPOSE 3000
CMD ["node", "deploy/run.js", "api"]
