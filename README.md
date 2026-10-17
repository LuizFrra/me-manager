# me-manager

A desktop app for Linux and macOS that organizes Claude Code work into
**themes**. You add git repos and plain folders to a theme, then open tasks on
a repo. Each task gets its own git worktree and branch, and runs `claude` in a
persistent tmux session that the app shows in a built-in terminal. Closing the
app doesn't stop anything, so you can reopen it, or attach from any terminal,
and pick up where you left off.

## Prerequisites

- **Linux:** `sudo apt install tmux git build-essential`
- **macOS:** `xcode-select --install && brew install tmux`
- **Both:** Node.js 20 or newer, and Claude Code (`claude`) on your PATH.

`build-essential` and the Xcode Command Line Tools are needed because
`npm install` rebuilds node-pty for Electron.

### Linux: Electron sandbox in development

Ubuntu 23.10 and newer restrict unprivileged user namespaces, so `npm run dev`
aborts with a `chrome-sandbox` error. After **every** `npm install` or `npm ci`,
run:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

The packaged builds handle this themselves:

- The **.deb** installs an AppArmor profile for the app, so it runs sandboxed.
- The **AppImage** falls back to `--no-sandbox` when user namespaces aren't
  available. It also needs FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu
  24.04, or `libfuse2` on older releases). Without FUSE, you can still run it
  with `--appimage-extract-and-run`.
- **`dist/linux-unpacked/me-manager`** does neither. Run it with `--no-sandbox`.

## Scripts

```bash
npm install          # install dependencies and rebuild node-pty for Electron
npm run dev          # run the app with hot reload
npm test             # run the unit tests (vitest)
npm run typecheck    # type-check main, preload and renderer
npm run build        # type-check and bundle into out/

npm run build:linux  # AppImage and .deb in dist/
npm run build:mac    # dmg for arm64 and x64 in dist/ (must run on a Mac)
npm run build:unpack # unpacked app in dist/, for quick checks
```

## How it works

- **Themes** hold **repos** and **folders**.
  - A **folder** gets a single Claude session, which runs directly in that
    folder.
  - A **repo** holds **tasks**.
- **A task** is a git worktree at
  `~/.me-manager/worktrees/<theme>/<repo>/<task>`, on the branch
  `claude/<theme>/<task>`. That branch starts from `origin/<default branch>`,
  fetched just before the worktree is created. If the fetch fails, the task
  branches from the refs you last fetched.
- **Sessions** run in tmux on a dedicated socket, `me-manager`, so they don't
  mix with your own tmux sessions. They outlive the app. To list them or attach
  from any terminal:

  ```bash
  tmux -L me-manager ls
  tmux -L me-manager attach -t <session>
  ```

  Task sessions are named `mmt_<theme>_<repo>_<task>`, and folder sessions are
  named `mmf_<theme>_<folder>`.

## Data

Everything lives in `~/.me-manager`:

- `state.json`: themes, repos, folders and tasks
- `tmux.conf`: tmux config for the app's socket, regenerated on every start
- `worktrees/`: the task worktrees

### Environment overrides

- `ME_MANAGER_HOME`: use a different data directory instead of `~/.me-manager`
- `ME_MANAGER_TMUX_SOCKET`: use a different tmux socket name instead of
  `me-manager`

For example, to try a build without touching your real sessions:

```bash
ME_MANAGER_HOME=/tmp/mm-test ME_MANAGER_TMUX_SOCKET=mm-test npm run dev
```

## Shortcuts

- **Linux:** copy and paste in the terminal are Ctrl+Shift+C and Ctrl+Shift+V.
  The app has no menu bar, so Ctrl+C and Ctrl+R always reach the terminal.
- **macOS:** copy and paste are Cmd+C and Cmd+V. Ctrl+C still reaches the
  terminal.

## Known limitations

- The macOS build is unsigned and not notarized. The first time you open it,
  right-click the app and choose **Open**.
- If your home directory isn't a trusted folder in Claude Code, Claude asks
  "Do you trust this folder?" once for each new worktree.
