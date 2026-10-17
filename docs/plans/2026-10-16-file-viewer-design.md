# me-manager: File Viewer, Changes and Markdown — Design

Date: 2026-10-16
Builds on: `2026-10-16-me-manager-design.md`

## Goal

From inside the app, the user can:

- browse and read the files of the selected task or folder
- see what the task changed, as diffs
- read Markdown files rendered, including Mermaid diagrams

It sits next to the Claude terminal, so you can review Claude's work while it
runs.

## Decisions

| Topic | Decision |
|---|---|
| Placement | Resizable side panel to the right of the terminal; toggle with Ctrl/Cmd+Shift+E |
| What Changes compares | Worktree, including uncommitted and untracked files, vs. the merge-base of the task branch and `baseRef` |
| Editing | Read-only |
| Diff style | Unified |
| Markdown | GFM, highlighted code, relative images and links, Mermaid |
| File tree contents | Repos: tracked + untracked-not-ignored. Folders: everything except `.git` and `node_modules` |
| Refresh | Poll every 3s while the panel is visible, plus a manual ⟳ button |

## Architecture

### Main process: `FilesService` (read-only)

- `listFiles(root, isRepo)`: a flat list of relative paths.
  - Repos: `git ls-files -z --cached --others --exclude-standard`.
  - Folders: a recursive walk that skips `.git` and `node_modules`, capped at
    20,000 entries.
- `readFile(root, rel)` returns `{ kind: 'text', content, truncated, size }`,
  `{ kind: 'binary', size }` or `{ kind: 'missing' }`.
  - Binary means a NUL byte appears in the first 8 KB.
  - Text is cut off at 1 MB.
- `readImage(root, rel)` returns a `data:` URL, or null if the image is over
  5 MB or the path is invalid.
- `listChanges(worktree, baseRef)` returns
  `{ files: ChangedFile[], fallback?: 'uncommitted-only' }`.
  - `ChangedFile` is `{ path, oldPath?, status: 'A'|'M'|'D'|'R'|'U', added, removed }`.
  - Base is `git merge-base HEAD <baseRef>`. Changes come from
    `git diff --numstat -z -M <base>` and `--name-status`, and untracked files
    from `ls-files --others --exclude-standard`.
  - If the base ref is missing, compare against `HEAD` and set `fallback`.
- `fileDiff(worktree, baseRef, rel)` returns the unified diff text, or a
  "binary" marker.
  - Untracked files use `git diff --no-index /dev/null <file>`.

### Path safety

Every `rel` is resolved against the root with `realpath`. The request is
rejected if the result is outside the root's realpath, which covers both `..`
and symlinks pointing out of the root. The renderer only ever sends a `Target`
plus a relative path; the main process works out the root itself.

### Contract additions (`MeManagerApi`)

```ts
listFiles(target: Target): Promise<string[]>
readFile(target: Target, path: string): Promise<FileContent>
readImage(target: Target, path: string): Promise<string | null>
listChanges(target: Target): Promise<ChangeList>
fileDiff(target: Target, path: string): Promise<string>
openExternal(url: string): Promise<void>
```

- `openExternal` only accepts `http:` and `https:` URLs.
- `listChanges` and `fileDiff` reject folder targets.

### Renderer

- `SidePanel`: Files/Changes tabs, ⟳, close, and the list/viewer split.
- `FileTree`: built from the flat path list, with a filter box and change
  badges.
- `ChangesList`: status letter, path, and `+n −m` counts.
- `FileViewer`: highlight.js code with line numbers, a binary or truncated
  placeholder, and Markdown routing.
- `MarkdownView`: `react-markdown` + `remark-gfm` + `rehype-highlight`.
  - Raw HTML is **not** rendered.
  - Images go through `readImage`.
  - Relative `.md` links open in the viewer, with history and back.
  - `http(s)` links go to `openExternal`.
- `MermaidBlock`: lazily imports `mermaid` with
  `securityLevel: 'strict'`. A syntax error is shown inline.
- `DiffView`: our own unified-diff parser, rendering hunks with old and new
  line numbers. Diffs over 5,000 lines are collapsed behind a button.
- Panel state (open, width, tab, selected file, Markdown mode) is kept in
  memory per target.

## Error handling

- File vanished: "File no longer exists", then the list refreshes.
- Worktree or repo missing: the panel shows a ⚠ message instead of toasts.
- Base ref missing: Changes shows only uncommitted changes, with a notice.
- Mermaid error: shown inline; the rest of the document still renders.
- Image too big or blocked: a placeholder with the reason in a tooltip.
- Polling errors are silent, with a dot on ⟳. Errors from user-initiated
  actions show as toasts.

## Security

- **Markdown:** no raw HTML is rendered, and the existing CSP blocks inline
  scripts. Mermaid runs in `strict` mode.
- **Paths:** every request is confined to the task's root; symlinks are
  followed and checked.
- **Links:** `openExternal` accepts only http(s).

## Testing

- **FilesService:** integration tests on temporary git repos, covering
  listing, ignore rules, path escapes and symlinks, binary and truncated
  files, and change kinds (committed, uncommitted, untracked, deleted,
  renamed) against the merge-base.
- **Diff parser:** unit tests with recorded `git diff` output.
- **MarkdownView:** `<script>` and `onerror` are not executed; relative
  links and images resolve; external links call `openExternal`.
- **UI:** Testing Library tests with the mock API. Mermaid is mocked in jsdom.
- **Real Mermaid rendering:** checked in the manual smoke test.

## Out of scope

Editing, side-by-side diffs, full-text search across files, staging,
committing, and live file watching (polling covers it).
