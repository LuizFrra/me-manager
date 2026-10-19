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
| 3 | Command palette (Ctrl/Cmd+Shift+P, plus Cmd+K on macOS): fuzzy jump to any task, folder, or file of the current task, and run app actions | ux | done (8561443) |
| 4 | Keyboard shortcuts: Cmd+1..9 (macOS) or Alt+1..9 (Linux, since e1111e6: Ctrl+digits belong to the terminal) to switch tasks, Ctrl/Cmd+Shift+T for a new shell tab, Ctrl/Cmd+Shift+W to close a tab, Ctrl/Cmd+Shift+[ / ] to switch tabs, Ctrl/Cmd+Shift+/ to show a shortcut help overlay. Fixed in 6bb3820: the palette moved from Ctrl+K to Ctrl+Shift+P and help from Ctrl+/ to Ctrl+Shift+/, so Linux Ctrl+K (kill line) and Ctrl+/ (undo) reach the terminal again; macOS also keeps Cmd+K and Cmd+/ | ux | done (b082539, 6bb3820) |
| 5 | Sidebar filter box: filter themes, repos and tasks by name | ux | done (d5dc635) |
| 6 | Rename a theme or task (display name only; slug, branch and path stay unchanged) | feature | done (68c499f) |
| 7 | Task notes: a free-text description per task, shown in the header and editable | feature | done (c7dff9e) |
| 8 | Copy actions: copy the branch name, worktree path, or `tmux attach` command | ux | done (cbf39fc) |
| 9 | Open the task in an external editor (VS Code, or `$EDITOR`, set in Settings) or the system file manager | feature | done (bd489c1) |
| 10 | Git status per task: commits ahead of the base, and the uncommitted file count, shown as a sidebar badge and in the header | feature | done (c8bde46) |
| 11 | Claude activity indicator: busy, waiting or idle per task, based on tmux pane activity, shown in the sidebar | feature | done (788ae65) |
| 12 | Desktop notification when a background task's Claude finishes or waits for input | feature | done (5d5c890) |
| 13 | New task: choose the base branch (dropdown, defaulting to origin's default) and an optional initial prompt passed to `claude` | feature | done (ccef010) |
| 14 | Settings screen: extra `claude` args (e.g. `--model`), editor command, poll interval, terminal font size, notifications toggle | feature | done (dae9a31) |
| 15 | Terminal zoom: Ctrl/Cmd +/−/0 changes the font size, which is remembered | ux | done (7b478d9) |
| 16 | Git actions per task: commit all (with a message), push the branch, and open a PR via `gh` if it's installed | feature | done (8c13e64) |
| 17 | Update the task from base: fetch, then rebase or merge `origin/<default>` into the task branch, with conflict reporting | feature | done (a7857e8) |
| 18 | Search file contents in the side panel (`git grep` or a folder walk), with clickable results | feature | done (3b50f29) |
| 19 | Image preview in the file viewer (png, jpg, gif, webp, svg) | feature | done (d2b1d6e) |
| 20 | Remember the last selected task and the sidebar's collapsed state across restarts | ux | done (3019c1e) |
| 21 | Confirm dialogs for removing a theme, repo or folder, and an undo-friendly flow | ux | done (ea786eb) |
| 22 | Clone a repository from a URL into a chosen directory and add it to a theme | feature | done (a0cfdbd) |
| 23 | Side-by-side diff toggle for wide panels | ux | done (6a96c5a) |
| 24 | Status bar: branch, ahead/behind, last commit subject and session state for the selected task | ux | done (1e4fbda) |
| 25 | Theme colors and emoji icons in the sidebar | ux | done (7360af9) |
| 26 | Virtualize the file tree and changes list for large repos, and cap the repo file listing | perf | done (87e00ad) |
| 27 | Welcome / onboarding empty state with quick actions | ux | done (3f0daff) |
| 28 | Start every Claude session with Remote Control (named `<theme>/<repo>/<task>`) and skipped permissions by default, as Settings toggles, with a warning and a header badge | feature | done (7076989) |
| 29 | Claude usage and spend: per-task, per-theme and total tokens (input, output, cache) from Claude Code's transcripts in `~/.claude/projects/`, estimated cost at API prices (labelled as an estimate for subscription users), header badge, and a usage view for today, this week and this month | feature | done (7014c87) |
| 30 | Fix findings from the full review of the loop features (`fv-1..HEAD`): prompts via a private file (no one-word subcommands, no tmux length limit), copy-mode cancel and tmux timeouts, idle check before "Ask Claude to resolve", full refs, submodule-safe PCRE search with cancellation, dialog focus trap and restore, per-dialog closing, shared effective-flag rule | quality | done (merges of fix/rv2-backend and fix/rv2-ui) |
| 31 | Review comments to Claude: select lines in a diff or file, write a note, "Send to Claude" types it into the task's claude window with file:line references | feature | done (merge of feat/f31-review) |
| 32 | Archive tasks: remove the worktree and kill the session but keep the branch; an Archived section lists them, with Restore (recreate the worktree from the branch) and Delete | feature | done (merge of feat/f32-archive) |
| 33 | Task templates: saved new-task presets (name pattern, base branch, initial prompt), chosen in the New task dialog and managed in Settings | feature | done (merge of feat/f33-templates) |
| 34 | Run command per repo: a configurable dev or test command (e.g. `npm run dev`) launched in a "run" tab with one click, with restart and stop | feature | done (merge of feat/f34-run) |
| 35 | Dev-server URLs: detect `http://localhost:<port>` printed in a task's tabs and show clickable links in the header and status bar | feature | done (merge of feat/f34-run) |
| 36 | Usage budgets: optional cost limits per task and per day, a warning toast or notification when crossed, and a badge in the sidebar | feature | todo |
| 37 | Drag and drop: reorder themes, items and tasks in the sidebar, persisted | ux | todo |
| 38 | Bulk actions: multi-select tasks (Shift/Ctrl-click) to push, update from base or remove together, with one confirmation | feature | todo |
| 39 | Save the terminal transcript: export a tab's tmux scrollback to a file, or copy it | feature | done (merge of feat/f39-transcript) |
| 40 | Appearance: light theme and system-follow option, with the terminal colors matching | ux | in progress (feat/f40-theme) |
| 41 | Portuguese (pt-BR) UI translation, with a language setting (English default) | ux | todo |
