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
RUN npm run build -w @radiohost/api && npm run build -w @radiohost/widgets

FROM node:22-alpine
RUN apk add --no-cache ffmpeg postgresql-client
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/widgets/dist ./apps/widgets/dist
ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 8080
# Push the schema, then start. (drizzle-kit push --force is non-interactive.)
CMD ["sh", "-c", "npx drizzle-kit push --force && node dist/index.js"]
