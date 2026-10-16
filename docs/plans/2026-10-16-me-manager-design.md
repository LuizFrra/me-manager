# me-manager — Design

Date: 2026-10-16

## Goal

An Electron desktop app for organizing work with Claude Code. The user creates
**themes** (named workspaces) and adds **repositories** and **folders** to them.
Work on a repository always happens in a dedicated **git worktree**, so Claude
never edits the user's main checkout. Each worktree ("task") runs the real
`claude` CLI in an embedded terminal, inside tmux so sessions survive the app
being closed.

## Decisions

| Topic | Decision |
|---|---|
| How Claude runs | Embedded terminal running the real `claude` CLI (xterm.js + node-pty) |
| Worktrees per repo | Many per repo, one per task |
| Same repo in several themes | Supported; theme is part of worktree path and branch name |
| Base for new tasks | Freshly fetched `origin/<default-branch>` |
| Session persistence | tmux on a dedicated socket; sessions survive app close |
| Terminals per task | Claude tab + any number of shell tabs (tmux windows) |
| Removing a task | Warn and confirm if uncommitted/unpushed work exists |
| Stack | Electron + TypeScript + React + electron-vite |

## UI

```
┌──────────────────────────┬─────────────────────────────────────────────┐
│ THEMES                 + │ my-api › fix-login-bug                      │
│ ▼ Client X               │ branch: claude/client-x/fix-login-bug       │
│   ▼ 📦 my-api          + ├─────────────────────────────────────────────┤
│      ● fix-login-bug     │ [claude] [shell] [+]                        │
│      ○ add-rate-limit    ├─────────────────────────────────────────────┤
│   ▶ 📁 contracts         │                                             │
│ ▼ Side projects          │        (xterm.js attached to tmux)          │
│   ▼ 📦 my-api          + │                                             │
│      ○ experiment        │                                             │
└──────────────────────────┴─────────────────────────────────────────────┘
● session running   ○ worktree exists, no session   ⚠ path missing
```

## Architecture

### Processes

- **Main (Node)**: owns all system access, split into services:
  - `StoreService`: reads and writes `state.json` (atomic write + `.bak`).
  - `GitService`: wraps the `git` CLI (fetch, default branch, worktree
    add/remove, status, unpushed check).
  - `TmuxService`: runs tmux on its own socket (`tmux -L me-manager -f
    ~/.me-manager/tmux.conf`); creates, lists and kills sessions and windows.
  - `PtyService`: spawns `tmux attach` via node-pty and streams bytes over IPC.
- **Preload**: exposes a typed `window.api` over IPC. No Node access in the UI.
- **Renderer (React)**: sidebar, task header, tab bar, xterm.js view. Holds UI
  state only.

### Data on disk

```
~/.me-manager/
  state.json
  state.json.bak
  tmux.conf                      # status bar off, mouse on
  worktrees/<theme>/<repo>/<task>/
```

### State

```ts
Theme  { id, name, slug, items: Item[] }
Item   = Repo   { id, kind: 'repo',   name, slug, path, tasks: Task[] }
       | Folder { id, kind: 'folder', name, slug, path }
Task   { id, name, slug, branch, worktreePath, baseRef, createdAt }
```

- Slugs are derived from names. They must be unique among themes, among items
  within a theme, and among tasks within a repo.
- Branch: `claude/<theme>/<task>`.
- tmux session name (computed, not stored): `mm_<theme>_<repo>_<task>`, or
  `mm_<theme>_folder_<folder>` for folders.
- Live status (session alive, paths exist) is computed at startup and refreshed
  every few seconds. It is never saved to disk.

## Flows

### Create task
1. Slugify the name and check it is unique within the theme and repo.
2. `git fetch origin`; find the default branch with `git symbolic-ref
   refs/remotes/origin/HEAD`, then try `origin/main`, then `origin/master`. If
   the repo has no remote, use the local default branch.
3. `git worktree add <worktreePath> -b claude/<theme>/<task> <baseRef>`
4. `tmux new-session -d -s <session> -c <worktreePath> -n claude claude`
5. Save to state and open the task.

If any step fails, undo the earlier steps and show git's error message.

### Open task / folder
- If the session exists, attach to it.
- If not (after a reboot, or Claude exited), create the session with
  `claude --continue`, then attach.
- One embedded terminal; switching tasks re-attaches it to a different session.
  All sessions keep running in the background.

### Tabs
- Each tab is a tmux window. The tab bar comes from `tmux list-windows`.
- Clicking a tab runs `select-window`; `+` runs `new-window -c <worktreePath>`;
  closing a tab kills that window.
- If the Claude window was closed or Claude exited, show a "Restart Claude"
  button, which runs `claude --continue`.

### Remove task
1. Check `git status --porcelain`, plus unpushed commits (`@{u}..HEAD`, or
   commits not on `origin/<default>` if there is no upstream).
2. If anything would be lost, list it and ask for confirmation.
3. Kill the session, run `git worktree remove --force`, and optionally
   `git branch -D`.
4. Remove the task from state.

### Remove repo / folder / theme
Blocked while the repo or theme still has tasks. The user's original repo is
never modified.

## Error handling

- **Startup check** for `git`, `tmux` and `claude`; if one is missing, a
  blocking screen gives install instructions.
- **PATH**: read the login shell's PATH once at startup (`$SHELL -lc 'echo
  $PATH'`), because GUI-launched Electron has a reduced PATH.
- **Repo path missing**: ⚠ in the sidebar; a "Relocate" action updates the
  path, and the user runs `git worktree repair`.
- **Worktree missing**: ⚠ in the sidebar; "Recreate from branch" or "Forget
  task".
- **tmux sessions not created by the app** are ignored.
- **Failed git or tmux commands**: one exec helper captures stderr; the UI
  shows a toast with the real error.
- **Folder trust**: worktrees live under `$HOME`, which is already trusted, so
  Claude shows no trust prompt (verified).

## Testing

- **Unit (Vitest)**: slug and uniqueness rules, naming, state changes.
- **Integration (Vitest)**: `GitService` and `TmuxService` against real
  temporary repos and a per-run tmux socket:
  - create a task → worktree and branch exist
  - remove a task → unsaved work is detected
  - restart → live sessions are found
- **UI**: manual check plus an end-to-end launch check. Playwright later.

## Out of scope (v1)

Diff panel, commit/merge/PR buttons, open in editor, archive, drag-and-drop
reordering.

## Prerequisites

`sudo apt install tmux`
