# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/engine/package.json apps/engine/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/widgets/package.json apps/widgets/package.json
RUN npm ci
RUN npm install "@rollup/rollup-linux-x64-musl@$(node -p "require('./node_modules/rollup/package.json').version")" --no-save
COPY . .
RUN npm run build -w @airwavehq/web

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
