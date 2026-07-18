FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/work-dispatcher/package.json services/work-dispatcher/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/work-dispatcher ./services/work-dispatcher
RUN npx tsc -b services/work-dispatcher

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8900
ENV DATA_SERVICE_URL=http://data-service:8300
ENV LLM_RUNNER_URL=http://llm-runner:8200
COPY --from=build /app/services/work-dispatcher/dist ./services/work-dispatcher/dist
EXPOSE 8900
CMD ["node", "services/work-dispatcher/dist/main.js"]
