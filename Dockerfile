FROM node:22-alpine
RUN apk add --no-cache git \
 && git config --global --add safe.directory "*"
WORKDIR /srv
COPY package*.json tsconfig.base.json ./
COPY app/package.json app/
COPY server/package.json server/
RUN npm install
COPY . .
RUN npm run build
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
# VAULT_SOURCE=git (default): mount your vault repo and set VAULT_PATH
# VAULT_SOURCE=fns: mirror from a fast-note-sync-service, see docker-compose.yml
CMD ["npm", "start"]
