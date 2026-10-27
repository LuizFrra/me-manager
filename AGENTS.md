# Agent guide: install, build, test and run me-manager

This file is for coding agents (Claude Code, Codex, etc.) and for people setting up a machine. It covers Linux
and macOS. Follow it top to bottom on a fresh machine; every command here was run on the setup described in
[Tested with](#tested-with).

me-manager is an Electron + React + TypeScript desktop app. It organizes Claude Code work into themes. Each repo
task is a git worktree with a persistent tmux session running `claude`. See [README.md](README.md) for what it
does.

## 1. Prerequisites

| Tool                       | Version                                           | Why                                                     |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Node.js                    | **22.12 or newer** (Electron 44 and Vite need it) | build, tests                                            |
| npm                        | comes with Node (10+)                             | install                                                 |
| git                        | recent (2.40+)                                    | the app and its tests run real git                      |
| tmux                       | **3.2 or newer** (`new-session -e`)               | the app's sessions; some tests start a real tmux server |
| C/C++ toolchain + Python 3 | Linux only, see below                             | `node-pty` is compiled from source on Linux             |
| `claude` (Claude Code CLI) | any                                               | only to _use_ the app; **not** needed to build or test  |

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y git tmux build-essential python3 curl
# Node.js 22+ via nvm (any other way to get Node >= 22.12 is fine):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install        # reads .nvmrc (Node 22)
```

Fedora: `sudo dnf install -y git tmux gcc-c++ make python3`. Arch: `sudo pacman -S git tmux base-devel python`.

To _launch_ Electron (not needed for tests or the build) a desktop session or `xvfb-run` is required, with the
usual Electron runtime libraries (present on any desktop install; on a bare server:
`sudo apt install -y libnss3 libgtk-3-0 libasound2t64 libgbm1 xvfb`, use `libasound2` before Ubuntu 24.04).

### macOS

```bash
xcode-select --install            # compilers and git; skip if already installed
brew install node@22 tmux git     # or any Node >= 22.12 (nvm works too: `nvm install`)
```

On macOS `node-pty` ships prebuilt binaries, but the Xcode Command Line Tools are still needed for
`electron-builder install-app-deps` and git.

## 2. Install

```bash
git clone <repo url> me-manager && cd me-manager
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins. Its `postinstall` downloads the Electron binary (network
access to GitHub is required) and rebuilds `node-pty` for Electron. Use `npm ci`, not `npm install`, unless you
are deliberately changing dependencies.

### Linux only: Electron's sandbox for `npm run dev`

Ubuntu 23.10+ restricts unprivileged user namespaces, so `npm run dev` aborts with a `chrome-sandbox` error.
After **every** `npm ci`/`npm install`, run:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

This needs sudo, so an agent must ask its human to run it. Tests and builds don't need it. Consequence: in a
checkout where this was done, **don't run `npm ci`/`npm install` again** without asking, because it resets the
file and `npm run dev` breaks until the commands are run again. Work in a separate git worktree with its own
`npm ci` instead.

## 3. Verify: the gates

Run all of these; every change must leave them passing:

```bash
npm test                               # vitest: node project (main/shared) + jsdom project (renderer)
npm run typecheck                      # tsc for main/preload and for the renderer
npx eslint src --max-warnings=0        # lint, zero warnings
npx prettier --check src               # formatting (fix with: npx prettier --write src)
npm run build                          # typecheck + bundle into out/
```

Test notes:

- Some tests run **real git and real tmux** on private, uniquely named sockets that they kill afterwards. They
  never touch `~/.me-manager` or the `me-manager` tmux socket.
- `vitest.config.ts` points `TMPDIR` at one folder per run and deletes it at the end
  (`src/main/test/globalTmp.ts`). On machines where `/tmp` is a small tmpfs, don't bypass this.
- On a heavily loaded machine (several suites in parallel) a slow jsdom test can time out; rerun that file alone
  (`npx vitest run path/to/file.test.tsx`) before assuming a regression.

## 4. Run

```bash
npm run dev      # hot reload; needs a display (and the Linux sandbox step above)
npm start        # preview the production bundle in out/
```

### Running the app safely as an agent

The real app uses `~/.me-manager`, the `me-manager` tmux socket and starts the real `claude` CLI in every task.
An agent must **never** do that. Always isolate:

```bash
ME_MANAGER_HOME="$SCRATCH/home" \
ME_MANAGER_TMUX_SOCKET="mm-agent-$$" \
npx electron . --remote-debugging-port=9333     # after npm run build
# afterwards: tmux -L "mm-agent-$$" kill-server
```

Putting a fake `claude` first on `PATH` is **not enough**: at startup the app replaces `PATH` with the one from
your login shell (`$SHELL -ilc`, see `src/main/shellEnv.ts`), which finds the real `claude` again. Also fake the
shell:

```bash
mkdir -p "$SCRATCH/fakebin"
cat > "$SCRATCH/fakebin/claude" <<'EOF'
#!/bin/sh
# Stand-in for the claude CLI: answers the startup check, then echoes input.
if [ "$1" = "--version" ]; then echo "0.0.0 (fake claude)"; exit 0; fi
echo "fake claude $*"
exec cat
EOF
cat > "$SCRATCH/fakebin/fakeshell" <<'EOF'
#!/bin/bash
# Never a login or interactive shell, so no profile can put the real claude back on PATH.
args=()
for a in "$@"; do case "$a" in -ilc|-lic|-lc|-cl|-ic|-ci) args+=(-c) ;; -l|-i|--login) ;; *) args+=("$a") ;; esac; done
exec /bin/bash --noprofile --norc "${args[@]}"
EOF
chmod +x "$SCRATCH/fakebin/claude" "$SCRATCH/fakebin/fakeshell"

SHELL="$SCRATCH/fakebin/fakeshell" PATH="$SCRATCH/fakebin:$PATH" \
CLAUDE_CONFIG_DIR="$SCRATCH/claude" \
ME_MANAGER_HOME="$SCRATCH/home" ME_MANAGER_TMUX_SOCKET="mm-agent-$$" \
npx electron . --remote-debugging-port=9333
```

Before interacting, check what each session runs:
`tmux -L mm-agent-$$ list-panes -a -F '#{session_name} #{pane_pid}'` then `ps -o args= --ppid <pid>`; it must be
the fake (`cat`), never `claude`.

- `CLAUDE_CONFIG_DIR` keeps the usage/budget views from reading your real `~/.claude`.
- Budget alerts still raise real desktop notifications.
- Drive and screenshot the UI through the Chrome DevTools Protocol on the debugging port
  (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.insertText`, `Page.captureScreenshot`).
- Use a different port per parallel launch.
- Stop the app by PID found with `pgrep -f "[r]emote-debugging-port=9333"`. The brackets matter: an unbracketed
  `pkill -f` pattern matches your own shell command and kills it.

Other environment variables: `ME_MANAGER_HOME` (default `~/.me-manager`), `ME_MANAGER_TMUX_SOCKET` (default
`me-manager`), `CLAUDE_CONFIG_DIR` (default `~/.claude`, read-only).

## 5. Package

```bash
npm run build:linux    # dist/: AppImage and .deb (run on Linux)
npm run build:mac      # dist/: .dmg for arm64 and x64 (must run on macOS; unsigned, not notarized)
npm run build:unpack   # dist/*-unpacked: quick local check
```

- **.deb:** install with `sudo apt install ./dist/me-manager_<version>_amd64.deb`. It installs an AppArmor
  profile, so it runs sandboxed.
- **AppImage:** needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04+, `libfuse2` before). Otherwise run it with
  `--appimage-extract-and-run`.
- **`dist/linux-unpacked/me-manager`:** run it with `--no-sandbox`.
- **macOS:** the first time, right-click the app and choose **Open**, because it is unsigned.

## 6. Project map

| Path                                            | What                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `src/shared/types.ts`                           | `MeManagerApi` (everything the renderer can call), state and settings types |
| `src/shared/ipc.ts`                             | `INVOKE_METHODS`: the IPC allow-list                                        |
| `src/main/contracts.ts`                         | `AppService` and the injected deps (`GitApi`, `TmuxApi`, `PtyApi`, …)       |
| `src/main/app/orchestrator.ts`                  | the app's logic; `fakes.ts` next to it has the test doubles                 |
| `src/main/{git,tmux,files,usage,notify,store}/` | services behind the contracts                                               |
| `src/preload/`                                  | exposes a generic `window.api`                                              |
| `src/renderer/src/`                             | React UI; `api/mockApi.ts` is the in-memory API used by renderer tests      |
| `docs/plans/`, `docs/features-backlog.md`       | designs and the feature log                                                 |

Adding an API method touches, in order:

1. `MeManagerApi` in `types.ts`;
2. `INVOKE_METHODS` in `ipc.ts`;
3. the orchestrator (with tests using `fakes.ts`);
4. `mockApi.ts`;
5. the renderer (with Testing Library tests).

Security rules in the code:

- **Commands:** run with `execFile`, never a shell. Quoting goes through `src/shared/shell.ts`.
- **Paths:** confined with `safePath`.
- **Markdown:** rendered without raw HTML. Mermaid runs with `securityLevel: 'strict'`.
- **Links:** go through `isHttpUrl`. The CSP allows only `script-src 'self'`.

## 7. Rules for agents

- Never touch `~/.me-manager`, the `me-manager` tmux socket or `~/.claude` from tests or launches.
- Never start the real `claude` CLI.
- Write tests first. Keep all gates passing. Match the surrounding code's style and comment density.

## Troubleshooting

| Symptom                                                                      | Fix                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev` exits with a `chrome-sandbox` / `setuid sandbox` error (Linux) | the sudo step in section 2                                                              |
| `npm ci` fails building `node-pty` (`gyp`, `make`, `g++` not found)          | install the toolchain: `build-essential python3` (Linux), Xcode CLT (macOS)             |
| `npm ci` fails downloading Electron                                          | network/proxy; Electron honours `ELECTRON_MIRROR`                                       |
| `posix_spawnp failed` when opening a terminal (macOS)                        | `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`                        |
| The app shows "Missing tools"                                                | install `git`, `tmux` and `claude` so your login shell finds them                       |
| `ENOSPC` in tests                                                            | `/tmp` is full; remove stale `/tmp/mm*` folders (only ones older than any running test) |

## Tested with

Ubuntu (Linux 6.17), Node 25.3, npm 11.6, git 2.51, tmux 3.5a, Python 3.13: fresh clone, `npm ci`, all gates
green. macOS was not available for testing; the macOS steps follow the same toolchain and the packaging config
(`electron-builder.yml`), which targets arm64 and x64.
