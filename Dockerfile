# Claude made this. I don't really care much about the Dockerfile.

# syntax=docker/dockerfile:1

ARG NODE_VERSION=24.12.0

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Full dependency tree, including devDependencies (tsc, prisma CLI).
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# `pnpm build` is `prisma generate && tsc`. Generate must precede tsc because
# the client is emitted into src/generated and compiles as part of the program.
FROM deps AS build
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm build

# Runtime dependencies only — no tsc, no prisma CLI.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Migration runner. Build with `--target migrate` and run as a release step;
# it needs the prisma CLI and schema, which the runtime image deliberately lacks.
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node

# Documentation only. The Express API on this port has no authentication —
# bind it to a private network, do not publish it to the internet.
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
