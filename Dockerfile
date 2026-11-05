FROM node:26.5.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run web:build && npm prune --omit=dev --ignore-scripts

FROM node:26.5.1-bookworm-slim AS runtime
ENV NODE_ENV=production APP_DEPLOYMENT=container PORT=3000 DATABASE_PATH=/app/.local/inbyeol.sqlite FLUE_DATABASE_PATH=/app/.local/flue.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node docs/samples ./docs/samples
COPY --chown=node:node assets/sample-store ./assets/sample-store
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
EXPOSE 3000
CMD ["node", "dist/http/server.js"]
