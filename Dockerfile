# syntax=docker/dockerfile:1

# ---- build (never shipped) ----
# Official Node 24 on Debian 13 "trixie": same Node major and glibc as the distroless runtime,
# so native modules built here load at runtime.
# Image scanners flag this line (2026-10-14: 0 critical / 9 high). Those findings are in the npm
# CLI bundled with the image (we use Yarn) and one unfixed Debian zlib issue. None of it is copied
# into the runtime image: only dist/, production node_modules and package.json are.
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build \
  && yarn install --frozen-lockfile --non-interactive --production \
  && yarn cache clean

# ---- runtime: distroless Node.js (no shell, no package manager), non-root user ----
# Scanned 2026-10-14 with Docker Scout: 0 critical / 0 high / 0 medium / 0 low.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
# The image's entrypoint is the node binary, so CMD holds only node's arguments.
CMD ["--enable-source-maps", "dist/bootstrap/main.js"]
