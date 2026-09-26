FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /srv
COPY package*.json tsconfig.base.json ./
COPY app/package.json app/
COPY server/package.json server/
RUN npm install
COPY . .
RUN npm run build
ENV VAULT_PATH=/vault PORT=8787
EXPOSE 8787
# mount your vault (a git repo) at /vault
CMD ["npm", "start"]
