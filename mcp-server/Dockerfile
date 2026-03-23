FROM node:20-slim AS builder

WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

ENV SEARXNG_URL=http://searxng:8080

# MCP communicates over stdio — run with `docker run -i`
CMD ["node", "dist/index.js"]
