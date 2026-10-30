# Build from the repository root: docker build -f service/Dockerfile .
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app/service
COPY service/package.json service/package-lock.json ./
RUN npm ci --omit=dev
COPY service/src ./src
COPY service/data ./data
RUN mkdir -p /app/logs && chown -R node:node /app/logs
EXPOSE 8787
# Same command as "npm start". Volumes mount as root, so fix ownership, then drop to node; exec keeps stop signals.
CMD ["sh", "-c", "chown -R node:node /app/logs && exec setpriv --reuid=node --regid=node --clear-groups node --experimental-strip-types src/server.ts"]
