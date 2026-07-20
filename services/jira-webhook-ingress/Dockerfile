FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/jira-webhook-ingress/package.json services/jira-webhook-ingress/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/jira-webhook-ingress ./services/jira-webhook-ingress
RUN npx tsc -b services/jira-webhook-ingress

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9000
ENV JIRA_WEBHOOK_EVENT_STORE_FILE=/data/jira-events.json
COPY --from=build /app/services/jira-webhook-ingress/dist ./services/jira-webhook-ingress/dist
EXPOSE 9000
CMD ["node", "services/jira-webhook-ingress/dist/main.js"]
