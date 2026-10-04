# The factory's VM image (experimental): what Claude Code needs to do one
# task on Erga's source, and nothing of the source itself. A task clones the
# repository when it starts (factory/vm/run.ts); the image only makes that
# fast: Bun, Node (Vite runs on it), git, headless Chromium for screenshots,
# the Claude Code CLI, and the repo's dependencies already in Bun's cache, so
# `bun install` in a fresh clone takes seconds.
#
# Built by factory/vm/build.ts, which stages the context (this file,
# package.json, bun.lock and the scripts in factory/vm/) and tags the image
# erga-factory:<hash of those>, so a new lockfile or script makes a new image
# and an unchanged one is reused. Locally Docker runs it; on Cloudflare it is
# the Sandbox's image (README, The factory).
ARG BUN_VERSION=1.4.2
FROM node:24-bookworm-slim AS node

FROM oven/bun:${BUN_VERSION}-debian
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl chromium fonts-liberation fonts-noto-color-emoji socat procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/erga-deps /opt/factory /work \
 && chown -R bun:bun /opt/erga-deps /opt/factory /work

# Not root: Claude Code refuses to skip its permission prompts as root, and the task's code needs no more.
USER bun
WORKDIR /home/bun
ENV PATH=/home/bun/.local/bin:$PATH \
    CHROME=/usr/bin/chromium \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Claude Code, pinned by the build (CLAUDE_CODE_VERSION; its flags and stream-json events change between releases).
ARG CLAUDE_CODE_VERSION=2.1.285
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} && claude --version

# The repo's dependencies, into Bun's cache: a clone's `bun install` then copies them from it.
COPY --chown=bun:bun package.json bun.lock /opt/erga-deps/
RUN cd /opt/erga-deps && bun install --frozen-lockfile && rm -rf /opt/erga-deps/node_modules

COPY --chown=bun:bun scripts/ /opt/factory/
RUN git config --global user.name "Erga factory" && git config --global user.email "factory@erga.dev" \
 && git config --global init.defaultBranch main && git config --global github.user factory

WORKDIR /work
# The agent (factory/vm/agent.ts): runs the factory's jobs when asked, on port 8080.
EXPOSE 8080 4401
CMD ["bun", "/opt/factory/agent.ts"]
