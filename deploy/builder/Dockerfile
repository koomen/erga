# The builder's container (deploy/builder/worker.ts): Bun, Node 22 (Vite and cf build run
# on it) and Git, and the build server. Each build clones the commit afresh
# (build.ts), so the image holds no source.
#
# Its Bun is worker.ts's BUILDER_BUN, which names the release cache's toolchain
# (tests/pipeline.test.ts keeps the two equal).
FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# Node 22 or newer (the cf CLI's `cf build` refuses older; Debian's nodejs is 20): the official image's binary.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# The repo's dependencies, into Bun's cache (as factory/vm/Dockerfile does): a build's `bun install
# --frozen-lockfile` then copies them from it and fetches only what the commit's lockfile has that this one didn't.
# It's only a cache: the commit's own lockfile decides what's installed, so a changed lockfile is still right
# (just slower, until the builder is deployed again). deploy/setup.ts puts the checkout's package.json and
# bun.lock in deps/ for the image's build (deps/ isn't committed).
COPY deps/package.json deps/bun.lock /opt/erga-deps/
RUN cd /opt/erga-deps && bun install --frozen-lockfile --ignore-scripts && rm -rf /opt/erga-deps
WORKDIR /builder
COPY build.ts server.ts ./
ENV PORT=8080 WORK=/tmp/erga-build
EXPOSE 8080
CMD ["bun", "server.ts"]
