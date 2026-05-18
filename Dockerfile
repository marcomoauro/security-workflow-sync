FROM node:24.14.1-alpine

WORKDIR /app

# No runtime deps — copy the lockfile + package.json so `npm ci --omit=dev` is still well-defined
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY bin ./bin
COPY src ./src

RUN chmod +x ./bin/sws.js

# Default to `sync` so `docker run …/security-workflow-sync` is the canonical invocation,
# but allow override (e.g. `docker run … bootstrap`).
ENTRYPOINT ["node", "/app/bin/sws.js"]
CMD ["sync"]
