FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/mcp-service/package.json services/mcp-service/package.json
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY services/mcp-service ./services/mcp-service
RUN npx tsc -b packages/contracts services/mcp-service

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8700
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/dist ./node_modules/@my-agent-toolkit/contracts/dist
COPY --from=build /app/services/mcp-service/dist ./services/mcp-service/dist
EXPOSE 8700
CMD ["node", "services/mcp-service/dist/main.js"]
