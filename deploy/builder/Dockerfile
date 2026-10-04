# The builder's container (deploy/builder/worker.ts): Bun, Node 22 (Vite and cf build run
# on it) and Git, and the build server. Each build clones the commit afresh
# (build.ts), so the image holds no source.
FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# Node 22 or newer (the cf CLI's `cf build` refuses older; Debian's nodejs is 20): the official image's binary.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /builder
COPY build.ts server.ts ./
ENV PORT=8080 WORK=/tmp/erga-build
EXPOSE 8080
CMD ["bun", "server.ts"]
