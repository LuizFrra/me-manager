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
- **Both:** Node.js 22.12 or newer, and Claude Code (`claude`) on your PATH.

Full install, build and test steps (for people and coding agents) are in [AGENTS.md](AGENTS.md).

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

## Features

- **Claude look:** warm light and dark themes in Claude's palette, with serif titles. The home screen greets
  you with a composer: say what Claude should work on, pick a repository, press Enter, and a task starts with
  that prompt.
- **Attention:** what is waiting for you is listed on the home screen and counted in the window title; a task
  whose Claude finished while you were elsewhere is marked in the sidebar until you open it.
- **Tasks and sessions:** a git worktree per task, with Claude in a persistent tmux session and extra shell tabs.
  Templates pre-fill new tasks. Tasks can be archived (worktree removed, branch kept) and restored.
- **Terminal:** Ctrl+click (Cmd+click on macOS) opens links in Claude's output: web addresses in the browser,
  `path:line` in the files panel at that line. On Linux, Ctrl+C copies a selection and still interrupts when
  nothing is selected, and Ctrl+V pastes text, or hands an image on the clipboard to Claude. Shift+Enter starts a
  new line in Claude's prompt, Ctrl+Backspace deletes a word, a right click offers Copy and Paste, and files
  dropped on the terminal are typed as their paths. After scrolling back, typing goes to Claude, and "Jump to the
  bottom" returns to the prompt. Emoji line up as tmux draws them, and Claude gets 24-bit colour.
- **Files panel:** a file tree, a code viewer and search. Diffs against the base (unified or split, virtualized
  for large diffs) and rendered Markdown with Mermaid.
- **Review:** select lines in a diff or file, write comments, and paste them into Claude's prompt.
- **Git:** commit, push, open a PR, and update from base (rebase or merge). When an update conflicts, you can
  ask Claude to resolve it.
- **Bulk actions:** push, update, archive or remove several selected tasks at once.
- **Running code:** a run command per repo in a "run" tab. Dev-server URLs it prints become clickable links.
- **Claude usage and estimated cost:** per task and folder, with daily and per-task budgets. Warnings and
  desktop notifications at 80% and 100%.
- **Notifications:** when Claude finishes or needs input.
- **Navigation:** a command palette, keyboard shortcuts, drag-and-drop ordering, a collapsible sidebar, and a
  light, dark or follow-system appearance.

## Scripts

```bash
npm ci               # install dependencies and rebuild node-pty for Electron
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
- `settings.json`: settings (Claude arguments, appearance, budgets, task templates, …)
- `ui-state.json`: what was open, selected and collapsed
- `budget-alerts.json`: which budget notifications were already sent
- `tmux.conf`: tmux config for the app's socket, regenerated on every start
- `prompts/`: short-lived files that hand a new task's first prompt to Claude
- `worktrees/`: the task worktrees

Usage and cost are read (never written) from Claude Code's transcripts in `~/.claude/projects`, or
`$CLAUDE_CONFIG_DIR/projects`.

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
- Selecting text in the terminal with the mouse doesn't change the clipboard;
  copy it with the keys above. A program that copies on purpose (Claude Code's
  `/copy`) still sets the clipboard.

## Known limitations

- The macOS build is unsigned and not notarized. The first time you open it,
  right-click the app and choose **Open**.
- If your home directory isn't a trusted folder in Claude Code, Claude asks
  "Do you trust this folder?" once for each new worktree.
