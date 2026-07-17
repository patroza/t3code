FROM node:24-bookworm AS build

WORKDIR /opt/t3code
ENV CI=1

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vite.config.ts ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages
COPY oxlint-plugin-t3code ./oxlint-plugin-t3code
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @t3tools/web build
RUN pnpm --filter t3 build:bundle
RUN pnpm deploy --filter t3 --prod /opt/t3code-runtime

FROM node:24-bookworm-slim AS runtime

ARG T3_AGENT_UID=1000
ARG T3_AGENT_GID=1000

ENV NODE_ENV=production
ENV T3_AGENT_UID=${T3_AGENT_UID}
ENV T3_AGENT_GID=${T3_AGENT_GID}
ENV HOME=/home/patroza
ENV T3CODE_HOME=/home/patroza/.t3
ENV XDG_CACHE_HOME=/cache/xdg
ENV NPM_CONFIG_CACHE=/cache/npm
ENV NPM_CONFIG_PREFIX=/home/patroza/.local
ENV PNPM_HOME=/cache/pnpm
ENV COREPACK_HOME=/cache/corepack
ENV PATH=/cache/pnpm:/home/patroza/.local/bin:/opt/t3code/node_modules/.bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    docker.io \
    git \
    gosu \
    jq \
    less \
    openssh-client \
    openssh-server \
    procps \
    ripgrep \
    sudo \
    tini \
    zsh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/t3code-runtime /opt/t3code
COPY infra/agentbox/entrypoint.sh /usr/local/bin/t3-agentbox-entrypoint

RUN chmod 0755 /usr/local/bin/t3-agentbox-entrypoint \
  && mkdir -p /home/patroza /cache /run/sshd \
  && groupadd --gid "${T3_AGENT_GID}" agent \
  && useradd --uid "${T3_AGENT_UID}" --gid "${T3_AGENT_GID}" --home-dir /home/patroza --shell /usr/bin/bash patroza \
  && usermod -aG sudo patroza \
  && printf 'patroza ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/patroza \
  && chmod 0440 /etc/sudoers.d/patroza \
  && chown -R "${T3_AGENT_UID}:${T3_AGENT_GID}" /home/patroza /cache

EXPOSE 22 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-agentbox-entrypoint"]
