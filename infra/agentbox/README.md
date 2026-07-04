# T3 Agentbox

Containerized T3 Code runtime for `smart.local`.

Goals:

- Keep the in-container path model universal: `/home/patroza`, `/home/patroza/pj`.
- Hide the real host home, backups, and media from agents.
- Keep hot project and worktree IO on host bind mounts for performance.
- Allow future Docker use without mounting the host Docker socket.

## Ports

The host already uses `22` and `8080`, so this compose file defaults to:

- T3 Code: `http://smart.local:18080`
- SSH into agentbox: `ssh -p 2222 patroza@smart.local`
- Optional OpenCode web UI: `http://smart.local:14096`

Change these in `.env`.

## Host Filesystem

Prepare only these host paths. Do not mount `/home/patroza`, `/mnt/backups`, or `/mnt/data*`.

```sh
sudo mkdir -p /srv/t3-agent/{home,projects,state,cache,ssh,docker}
sudo mkdir -p /srv/t3-agent/cache/apt/{archives,lists}
sudo chown -R "$USER:$USER" /srv/t3-agent
install -m 700 -d /srv/t3-agent/ssh
cp ~/.ssh/authorized_keys /srv/t3-agent/ssh/authorized_keys
chmod 600 /srv/t3-agent/ssh/authorized_keys
```

If `/srv/t3-agent` becomes a btrfs filesystem/subvolume later, use subvolumes for:

```text
home
projects
state
cache
docker
snapshots
```

Good mount options for the btrfs filesystem:

```text
noatime,compress=zstd:1,ssd,discard=async,space_cache=v2
```

Keep CoW on for source and worktrees. Consider `chattr +C` only for `cache`, `state`, and `docker` before files are created.

## Build Only

```sh
cd ~/pj/t3code/infra/agentbox
cp .env.example .env
docker compose build
```

This does not start the container.

## Start Later

```sh
cd ~/pj/t3code/infra/agentbox
docker compose up -d t3code
```

Then:

```sh
ssh -p 2222 patroza@smart.local
```

## Retained Package Installs

Fast and persistent:

- `npm install -g ...` goes to `/home/patroza/.local`.
- `pnpm` store/cache goes to `/cache/pnpm`.
- npm cache goes to `/cache/npm`.
- Corepack cache goes to `/cache/corepack`.
- All of those live under `/srv/t3-agent` on the host.

Inside the container:

```sh
npm install -g opencode-ai
pnpm setup
```

System packages are different:

- `sudo apt install ...` works inside the container.
- Installed files are retained while the same container is kept.
- If you recreate/rebuild the container, installed system files are lost.
- apt package downloads/lists are cached under `/srv/t3-agent/cache/apt`, so reinstall is fast.
- Packages you always need should be added to `Dockerfile` so they are image-layer retained and reproducible.

If you want a truly mutable OS with retained system packages and systemd services, use a VM, Incus, or `systemd-nspawn` on a btrfs subvolume instead of plain Docker.

## Optional OpenCode Autostart

Once `opencode` exists in the sandbox home, start it as a separate compose service:

```sh
cd ~/pj/t3code/infra/agentbox
docker compose --profile opencode up -d opencode
```

It shares `/home/patroza`, `/home/patroza/pj`, `.t3`, and caches with T3.

## Optional Isolated Docker For Agents

Do not mount `/var/run/docker.sock`; that is host-root-equivalent.

Instead, start the isolated Docker daemon profile:

```sh
cd ~/pj/t3code/infra/agentbox
T3_AGENT_DOCKER_HOST=tcp://agent-docker:2375 docker compose --profile docker up -d
```

Containers launched by agents then live inside the `agent-docker` service and use `/srv/t3-agent/docker`, not the host Docker daemon.

Tradeoff: the `agent-docker` sidecar is privileged, so for stronger hostile-code isolation use a VM/microVM instead of Docker Compose.
