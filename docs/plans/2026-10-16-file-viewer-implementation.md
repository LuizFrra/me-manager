# File Viewer, Changes and Markdown — Implementation Plan

> **For Claude:** This plan is built for parallel execution. Use
> superpowers:subagent-driven-development, with one agent per track, each in
> its own git worktree. Within a track, use TDD (superpowers:test-driven-development).

**Goal:** Add a resizable, read-only side panel next to the terminal. It has a
Files tab (tree, file viewer, rendered Markdown with Mermaid) and a Changes tab
(changed files and unified diffs against the merge-base of the task branch and
its base).

**Design:** `docs/plans/2026-10-16-file-viewer-design.md`. Read it first.

**Existing app:** see the README and
`docs/plans/2026-10-16-me-manager-implementation.md`.

- Contracts live in `src/shared/types.ts`, `src/shared/ipc.ts` and
  `src/main/contracts.ts`.
- The main process composes services in `src/main/app/orchestrator.ts`.
- The renderer is in `src/renderer/src`. Tests use `api/mockApi.ts` and mock
  `TerminalView`.
- Every git call goes through `run()` from `src/main/exec.ts` (`execFile`,
  no shell).

**Tech:** react-markdown, remark-gfm, rehype-highlight, highlight.js and
mermaid. The unified-diff parser is our own.

---

## Execution shape

```
V0 Foundation (1 agent, worktree branch fv/foundation → merged to main, tag fv-0)
   │
   ├── H FilesService (main)        src/main/files/**
   ├── I Diff parser + DiffView      src/renderer/src/lib/diff/**, components/files/DiffView.tsx
   ├── J Markdown + Mermaid          src/renderer/src/lib/markdown/**, components/files/{MarkdownView,MermaidBlock}.tsx
   ├── K Side panel + App wiring     the rest of src/renderer/src/** (see ownership)
   └── L Orchestrator file methods   src/main/app/**
   │
   merge all → full suite → manual smoke test
```

### Ownership

| Owner | Files |
|---|---|
| V0 | `package.json`, lockfile, `src/shared/**`, `src/main/contracts.ts`, `src/main/exec.ts`, `src/main/ipc.ts`, `src/main/index.ts`, plus the stubs listed in V0 |
| H | `src/main/files/**` |
| I | `src/renderer/src/lib/diff/**`, `src/renderer/src/components/files/DiffView.tsx` (+ test) |
| J | `src/renderer/src/lib/markdown/**`, `src/renderer/src/components/files/MarkdownView.tsx`, `MermaidBlock.tsx` (+ tests) |
| K | All other files under `src/renderer/src/**`, including `App.tsx`, `TabBar.tsx`, `TerminalView.tsx`, `api/mockApi.ts`, `styles.css`, and new `components/files/{SidePanel,FileTree,ChangesList,FileViewer,CodeView}.tsx` and `lib/fileTree.ts` |
| L | `src/main/app/**` |

### Rules for every track agent

1. Work only in your own worktree and branch. Run `npm ci` first.
2. Only touch the files you own.
   - Never edit `package.json`, the lockfile, `src/shared/**` or
     `src/main/contracts.ts`.
   - Need a contract change? Stop and report it.
3. Use TDD: write the failing test, implement, see it pass, commit.
4. Gates before you report: `npm test` (the full suite), `npm run typecheck`,
   `npm run build`, and `npx eslint src` with 0 errors.
5. Commit messages end with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
6. Don't merge or push.
7. If you launch the app, use
   `ME_MANAGER_HOME=<scratchpad dir> ME_MANAGER_TMUX_SOCKET=mm-<track>`.
   Never touch `~/.me-manager` or the `me-manager` socket.

---

# V0 — Foundation

**Branch:** `fv/foundation`, from `main`.

### V0.1 Dependencies

```bash
npm install -D react-markdown remark-gfm rehype-highlight highlight.js mermaid
```

All of these are renderer-only and bundled by Vite, so they go in
devDependencies.

### V0.2 Contract types: `src/shared/types.ts` (append)

```ts
export type FileContent =
  | { kind: 'text'; content: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'missing' }

/** A added, M modified, D deleted, R renamed, U untracked. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U'

export interface ChangedFile {
  path: string
  /** Set for renames. */
  oldPath?: string
  status: ChangeStatus
  added: number
  removed: number
  binary: boolean
}

export interface ChangeList {
  files: ChangedFile[]
  /** Set when the base ref was missing and only uncommitted changes vs HEAD are shown. */
  fallback?: 'uncommitted-only'
}
```

Then add these to `MeManagerApi`, after the tab methods:

```ts
  listFiles(target: Target): Promise<string[]>
  readFile(target: Target, path: string): Promise<FileContent>
  /** data: URL for an image inside the target's folder, or null if too large / not an image / outside. */
  readImage(target: Target, path: string): Promise<string | null>
  /** Repo tasks only; rejects for folders. */
  listChanges(target: Target): Promise<ChangeList>
  /** Unified diff text for one changed file; '' if unchanged. Repo tasks only. */
  fileDiff(target: Target, path: string): Promise<string>
  /** Opens an http(s) URL in the system browser; rejects other schemes. */
  openExternal(url: string): Promise<void>
```

### V0.3 IPC: `src/shared/ipc.ts`

Append `'listFiles', 'readFile', 'readImage', 'listChanges', 'fileDiff',
'openExternal'` to `INVOKE_METHODS`.

### V0.4 Main contracts: `src/main/contracts.ts`

```ts
export interface FilesApi {
  /** Relative paths (POSIX separators), sorted. Repos: tracked + untracked-not-ignored. Folders: walk minus .git/node_modules. */
  listFiles(root: string, isRepo: boolean): Promise<string[]>
  readFile(root: string, relPath: string): Promise<FileContent>
  readImage(root: string, relPath: string): Promise<string | null>
  listChanges(worktree: string, baseRef: string): Promise<ChangeList>
  fileDiff(worktree: string, baseRef: string, relPath: string): Promise<string>
}
```

- Add `files: FilesApi` to `OrchestratorDeps`.
- Add `'openExternal'` to the `Omit<...>` list in `AppService`.

### V0.5 `run()` exit codes: `src/main/exec.ts`

Add `okExitCodes?: number[]` to `RunOptions`. When the process exits with one
of those codes, resolve with stdout instead of rejecting. `git diff --no-index`
exits with 1 when there are differences, which is why this is needed.

Test it with `process.execPath -e "process.stdout.write('x'); process.exit(1)"`
and `{ okExitCodes: [1] }`. It should resolve to `'x'`.

### V0.6 Stubs (the owning track replaces them; keep the exports)

- **`src/main/files/filesService.ts`:**
  `export class FilesService implements FilesApi`. Every method throws
  `new Error('FilesService not implemented yet')`.
- **`src/main/app/orchestrator.ts`:** add the five file methods (`listFiles`,
  `readFile`, `readImage`, `listChanges`, `fileDiff`), each throwing
  `'not implemented'`, so it still `implements AppService`.
- **`src/main/app/fakes.ts`:** add `class FakeFiles implements FilesApi`.
  It records calls in `calls: string[]` and returns `[]`,
  `{ kind: 'missing' }`, `null`, `{ files: [] }` and `''`. Add it to
  `makeDeps()` as `files`, and return it.
- **`src/main/index.ts`:** pass `files: new FilesService()` to the
  Orchestrator.
- **`src/main/ipc.ts`:** add a `special` handler for `openExternal`:

  ```ts
  openExternal: async (url) => {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) links can be opened')
    await shell.openExternal(parsed.toString())
  },
  ```

- **`src/renderer/src/api/mockApi.ts`:** add the six methods with trivial
  results: `[]`, `{ kind: 'missing' }`, `null`, `{ files: [] }`, `''`, and a
  no-op.
- **`src/renderer/src/components/files/DiffView.tsx`:**

  ```tsx
  export interface DiffViewProps { diff: string }
  export function DiffView({ diff }: DiffViewProps): React.JSX.Element { return <pre className="diff-raw">{diff}</pre> }
  ```

- **`src/renderer/src/components/files/MarkdownView.tsx`:**

  ```tsx
  export interface MarkdownViewProps {
    source: string
    /** Path of the .md file relative to the root, used to resolve relative links/images. */
    filePath: string
    loadImage: (relPath: string) => Promise<string | null>
    /** Called with a root-relative path for links to other files inside the root. */
    onOpenLink: (relPath: string) => void
    onOpenExternal: (url: string) => void
  }
  export function MarkdownView({ source }: MarkdownViewProps): React.JSX.Element { return <pre>{source}</pre> }
  ```

### V0.7 Verify, commit, merge

Run the gates (`npm test`, `npm run typecheck`, `npm run build`,
`npx eslint src`). Commit, then the coordinator merges into `main` and tags
`fv-0`.

---

# H — FilesService (`src/main/files/**`)

Implements `FilesApi` with `run()` and `node:fs/promises`. Integration tests
use real temporary git repos; you may copy the helper ideas from
`src/main/git/testRepos.ts`, but don't import from `src/main/git`.

## Constants

```
MAX_TEXT_BYTES = 1_000_000
BINARY_SNIFF_BYTES = 8_192
MAX_IMAGE_BYTES = 5_000_000
MAX_WALK_ENTRIES = 20_000
```

## Path safety: `safePath(root, rel)`

1. **Reject bad input.** Throw `Path is outside the folder` for an empty
   `rel`, an absolute path, or a path containing NUL.
2. **Lexical check.** `realRoot = realpath(root)` and
   `candidate = resolve(realRoot, rel)`. If `candidate` isn't `realRoot` and
   doesn't start with `realRoot + sep`, throw.
3. **Missing file.** If `realpath(candidate)` fails with ENOENT, return
   `{ missing: true }`.
4. **Symlink check.** If the realpath result is outside `realRoot`, throw.
   This catches symlinks that point outside.
5. Otherwise return `{ abs: real }`.

**Tests:**
- `../x` throws.
- `/etc/passwd` throws.
- A symlink inside the root that points to `/etc` throws.
- A symlink to a file inside the root is allowed.
- A missing file returns `missing`.

## `listFiles(root, isRepo)`

- **Repos:** `git -C root -c core.quotepath=false ls-files -z --cached --others --exclude-standard`.
  - Split on NUL and dedupe.
  - Keep only entries that are files or symlinks, using `lstat`. This drops
    tracked-but-deleted files and submodule directories.
  - Sort.
- **Folders:** a recursive `readdir({ withFileTypes: true })`.
  - Skip `.git` and `node_modules` directories, and don't follow symlinked
    directories.
  - Stop at `MAX_WALK_ENTRIES`.
  - Use POSIX separators and sort.

**Tests:**
- Tracked, untracked and ignored files: the ignored one is absent and
  `.gitignore` itself is present.
- A deleted tracked file is absent.
- Folder mode skips `node_modules` and `.git`.

## `readFile(root, rel)`

- Run `safePath`; if the file is missing, return `{ kind: 'missing' }`.
- Throw if the path is a directory.
- Read the first `min(size, MAX_TEXT_BYTES)` bytes through a file handle.
  Never read a whole huge file.
- **Binary:** if there's a NUL byte in the first `BINARY_SNIFF_BYTES`, return
  `{ kind: 'binary', size }`.
- **Text:** otherwise return `{ kind: 'text', content: utf8, size, truncated: size > MAX_TEXT_BYTES }`.
  Don't split a multi-byte character at the cut: trim trailing bytes until the
  result decodes cleanly, or use `TextDecoder` with `stream: true`.

**Tests:** text, binary (a PNG header), a 1.5 MB truncated file, missing, and
directory throws.

## `readImage(root, rel)`

- The MIME type comes from the extension: png, jpg/jpeg, gif, webp, svg
  (`image/svg+xml`), bmp, ico.
- Return null for any other extension, a missing file, size over
  `MAX_IMAGE_BYTES`, or a path that escapes (catch the error and return null).
- Otherwise return `data:<mime>;base64,...`.

**Tests:** a png returns a data URL, a `.txt` returns null, an escaping path
returns null, an oversized file returns null.

## `listChanges(worktree, baseRef)`

1. **Find the base.** `git merge-base HEAD <baseRef>`. If it fails (for
   example the base ref is gone), set `base = 'HEAD'` and
   `fallback = 'uncommitted-only'`.
2. **Read the changes.** Run
   `git -c core.quotepath=false diff --no-color --no-ext-diff -z -M --name-status <base>` and
   `... --numstat <base>`. Both compare `base` against the working tree,
   which includes uncommitted edits to tracked files.
   - **name-status (`-z`):** a status token, then a path. For `R<score>` and
     `C<score>`, the token is followed by the old path and then the new path.
     Map `A`, `M`, `D` and `R` directly, `C` to `A`, and `T` to `M`.
   - **numstat (`-z`):** `added\tremoved\tpath\0`. For renames it's
     `added\tremoved\t\0old\0new\0`. `-\t-` means the file is binary.
3. **Add untracked files.** `git ls-files -z --others --exclude-standard`
   gives the untracked files: status `U`. `added` is the newline count for
   text files under `MAX_TEXT_BYTES`, otherwise 0. Set `binary` by sniffing.
4. Sort by path.

**Tests** (a clone with an `origin/main` base and a task branch):
- A committed modification shows as `M` with the right counts.
- An uncommitted modification shows as `M`.
- An untracked file shows as `U`.
- A deleted file shows as `D`.
- A rename (`git mv` plus commit) shows as `R` with `oldPath`.
- A binary change has `binary: true`.
- A base ref that doesn't exist (`origin/gone`) returns
  `fallback: 'uncommitted-only'` and only uncommitted changes.
- A fresh task returns an empty list.

## `fileDiff(worktree, baseRef, rel)`

- Run `safePath` on `rel`, but allow missing, because deleted files are
  diffable.
- Work out the base the same way as in `listChanges`.
- **Untracked file:** `ls-files --error-unmatch` fails and the file exists.
  Run `git diff --no-color --no-ext-diff --no-index -- /dev/null <rel>` with
  `cwd: worktree` and `okExitCodes: [1]`.
- **Otherwise:** look up `rel` in `--name-status -M <base>`. If it's a rename
  target, use the pathspec `-- <old> <rel>`; else `-- <rel>`. Run
  `git -c core.quotepath=false diff --no-color --no-ext-diff -M <base> -- ...`.
- Return stdout. `''` means no changes.

**Tests:**
- A modified file's diff contains `@@` and `+new line`.
- An untracked file's diff has `new file mode` and all lines as `+`.
- A deleted file's diff shows all lines as `-`.
- A rename shows `rename from` and `rename to`.
- An escaping path throws.

---

# I — Diff parser and DiffView

## `src/renderer/src/lib/diff/parse.ts`

```ts
export type DiffLineKind = 'context' | 'add' | 'del' | 'note'
export interface DiffLine { kind: DiffLineKind; text: string; oldNo?: number; newNo?: number }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface ParsedDiff {
  binary: boolean
  oldPath?: string
  newPath?: string
  renamed: boolean
  hunks: DiffHunk[]
  lineCount: number
}
export function parseUnifiedDiff(text: string): ParsedDiff
```

**Parsing rules:**
- Header lines before the first `@@` set fields:
  - `--- a/x` and `+++ b/y` set the paths (`/dev/null` means absent).
  - `rename from` and `rename to` set `renamed`.
  - `Binary files ... differ` sets `binary`.
- A hunk header looks like `@@ -a,b +c,d @@ optional`; the counts default to
  1 when omitted.
- Within a hunk, the first character decides the line kind:
  - `' '` is context, `+` an addition, `-` a deletion.
  - `\` is a note (`\ No newline at end of file`) and gets no line numbers.
- Track `oldNo` and `newNo` as you go. Lines with no prefix (for example a
  trailing `''`) are ignored.
- `lineCount` is the total number of lines across all hunks.

**Tests** (recorded `git diff` text): a single hunk, multiple hunks, an added
file (`--- /dev/null`), a deleted file, a rename with no content change,
binary, the "no newline" note, a hunk header with omitted counts, and empty
input (`hunks: []`).

## `components/files/DiffView.tsx`

Replaces the stub; keep `DiffViewProps { diff: string }`.

- **Empty input:** show "No changes."
- **Binary:** show "Binary file changed."
- **Renamed with no hunks:** show "Renamed from X" (with X the old path).
- **Otherwise:** render a table with one row per line: old number, new
  number, and the text. Each row has the class `diff-add`, `diff-del`,
  `diff-context` or `diff-note`. Hunk headers get their own row with class
  `diff-hunk`.
- **Large diffs:** if `lineCount > 5000`, render a "Large diff (N lines)"
  notice with a **Show diff anyway** button instead of the table.
- **Text safety:** render text as React text nodes, never HTML. Keep
  whitespace with `white-space: pre` (via class names; K owns
  `styles.css`, so use these exact class names and K will style them).

**Tests (Testing Library):**
- An added line is rendered with class `diff-add` and its line number.
- A large diff shows the button, and clicking it renders the rows.
- `<script>` in diff text appears as text.

---

# J — Markdown and Mermaid

## `lib/markdown/paths.ts`

```ts
/** Resolve a link/image href found in `fromFile` (root-relative) to a root-relative path, or null if it escapes the root or is not a relative path. Strips #fragment and ?query; decodes %20 etc. */
export function resolveRelative(fromFile: string, href: string): string | null
export function isExternal(href: string): boolean // http: or https:
```

**Tests:**
- `('docs/a.md', 'b.md')` gives `docs/b.md`.
- `('docs/a.md', '../README.md#x')` gives `README.md`.
- `('a.md', '../../etc/passwd')` gives null.
- `'/abs'` is treated as root-relative and gives `abs`.
- `mailto:` gives null, and `#anchor` alone gives null.
- `'img%20one.png'` gives `img one.png`.

## `components/files/MarkdownView.tsx`

Replaces the stub; keep the props.

- **Rendering:** `react-markdown` with `remarkPlugins={[remarkGfm]}` and
  `rehypePlugins={[rehypeHighlight]}`, wrapped in `<div className="markdown-body">`.
  **Never** add `rehype-raw`, so raw HTML stays as text or is dropped.
- **`a`:**
  - `isExternal(href)`: on click, `preventDefault()` and call
    `onOpenExternal(href)`.
  - Otherwise, if `resolveRelative` returns a path: on click,
    `preventDefault()` and call `onOpenLink(path)`.
  - Otherwise (an anchor or unsupported link): render the plain text with no
    navigation.
- **`img`:**
  - A relative src goes through `resolveRelative`, then `loadImage(path)`,
    and is shown once loaded.
  - On null, show a placeholder `<span className="md-img-missing" title="...">`.
  - External image URLs are **not** loaded (the CSP blocks them anyway): show
    the placeholder with the alt text.
- **`code`:** for a fenced block whose language is `mermaid`, render
  `<MermaidBlock code={...} />`; otherwise use the default rendering.

## `components/files/MermaidBlock.tsx`

- Load mermaid lazily: `const { default: mermaid } = await import('mermaid')`.
  Initialize it once with
  `{ startOnLoad: false, securityLevel: 'strict', theme: 'dark' }`.
- Render with `mermaid.render(uniqueId, code)`, inject the returned SVG into a
  container with `innerHTML`, and handle the async lifecycle (ignore results
  after unmount).
- `securityLevel: 'strict'` makes mermaid sanitize its own SVG output.
- **On error:** show `<div className="mermaid-error">` with the message, plus
  the raw code in a `<pre>`.

**Tests** (`vi.mock('mermaid', ...)` returning a fake `render`):
- The SVG is injected.
- An error shows the message and the source.
- `<script>alert(1)</script>` in the Markdown is not in the DOM as a script
  element.
- `<img src=x onerror=...>` produces no `img` with an `onerror` attribute.
- Clicking a relative link calls `onOpenLink('docs/b.md')`.
- Clicking an external link calls `onOpenExternal` and doesn't navigate.
- A relative image calls `loadImage` and renders the returned src.
- A GFM table renders a `<table>`.
- A fenced `ts` block gets the `hljs` class.

---

# K — Side panel, App integration, styles

K builds on the V0 stubs for `DiffView` and `MarkdownView`. Import them and
code against their props; I and J are replacing them in parallel.

## `lib/fileTree.ts`

```ts
export interface TreeNode { name: string; path: string; dir: boolean; children: TreeNode[] }
export function buildTree(paths: string[]): TreeNode[]   // dirs first, then files, alphabetical (case-insensitive)
export function filterPaths(paths: string[], query: string): string[] // case-insensitive substring on full path
```

Unit-test both.

## Components (`components/files/`)

- **`SidePanel.tsx`**
  - **Props:**
    ```ts
    {
      api: MeManagerApi
      target: Target
      isRepo: boolean
      missing: boolean
      state: PanelState
      onState: (s: PanelState) => void
      onError: (e: unknown) => void
    }
    ```
    where
    ```ts
    PanelState = { tab: 'files' | 'changes'; selected?: string; mdMode: 'view' | 'raw'; history: string[] }
    ```
  - **Header:** a Files tab, a Changes tab (only if `isRepo`, titled
    "Changes N"), ⟳ and ✕ (✕ calls a prop `onClose`).
  - **Body:**
    - Files: a filter `<input aria-label="Filter files">`, then `FileTree`.
    - Changes: `ChangesList`.
    - Below either one: the viewer.
  - If `missing`, show "This task's folder is missing." instead of the body.
  - **Data loading:**
    - On mount and on target change: `listFiles`, plus `listChanges` if it's
      a repo.
    - Every 3 s while mounted: `listChanges` (repos) and a re-read of the
      selected file or diff.
    - Only call `setState` when the data actually changed, by comparing JSON,
      to avoid flicker.
    - Polling errors are silent and set a `stale` dot on ⟳.
    - Errors from user clicks go to `onError`.
  - If `listChanges` returns `fallback`, show the notice "Base branch not
    found — showing uncommitted changes only."
- **`FileTree.tsx`**
  - Collapsible directories, using `buttons` with `aria-expanded`.
  - Files are buttons. The selected file has `aria-current="true"`.
  - A change badge (`M`, `A`, `D`, `R`, `U`) appears next to files in the
    change list.
  - When the filter is non-empty, every directory is shown expanded.
- **`ChangesList.tsx`**
  - Rows show the status letter, the path (`old → new` for renames), and
    `+a −r` (or "binary").
  - Clicking a row selects it. When the list is empty, show "No changes yet."
- **`FileViewer.tsx`**
  - **Files tab:**
    - `missing` shows "File no longer exists".
    - `binary` shows "Binary file (size)".
    - For `text`, a `.md` / `.markdown` file renders `MarkdownView`, with a
      View/Raw toggle stored in `PanelState.mdMode`. Other files render
      `CodeView`.
    - A truncated file shows a notice bar.
  - **Markdown wiring:**
    - `MarkdownView` gets `loadImage = (p) => api.readImage(target, p)`.
    - `onOpenLink` pushes the current file onto `history` and selects the
      link target, switching to the Files tab.
    - `onOpenExternal = api.openExternal`.
    - A ← Back button appears when `history` is non-empty.
  - **Changes tab:** `DiffView` with the diff text, plus an **Open file**
    button (disabled for `D`) that switches to Files with that path selected.
- **`CodeView.tsx`**
  - Highlight with `highlight.js/lib/common`, choosing the language from the
    file extension via `hljs.getLanguageForExtension`-style mapping, with
    `highlightAuto` as the fallback.
  - Skip highlighting above 200 KB.
  - Show line numbers. Output via `dangerouslySetInnerHTML` is acceptable
    **only** with hljs output, because hljs escapes its input. Plain text
    otherwise.

## App integration

- **Layout:** the `.terminal-area` and a new `<aside className="side-panel">`
  sit side by side in a `.workspace` flex row.
  - Between them is a draggable `.splitter` (`role="separator"`,
    `aria-orientation="vertical"`), using pointer events.
  - Panel width is clamped to 280px … 70% of the main area, defaults to 40%,
    and is remembered in a `localStorage` value wrapped in try/catch.
- **Toggle:**
  - A `⊞` button in `TabBar` with `aria-label="Toggle files panel"`.
  - The shortcut is Ctrl+Shift+E, or Cmd+Shift+E on macOS. Handle it with a
    window `keydown` listener.
  - In `TerminalView`'s `attachCustomKeyEventHandler`, return `false` for that
    combo so xterm doesn't send it to tmux.
- **Per-target state:** App keeps a `Map<targetKey, PanelState & { open: boolean }>`
  in a ref. Switching targets restores that target's state. The default is
  closed.
- **Props from App:** `isRepo` comes from the target's item kind, and
  `missing` from `status.missing`.
- **`mockApi.ts`:** give it a small demo file set, so `npm run dev` in a
  browser shows something:
  - `README.md` containing a table and a mermaid block, `src/app.ts`, and a
    fake change list with a diff.
  - Keep its existing behavior and tests intact.
- **`styles.css`:** styles for the panel, splitter, tree, badges, the
  Markdown body (GitHub-dark-like), highlight.js (import
  `highlight.js/styles/github-dark.css` in `main.tsx` or in the CSS), and
  the diff classes from Track I (`diff-add`, `diff-del`, `diff-context`,
  `diff-note`, `diff-hunk`).

## Tests (App and SidePanel, with the mock API; mock TerminalView and MarkdownView where convenient)

- The toggle button opens the panel, and the Files tab lists the mock files.
- Typing in the filter narrows the tree.
- Clicking a file calls `readFile` and shows its content.
- A `.md` file renders through `MarkdownView` (mocked to show "MD:" plus the
  source), and the Raw toggle shows the source text.
- The Changes tab is hidden for a folder target.
- In Changes, clicking a file calls `fileDiff` and renders `DiffView`.
- Open file switches to Files with that file selected.
- Panel state is per target: open A, switch to B (closed), switch back to A
  (open, same file).
- The Ctrl+Shift+E keydown toggles the panel.

---

# L — Orchestrator file methods (`src/main/app/**`)

Replace the V0 stubs in `orchestrator.ts`. These methods are read-only, so
they don't go through the mutation mutex.

```ts
private resolveRoot(target: Target): { root: string; isRepo: boolean; baseRef?: string }
// folder → { root: item.path, isRepo: false }
// task   → { root: task.worktreePath, isRepo: true, baseRef: task.baseRef }
// repo without taskId → throw 'Choose a task to open'
```

- Each method calls `resolveRoot`. If `!deps.pathExists(root)`, it throws
  `Folder not found: <root>`.
- `listFiles` maps to `files.listFiles(root, isRepo)`.
- `readFile` and `readImage` delegate with `(root, path)`.
- `listChanges` and `fileDiff` throw
  `'Changes are only available for repository tasks'` for folders; otherwise
  they delegate with `(root, baseRef, ...)`.

**Tests** (using `FakeFiles` from `fakes.ts`, extended as needed):
- A task target passes the worktree path and `isRepo: true`.
- A folder target passes the folder path and `false`.
- `listChanges` on a folder rejects.
- A missing root rejects with `Folder not found`.
- `fileDiff` passes the task's `baseRef`.

---

# Merge and smoke test (coordinator + user)

1. **Merge** H, I, J, K and L into `main`. Run `npm install` (new deps), then
   `npm test`, typecheck, build and eslint.
2. **Linux sandbox:** if `npm install` reset
   `node_modules/electron/dist/chrome-sandbox`, the user re-runs the
   chown/chmod from the README.
3. **Manual check** with `npm run dev`:
   - Open a task. Toggle the panel with the button and with Ctrl+Shift+E.
   - Browse files, filter, and open a `.ts` file (highlighted) and the
     `README.md` (rendered).
   - A Mermaid block renders. Relative links and images work, and an external
     link opens the browser.
   - Ask Claude to edit a file. Within about 3 s it appears in Changes, and
     the diff is correct.
   - Drag the splitter, switch tasks and come back: the panel state is
     restored.
   - For a folder target, the Changes tab is hidden.
