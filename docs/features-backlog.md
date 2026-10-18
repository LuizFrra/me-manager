# Feature Backlog (Ralph loop)

Features are added **one at a time**. Each one:

- is built test-first
- must pass all gates: `npm test`, `npm run typecheck`, `npm run build`,
  `npx eslint src` with 0 errors
- gets its own commit on `main`

Status: `todo` · `doing` · `done (<sha>)` · `dropped (<reason>)`.

**Rules:**

- Keep the app safe:
  - path confinement
  - no shell interpolation of user input
  - no raw HTML
  - http(s)-only external links
- Keep both platforms working (Linux and macOS).
- Never touch `~/.me-manager` or the `me-manager` tmux socket in tests or
  launch checks. Use `ME_MANAGER_HOME` and `ME_MANAGER_TMUX_SOCKET`.
- Don't run `npm ci` in the main checkout. It resets the Linux `chrome-sandbox`
  permissions; use `npm install` only if dependencies change.

| # | Feature | Area | Status |
|---|---|---|---|
| 0 | Fix findings from the file-viewer code review | quality | done (9d73c69..97b9447) |
| 1 | Lazy-load the Markdown viewer and highlight.js, shrinking the 2.2 MB startup bundle | perf | done (139b497) |
| 2 | Pause polling while the window is hidden or minimized, using `visibilitychange` | perf | done (32c97b7) |
| 3 | Command palette (Ctrl/Cmd+K): fuzzy jump to any task, folder, or file of the current task, and run app actions | ux | done (8561443) |
| 4 | Keyboard shortcuts: Ctrl/Cmd+1..9 to switch tasks, Ctrl/Cmd+Shift+T for a new shell tab, Ctrl/Cmd+Shift+W to close a tab, Ctrl/Cmd+Shift+[ / ] to switch tabs, Ctrl/Cmd+/ to show a shortcut help overlay | ux | done (b082539) |
| 5 | Sidebar filter box: filter themes, repos and tasks by name | ux | done (d5dc635) |
| 6 | Rename a theme or task (display name only; slug, branch and path stay unchanged) | feature | todo |
| 7 | Task notes: a free-text description per task, shown in the header and editable | feature | todo |
| 8 | Copy actions: copy the branch name, worktree path, or `tmux attach` command | ux | todo |
| 9 | Open the task in an external editor (VS Code, or `$EDITOR`, set in Settings) or the system file manager | feature | todo |
| 10 | Git status per task: commits ahead of the base, and the uncommitted file count, shown as a sidebar badge and in the header | feature | todo |
| 11 | Claude activity indicator: busy, waiting or idle per task, based on tmux pane activity, shown in the sidebar | feature | todo |
| 12 | Desktop notification when a background task's Claude finishes or waits for input | feature | todo |
| 13 | New task: choose the base branch (dropdown, defaulting to origin's default) and an optional initial prompt passed to `claude` | feature | todo |
| 14 | Settings screen: extra `claude` args (e.g. `--model`), editor command, poll interval, terminal font size, notifications toggle | feature | todo |
| 15 | Terminal zoom: Ctrl/Cmd +/−/0 changes the font size, which is remembered | ux | todo |
| 16 | Git actions per task: commit all (with a message), push the branch, and open a PR via `gh` if it's installed | feature | todo |
| 17 | Update the task from base: fetch, then rebase or merge `origin/<default>` into the task branch, with conflict reporting | feature | todo |
| 18 | Search file contents in the side panel (`git grep` or a folder walk), with clickable results | feature | todo |
| 19 | Image preview in the file viewer (png, jpg, gif, webp, svg) | feature | todo |
| 20 | Remember the last selected task and the sidebar's collapsed state across restarts | ux | todo |
| 21 | Confirm dialogs for removing a theme, repo or folder, and an undo-friendly flow | ux | todo |
| 22 | Clone a repository from a URL into a chosen directory and add it to a theme | feature | todo |
| 23 | Side-by-side diff toggle for wide panels | ux | todo |
| 24 | Status bar: branch, ahead/behind, last commit subject and session state for the selected task | ux | todo |
| 25 | Theme colors and emoji icons in the sidebar | ux | todo |
| 26 | Virtualize the file tree and changes list for large repos, and cap the repo file listing | perf | todo |
| 27 | Welcome / onboarding empty state with quick actions | ux | todo |
