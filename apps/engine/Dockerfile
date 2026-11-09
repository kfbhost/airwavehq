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
RUN npm run build -w @radiohost/engine

FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/engine ./apps/engine
ENV NODE_ENV=production
WORKDIR /app/apps/engine
CMD ["node", "dist/index.js"]
