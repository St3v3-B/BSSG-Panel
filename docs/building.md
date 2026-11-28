# Building BSSG Panel (Ubuntu and Windows)

This guide builds BSSG Panel from source. To install it on a server, follow [installation.md](installation.md); the
installer builds everything for you. Use this guide when you want to develop, run the checks, or build the parts yourself.

| You want to | Ubuntu | Windows |
|---|---|---|
| Work on the UI against the mock (no daemon, no database) | yes | yes, native or in WSL |
| Build the panel image and the daemon binary | yes | yes, native (cross-compiled) or in WSL |
| Run `make check`, the integration and browser tests | yes | only in WSL 2 |
| Run a real panel with the daemon and game servers | yes (production) | only in WSL 2, for testing |

The daemon is Linux-only: it needs Docker, a unix socket and systemd. Production always runs on Linux (Ubuntu 24.04 is
the tested target). Windows is fine for development and for building.

## What gets built

| Part | Source | Result |
|---|---|---|
| Panel (Next.js) | `apps/web/` | Docker image built from `deploy/panel.Dockerfile`, also embeds daemon binaries for remote nodes |
| Node daemon (Go) | `daemon/` | static Linux binary `panel-daemon` (amd64 or arm64) |
| Caddy | `deploy/caddy/` | Docker image `panel-caddy:local` |
| phpMyAdmin | `deploy/phpmyadmin/` | Docker image `panel-phpmyadmin:local` |

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Git | any recent | |
| Node.js | 22 or newer | |
| pnpm | 12 (the exact version is in `package.json`, `packageManager`) | install with `corepack enable` |
| Go | 1.26 or newer (see `daemon/go.mod`) | only for building the daemon outside Docker |
| Docker | Engine 24+ with the Compose plugin (Ubuntu) or Docker Desktop (Windows) | for images, database tests and Docker-backed tests |
| TypeScript | 5.9, comes with `pnpm install` | not 7 |

---

## Ubuntu (22.04 or 24.04)

### 1. Install the toolchain

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential

# Docker Engine + Compose plugin (official repository)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # log out and in again afterwards

# Node.js 22 (NodeSource) and pnpm via corepack
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable

# Go (check https://go.dev/dl/ for the current 1.26.x or newer)
GO_VERSION=1.26.0
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile && source ~/.profile
```

Check:

```bash
node -v && pnpm -v && go version && docker compose version
```

### 2. Get the code and install dependencies

```bash
git clone https://github.com/St3v3-B/BSSG-Panel.git
cd BSSG-Panel
pnpm install
```

### 3. Develop against the mock

```bash
make dev                      # http://localhost:3000, sample data, no daemon or database
MOCK_ROLE=user make dev       # other roles: admin (default), user, pending, anonymous
```

### 4. Run the checks

```bash
make check
```

This runs the OpenAPI lint, typecheck and tests for all TypeScript packages, `gofmt`/`go vet`/`go build`/`go test` for the
daemon, and a migration run on an empty PostgreSQL. Several daemon tests start real (small) containers, so Docker must be
running. Some Go tests need root (network and quota tests); CI runs `sudo make check`.

Extra test suites:

```bash
make integration    # real panel + daemon + Docker, API level (starts a Minecraft server: needs about 2 GB free RAM)
make e2e            # browser tests with Playwright
deploy/test.sh      # shellcheck, compose validation, template smoke tests
```

### 5. Build the parts

**Daemon binary**

```bash
cd daemon
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/panel-daemon ./cmd/panel-daemon
# for an ARM machine (Raspberry Pi 4/5, Ampere):
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o bin/panel-daemon-arm64 ./cmd/panel-daemon
cd ..
```

**Panel production build (without Docker)**

```bash
pnpm --filter @panel/web build      # output in apps/web/.next (standalone)
```

**Panel Docker image** (what the installer uses; run from the repository root)

```bash
docker build -f deploy/panel.Dockerfile -t bssg-panel:local .
```

**All images at once**, exactly like production:

```bash
docker compose -f deploy/docker-compose.yml build
```

### 6. Install what you built

```bash
sudo deploy/install.sh                                      # builds and installs everything
sudo deploy/install.sh --daemon-bin daemon/bin/panel-daemon # reuse the daemon you just built
sudo deploy/install.sh --dry-run                            # show what it would do, change nothing
```

See [installation.md](installation.md) for the questions it asks, DNS and Discord setup.

---

## Windows 10/11

There are two ways. **WSL 2 is recommended**: you get the full Linux toolchain, all tests work and the scripts run
unchanged. The native route is enough to work on the UI and to build images and the daemon binary.

### Option A (recommended): WSL 2 with Ubuntu

1. Open PowerShell **as administrator** and install WSL with Ubuntu:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

   Restart when asked, open **Ubuntu** from the Start menu and create a Linux user.

2. Docker, pick one:
   - **Docker Desktop** for Windows: Settings, *Resources, WSL integration*, enable it for *Ubuntu-24.04*. Do not
     install Docker inside Ubuntu as well.
   - Or **Docker Engine inside WSL** (no Docker Desktop): first enable systemd in WSL by putting this in
     `/etc/wsl.conf` inside Ubuntu, then run `wsl --shutdown` in PowerShell and reopen Ubuntu:

     ```ini
     [boot]
     systemd=true
     ```

     Then install Docker with the Ubuntu steps above (`get.docker.com`).

3. In the Ubuntu terminal, follow the **Ubuntu** section from step 1 (skip the Docker line if you use Docker Desktop).

4. **Clone inside the Linux filesystem**, not under `/mnt/c/...`:

   ```bash
   cd ~ && git clone https://github.com/St3v3-B/BSSG-Panel.git
   ```

   On `/mnt/c` file watching is slow, `pnpm install` takes much longer and file permissions break the shell scripts.

5. Open the code in VS Code from Windows with the *WSL* extension: run `code .` in the Ubuntu terminal inside the
   repository.

6. `make dev` is reachable from Windows at `http://localhost:3000`.

Running a real panel with the daemon inside WSL works for testing, with WSL's systemd enabled (step 2). It is not meant
for production: WSL stops when Windows sleeps, and exposing ports 80/443 to the internet from WSL is awkward.

### Option B: native Windows (PowerShell)

Install the tools:

```powershell
winget install Git.Git OpenJS.NodeJS.LTS GoLang.Go Docker.DockerDesktop
corepack enable
```

Use Node 22 or newer (`node -v`); if winget gives an older LTS, install 22 from nodejs.org. Restart PowerShell
afterwards so the new `PATH` applies.

**Line endings.** The shell scripts must keep LF line endings. The repository has a `.gitattributes` that enforces this,
but set Git to not convert anything to be safe, **before cloning**:

```powershell
git config --global core.autocrlf input
git clone https://github.com/St3v3-B/BSSG-Panel.git
cd BSSG-Panel
pnpm install
```

**UI development against the mock.** The `dev` script uses Unix-style environment variables, so start Next.js directly
in PowerShell:

```powershell
cd apps/web
node copy-monaco.mjs
$env:PANEL_MOCK = "1"; $env:NEXT_PUBLIC_PANEL_MOCK = "1"; $env:MOCK_ROLE = "admin"
pnpm exec next dev -p 3000
```

**Typecheck and unit tests** (TypeScript only):

```powershell
pnpm -r --if-present typecheck
pnpm --filter @panel/web test
```

`make check` itself, the database migration test, the Docker-backed Go tests, `make integration` and `make e2e` need
bash and Linux Docker; run those in WSL.

**Build the daemon for Linux** (cross-compile; the result does not run on Windows):

```powershell
cd daemon
$env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "amd64"
go build -trimpath -ldflags "-s -w" -o bin/panel-daemon ./cmd/panel-daemon
Remove-Item Env:GOOS, Env:GOARCH
cd ..
```

Copy `daemon/bin/panel-daemon` to your Ubuntu server and install it with `sudo deploy/install.sh --daemon-bin <path>`.

**Build the images** with Docker Desktop running (Linux containers mode), from the repository root:

```powershell
docker build -f deploy/panel.Dockerfile -t bssg-panel:local .
docker compose -f deploy/docker-compose.yml build
```

To get an image you built on Windows onto your server without a registry:

```powershell
docker save bssg-panel:local -o bssg-panel.tar
scp bssg-panel.tar user@your-server:/tmp/
# on the server: docker load -i /tmp/bssg-panel.tar
```

Normally you do not need this: running `sudo deploy/install.sh` on the server builds the same image there.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `bash\r: No such file or directory` or `$'\r': command not found` | The scripts got Windows line endings. In the repo: `git config core.autocrlf input`, then `git rm --cached -r . && git reset --hard`. |
| `pnpm: command not found` | `corepack enable` (as admin/sudo), then open a new terminal. |
| `go: go.mod requires go >= 1.26` | Your Go is too old. Install the version from `daemon/go.mod` or newer, or let the installer build the daemon in a container. |
| `permission denied ... /var/run/docker.sock` | Add yourself to the `docker` group (`sudo usermod -aG docker $USER`) and log in again. |
| Go tests fail with `operation not permitted` | Those tests need root: `sudo make check` (as CI does). |
| `make dev` keeps reloading the page | Stop it, delete `apps/web/.next/dev/cache` and start again. |
| Docker Desktop: `no matching manifest for windows/amd64` | Switch Docker Desktop to *Linux containers*. |
| WSL is slow or `pnpm install` takes ages | The repository is on `/mnt/c`. Clone it in your Linux home (`~`). |
| Integration test fails with out-of-memory | It starts a Minecraft server; give WSL more memory in `%UserProfile%\.wslconfig` (`[wsl2]` then `memory=6GB`). |
