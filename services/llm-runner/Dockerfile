FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/llm-runner/package.json services/llm-runner/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY services/llm-runner ./services/llm-runner
RUN npx tsc -b packages/contracts services/llm-runner

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8200
COPY packages/contracts/package.json ./node_modules/@my-agent-toolkit/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/services/llm-runner/dist ./services/llm-runner/dist
COPY services/llm-runner/scripts ./services/llm-runner/scripts
COPY --from=deps /app/node_modules/undici ./node_modules/undici
RUN mkdir -p ./node_modules/@my-agent-toolkit/contracts/dist \
  && cp -R ./packages/contracts/dist/. ./node_modules/@my-agent-toolkit/contracts/dist/
EXPOSE 8200
CMD ["node", "services/llm-runner/dist/main.js"]
