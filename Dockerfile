FROM node:lts-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data ./data

FROM node:lts-alpine AS final
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/data ./data
COPY --from=builder /app/package*.json ./

EXPOSE 3001
CMD ["npm", "start"]
