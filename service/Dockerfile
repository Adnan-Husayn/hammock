# Build from the repository root: docker build -f service/Dockerfile .
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app/service
COPY service/package.json service/package-lock.json ./
RUN npm ci --omit=dev
COPY service/src ./src
COPY service/data ./data
RUN mkdir -p /app/logs && chown -R node:node /app/logs
USER node
EXPOSE 8787
# Same command as "npm start"; node runs directly so it receives stop signals.
CMD ["node", "--experimental-strip-types", "src/server.ts"]
