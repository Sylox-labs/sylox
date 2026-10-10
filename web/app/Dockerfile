# A separate Dockerfile for this service - not Railpack (see railpack.json
# at the repo root) - because Railpack's own build-plan resolution in this
# monorepo consistently built web/landing's package.json scripts regardless
# of this service's dashboard-configured build/start commands (observed
# across three different Railway projects/services). A Dockerfile has no
# auto-detection step to get wrong: it runs exactly the commands below.
FROM node:24-slim

WORKDIR /app

# The whole monorepo, not just web/app - this app depends on the
# web/shared/ui workspace member, so npm's workspace resolution needs
# every workspace's package.json (and the root lockfile) present.
COPY package.json package-lock.json ./
COPY web/app/package.json web/app/package.json
COPY web/app/lib/contracts/event-registry/package.json web/app/lib/contracts/event-registry/package.json
COPY web/app/lib/contracts/risk-oracle/package.json web/app/lib/contracts/risk-oracle/package.json
COPY web/app/lib/contracts/token/package.json web/app/lib/contracts/token/package.json
COPY web/landing/package.json web/landing/package.json
COPY web/shared/ui/package.json web/shared/ui/package.json

RUN npm install

COPY . .

ENV NODE_ENV=production
RUN npm run build -w web/app

EXPOSE 3000
CMD ["npm", "run", "start", "-w", "web/app", "--", "-p", "3000"]
