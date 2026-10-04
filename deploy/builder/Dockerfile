# The builder's container (deploy/builder/worker.ts): Bun, Node (Vite runs
# on it) and Git, and the build server. Each build clones the commit afresh
# (build.ts), so the image holds no source.
FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates nodejs && rm -rf /var/lib/apt/lists/*
WORKDIR /builder
COPY build.ts server.ts ./
ENV PORT=8080 WORK=/tmp/erga-build
EXPOSE 8080
CMD ["bun", "server.ts"]
