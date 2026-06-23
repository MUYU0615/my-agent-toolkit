FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/capability-runner/package.json services/capability-runner/package.json
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/capability-runner ./services/capability-runner
RUN npx tsc -b services/capability-runner

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8400
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/capability-runner/dist ./services/capability-runner/dist
EXPOSE 8400
CMD ["node", "services/capability-runner/dist/main.js"]
