# me-manager Implementation Plan

> **For Claude:** This plan is built for parallel execution. Use
> superpowers:dispatching-parallel-agents (or superpowers:subagent-driven-development)
> to run each phase's tracks in parallel, one agent per track, each in its own git
> worktree. Within a track, follow the steps in order (TDD).

**Goal:** Build an Electron app for Linux and macOS that organizes Claude Code
work into themes. Repos open as per-task git worktrees, and each task runs
`claude` inside a persistent tmux session shown in an embedded terminal.

**Architecture:** The Electron main process owns small services (store, git,
tmux, pty) and an orchestrator that composes them. The React renderer talks to
it only through a typed `window.api` exposed by the preload over IPC. Terminals
are xterm.js views attached through node-pty to `tmux attach`. Sessions live on
a dedicated tmux socket, so they survive the app closing.

**Tech Stack:** Electron, electron-vite, TypeScript, React, xterm.js, node-pty,
tmux, git CLI, Vitest, Testing Library.

**Design doc:** `docs/plans/2026-10-16-me-manager-design.md`. Read it first.

---

## How the parallel execution works

```
Phase 0  (1 agent, on main)        Foundation: scaffold + shared contracts + stubs
            │  tag: phase-0
            ▼
Phase 1  (5 agents in parallel)    A Store │ B Git │ C Tmux │ D Pty+Terminal │ E UI
            │  merge all into main, run full suite, tag: phase-1
            ▼
Phase 2  (2 agents in parallel)    F Orchestrator │ G Electron wiring
            │  merge, run full suite, tag: phase-2
            ▼
Phase 3  (1 agent + the user)      Smoke test, packaging, README
```

The plan is parallel-safe because:

- **Phase 0 freezes the contracts** in `src/shared/types.ts`,
  `src/shared/ipc.ts` and `src/main/contracts.ts`. Every later track codes
  against these interfaces, never against another track's code.
- **Phase 0 creates stubs** for the two files that other tracks import before
  the real ones exist: `TerminalView.tsx` (owned by D, imported by E) and
  `orchestrator.ts` (owned by F, imported by G). The owning track replaces the
  stub, keeping the exported names and signatures.
- **Every file has exactly one owner** (table below), so merges never conflict.
- **All npm dependencies are installed in Phase 0**, so no track touches
  `package.json` or the lockfile.

### File ownership

| Owner | Files |
|---|---|
| P0 | `package.json`, lockfile, all config files, `src/shared/**`, `src/main/contracts.ts`, `src/main/exec*.ts`, `src/main/shellEnv.ts`, `src/main/paths*.ts`, `src/preload/index.d.ts`, `src/renderer/src/test/setup.ts` |
| A Store | `src/main/store/**` |
| B Git | `src/main/git/**` |
| C Tmux | `src/main/tmux/**` |
| D Pty+Terminal | `src/main/pty/**`, `src/renderer/src/components/TerminalView.tsx` |
| E UI | `src/renderer/src/**` (except `TerminalView.tsx` and `test/setup.ts`), `src/renderer/index.html` |
| F Orchestrator | `src/main/app/**` |
| G Wiring | `src/main/index.ts`, `src/main/ipc.ts`, `src/main/prereqs.ts`, `src/preload/index.ts` |
| P3 | `electron-builder.yml`, `README.md` |

### Rules for every track agent

1. **Work in your own worktree and branch.** For example, from the repo root:
   `git worktree add ../me-manager-wt/track-a -b track/a-store phase-0`, then
   `cd` there and run `npm ci`. (With Claude Code's Agent tool, use
   `isolation: "worktree"`.)
2. **Only create or modify files you own.** Never edit `package.json`, the
   lockfile, configs, `src/shared/**` or `src/main/contracts.ts`. If you need a
   contract change, **stop and report it** instead of working around it.
3. **Use TDD:** write the test, watch it fail, implement, watch it pass, commit.
4. **Before every commit**, run your own tests and `npm run typecheck`. Both
   must pass.
5. **Commit messages** use conventional style (`feat(store): ...`) and end
   with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
6. **When you finish**, report your branch name, the commits, and anything you
   could not do.

### Merging (coordinator, after each phase)

```bash
git checkout main
git merge --no-ff track/a-store      # repeat for each track of the phase
npm ci && npm test && npm run typecheck && npm run build
git tag phase-1                      # or phase-2
git worktree remove ../me-manager-wt/track-a   # clean up each track worktree
```

### Prerequisites (machine)

- **Linux:** `sudo apt install tmux git build-essential`
- **macOS:** `xcode-select --install && brew install tmux`
- **Both:** Node.js 20 or newer and Claude Code (`claude`) on PATH. The node-pty
  native module is rebuilt for Electron on `npm install`, which needs a C++
  toolchain.

---

# Phase 0 — Foundation (1 agent, on `main`)

### Task 0.1: Scaffold the electron-vite React + TS project

**Files:** creates the project skeleton in the repo root.

**Step 1: Generate the template into a temp dir.** The repo root already has
`docs/` and `.git`, so generate elsewhere and copy:

```bash
cd "$(mktemp -d)"
npm create @quick-start/electron@latest me-manager -- --template react-ts
```

If it prompts: say **No** to the update plugin and **No** to the download
mirror.

**Step 2: Copy it into the repo.**

```bash
rsync -a --exclude .git --exclude node_modules ./me-manager/ /home/luiz/Desktop/projetos/me-manager/
cd /home/luiz/Desktop/projetos/me-manager
```

**Step 3: Inspect the layout.** Expect `electron.vite.config.ts`,
`electron-builder.yml`, `tsconfig.json`, `tsconfig.node.json`,
`tsconfig.web.json`, `src/main/index.ts`, `src/preload/index.ts`,
`src/preload/index.d.ts`, `src/renderer/index.html`,
`src/renderer/src/{main.tsx,App.tsx,env.d.ts}`, `resources/icon.png`. If the
template differs, adapt the paths in the rest of this plan and note it in the
Phase 0 report.

**Step 4: Install dependencies.**

```bash
npm install
npm install node-pty
npm install -D @xterm/xterm @xterm/addon-fit @xterm/addon-clipboard \
  vitest jsdom @testing-library/react @testing-library/dom \
  @testing-library/user-event @testing-library/jest-dom
```

`npm install` triggers the template's `postinstall`
(`electron-builder install-app-deps`), which rebuilds node-pty for Electron.

- If that rebuild fails with a compiler error, install the toolchain from the
  prerequisites.
- If it fails because node-pty doesn't support this Electron version, try
  `npm install node-pty@beta` and record what you did.

**Step 5: Add test scripts to `package.json`.**

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 6: Create `vitest.config.ts`.**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/src/test/setup.ts'],
        },
      },
    ],
  },
})
```

**Step 7: Create `src/renderer/src/test/setup.ts`.**

```ts
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())
```

**Step 8: Update the tsconfig includes.**

- In `tsconfig.node.json`, add `"src/shared/**/*"` and `"vitest.config.ts"` to
  `include`.
- In `tsconfig.web.json`, add `"src/shared/**/*"` to `include`.

**Step 9: Remove the template demo UI.**

- Delete `src/renderer/src/components/Versions.tsx` and
  `src/renderer/src/assets/*`.
- Replace `src/renderer/src/App.tsx` with this placeholder (track E replaces
  it):

```tsx
export function App(): React.JSX.Element {
  return <div>me-manager</div>
}
```

- Replace `src/renderer/src/main.tsx` with:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

**Step 10: Add `.gitignore` entries** if the template's file lacks them:
`node_modules`, `out`, `dist`, `*.log`.

**Step 11: Verify.**

```bash
npm run typecheck && npm run build && npx vitest run --passWithNoTests
```

Expected: all three succeed.

**Step 12: Commit.**

```bash
git add -A && git commit -m "chore: scaffold electron-vite react-ts project with vitest"
```

### Task 0.2: Shared types and IPC contract

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/ipc.ts`

**Step 1: Write `src/shared/types.ts`.**

```ts
export interface Task {
  id: string
  name: string
  slug: string
  branch: string
  worktreePath: string
  baseRef: string
  createdAt: string
}

export interface Repo {
  id: string
  kind: 'repo'
  name: string
  slug: string
  path: string
  tasks: Task[]
}

export interface Folder {
  id: string
  kind: 'folder'
  name: string
  slug: string
  path: string
}

export type Item = Repo | Folder

export interface Theme {
  id: string
  name: string
  slug: string
  items: Item[]
}

export interface AppState {
  version: 1
  themes: Theme[]
}

/** What a terminal is attached to: a folder (no taskId) or a repo task. */
export interface Target {
  themeId: string
  itemId: string
  taskId?: string
}

/** Ids (task ids for tasks, item ids for folders/repos). */
export interface LiveStatus {
  running: string[]
  missing: string[]
}

export interface TabInfo {
  index: number
  name: string
  active: boolean
}

export interface UnsavedWork {
  uncommittedFiles: string[]
  unpushedCommits: string[]
}

export interface PrereqResult {
  ok: boolean
  missing: { tool: string; hint: string }[]
}

export function hasUnsavedWork(work: UnsavedWork): boolean {
  return work.uncommittedFiles.length > 0 || work.unpushedCommits.length > 0
}

/** The API the renderer sees as `window.api`. */
export interface MeManagerApi {
  getState(): Promise<AppState>
  getStatus(): Promise<LiveStatus>
  checkPrereqs(): Promise<PrereqResult>

  createTheme(name: string): Promise<AppState>
  removeTheme(themeId: string): Promise<AppState>

  pickDirectory(): Promise<string | null>
  addRepo(themeId: string, path: string): Promise<AppState>
  addFolder(themeId: string, path: string): Promise<AppState>
  removeItem(themeId: string, itemId: string): Promise<AppState>

  createTask(themeId: string, repoId: string, name: string): Promise<AppState>
  checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork>
  removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState>

  openTarget(target: Target): Promise<TabInfo[]>
  listTabs(target: Target): Promise<TabInfo[]>
  newTab(target: Target): Promise<TabInfo[]>
  selectTab(target: Target, index: number): Promise<TabInfo[]>
  closeTab(target: Target, index: number): Promise<TabInfo[]>
  restartClaude(target: Target): Promise<TabInfo[]>

  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyExit(cb: (code: number) => void): () => void
}
```

**Step 2: Write `src/shared/ipc.ts`.**

```ts
import type { MeManagerApi } from './types'

/** Methods of MeManagerApi that go over ipcRenderer.invoke. */
export const INVOKE_METHODS = [
  'getState',
  'getStatus',
  'checkPrereqs',
  'createTheme',
  'removeTheme',
  'pickDirectory',
  'addRepo',
  'addFolder',
  'removeItem',
  'createTask',
  'checkTaskRemoval',
  'removeTask',
  'openTarget',
  'listTabs',
  'newTab',
  'selectTab',
  'closeTab',
  'restartClaude',
] as const satisfies readonly (keyof MeManagerApi)[]

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

export const invokeChannel = (method: InvokeMethod): string => `api:${method}`

export const PTY_WRITE = 'pty:write'
export const PTY_RESIZE = 'pty:resize'
export const PTY_DATA = 'pty:data'
export const PTY_EXIT = 'pty:exit'
```

**Step 3:** Run `npm run typecheck`. Expected: PASS.

**Step 4: Commit.**

```bash
git add src/shared && git commit -m "feat(shared): add app types and IPC contract"
```

### Task 0.3: Naming rules (TDD)

**Files:**
- Create: `src/shared/naming.ts`
- Test: `src/shared/naming.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import { branchName, sessionName, slugify, targetKey } from './naming'

describe('slugify', () => {
  it('lowercases and dashes words', () => {
    expect(slugify('Fix Login Bug!')).toBe('fix-login-bug')
  })
  it('strips accents', () => {
    expect(slugify('Ação Rápida')).toBe('acao-rapida')
  })
  it('trims leading and trailing separators', () => {
    expect(slugify('  --x--  ')).toBe('x')
  })
  it('returns empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('')
  })
  it('truncates to 40 chars without a trailing dash', () => {
    const slug = slugify('a'.repeat(39) + ' bbbb')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('branchName', () => {
  it('namespaces by theme', () => {
    expect(branchName('client-x', 'fix-login-bug')).toBe('claude/client-x/fix-login-bug')
  })
})

describe('sessionName', () => {
  it('names task sessions', () => {
    expect(sessionName('client-x', 'my-api', 'fix-login-bug')).toBe('mmt_client-x_my-api_fix-login-bug')
  })
  it('names folder sessions so they cannot collide with task sessions', () => {
    expect(sessionName('client-x', 'notes')).toBe('mmf_client-x_notes')
  })
})

describe('targetKey', () => {
  it('uses the task id when present, otherwise the item id', () => {
    expect(targetKey({ themeId: 't', itemId: 'i', taskId: 'k' })).toBe('k')
    expect(targetKey({ themeId: 't', itemId: 'i' })).toBe('i')
  })
})
```

**Step 2:** Run `npx vitest run src/shared/naming.test.ts`. Expected: FAIL
(module not found).

**Step 3: Implement `src/shared/naming.ts`.**

```ts
import type { Target } from './types'

const MAX_SLUG = 40

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
}

export function branchName(themeSlug: string, taskSlug: string): string {
  return `claude/${themeSlug}/${taskSlug}`
}

/** Slugs never contain "_", so the prefixes keep task and folder sessions apart. */
export function sessionName(themeSlug: string, itemSlug: string, taskSlug?: string): string {
  return taskSlug ? `mmt_${themeSlug}_${itemSlug}_${taskSlug}` : `mmf_${themeSlug}_${itemSlug}`
}

export function targetKey(target: Target): string {
  return target.taskId ?? target.itemId
}
```

**Step 4:** Run `npx vitest run src/shared/naming.test.ts`. Expected: PASS.

**Step 5: Commit.**

```bash
git add src/shared && git commit -m "feat(shared): add slug, branch and session naming"
```

### Task 0.4: Command runner, login-shell PATH and app paths (TDD)

**Files:**
- Create: `src/main/exec.ts`, `src/main/shellEnv.ts`, `src/main/paths.ts`
- Test: `src/main/exec.test.ts`, `src/main/paths.test.ts`

**Step 1: Write the failing tests.**

`src/main/exec.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CommandError, run } from './exec'

describe('run', () => {
  it('returns stdout', async () => {
    await expect(run(process.execPath, ['-e', 'process.stdout.write("hi")'])).resolves.toBe('hi')
  })
  it('rejects with stderr on non-zero exit', async () => {
    const err = await run(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('boom')
    expect(err.code).toBe(3)
  })
  it('explains a missing binary', async () => {
    const err = await run('definitely-not-a-real-binary-xyz', []).catch((e) => e)
    expect(err).toBeInstanceOf(CommandError)
    expect(err.message).toContain('not found')
  })
})
```

`src/main/paths.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { appHome, stateFile, taskWorktreePath, worktreesRoot } from './paths'

describe('paths', () => {
  afterEach(() => {
    delete process.env.ME_MANAGER_HOME
  })
  it('honours ME_MANAGER_HOME', () => {
    process.env.ME_MANAGER_HOME = '/tmp/mm'
    expect(appHome()).toBe('/tmp/mm')
    expect(stateFile()).toBe(join('/tmp/mm', 'state.json'))
    expect(worktreesRoot()).toBe(join('/tmp/mm', 'worktrees'))
  })
  it('builds task worktree paths from slugs', () => {
    expect(taskWorktreePath('client-x', 'my-api', 'fix', '/root')).toBe(join('/root', 'client-x', 'my-api', 'fix'))
  })
})
```

**Step 2:** Run `npx vitest run src/main`. Expected: FAIL (modules missing).

**Step 3: Implement.**

`src/main/exec.ts`:

```ts
import { execFile } from 'node:child_process'

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
}

/** Runs a binary without a shell and resolves with stdout. Rejects with CommandError. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const command = [file, ...args].join(' ')
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 0, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout))
          return
        }
        const errno = (err as NodeJS.ErrnoException).code
        if (errno === 'ENOENT') {
          reject(new CommandError(command, null, '', `${file}: command not found on PATH`))
          return
        }
        const code = typeof err.code === 'number' ? err.code : null
        const detail = String(stderr).trim() || `exit code ${code}`
        reject(new CommandError(command, code, String(stderr), `${command} failed: ${detail}`))
      },
    )
  })
}
```

`src/main/shellEnv.ts`:

```ts
import { run } from './exec'

const MARK = '__ME_MANAGER_PATH__'

/**
 * GUI-launched Electron (desktop icon, macOS Dock) gets a minimal PATH that
 * misses nvm, ~/.local/bin and Homebrew. Ask the user's interactive login shell.
 */
export async function loadLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeoutMs: 5000 })
    const match = out.match(new RegExp(`${MARK}(.*)${MARK}`))
    if (match?.[1]) process.env.PATH = match[1]
  } catch {
    // Keep the inherited PATH; the prerequisite check will report missing tools.
  }
}
```

`src/main/paths.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TMUX_SOCKET = process.env.ME_MANAGER_TMUX_SOCKET || 'me-manager'

export function appHome(): string {
  return process.env.ME_MANAGER_HOME || join(homedir(), '.me-manager')
}

export const stateFile = (): string => join(appHome(), 'state.json')
export const tmuxConfFile = (): string => join(appHome(), 'tmux.conf')
export const worktreesRoot = (): string => join(appHome(), 'worktrees')

export function taskWorktreePath(themeSlug: string, repoSlug: string, taskSlug: string, root = worktreesRoot()): string {
  return join(root, themeSlug, repoSlug, taskSlug)
}
```

**Step 4:** Run `npx vitest run src/main`. Expected: PASS.

**Step 5: Commit.**

```bash
git add src/main && git commit -m "feat(main): add command runner, login-shell PATH and app paths"
```

### Task 0.5: Main-process service contracts and stubs

**Files:**
- Create: `src/main/contracts.ts`
- Create (stub, owned by F): `src/main/app/orchestrator.ts`
- Create (stub, owned by D): `src/renderer/src/components/TerminalView.tsx`
- Replace: `src/preload/index.d.ts`

**Step 1: Write `src/main/contracts.ts`.**

```ts
import type { AppState, MeManagerApi, TabInfo, UnsavedWork } from '../shared/types'

export interface StoreApi {
  load(): Promise<AppState>
  save(state: AppState): Promise<void>
}

export interface GitApi {
  /** Top-level directory of the repo containing `path`, or null if not a repo. */
  repoRoot(path: string): Promise<string | null>
  /** `git fetch origin --prune`; no-op when there is no origin remote. */
  fetch(repoPath: string): Promise<void>
  /** e.g. "origin/main"; falls back to local main/master/current branch. */
  resolveBaseRef(repoPath: string): Promise<string>
  addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>
  /** Removes the worktree (forced); prunes if its folder is already gone. */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>
  deleteBranch(repoPath: string, branch: string): Promise<void>
  getUnsavedWork(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<UnsavedWork>
}

export interface TmuxApi {
  hasSession(name: string): Promise<boolean>
  /** Session names on our socket; [] when the tmux server is not running. */
  listSessions(): Promise<string[]>
  /** Detached session whose first window runs `command` (a shell string). */
  newSession(name: string, cwd: string, windowName: string, command: string): Promise<void>
  /** No-op if the session does not exist. */
  killSession(name: string): Promise<void>
  listWindows(session: string): Promise<TabInfo[]>
  /** New window that becomes active; runs the default shell when command is omitted. */
  newWindow(session: string, cwd: string, windowName: string, command?: string): Promise<void>
  selectWindow(session: string, index: number): Promise<void>
  killWindow(session: string, index: number): Promise<void>
  attachCommand(session: string): { file: string; args: string[] }
}

export interface PtyApi {
  /** Spawns file/args in a pty, replacing (killing) any previous one. */
  attach(file: string, args: string[], cwd: string): void
  /** Kills the current pty without emitting exit. */
  detach(): void
  write(data: string): void
  /** Remembers the size and resizes the current pty, if any. */
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
}

/** What the orchestrator implements: everything except renderer/pty-only calls. */
export type AppService = Omit<
  MeManagerApi,
  'checkPrereqs' | 'pickDirectory' | 'ptyWrite' | 'ptyResize' | 'onPtyData' | 'onPtyExit'
>

export interface OrchestratorDeps {
  store: StoreApi
  git: GitApi
  tmux: TmuxApi
  pty: PtyApi
  worktreesRoot: string
  pathExists: (path: string) => boolean
}
```

**Step 2: Write the orchestrator stub** `src/main/app/orchestrator.ts`. Track F
replaces the body but keeps these exports and signatures.

```ts
import type { AppService, OrchestratorDeps } from '../contracts'

export class Orchestrator implements AppService {
  constructor(private readonly deps: OrchestratorDeps) {}
  async init(): Promise<void> {}
  getState = notImplemented
  getStatus = notImplemented
  createTheme = notImplemented
  removeTheme = notImplemented
  addRepo = notImplemented
  addFolder = notImplemented
  removeItem = notImplemented
  createTask = notImplemented
  checkTaskRemoval = notImplemented
  removeTask = notImplemented
  openTarget = notImplemented
  listTabs = notImplemented
  newTab = notImplemented
  selectTab = notImplemented
  closeTab = notImplemented
  restartClaude = notImplemented
}

function notImplemented(): never {
  throw new Error('Orchestrator not implemented yet')
}
```

If `noUnusedLocals` complains about `deps`, add `void this.deps` in `init()`.

**Step 3: Write the TerminalView stub**
`src/renderer/src/components/TerminalView.tsx`. Track D replaces the body but
keeps the props.

```tsx
import type { MeManagerApi } from '../../../shared/types'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'>
  /** Changes whenever the attached session changes; the terminal resets. */
  sessionKey: string
}

export function TerminalView(_props: TerminalViewProps): React.JSX.Element {
  return <div className="terminal-host" />
}
```

**Step 4: Replace `src/preload/index.d.ts`.**

```ts
import type { MeManagerApi } from '../shared/types'

declare global {
  interface Window {
    api: MeManagerApi
  }
}

export {}
```

The template's `src/preload/index.ts` may still reference
`@electron-toolkit/preload` and `window.electron`. Leave it alone if typecheck
passes; track G rewrites it. If typecheck fails, reduce it to
`export {}` plus a comment.

**Step 5: Verify.**

```bash
npm run typecheck && npm test && npm run build
```

Expected: PASS.

**Step 6: Commit and tag.**

```bash
git add -A && git commit -m "feat: add service contracts and stubs for parallel tracks"
git tag phase-0
```

---

# Phase 1 — Five parallel tracks (branch from `phase-0`)

## Track A: Store (`src/main/store/**`)

Pure state mutations plus atomic JSON persistence. Mutations take a state and
return a **new** state; they never mutate their input.

### Task A.1: State mutations (TDD)

**Files:**
- Create: `src/main/store/mutations.ts`
- Test: `src/main/store/mutations.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import type { Task } from '../../shared/types'
import * as m from './mutations'

const task = (slug: string): Task => ({
  id: `task-${slug}`,
  name: slug,
  slug,
  branch: `claude/t/${slug}`,
  worktreePath: `/wt/${slug}`,
  baseRef: 'origin/main',
  createdAt: '2026-01-01T00:00:00.000Z',
})

function setup() {
  let s = m.addTheme(m.emptyState(), 'Client X')
  const themeId = s.themes[0].id
  s = m.addRepo(s, themeId, '/code/my-api')
  const repoId = s.themes[0].items[0].id
  return { s, themeId, repoId }
}

describe('themes', () => {
  it('adds a theme with a slug', () => {
    const s = m.addTheme(m.emptyState(), 'Client X')
    expect(s.themes[0]).toMatchObject({ name: 'Client X', slug: 'client-x', items: [] })
  })
  it('rejects duplicate slugs', () => {
    const s = m.addTheme(m.emptyState(), 'Client X')
    expect(() => m.addTheme(s, 'client x')).toThrow(/already exists/)
  })
  it('rejects names without letters or numbers', () => {
    expect(() => m.addTheme(m.emptyState(), '!!!')).toThrow(/letters or numbers/)
  })
  it('does not mutate the input state', () => {
    const before = m.emptyState()
    m.addTheme(before, 'X')
    expect(before.themes).toHaveLength(0)
  })
  it('blocks removing a theme that still has tasks', () => {
    const { s, themeId, repoId } = setup()
    const withTask = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.removeTheme(withTask, themeId)).toThrow(/tasks/)
    expect(m.removeTheme(s, themeId).themes).toHaveLength(0)
  })
})

describe('items', () => {
  it('adds a repo named after the folder', () => {
    const { s } = setup()
    expect(s.themes[0].items[0]).toMatchObject({ kind: 'repo', name: 'my-api', slug: 'my-api', path: '/code/my-api', tasks: [] })
  })
  it('rejects the same path twice in one theme', () => {
    const { s, themeId } = setup()
    expect(() => m.addRepo(s, themeId, '/code/my-api')).toThrow(/already in this theme/)
  })
  it('rejects a second item with the same slug', () => {
    const { s, themeId } = setup()
    expect(() => m.addFolder(s, themeId, '/other/my-api')).toThrow(/already exists/)
  })
  it('allows the same repo in two themes', () => {
    let { s } = setup()
    s = m.addTheme(s, 'Side')
    s = m.addRepo(s, s.themes[1].id, '/code/my-api')
    expect(s.themes[1].items).toHaveLength(1)
  })
  it('adds a folder', () => {
    const { s, themeId } = setup()
    const next = m.addFolder(s, themeId, '/docs/contracts')
    expect(next.themes[0].items[1]).toMatchObject({ kind: 'folder', name: 'contracts', slug: 'contracts' })
  })
  it('blocks removing a repo with tasks', () => {
    const { s, themeId, repoId } = setup()
    const withTask = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.removeItem(withTask, themeId, repoId)).toThrow(/tasks/)
    expect(m.removeItem(s, themeId, repoId).themes[0].items).toHaveLength(0)
  })
})

describe('tasks', () => {
  it('adds and removes tasks', () => {
    const { s, themeId, repoId } = setup()
    const added = m.addTask(s, themeId, repoId, task('fix'))
    expect(m.getRepo(added, themeId, repoId).tasks).toHaveLength(1)
    const removed = m.removeTask(added, themeId, repoId, 'task-fix')
    expect(m.getRepo(removed, themeId, repoId).tasks).toHaveLength(0)
  })
  it('rejects duplicate task slugs in a repo', () => {
    const { s, themeId, repoId } = setup()
    const added = m.addTask(s, themeId, repoId, task('fix'))
    expect(() => m.addTask(added, themeId, repoId, task('fix'))).toThrow(/already exists/)
  })
  it('getRepo rejects folders', () => {
    const { s, themeId } = setup()
    const next = m.addFolder(s, themeId, '/docs/notes')
    const folderId = next.themes[0].items[1].id
    expect(() => m.getRepo(next, themeId, folderId)).toThrow(/not a repository/)
  })
})
```

**Step 2:** Run `npx vitest run src/main/store`. Expected: FAIL.

**Step 3: Implement `src/main/store/mutations.ts`.**

```ts
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AppState, Folder, Item, Repo, Task, Theme } from '../../shared/types'
import { slugify } from '../../shared/naming'

export function emptyState(): AppState {
  return { version: 1, themes: [] }
}

function clone(state: AppState): AppState {
  return structuredClone(state)
}

export function requireSlug(name: string, what: string): string {
  const slug = slugify(name)
  if (!slug) throw new Error(`${what} name "${name}" must contain letters or numbers`)
  return slug
}

export function getTheme(state: AppState, themeId: string): Theme {
  const theme = state.themes.find((t) => t.id === themeId)
  if (!theme) throw new Error(`Theme not found: ${themeId}`)
  return theme
}

export function getItem(state: AppState, themeId: string, itemId: string): Item {
  const item = getTheme(state, themeId).items.find((i) => i.id === itemId)
  if (!item) throw new Error(`Item not found: ${itemId}`)
  return item
}

export function getRepo(state: AppState, themeId: string, repoId: string): Repo {
  const item = getItem(state, themeId, repoId)
  if (item.kind !== 'repo') throw new Error(`"${item.name}" is not a repository`)
  return item
}

export function getTask(state: AppState, themeId: string, repoId: string, taskId: string): Task {
  const task = getRepo(state, themeId, repoId).tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return task
}

export function assertTaskSlugFree(repo: Repo, slug: string): void {
  if (repo.tasks.some((t) => t.slug === slug)) {
    throw new Error(`A task named "${slug}" already exists in ${repo.name}`)
  }
}

export function addTheme(state: AppState, name: string): AppState {
  const slug = requireSlug(name, 'Theme')
  if (state.themes.some((t) => t.slug === slug)) throw new Error(`A theme named "${name.trim()}" already exists`)
  const next = clone(state)
  next.themes.push({ id: randomUUID(), name: name.trim(), slug, items: [] })
  return next
}

export function removeTheme(state: AppState, themeId: string): AppState {
  const theme = getTheme(state, themeId)
  if (theme.items.some((i) => i.kind === 'repo' && i.tasks.length > 0)) {
    throw new Error(`Remove the tasks in "${theme.name}" first`)
  }
  const next = clone(state)
  next.themes = next.themes.filter((t) => t.id !== themeId)
  return next
}

function addItem(state: AppState, themeId: string, item: Repo | Folder): AppState {
  const theme = getTheme(state, themeId)
  if (theme.items.some((i) => i.path === item.path)) throw new Error(`${item.path} is already in this theme`)
  if (theme.items.some((i) => i.slug === item.slug)) {
    throw new Error(`An item named "${item.name}" already exists in this theme`)
  }
  const next = clone(state)
  getTheme(next, themeId).items.push(item)
  return next
}

export function addRepo(state: AppState, themeId: string, repoPath: string): AppState {
  const name = basename(repoPath)
  return addItem(state, themeId, { id: randomUUID(), kind: 'repo', name, slug: requireSlug(name, 'Repository'), path: repoPath, tasks: [] })
}

export function addFolder(state: AppState, themeId: string, folderPath: string): AppState {
  const name = basename(folderPath)
  return addItem(state, themeId, { id: randomUUID(), kind: 'folder', name, slug: requireSlug(name, 'Folder'), path: folderPath })
}

export function removeItem(state: AppState, themeId: string, itemId: string): AppState {
  const item = getItem(state, themeId, itemId)
  if (item.kind === 'repo' && item.tasks.length > 0) throw new Error(`Remove the tasks in "${item.name}" first`)
  const next = clone(state)
  const theme = getTheme(next, themeId)
  theme.items = theme.items.filter((i) => i.id !== itemId)
  return next
}

export function addTask(state: AppState, themeId: string, repoId: string, task: Task): AppState {
  assertTaskSlugFree(getRepo(state, themeId, repoId), task.slug)
  const next = clone(state)
  getRepo(next, themeId, repoId).tasks.push(task)
  return next
}

export function removeTask(state: AppState, themeId: string, repoId: string, taskId: string): AppState {
  getTask(state, themeId, repoId, taskId)
  const next = clone(state)
  const repo = getRepo(next, themeId, repoId)
  repo.tasks = repo.tasks.filter((t) => t.id !== taskId)
  return next
}
```

**Step 4:** Run `npx vitest run src/main/store`. Expected: PASS.

**Step 5: Commit.**

```bash
git add src/main/store && git commit -m "feat(store): add pure state mutations"
```

### Task A.2: File store (TDD)

**Files:**
- Create: `src/main/store/fileStore.ts`
- Test: `src/main/store/fileStore.test.ts`

**Step 1: Write the failing test.**

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileStore } from './fileStore'
import { addTheme, emptyState } from './mutations'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-store-'))
  file = join(dir, 'nested', 'state.json')
})

describe('FileStore', () => {
  it('returns empty state when the file does not exist', async () => {
    await expect(new FileStore(file).load()).resolves.toEqual(emptyState())
  })
  it('round-trips state', async () => {
    const store = new FileStore(file)
    const state = addTheme(emptyState(), 'Client X')
    await store.save(state)
    await expect(store.load()).resolves.toEqual(state)
  })
  it('keeps the previous version as .bak', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(first)
  })
  it('falls back to .bak when the main file is corrupt', async () => {
    const store = new FileStore(file)
    const first = addTheme(emptyState(), 'One')
    await store.save(first)
    await store.save(addTheme(first, 'Two'))
    await writeFile(file, '{ not json', 'utf8')
    await expect(store.load()).resolves.toEqual(first)
  })
  it('throws when both files are unreadable', async () => {
    const store = new FileStore(file)
    await store.save(emptyState())
    await writeFile(file, 'garbage', 'utf8')
    await expect(store.load()).rejects.toThrow(/Could not read/)
  })
})
```

The last test has no `.bak`, because only one save happened.

**Step 2:** Run `npx vitest run src/main/store`. Expected: FAIL.

**Step 3: Implement `src/main/store/fileStore.ts`.**

```ts
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppState } from '../../shared/types'
import type { StoreApi } from '../contracts'
import { emptyState } from './mutations'

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

function parseState(raw: string): AppState {
  const data = JSON.parse(raw)
  if (data?.version !== 1 || !Array.isArray(data.themes)) throw new Error('unrecognized state format')
  return data as AppState
}

export class FileStore implements StoreApi {
  constructor(private readonly file: string) {}

  async load(): Promise<AppState> {
    try {
      return parseState(await readFile(this.file, 'utf8'))
    } catch (err) {
      if (isNotFound(err)) return emptyState()
      try {
        return parseState(await readFile(this.file + '.bak', 'utf8'))
      } catch {
        throw new Error(`Could not read ${this.file}: ${(err as Error).message}`)
      }
    }
  }

  async save(state: AppState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    try {
      await copyFile(this.file, this.file + '.bak')
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }
}
```

**Step 4:** Run `npx vitest run src/main/store`, then `npm run typecheck`.
Expected: PASS.

**Step 5: Commit.**

```bash
git add src/main/store && git commit -m "feat(store): add atomic JSON file store with backup"
```

---

## Track B: Git (`src/main/git/**`)

Implements `GitApi` from `src/main/contracts.ts` by shelling out to `git`
through `run()` from `src/main/exec.ts`. Tests use real temporary repos.

> **macOS note:** `tmpdir()` is a symlink (`/var` → `/private/var`), so the
> tests compare against `realpath`.

### Task B.1: Test helpers + repoRoot/fetch/resolveBaseRef (TDD)

**Files:**
- Create: `src/main/git/gitService.ts`
- Create: `src/main/git/testRepos.ts` (test helper)
- Test: `src/main/git/gitService.test.ts`

**Step 1: Write the helper `src/main/git/testRepos.ts`.**

```ts
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../exec'

/** git with a fixed identity, so commits work on any machine. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return run('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args])
}

export async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(repo, file), content)
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', message)
}

/** A bare "origin", plus a clone of it with one commit on main. */
export async function makeClonedRepo(): Promise<{ root: string; clone: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mm-git-')))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const clone = join(root, 'clone')
  await run('git', ['init', '--bare', '-b', 'main', origin])
  await mkdir(seed)
  await run('git', ['init', '-b', 'main', seed])
  await commitFile(seed, 'README.md', 'hello\n', 'init')
  await git(seed, 'remote', 'add', 'origin', origin)
  await git(seed, 'push', 'origin', 'main')
  await run('git', ['clone', origin, clone])
  return { root, clone }
}

/** A repo with no remotes and one commit on main. */
export async function makeLocalRepo(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mm-git-')))
  const repo = join(root, 'local')
  await mkdir(repo)
  await run('git', ['init', '-b', 'main', repo])
  await commitFile(repo, 'README.md', 'hello\n', 'init')
  return { root, repo }
}
```

**Step 2: Write the failing tests** in `src/main/git/gitService.test.ts`.

```ts
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitService } from './gitService'
import { makeClonedRepo, makeLocalRepo } from './testRepos'

const svc = new GitService()

describe('repoRoot', () => {
  it('returns the top-level dir from a subfolder', async () => {
    const { clone } = await makeClonedRepo()
    await mkdir(join(clone, 'sub'))
    await expect(svc.repoRoot(join(clone, 'sub'))).resolves.toBe(clone)
  })
  it('returns null outside a repo', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'mm-norepo-')))
    await expect(svc.repoRoot(dir)).resolves.toBeNull()
  })
})

describe('fetch', () => {
  it('is a no-op without an origin remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.fetch(repo)).resolves.toBeUndefined()
  })
  it('fetches from origin', async () => {
    const { clone } = await makeClonedRepo()
    await expect(svc.fetch(clone)).resolves.toBeUndefined()
  })
})

describe('resolveBaseRef', () => {
  it('uses origin/HEAD for clones', async () => {
    const { clone } = await makeClonedRepo()
    await expect(svc.resolveBaseRef(clone)).resolves.toBe('origin/main')
  })
  it('uses local main without a remote', async () => {
    const { repo } = await makeLocalRepo()
    await expect(svc.resolveBaseRef(repo)).resolves.toBe('main')
  })
})
```

**Step 3:** Run `npx vitest run src/main/git`. Expected: FAIL (no
`gitService`).

**Step 4: Implement the first part of `src/main/git/gitService.ts`.**

```ts
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UnsavedWork } from '../../shared/types'
import type { GitApi } from '../contracts'
import { run } from '../exec'

export class GitService implements GitApi {
  private git(cwd: string, args: string[]): Promise<string> {
    return run('git', ['-C', cwd, ...args])
  }

  private async hasOrigin(repoPath: string): Promise<boolean> {
    const out = await this.git(repoPath, ['remote'])
    return out.split('\n').includes('origin')
  }

  private async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', '--quiet', ref])
      return true
    } catch {
      return false
    }
  }

  async repoRoot(path: string): Promise<string | null> {
    try {
      return (await this.git(path, ['rev-parse', '--show-toplevel'])).trim()
    } catch {
      return null
    }
  }

  async fetch(repoPath: string): Promise<void> {
    if (await this.hasOrigin(repoPath)) await this.git(repoPath, ['fetch', 'origin', '--prune'])
  }

  async resolveBaseRef(repoPath: string): Promise<string> {
    if (await this.hasOrigin(repoPath)) {
      try {
        const head = (await this.git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
        if (head) return head
      } catch {
        // origin/HEAD not set; try well-known names below
      }
      for (const name of ['origin/main', 'origin/master']) {
        if (await this.refExists(repoPath, `refs/remotes/${name}`)) return name
      }
    }
    for (const name of ['main', 'master']) {
      if (await this.refExists(repoPath, `refs/heads/${name}`)) return name
    }
    const current = (await this.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (current && current !== 'HEAD') return current
    throw new Error(`Could not find a base branch in ${repoPath}`)
  }

  async addWorktree(): Promise<void> {
    throw new Error('not implemented')
  }

  async removeWorktree(): Promise<void> {
    throw new Error('not implemented')
  }

  async deleteBranch(): Promise<void> {
    throw new Error('not implemented')
  }

  async getUnsavedWork(): Promise<UnsavedWork> {
    throw new Error('not implemented')
  }
}
```

(The `existsSync`, `mkdir` and `dirname` imports are used in Task B.2. If lint
complains now, add them in B.2 instead.)

**Step 5:** Run `npx vitest run src/main/git`. Expected: PASS.

**Step 6: Commit.**

```bash
git add src/main/git && git commit -m "feat(git): resolve repo root and base branch"
```

### Task B.2: Worktrees, branches and unsaved work (TDD)

**Files:**
- Modify: `src/main/git/gitService.ts`
- Test: `src/main/git/gitService.test.ts` (append)

**Step 1: Append the failing tests.**

```ts
import { rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { commitFile, git } from './testRepos'
import { run } from '../exec'

async function withTask() {
  const { root, clone } = await makeClonedRepo()
  const wt = join(root, 'worktrees', 'client-x', 'clone', 'fix')
  await svc.addWorktree(clone, wt, 'claude/client-x/fix', 'origin/main')
  return { clone, wt, branch: 'claude/client-x/fix' }
}

describe('addWorktree', () => {
  it('creates the worktree on a new branch without upstream', async () => {
    const { wt, branch } = await withTask()
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    expect((await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branch)
    await expect(run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', '@{u}'])).rejects.toThrow()
  })
})

describe('getUnsavedWork', () => {
  it('is empty for a fresh task', async () => {
    const { clone, wt, branch } = await withTask()
    await expect(svc.getUnsavedWork(clone, wt, branch, 'origin/main')).resolves.toEqual({
      uncommittedFiles: [],
      unpushedCommits: [],
    })
  })
  it('reports uncommitted files and unpushed commits', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await writeFile(join(wt, 'b.txt'), 'b')
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual(['b.txt'])
    expect(work.unpushedCommits).toHaveLength(1)
    expect(work.unpushedCommits[0]).toContain('add a')
  })
  it('treats pushed commits as safe', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await git(wt, 'push', 'origin', branch)
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.unpushedCommits).toEqual([])
  })
  it('uses baseRef when the repo has no remote', async () => {
    const { root, repo } = await makeLocalRepo()
    const wt = join(root, 'wt')
    await svc.addWorktree(repo, wt, 'claude/t/x', 'main')
    await commitFile(wt, 'a.txt', 'a', 'local change')
    const work = await svc.getUnsavedWork(repo, wt, 'claude/t/x', 'main')
    expect(work.unpushedCommits).toHaveLength(1)
  })
  it('still checks the branch when the worktree folder is gone', async () => {
    const { clone, wt, branch } = await withTask()
    await commitFile(wt, 'a.txt', 'a', 'add a')
    await rm(wt, { recursive: true, force: true })
    const work = await svc.getUnsavedWork(clone, wt, branch, 'origin/main')
    expect(work.uncommittedFiles).toEqual([])
    expect(work.unpushedCommits).toHaveLength(1)
  })
})

describe('removeWorktree / deleteBranch', () => {
  it('removes a dirty worktree and deletes the branch', async () => {
    const { clone, wt, branch } = await withTask()
    await writeFile(join(wt, 'dirty.txt'), 'x')
    await svc.removeWorktree(clone, wt)
    await svc.deleteBranch(clone, branch)
    expect(existsSync(wt)).toBe(false)
    expect((await run('git', ['-C', clone, 'branch', '--list', branch])).trim()).toBe('')
  })
  it('prunes when the folder was deleted manually', async () => {
    const { clone, wt } = await withTask()
    await rm(wt, { recursive: true, force: true })
    await svc.removeWorktree(clone, wt)
    expect(await run('git', ['-C', clone, 'worktree', 'list'])).not.toContain(wt)
  })
})
```

Merge these imports into the file's existing import block.

**Step 2:** Run `npx vitest run src/main/git`. Expected: the new tests FAIL
with "not implemented".

**Step 3: Replace the four stub methods** in `gitService.ts`.

```ts
  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    await mkdir(dirname(worktreePath), { recursive: true })
    // --no-track: otherwise the branch would track origin/main and `git push` would be confusing.
    await this.git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseRef])
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (existsSync(worktreePath)) {
      await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath])
    } else {
      await this.git(repoPath, ['worktree', 'prune'])
    }
  }

  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    await this.git(repoPath, ['branch', '-D', branch])
  }

  async getUnsavedWork(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<UnsavedWork> {
    const uncommittedFiles = existsSync(worktreePath)
      ? (await this.git(worktreePath, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3))
      : []
    if (!(await this.refExists(repoPath, `refs/heads/${branch}`))) {
      return { uncommittedFiles, unpushedCommits: [] }
    }
    const range = (await this.hasOrigin(repoPath)) ? [branch, '--not', '--remotes'] : [`${baseRef}..${branch}`]
    const log = await this.git(repoPath, ['log', '--format=%h %s', ...range, '--'])
    return { uncommittedFiles, unpushedCommits: log.split('\n').filter(Boolean) }
  }
```

**Step 4:** Run `npx vitest run src/main/git && npm run typecheck`. Expected:
PASS.

**Step 5: Commit.**

```bash
git add src/main/git && git commit -m "feat(git): manage worktrees, branches and unsaved-work checks"
```

---

## Track C: Tmux (`src/main/tmux/**`)

Implements `TmuxApi` on a dedicated socket (`tmux -L <socket>`) with an
app-owned config file. Tests run a real tmux server on a unique socket and
skip when tmux isn't installed.

**tmux targeting notes:**
- `-t =name` means an exact session-name match.
- `=name:` means "next free window index in that session".
- `=name:3` means window 3 of that session.

### Task C.1: tmux config

**Files:**
- Create: `src/main/tmux/tmuxConf.ts`

**Step 1: Write it.** It has no test; it's a constant that C.2 exercises.

```ts
/**
 * Written to ~/.me-manager/tmux.conf; only used by our own tmux socket.
 * screen-256color (not tmux-256color) because macOS ncurses lacks tmux-256color.
 */
export const TMUX_CONF = `# Generated by me-manager. Changes are overwritten on start.
set -g status off
set -g mouse on
set -g history-limit 50000
set -sg escape-time 0
set -g focus-events on
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:RGB"
set -g set-clipboard on
set -as terminal-features ",xterm-256color:clipboard"
set -g allow-rename off
set -g automatic-rename off
set -g base-index 0
`
```

**Step 2: Commit.**

```bash
git add src/main/tmux && git commit -m "feat(tmux): add app tmux config"
```

### Task C.2: TmuxService (TDD)

**Files:**
- Create: `src/main/tmux/tmuxService.ts`
- Test: `src/main/tmux/tmuxService.test.ts`

**Step 1: Write the failing test.**

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { TmuxService } from './tmuxService'

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const socket = `mm-test-${process.pid}-${Date.now()}`
let svc: TmuxService
let cwd: string

describe.skipIf(!hasTmux)('TmuxService', () => {
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mm-tmux-'))
    svc = new TmuxService(socket, join(cwd, 'tmux.conf'))
    await svc.ensureConfig()
  })
  afterAll(async () => {
    await run('tmux', ['-L', socket, 'kill-server']).catch(() => {})
  })

  it('lists no sessions before the server starts', async () => {
    await expect(svc.listSessions()).resolves.toEqual([])
    await expect(svc.hasSession('nope')).resolves.toBe(false)
  })

  it('creates a session with a named first window', async () => {
    await svc.newSession('mmt_a_b_c', cwd, 'claude', 'sh')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(true)
    await expect(svc.listSessions()).resolves.toContain('mmt_a_b_c')
    await expect(svc.listWindows('mmt_a_b_c')).resolves.toEqual([{ index: 0, name: 'claude', active: true }])
  })

  it('matches session names exactly', async () => {
    await expect(svc.hasSession('mmt_a_b')).resolves.toBe(false)
  })

  it('adds, selects and kills windows', async () => {
    await svc.newWindow('mmt_a_b_c', cwd, 'shell')
    let tabs = await svc.listWindows('mmt_a_b_c')
    expect(tabs.map((t) => [t.name, t.active])).toEqual([
      ['claude', false],
      ['shell', true],
    ])
    await svc.selectWindow('mmt_a_b_c', 0)
    tabs = await svc.listWindows('mmt_a_b_c')
    expect(tabs[0].active).toBe(true)
    await svc.killWindow('mmt_a_b_c', 1)
    await expect(svc.listWindows('mmt_a_b_c')).resolves.toHaveLength(1)
  })

  it('builds an attach command on our socket', () => {
    const { file, args } = svc.attachCommand('mmt_a_b_c')
    expect(file).toBe('tmux')
    expect(args).toEqual(expect.arrayContaining(['-L', socket, 'attach-session', '-t', '=mmt_a_b_c']))
  })

  it('kills sessions and ignores missing ones', async () => {
    await svc.killSession('mmt_a_b_c')
    await expect(svc.hasSession('mmt_a_b_c')).resolves.toBe(false)
    await expect(svc.killSession('mmt_a_b_c')).resolves.toBeUndefined()
  })
})
```

The tests in this file run in order and share one server.

**Step 2:** Run `npx vitest run src/main/tmux`. Expected: FAIL (or SKIPPED
when tmux is missing; in that case install tmux first).

**Step 3: Implement `src/main/tmux/tmuxService.ts`.**

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TabInfo } from '../../shared/types'
import type { TmuxApi } from '../contracts'
import { CommandError, run } from '../exec'
import { TMUX_CONF } from './tmuxConf'

export class TmuxService implements TmuxApi {
  constructor(
    private readonly socket: string,
    private readonly configFile: string,
  ) {}

  async ensureConfig(): Promise<void> {
    await mkdir(dirname(this.configFile), { recursive: true })
    await writeFile(this.configFile, TMUX_CONF, 'utf8')
  }

  private baseArgs(): string[] {
    return ['-L', this.socket, '-f', this.configFile]
  }

  private tmux(args: string[]): Promise<string> {
    return run('tmux', [...this.baseArgs(), ...args])
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', `=${name}`])
      return true
    } catch (err) {
      if (err instanceof CommandError) return false
      throw err
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const out = await this.tmux(['list-sessions', '-F', '#{session_name}'])
      return out.split('\n').filter(Boolean)
    } catch (err) {
      if (err instanceof CommandError && /no server running|error connecting/i.test(err.stderr)) return []
      throw err
    }
  }

  async newSession(name: string, cwd: string, windowName: string, command: string): Promise<void> {
    await this.tmux(['new-session', '-d', '-s', name, '-c', cwd, '-n', windowName, command])
  }

  async killSession(name: string): Promise<void> {
    if (await this.hasSession(name)) await this.tmux(['kill-session', '-t', `=${name}`])
  }

  async listWindows(session: string): Promise<TabInfo[]> {
    const out = await this.tmux([
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      '#{window_index}\t#{window_name}\t#{window_active}',
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, windowName, active] = line.split('\t')
        return { index: Number(index), name: windowName, active: active === '1' }
      })
  }

  async newWindow(session: string, cwd: string, windowName: string, command?: string): Promise<void> {
    await this.tmux(['new-window', '-t', `=${session}:`, '-c', cwd, '-n', windowName, ...(command ? [command] : [])])
  }

  async selectWindow(session: string, index: number): Promise<void> {
    await this.tmux(['select-window', '-t', `=${session}:${index}`])
  }

  async killWindow(session: string, index: number): Promise<void> {
    await this.tmux(['kill-window', '-t', `=${session}:${index}`])
  }

  attachCommand(session: string): { file: string; args: string[] } {
    return { file: 'tmux', args: [...this.baseArgs(), 'attach-session', '-t', `=${session}`] }
  }
}
```

**Step 4:** Run `npx vitest run src/main/tmux && npm run typecheck`. Expected:
PASS, and no tests skipped.

**Step 5: Commit.**

```bash
git add src/main/tmux && git commit -m "feat(tmux): add tmux session and window service"
```

---

## Track D: Pty + Terminal view

### Task D.1: PtyService (TDD with a fake spawn)

**Files:**
- Create: `src/main/pty/ptyService.ts`
- Test: `src/main/pty/ptyService.test.ts`

The service **must not** import `node-pty` at runtime. Only a type import is
allowed, because the native module is built for Electron and won't load in
Vitest. Track G passes the real `pty.spawn` in.

**Step 1: Write the failing test.**

```ts
import { describe, expect, it, vi } from 'vitest'
import { PtyService, type SpawnFn } from './ptyService'

function fakeSpawn() {
  const procs: FakePty[] = []
  const spawn = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    const p = new FakePty(file, args, opts)
    procs.push(p)
    return p
  }) as unknown as SpawnFn & ReturnType<typeof vi.fn>
  return { spawn, procs }
}

class FakePty {
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  written: string[] = []
  size: [number, number] | null = null
  killed = false
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: Record<string, unknown>,
  ) {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb
    return { dispose() {} }
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
    return { dispose() {} }
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  kill() {
    this.killed = true
  }
}

describe('PtyService', () => {
  it('spawns with the remembered size and a clean env', () => {
    const { spawn, procs } = fakeSpawn()
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    const svc = new PtyService(spawn)
    svc.resize(100, 40)
    svc.attach('tmux', ['attach'], '/work')
    const opts = procs[0].opts as { cols: number; rows: number; cwd: string; env: Record<string, string> }
    expect([opts.cols, opts.rows, opts.cwd]).toEqual([100, 40, '/work'])
    expect(opts.env.TERM).toBe('xterm-256color')
    expect(opts.env.TMUX).toBeUndefined()
    delete process.env.TMUX
  })

  it('forwards data, writes and resizes for the current pty', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn)
    const data: string[] = []
    svc.onData((d) => data.push(d))
    svc.attach('tmux', [], '/w')
    procs[0].dataCb('hello')
    svc.write('ls\r')
    svc.resize(90, 30)
    expect(data).toEqual(['hello'])
    expect(procs[0].written).toEqual(['ls\r'])
    expect(procs[0].size).toEqual([90, 30])
  })

  it('kills the previous pty on re-attach and ignores its late events', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn)
    const data: string[] = []
    const exits: number[] = []
    svc.onData((d) => data.push(d))
    svc.onExit((c) => exits.push(c))
    svc.attach('tmux', ['a'], '/w')
    svc.attach('tmux', ['b'], '/w')
    expect(procs[0].killed).toBe(true)
    procs[0].dataCb('stale')
    procs[0].exitCb({ exitCode: 0 })
    expect(data).toEqual([])
    expect(exits).toEqual([])
  })

  it('emits exit when the current pty ends', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn)
    const exits: number[] = []
    svc.onExit((c) => exits.push(c))
    svc.attach('tmux', [], '/w')
    procs[0].exitCb({ exitCode: 1 })
    expect(exits).toEqual([1])
    svc.write('ignored')
    expect(procs[0].written).toEqual([])
  })

  it('detach kills without emitting exit; unsubscribe works', () => {
    const { spawn, procs } = fakeSpawn()
    const svc = new PtyService(spawn)
    const exits: number[] = []
    const off = svc.onExit((c) => exits.push(c))
    svc.attach('tmux', [], '/w')
    svc.detach()
    expect(procs[0].killed).toBe(true)
    off()
    svc.attach('tmux', [], '/w')
    procs[1].exitCb({ exitCode: 0 })
    expect(exits).toEqual([])
  })
})
```

**Step 2:** Run `npx vitest run src/main/pty`. Expected: FAIL.

**Step 3: Implement `src/main/pty/ptyService.ts`.**

```ts
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { PtyApi } from '../contracts'

export type SpawnFn = (file: string, args: string[], options: IPtyForkOptions) => IPty

export class PtyService implements PtyApi {
  private proc: IPty | null = null
  private cols = 120
  private rows = 30
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(private readonly spawn: SpawnFn) {}

  attach(file: string, args: string[], cwd: string): void {
    this.detach()
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env.TERM = 'xterm-256color'
    delete env.TMUX // launched from inside tmux? attaching would be refused as "nested"
    const proc = this.spawn(file, args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env })
    this.proc = proc
    proc.onData((data) => {
      if (this.proc === proc) this.dataListeners.forEach((cb) => cb(data))
    })
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return
      this.proc = null
      this.exitListeners.forEach((cb) => cb(exitCode))
    })
  }

  detach(): void {
    const proc = this.proc
    this.proc = null
    proc?.kill()
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    this.cols = cols
    this.rows = rows
    this.proc?.resize(cols, rows)
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}
```

**Step 4:** Run `npx vitest run src/main/pty && npm run typecheck`. Expected:
PASS.

**Step 5: Commit.**

```bash
git add src/main/pty && git commit -m "feat(pty): add pty service with safe re-attach"
```

### Task D.2: TerminalView (xterm.js)

**Files:**
- Replace: `src/renderer/src/components/TerminalView.tsx` (keep the exported
  names and props from the Phase 0 stub)

xterm.js doesn't render in jsdom, so this component has no unit test. Track E
mocks it, and Phase 3 verifies it in the real app. Keep it thin.

**Step 1: Implement.**

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import type { MeManagerApi } from '../../../shared/types'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'>
  /** Changes whenever the attached session changes; the terminal resets. */
  sessionKey: string
}

const isMac = navigator.userAgent.includes('Mac')

export function TerminalView({ api, sessionKey }: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'Menlo, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      macOptionClickForcesSelection: true,
      theme: { background: '#1e1e1e' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new ClipboardAddon()) // tmux copy-mode -> OSC 52 -> system clipboard
    term.open(host)

    // Linux has no app menu (it would steal Ctrl+C), so handle Ctrl+Shift+C/V here.
    // On macOS the Edit menu handles Cmd+C/V.
    term.attachCustomKeyEventHandler((e) => {
      if (isMac || e.type !== 'keydown' || !(e.ctrlKey && e.shiftKey)) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (key === 'v') {
        void navigator.clipboard.readText().then((text) => term.paste(text))
        return false
      }
      return true
    })

    const offData = api.onPtyData((data) => term.write(data))
    const input = term.onData((data) => api.ptyWrite(data))
    const doFit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      api.ptyResize(term.cols, term.rows)
    }
    const observer = new ResizeObserver(doFit)
    observer.observe(host)
    termRef.current = term
    fitRef.current = fit
    doFit()

    return () => {
      observer.disconnect()
      offData()
      input.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset() // the new tmux client redraws the whole screen on attach
    fitRef.current?.fit()
    api.ptyResize(term.cols, term.rows)
    term.focus()
  }, [sessionKey, api])

  return <div className="terminal-host" ref={hostRef} />
}
```

**Step 2:** Run `npm run typecheck && npm run build`. Expected: PASS.

**Step 3: Commit.**

```bash
git add src/renderer/src/components/TerminalView.tsx && git commit -m "feat(terminal): add xterm.js terminal view"
```

---

## Track E: UI (`src/renderer/src/**`)

React UI built against `MeManagerApi`, using an in-memory mock API for tests
and for `npm run dev` before track G lands.

- **Do not edit** `components/TerminalView.tsx` (owned by D) or `test/setup.ts`
  (owned by P0).
- **In tests, mock TerminalView:**
  `vi.mock('./components/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }))`.

### Task E.1: Mock API and API entry point

**Files:**
- Create: `src/renderer/src/api/mockApi.ts`
- Create: `src/renderer/src/api/index.ts`
- Test: `src/renderer/src/api/mockApi.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import { createMockApi } from './mockApi'

describe('createMockApi', () => {
  it('supports theme, repo and task flows', async () => {
    const api = createMockApi({ pickDirectory: async () => '/code/my-api' })
    let s = await api.createTheme('Client X')
    const themeId = s.themes[0].id
    s = await api.addRepo(themeId, (await api.pickDirectory())!)
    const repo = s.themes[0].items[0]
    expect(repo).toMatchObject({ kind: 'repo', name: 'my-api' })
    s = await api.createTask(themeId, repo.id, 'fix login')
    const task = s.themes[0].items[0].kind === 'repo' ? s.themes[0].items[0].tasks[0] : null
    expect(task).toMatchObject({ name: 'fix login', branch: 'claude/client-x/fix-login' })
  })
  it('applies overrides', async () => {
    const api = createMockApi({ checkPrereqs: async () => ({ ok: false, missing: [] }) })
    await expect(api.checkPrereqs()).resolves.toEqual({ ok: false, missing: [] })
  })
})
```

**Step 2:** Run `npx vitest run src/renderer`. Expected: FAIL.

**Step 3: Implement.**

`src/renderer/src/api/mockApi.ts`:

```ts
import type { AppState, MeManagerApi, TabInfo, Theme } from '../../../shared/types'
import { branchName, slugify } from '../../../shared/naming'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** In-memory MeManagerApi for tests and for running the UI in a browser. */
export function createMockApi(overrides: Partial<MeManagerApi> = {}): MeManagerApi {
  let state: AppState = { version: 1, themes: [] }
  let counter = 0
  const id = (): string => `id-${++counter}`
  const tabs: TabInfo[] = [{ index: 0, name: 'claude', active: true }]

  const edit = async (themeId: string, fn: (t: Theme) => void): Promise<AppState> => {
    const next = clone(state)
    const theme = next.themes.find((t) => t.id === themeId)
    if (!theme) throw new Error(`Theme not found: ${themeId}`)
    fn(theme)
    state = next
    return state
  }

  const api: MeManagerApi = {
    getState: async () => state,
    getStatus: async () => ({ running: [], missing: [] }),
    checkPrereqs: async () => ({ ok: true, missing: [] }),
    createTheme: async (name) => {
      state = { ...state, themes: [...state.themes, { id: id(), name, slug: slugify(name), items: [] }] }
      return state
    },
    removeTheme: async (themeId) => {
      state = { ...state, themes: state.themes.filter((t) => t.id !== themeId) }
      return state
    },
    pickDirectory: async () => `/home/demo/project-${++counter}`,
    addRepo: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'repo', name: baseName(path), slug: slugify(baseName(path)), path, tasks: [] })
      }),
    addFolder: (themeId, path) =>
      edit(themeId, (t) => {
        t.items.push({ id: id(), kind: 'folder', name: baseName(path), slug: slugify(baseName(path)), path })
      }),
    removeItem: (themeId, itemId) =>
      edit(themeId, (t) => {
        t.items = t.items.filter((i) => i.id !== itemId)
      }),
    createTask: (themeId, repoId, name) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind !== 'repo') throw new Error('Repository not found')
        const slug = slugify(name)
        repo.tasks.push({
          id: id(),
          name,
          slug,
          branch: branchName(t.slug, slug),
          worktreePath: `/home/demo/.me-manager/worktrees/${t.slug}/${repo.slug}/${slug}`,
          baseRef: 'origin/main',
          createdAt: new Date().toISOString(),
        })
      }),
    checkTaskRemoval: async () => ({ uncommittedFiles: [], unpushedCommits: [] }),
    removeTask: (themeId, repoId, taskId) =>
      edit(themeId, (t) => {
        const repo = t.items.find((i) => i.id === repoId)
        if (repo?.kind === 'repo') repo.tasks = repo.tasks.filter((k) => k.id !== taskId)
      }),
    openTarget: async () => tabs,
    listTabs: async () => tabs,
    newTab: async () => tabs,
    selectTab: async () => tabs,
    closeTab: async () => tabs,
    restartClaude: async () => tabs,
    ptyWrite: () => {},
    ptyResize: () => {},
    onPtyData: () => () => {},
    onPtyExit: () => () => {},
  }
  return { ...api, ...overrides }
}
```

`src/renderer/src/api/index.ts`:

```ts
import type { MeManagerApi } from '../../../shared/types'
import { createMockApi } from './mockApi'

/** Real API from the preload, or the in-memory mock when running in a plain browser. */
export const api: MeManagerApi = window.api ?? createMockApi()
```

**Step 4:** Run `npx vitest run src/renderer`. Expected: PASS.

**Step 5: Commit.**

```bash
git add src/renderer/src/api && git commit -m "feat(ui): add in-memory mock API"
```

### Task E.2: Presentational components

**Files:**
- Create: `src/renderer/src/components/Sidebar.tsx`
- Create: `src/renderer/src/components/TabBar.tsx`
- Create: `src/renderer/src/components/Dialogs.tsx`
- Create: `src/renderer/src/components/Toasts.tsx`
- Create: `src/renderer/src/components/PrereqScreen.tsx`
- Create: `src/renderer/src/lib/describe.ts`
- Test: `src/renderer/src/components/Toasts.test.ts`

**Step 1: Write the failing test** for the one piece of logic here.

```ts
import { describe, expect, it } from 'vitest'
import { cleanError } from './Toasts'

describe('cleanError', () => {
  it('strips the Electron IPC prefix', () => {
    const err = new Error("Error invoking remote method 'api:createTask': Error: A task named \"x\" already exists")
    expect(cleanError(err)).toBe('A task named "x" already exists')
  })
  it('handles non-errors', () => {
    expect(cleanError('plain')).toBe('plain')
  })
})
```

**Step 2:** Run `npx vitest run src/renderer`. Expected: FAIL.

**Step 3: Implement the components.**

`src/renderer/src/components/Toasts.tsx`:

```tsx
import { useCallback, useRef, useState } from 'react'

export interface Toast {
  id: number
  message: string
}

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useToasts(): { toasts: Toast[]; showError: (err: unknown) => void; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const showError = useCallback(
    (err: unknown) => {
      const id = ++nextId.current
      setToasts((ts) => [...ts, { id, message: cleanError(err) }])
      setTimeout(() => dismiss(id), 8000)
    },
    [dismiss],
  )
  return { toasts, showError, dismiss }
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="alert">
          <span>{t.message}</span>
          <button aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
```

`src/renderer/src/components/Dialogs.tsx`:

```tsx
import { useState } from 'react'
import type { UnsavedWork } from '../../../shared/types'

export function NameDialog(props: {
  title: string
  placeholder: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="overlay">
      <form
        className="dialog"
        role="dialog"
        aria-label={props.title}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          setBusy(true)
          try {
            await props.onSubmit(name.trim())
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2>{props.title}</h2>
        <input
          autoFocus
          aria-label="Name"
          placeholder={props.placeholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
        />
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Working…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function RemoveTaskDialog(props: {
  taskName: string
  work: UnsavedWork
  onConfirm: (deleteBranch: boolean) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [deleteBranch, setDeleteBranch] = useState(false)
  const { uncommittedFiles, unpushedCommits } = props.work
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-label={`Remove ${props.taskName}`}>
        <h2>Remove “{props.taskName}”?</h2>
        <p>This task has work that will be lost:</p>
        {uncommittedFiles.length > 0 && (
          <>
            <h3>{uncommittedFiles.length} uncommitted file(s)</h3>
            <ul>
              {uncommittedFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {unpushedCommits.length > 0 && (
          <>
            <h3>{unpushedCommits.length} unpushed commit(s)</h3>
            <ul>
              {unpushedCommits.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Also delete the branch
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => props.onConfirm(deleteBranch)}>
            Remove anyway
          </button>
        </div>
      </div>
    </div>
  )
}
```

`src/renderer/src/components/PrereqScreen.tsx`:

```tsx
import type { PrereqResult } from '../../../shared/types'

export function PrereqScreen({ result, onRetry }: { result: PrereqResult; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="prereq">
      <h1>Missing tools</h1>
      <p>me-manager needs these command-line tools:</p>
      <ul>
        {result.missing.map((m) => (
          <li key={m.tool}>
            <strong>{m.tool}</strong> — <code>{m.hint}</code>
          </li>
        ))}
      </ul>
      <button onClick={onRetry}>Check again</button>
    </div>
  )
}
```

`src/renderer/src/components/TabBar.tsx`:

```tsx
import type { TabInfo } from '../../../shared/types'

export function TabBar(props: {
  tabs: TabInfo[]
  onSelect: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onRestartClaude: () => void
}): React.JSX.Element {
  const hasClaude = props.tabs.some((t) => t.name === 'claude')
  return (
    <div className="tabbar" role="tablist">
      {props.tabs.map((t) => (
        <div key={t.index} className={t.active ? 'tab active' : 'tab'}>
          <button role="tab" aria-selected={t.active} onClick={() => props.onSelect(t.index)}>
            {t.name}
          </button>
          <button className="tab-close" aria-label={`Close tab ${t.name}`} onClick={() => props.onClose(t.index)}>
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" aria-label="New shell tab" onClick={props.onNew}>
        +
      </button>
      {!hasClaude && props.tabs.length > 0 && (
        <button className="restart" onClick={props.onRestartClaude}>
          Restart Claude
        </button>
      )}
    </div>
  )
}
```

`src/renderer/src/lib/describe.ts`:

```ts
import type { AppState, Target } from '../../../shared/types'

/** Header text for the selected target, or null if it no longer exists. */
export function describeTarget(state: AppState, target: Target): { title: string; subtitle: string } | null {
  const theme = state.themes.find((t) => t.id === target.themeId)
  const item = theme?.items.find((i) => i.id === target.itemId)
  if (!theme || !item) return null
  if (item.kind === 'folder') return { title: `${theme.name} › ${item.name}`, subtitle: item.path }
  const task = item.tasks.find((t) => t.id === target.taskId)
  if (!task) return null
  return { title: `${item.name} › ${task.name}`, subtitle: `branch: ${task.branch} · ${task.worktreePath}` }
}
```

`src/renderer/src/components/Sidebar.tsx`:

```tsx
import { useState } from 'react'
import type { AppState, LiveStatus, Target } from '../../../shared/types'

export interface SidebarProps {
  state: AppState
  status: LiveStatus
  selected: Target | null
  onSelect: (target: Target) => void
  onAddTheme: () => void
  onRemoveTheme: (themeId: string) => void
  onAddRepo: (themeId: string) => void
  onAddFolder: (themeId: string) => void
  onRemoveItem: (themeId: string, itemId: string) => void
  onAddTask: (themeId: string, repoId: string) => void
  onRemoveTask: (themeId: string, repoId: string, taskId: string, taskName: string) => void
}

export function Sidebar(p: SidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const running = new Set(p.status.running)
  const missing = new Set(p.status.missing)
  const arrow = (id: string): string => (collapsed.has(id) ? '▶' : '▼')
  const dot = (id: string): React.JSX.Element =>
    missing.has(id) ? (
      <span className="dot missing" title="Path missing">⚠</span>
    ) : running.has(id) ? (
      <span className="dot running" title="Session running">●</span>
    ) : (
      <span className="dot idle" title="No session">○</span>
    )
  const isSelected = (itemId: string, taskId?: string): boolean =>
    p.selected?.itemId === itemId && p.selected?.taskId === taskId

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <span>THEMES</span>
        <button aria-label="New theme" title="New theme" onClick={p.onAddTheme}>
          +
        </button>
      </div>
      {p.state.themes.length === 0 && <p className="hint">Create a theme to get started.</p>}
      {p.state.themes.map((theme) => (
        <div key={theme.id} className="theme">
          <div className="row theme-row">
            <button className="row-label" onClick={() => toggle(theme.id)}>
              {arrow(theme.id)} {theme.name}
            </button>
            <span className="row-actions">
              <button aria-label={`Add repository to ${theme.name}`} title="Add repository" onClick={() => p.onAddRepo(theme.id)}>
                📦+
              </button>
              <button aria-label={`Add folder to ${theme.name}`} title="Add folder" onClick={() => p.onAddFolder(theme.id)}>
                📁+
              </button>
              <button aria-label={`Remove theme ${theme.name}`} title="Remove theme" onClick={() => p.onRemoveTheme(theme.id)}>
                ×
              </button>
            </span>
          </div>
          {!collapsed.has(theme.id) &&
            theme.items.map((item) =>
              item.kind === 'folder' ? (
                <div key={item.id} className={`row item-row${isSelected(item.id) ? ' selected' : ''}`}>
                  <button className="row-label" onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id })}>
                    {dot(item.id)} 📁 {item.name}
                  </button>
                  <span className="row-actions">
                    <button aria-label={`Remove ${item.name}`} title="Remove folder" onClick={() => p.onRemoveItem(theme.id, item.id)}>
                      ×
                    </button>
                  </span>
                </div>
              ) : (
                <div key={item.id}>
                  <div className="row item-row">
                    <button className="row-label" onClick={() => toggle(item.id)}>
                      {arrow(item.id)} {missing.has(item.id) ? '⚠ ' : ''}📦 {item.name}
                    </button>
                    <span className="row-actions">
                      <button aria-label={`New task in ${item.name}`} title="New task" onClick={() => p.onAddTask(theme.id, item.id)}>
                        +
                      </button>
                      <button aria-label={`Remove ${item.name}`} title="Remove repository" onClick={() => p.onRemoveItem(theme.id, item.id)}>
                        ×
                      </button>
                    </span>
                  </div>
                  {!collapsed.has(item.id) &&
                    item.tasks.map((task) => (
                      <div key={task.id} className={`row task-row${isSelected(item.id, task.id) ? ' selected' : ''}`}>
                        <button
                          className="row-label"
                          onClick={() => p.onSelect({ themeId: theme.id, itemId: item.id, taskId: task.id })}
                        >
                          {dot(task.id)} {task.name}
                        </button>
                        <span className="row-actions">
                          <button
                            aria-label={`Remove task ${task.name}`}
                            title="Remove task"
                            onClick={() => p.onRemoveTask(theme.id, item.id, task.id, task.name)}
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    ))}
                </div>
              ),
            )}
        </div>
      ))}
    </nav>
  )
}
```

**Step 4:** Run `npx vitest run src/renderer && npm run typecheck`. Expected:
PASS.

**Step 5: Commit.**

```bash
git add src/renderer/src && git commit -m "feat(ui): add sidebar, tabs, dialogs, toasts and prereq screen"
```

### Task E.3: App container (TDD)

**Files:**
- Replace: `src/renderer/src/App.tsx`
- Replace: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/styles.css`
- Test: `src/renderer/src/App.test.tsx`

**Step 1: Write the failing test.**

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createMockApi } from './api/mockApi'

vi.mock('./components/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }))

async function createTheme(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New theme' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), name)
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: `Remove theme ${name}` })
}

async function createRepoAndTask(user: UserEvent): Promise<void> {
  await createTheme(user, 'Client X')
  await user.click(screen.getByRole('button', { name: 'Add repository to Client X' }))
  await user.click(await screen.findByRole('button', { name: 'New task in my-api' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'fix login bug')
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: 'Remove task fix login bug' })
}

const repoApi = (extra = {}) => createMockApi({ pickDirectory: async () => '/home/me/code/my-api', ...extra })

describe('App', () => {
  it('creates a theme', async () => {
    const user = userEvent.setup()
    render(<App api={createMockApi()} />)
    await createTheme(user, 'Client X')
    expect(screen.getByText(/Client X/)).toBeInTheDocument()
  })

  it('adds a repo, creates a task and opens it', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const openTarget = vi.spyOn(api, 'openTarget')
    render(<App api={api} />)
    await createRepoAndTask(user)
    expect(await screen.findByRole('tab', { name: 'claude' })).toBeInTheDocument()
    expect(openTarget).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String) }))
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
  })

  it('removes a clean task without asking and deletes its branch', async () => {
    const user = userEvent.setup()
    const api = repoApi()
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Remove task fix login bug' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(removeTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), true)
  })

  it('asks before removing a task with unsaved work', async () => {
    const user = userEvent.setup()
    const api = repoApi({
      checkTaskRemoval: async () => ({ uncommittedFiles: ['src/login.ts'], unpushedCommits: [] }),
    })
    const removeTask = vi.spyOn(api, 'removeTask')
    render(<App api={api} />)
    await createRepoAndTask(user)
    await user.click(screen.getByRole('button', { name: 'Remove task fix login bug' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('src/login.ts')).toBeInTheDocument()
    expect(removeTask).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Remove anyway' }))
    expect(removeTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), false)
  })

  it('shows backend errors as toasts', async () => {
    const user = userEvent.setup()
    const api = createMockApi({
      createTheme: async () => {
        throw new Error("Error invoking remote method 'api:createTheme': Error: A theme named \"X\" already exists")
      },
    })
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: 'New theme' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'X')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A theme named "X" already exists')
  })

  it('shows the missing tools screen', async () => {
    render(
      <App
        api={createMockApi({
          checkPrereqs: async () => ({ ok: false, missing: [{ tool: 'tmux', hint: 'Run: sudo apt install tmux' }] }),
        })}
      />,
    )
    expect(await screen.findByText('Run: sudo apt install tmux')).toBeInTheDocument()
  })
})
```

**Step 2:** Run `npx vitest run src/renderer`. Expected: FAIL.

**Step 3: Implement `src/renderer/src/App.tsx`.**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, LiveStatus, MeManagerApi, PrereqResult, TabInfo, Target, UnsavedWork } from '../../shared/types'
import { hasUnsavedWork } from '../../shared/types'
import { targetKey } from '../../shared/naming'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { NameDialog, RemoveTaskDialog } from './components/Dialogs'
import { Toasts, useToasts } from './components/Toasts'
import { PrereqScreen } from './components/PrereqScreen'
import { describeTarget } from './lib/describe'

type Dialog =
  | { kind: 'name'; title: string; placeholder: string; onSubmit: (name: string) => Promise<void> }
  | { kind: 'removeTask'; taskName: string; work: UnsavedWork; onConfirm: (deleteBranch: boolean) => Promise<void> }

const EMPTY: AppState = { version: 1, themes: [] }
const POLL_MS = 3000

export function App({ api }: { api: MeManagerApi }): React.JSX.Element {
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null)
  const [state, setState] = useState<AppState>(EMPTY)
  const [status, setStatus] = useState<LiveStatus>({ running: [], missing: [] })
  const [selected, setSelected] = useState<Target | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [sessionEnded, setSessionEnded] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const { toasts, showError, dismiss } = useToasts()
  const selectedRef = useRef<Target | null>(null)
  selectedRef.current = selected

  const attempt = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        showError(err)
        return undefined
      }
    },
    [showError],
  )

  const refresh = useCallback(() => {
    api.getStatus().then(setStatus, () => {})
    const current = selectedRef.current
    if (current) api.listTabs(current).then(setTabs, () => {})
  }, [api])

  const checkPrereqs = useCallback(() => {
    void attempt(async () => setPrereqs(await api.checkPrereqs()))
  }, [api, attempt])

  useEffect(() => {
    checkPrereqs()
    void attempt(async () => setState(await api.getState()))
  }, [api, attempt, checkPrereqs])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(
    () =>
      api.onPtyExit(() => {
        setSessionEnded(true)
        setTabs([])
        refresh()
      }),
    [api, refresh],
  )

  const open = async (target: Target): Promise<void> => {
    setSelected(target)
    setSessionEnded(false)
    const result = await attempt(() => api.openTarget(target))
    setTabs(result ?? [])
    refresh()
  }

  const tabAction = async (fn: (target: Target) => Promise<TabInfo[]>): Promise<void> => {
    if (!selected) return
    const result = await attempt(() => fn(selected))
    if (result) setTabs(result)
  }

  const clearSelectionIf = (pred: (t: Target) => boolean): void => {
    if (selected && pred(selected)) {
      setSelected(null)
      setTabs([])
    }
  }

  const askName = (title: string, placeholder: string, submit: (name: string) => Promise<AppState>, after?: (s: AppState, name: string) => void): void =>
    setDialog({
      kind: 'name',
      title,
      placeholder,
      onSubmit: async (name) => {
        const next = await attempt(() => submit(name))
        if (!next) return
        setState(next)
        setDialog(null)
        after?.(next, name)
      },
    })

  const update = async (fn: () => Promise<AppState>): Promise<AppState | undefined> => {
    const next = await attempt(fn)
    if (next) setState(next)
    return next
  }

  const addPath = async (themeId: string, add: (themeId: string, path: string) => Promise<AppState>): Promise<void> => {
    const path = await attempt(() => api.pickDirectory())
    if (path) await update(() => add(themeId, path))
  }

  const removeTask = async (themeId: string, repoId: string, taskId: string, taskName: string): Promise<void> => {
    const work = await attempt(() => api.checkTaskRemoval(themeId, repoId, taskId))
    if (!work) return
    const doRemove = async (deleteBranch: boolean): Promise<void> => {
      const next = await update(() => api.removeTask(themeId, repoId, taskId, deleteBranch))
      if (!next) return
      setDialog(null)
      clearSelectionIf((t) => t.taskId === taskId)
      refresh()
    }
    if (hasUnsavedWork(work)) setDialog({ kind: 'removeTask', taskName, work, onConfirm: doRemove })
    else await doRemove(true)
  }

  if (prereqs && !prereqs.ok) return <PrereqScreen result={prereqs} onRetry={checkPrereqs} />

  const header = selected ? describeTarget(state, selected) : null

  return (
    <div className="app">
      <Sidebar
        state={state}
        status={status}
        selected={selected}
        onSelect={(t) => void open(t)}
        onAddTheme={() => askName('New theme', 'e.g. Client X', (name) => api.createTheme(name))}
        onRemoveTheme={async (themeId) => {
          if (await update(() => api.removeTheme(themeId))) clearSelectionIf((t) => t.themeId === themeId)
        }}
        onAddRepo={(themeId) => void addPath(themeId, api.addRepo)}
        onAddFolder={(themeId) => void addPath(themeId, api.addFolder)}
        onRemoveItem={async (themeId, itemId) => {
          if (await update(() => api.removeItem(themeId, itemId))) clearSelectionIf((t) => t.itemId === itemId)
        }}
        onAddTask={(themeId, repoId) =>
          askName(
            'New task',
            'e.g. fix login bug',
            (name) => api.createTask(themeId, repoId, name),
            (next, name) => {
              const repo = next.themes.find((t) => t.id === themeId)?.items.find((i) => i.id === repoId)
              const task = repo?.kind === 'repo' ? repo.tasks.find((t) => t.name === name) : undefined
              if (task) void open({ themeId, itemId: repoId, taskId: task.id })
            },
          )
        }
        onRemoveTask={(themeId, repoId, taskId, taskName) => void removeTask(themeId, repoId, taskId, taskName)}
      />
      <main className="main">
        {selected && header ? (
          <>
            <header className="task-header">
              <div className="task-title">{header.title}</div>
              <div className="task-subtitle">{header.subtitle}</div>
            </header>
            <TabBar
              tabs={tabs}
              onSelect={(index) => void tabAction((t) => api.selectTab(t, index))}
              onClose={(index) => void tabAction((t) => api.closeTab(t, index))}
              onNew={() => void tabAction((t) => api.newTab(t))}
              onRestartClaude={() => void tabAction((t) => api.restartClaude(t))}
            />
            <div className="terminal-area">
              <TerminalView api={api} sessionKey={targetKey(selected)} />
              {sessionEnded && (
                <div className="session-ended">
                  <p>Session ended.</p>
                  <button onClick={() => void open(selected)}>Start again</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty">Select a task or folder, or create one from the sidebar.</div>
        )}
      </main>
      {dialog?.kind === 'name' && (
        <NameDialog title={dialog.title} placeholder={dialog.placeholder} onSubmit={dialog.onSubmit} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'removeTask' && (
        <RemoveTaskDialog taskName={dialog.taskName} work={dialog.work} onConfirm={dialog.onConfirm} onCancel={() => setDialog(null)} />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
```

`addPath(themeId, api.addRepo)` passes an unbound method. That's fine,
because neither the preload proxies nor the mock use `this`.

**Step 4: Replace `src/renderer/src/main.tsx`.**

```tsx
import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { api } from './api'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
)
```

**Step 5: Create `src/renderer/src/styles.css`.**

```css
:root {
  --bg: #1e1e1e;
  --panel: #252526;
  --border: #3c3c3c;
  --text: #d4d4d4;
  --muted: #8a8a8a;
  --accent: #4fa3ff;
  --danger: #e5534b;
  --ok: #3fb950;
  font-family: system-ui, -apple-system, 'Segoe UI', Ubuntu, sans-serif;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
}
* { box-sizing: border-box; }
html, body, #root { margin: 0; height: 100%; }
button { font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
button:hover { background: #ffffff14; }
button:disabled { opacity: 0.5; cursor: default; }

.app { display: grid; grid-template-columns: 280px 1fr; height: 100%; }
.sidebar { background: var(--panel); border-right: 1px solid var(--border); overflow-y: auto; padding: 8px 0; }
.sidebar-header { display: flex; justify-content: space-between; align-items: center; padding: 0 12px 8px; color: var(--muted); font-weight: 600; letter-spacing: 0.05em; }
.hint { color: var(--muted); padding: 0 12px; }
.row { display: flex; align-items: center; padding-right: 6px; }
.row:hover { background: #ffffff0a; }
.row.selected { background: #4fa3ff26; }
.row-label { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: none; border-radius: 0; padding: 4px 8px; }
.theme-row .row-label { padding-left: 12px; font-weight: 600; }
.item-row .row-label { padding-left: 28px; }
.task-row .row-label { padding-left: 48px; }
.row-actions { display: none; gap: 2px; }
.row:hover .row-actions, .row:focus-within .row-actions { display: flex; }
.dot.running { color: var(--ok); }
.dot.missing { color: #d29922; }
.dot.idle { color: var(--muted); }

.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.task-header { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.task-title { font-weight: 600; }
.task-subtitle { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabbar { display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--panel); }
.tab { display: flex; align-items: center; border-radius: 4px; }
.tab.active { background: var(--bg); }
.tab-close { opacity: 0.5; }
.restart { margin-left: auto; border-color: var(--accent); color: var(--accent); }
.terminal-area { position: relative; flex: 1; min-height: 0; }
.terminal-host { position: absolute; inset: 4px; }
.session-ended { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #1e1e1ee6; }
.empty { margin: auto; color: var(--muted); }

.overlay { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; width: min(420px, 90vw); display: flex; flex-direction: column; gap: 10px; }
.dialog h2 { margin: 0; font-size: 15px; }
.dialog h3 { margin: 4px 0 0; font-size: 13px; }
.dialog ul { margin: 0; padding-left: 18px; max-height: 160px; overflow-y: auto; font-family: monospace; }
.dialog input[aria-label='Name'] { padding: 6px 8px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dialog-actions button { border-color: var(--border); }
.danger { background: var(--danger); color: white; }
.checkbox { display: flex; gap: 6px; align-items: center; }

.toasts { position: fixed; bottom: 12px; right: 12px; display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
.toast { display: flex; gap: 8px; align-items: flex-start; background: #5a1d1d; border: 1px solid var(--danger); border-radius: 6px; padding: 8px 10px; }
.prereq { max-width: 560px; margin: 80px auto; }
```

**Step 6:** Run `npx vitest run src/renderer && npm run typecheck && npm run build`.
Expected: PASS.

**Step 7: Optional manual check.** `npm run dev` should show the UI. The
preload doesn't expose `window.api` yet, so it runs on the mock API. Terminals
will be blank.

**Step 8: Commit.**

```bash
git add src/renderer && git commit -m "feat(ui): add app shell with themes, tasks, tabs and removal flow"
```

---

# Phase 2 — Two parallel tracks (branch from `phase-1`)

## Track F: Orchestrator (`src/main/app/**`)

Composes the services and implements `AppService`. Replace the Phase 0 stub,
keeping `export class Orchestrator`, `constructor(deps: OrchestratorDeps)` and
`init()`. Tests use in-memory fakes, never real git or tmux.

### Task F.1: Test fakes

**Files:**
- Create: `src/main/app/fakes.ts`

```ts
import type { AppState, TabInfo, UnsavedWork } from '../../shared/types'
import type { GitApi, OrchestratorDeps, PtyApi, StoreApi, TmuxApi } from '../contracts'
import { emptyState } from '../store/mutations'

export class MemoryStore implements StoreApi {
  saved: AppState[] = []
  constructor(private state: AppState = emptyState()) {}
  async load() {
    return this.state
  }
  async save(state: AppState) {
    this.state = state
    this.saved.push(state)
  }
}

export class FakeGit implements GitApi {
  calls: string[] = []
  unsaved: UnsavedWork = { uncommittedFiles: [], unpushedCommits: [] }
  roots = new Map<string, string>()
  failFetch = false
  async repoRoot(path: string) {
    return this.roots.get(path) ?? null
  }
  async fetch(repo: string) {
    this.calls.push(`fetch ${repo}`)
    if (this.failFetch) throw new Error('offline')
  }
  async resolveBaseRef() {
    return 'origin/main'
  }
  async addWorktree(repo: string, wt: string, branch: string, base: string) {
    this.calls.push(`addWorktree ${wt} ${branch} ${base}`)
  }
  async removeWorktree(repo: string, wt: string) {
    this.calls.push(`removeWorktree ${wt}`)
  }
  async deleteBranch(repo: string, branch: string) {
    this.calls.push(`deleteBranch ${branch}`)
  }
  async getUnsavedWork() {
    return this.unsaved
  }
}

export class FakeTmux implements TmuxApi {
  sessions = new Map<string, { cwd: string; windows: { name: string; command?: string }[]; active: number }>()
  calls: string[] = []
  failNewSession = false
  async hasSession(name: string) {
    return this.sessions.has(name)
  }
  async listSessions() {
    return [...this.sessions.keys()]
  }
  async newSession(name: string, cwd: string, windowName: string, command: string) {
    this.calls.push(`newSession ${name} ${command}`)
    if (this.failNewSession) throw new Error('tmux failed')
    this.sessions.set(name, { cwd, windows: [{ name: windowName, command }], active: 0 })
  }
  async killSession(name: string) {
    this.calls.push(`killSession ${name}`)
    this.sessions.delete(name)
  }
  async listWindows(session: string): Promise<TabInfo[]> {
    const s = this.sessions.get(session)
    if (!s) throw new Error(`no session ${session}`)
    return s.windows.map((w, index) => ({ index, name: w.name, active: index === s.active }))
  }
  async newWindow(session: string, _cwd: string, windowName: string, command?: string) {
    const s = this.sessions.get(session)!
    s.windows.push({ name: windowName, command })
    s.active = s.windows.length - 1
  }
  async selectWindow(session: string, index: number) {
    this.sessions.get(session)!.active = index
  }
  async killWindow(session: string, index: number) {
    const s = this.sessions.get(session)!
    s.windows.splice(index, 1)
    s.active = 0
    if (s.windows.length === 0) this.sessions.delete(session)
  }
  attachCommand(session: string) {
    return { file: 'tmux', args: ['attach', session] }
  }
}

export class FakePty implements PtyApi {
  attached: { file: string; args: string[]; cwd: string } | null = null
  detached = 0
  attach(file: string, args: string[], cwd: string) {
    this.attached = { file, args, cwd }
  }
  detach() {
    this.attached = null
    this.detached++
  }
  write() {}
  resize() {}
  onData() {
    return () => {}
  }
  onExit() {
    return () => {}
  }
}

export function makeDeps(overrides: Partial<OrchestratorDeps> = {}) {
  const store = new MemoryStore()
  const git = new FakeGit()
  const tmux = new FakeTmux()
  const pty = new FakePty()
  const deps: OrchestratorDeps = { store, git, tmux, pty, worktreesRoot: '/wt', pathExists: () => true, ...overrides }
  return { deps, store, git, tmux, pty }
}
```

Fake windows keep a dense index, which is a simplification of tmux's real
behaviour. Commit with the tests in F.2.

### Task F.2: Themes, items and tasks (TDD)

**Files:**
- Replace: `src/main/app/orchestrator.ts`
- Test: `src/main/app/orchestrator.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import { Orchestrator, CLAUDE_CMD, CLAUDE_CONTINUE_CMD } from './orchestrator'
import { makeDeps } from './fakes'

async function setup() {
  const ctx = makeDeps()
  ctx.git.roots.set('/code/my-api/src', '/code/my-api')
  const orch = new Orchestrator(ctx.deps)
  await orch.init()
  let s = await orch.createTheme('Client X')
  const themeId = s.themes[0].id
  s = await orch.addRepo(themeId, '/code/my-api/src')
  const repoId = s.themes[0].items[0].id
  return { ...ctx, orch, themeId, repoId }
}

const taskOf = (s: Awaited<ReturnType<Orchestrator['getState']>>) => {
  const repo = s.themes[0].items[0]
  if (repo.kind !== 'repo') throw new Error('expected repo')
  return repo.tasks[0]
}

describe('Orchestrator: themes and items', () => {
  it('persists a new theme', async () => {
    const { store, orch } = await setup()
    expect(store.saved.at(-1)?.themes[0].name).toBe('Client X')
    expect((await orch.getState()).themes).toHaveLength(1)
  })
  it('stores the repo top-level path', async () => {
    const { orch } = await setup()
    expect((await orch.getState()).themes[0].items[0].path).toBe('/code/my-api')
  })
  it('rejects non-repos', async () => {
    const { orch, themeId } = await setup()
    await expect(orch.addRepo(themeId, '/not/a/repo')).rejects.toThrow(/Not a git repository/)
  })
  it('kills the folder session when removing a folder', async () => {
    const { orch, tmux, themeId } = await setup()
    const s = await orch.addFolder(themeId, '/docs/notes')
    const folderId = s.themes[0].items[1].id
    await orch.openTarget({ themeId, itemId: folderId })
    await orch.removeItem(themeId, folderId)
    expect(tmux.calls).toContain('killSession mmf_client-x_notes')
  })
})

describe('Orchestrator: createTask', () => {
  it('fetches, creates worktree + session, and saves', async () => {
    const { orch, git, tmux, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'Fix Login Bug'))
    expect(task).toMatchObject({
      name: 'Fix Login Bug',
      slug: 'fix-login-bug',
      branch: 'claude/client-x/fix-login-bug',
      worktreePath: '/wt/client-x/my-api/fix-login-bug',
      baseRef: 'origin/main',
    })
    expect(git.calls).toEqual([
      'fetch /code/my-api',
      'addWorktree /wt/client-x/my-api/fix-login-bug claude/client-x/fix-login-bug origin/main',
    ])
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix-login-bug ${CLAUDE_CMD}`)
  })
  it('continues when fetch fails (offline)', async () => {
    const { orch, git, themeId, repoId } = await setup()
    git.failFetch = true
    await expect(orch.createTask(themeId, repoId, 'x')).resolves.toBeDefined()
  })
  it('rejects duplicate names before touching git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    await orch.createTask(themeId, repoId, 'fix')
    git.calls = []
    await expect(orch.createTask(themeId, repoId, 'FIX')).rejects.toThrow(/already exists/)
    expect(git.calls).toEqual([])
  })
  it('rolls back the worktree and branch when tmux fails', async () => {
    const { orch, git, tmux, store, themeId, repoId } = await setup()
    tmux.failNewSession = true
    const savesBefore = store.saved.length
    await expect(orch.createTask(themeId, repoId, 'fix')).rejects.toThrow('tmux failed')
    expect(git.calls).toContain('removeWorktree /wt/client-x/my-api/fix')
    expect(git.calls).toContain('deleteBranch claude/client-x/fix')
    expect(store.saved.length).toBe(savesBefore)
  })
})

describe('Orchestrator: removeTask', () => {
  it('detaches, kills the session, removes the worktree and optionally the branch', async () => {
    const { orch, git, tmux, pty, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.openTarget({ themeId, itemId: repoId, taskId: task.id })
    const s = await orch.removeTask(themeId, repoId, task.id, true)
    expect(pty.detached).toBeGreaterThan(0)
    expect(tmux.sessions.size).toBe(0)
    expect(git.calls).toContain('removeWorktree /wt/client-x/my-api/fix')
    expect(git.calls).toContain('deleteBranch claude/client-x/fix')
    expect(taskOf(s)).toBeUndefined()
  })
  it('keeps the branch when asked', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    await orch.removeTask(themeId, repoId, task.id, false)
    expect(git.calls).not.toContain('deleteBranch claude/client-x/fix')
  })
  it('reports unsaved work from git', async () => {
    const { orch, git, themeId, repoId } = await setup()
    const task = taskOf(await orch.createTask(themeId, repoId, 'fix'))
    git.unsaved = { uncommittedFiles: ['a.ts'], unpushedCommits: [] }
    await expect(orch.checkTaskRemoval(themeId, repoId, task.id)).resolves.toEqual(git.unsaved)
  })
})
```

**Step 2:** Run `npx vitest run src/main/app`. Expected: FAIL (stub throws
"not implemented", and the `CLAUDE_*` exports are missing).

**Step 3: Implement `src/main/app/orchestrator.ts`.**

```ts
import { randomUUID } from 'node:crypto'
import type { AppState, LiveStatus, TabInfo, Target, Task, UnsavedWork } from '../../shared/types'
import { branchName, sessionName } from '../../shared/naming'
import type { AppService, OrchestratorDeps } from '../contracts'
import { taskWorktreePath } from '../paths'
import * as m from '../store/mutations'

export const CLAUDE_CMD = 'claude'
/** `--continue` fails when there is no previous conversation; fall back to a fresh one. */
export const CLAUDE_CONTINUE_CMD = 'claude --continue || claude'
const CLAUDE_WINDOW = 'claude'

export class Orchestrator implements AppService {
  private state: AppState = m.emptyState()
  private current: Target | null = null

  constructor(private readonly deps: OrchestratorDeps) {}

  async init(): Promise<void> {
    this.state = await this.deps.store.load()
  }

  private async commit(next: AppState): Promise<AppState> {
    await this.deps.store.save(next)
    this.state = next
    return next
  }

  private resolve(target: Target): { session: string; cwd: string } {
    const theme = m.getTheme(this.state, target.themeId)
    const item = m.getItem(this.state, target.themeId, target.itemId)
    if (item.kind === 'folder') return { session: sessionName(theme.slug, item.slug), cwd: item.path }
    if (!target.taskId) throw new Error('Choose a task to open')
    const task = m.getTask(this.state, theme.id, item.id, target.taskId)
    return { session: sessionName(theme.slug, item.slug, task.slug), cwd: task.worktreePath }
  }

  private detachIf(pred: (t: Target) => boolean): void {
    if (this.current && pred(this.current)) {
      this.deps.pty.detach()
      this.current = null
    }
  }

  async getState(): Promise<AppState> {
    return this.state
  }

  async getStatus(): Promise<LiveStatus> {
    const sessions = new Set(await this.deps.tmux.listSessions().catch(() => [] as string[]))
    const running: string[] = []
    const missing: string[] = []
    for (const theme of this.state.themes) {
      for (const item of theme.items) {
        if (!this.deps.pathExists(item.path)) missing.push(item.id)
        if (item.kind === 'folder') {
          if (sessions.has(sessionName(theme.slug, item.slug))) running.push(item.id)
          continue
        }
        for (const task of item.tasks) {
          if (!this.deps.pathExists(task.worktreePath)) missing.push(task.id)
          if (sessions.has(sessionName(theme.slug, item.slug, task.slug))) running.push(task.id)
        }
      }
    }
    return { running, missing }
  }

  async createTheme(name: string): Promise<AppState> {
    return this.commit(m.addTheme(this.state, name))
  }

  async removeTheme(themeId: string): Promise<AppState> {
    const next = m.removeTheme(this.state, themeId) // throws if tasks remain
    const theme = m.getTheme(this.state, themeId)
    this.detachIf((t) => t.themeId === themeId)
    for (const item of theme.items) {
      if (item.kind === 'folder') await this.deps.tmux.killSession(sessionName(theme.slug, item.slug))
    }
    return this.commit(next)
  }

  async addRepo(themeId: string, path: string): Promise<AppState> {
    const root = await this.deps.git.repoRoot(path)
    if (!root) throw new Error(`Not a git repository: ${path}`)
    return this.commit(m.addRepo(this.state, themeId, root))
  }

  async addFolder(themeId: string, path: string): Promise<AppState> {
    return this.commit(m.addFolder(this.state, themeId, path))
  }

  async removeItem(themeId: string, itemId: string): Promise<AppState> {
    const next = m.removeItem(this.state, themeId, itemId) // throws if repo has tasks
    const theme = m.getTheme(this.state, themeId)
    const item = m.getItem(this.state, themeId, itemId)
    this.detachIf((t) => t.itemId === itemId)
    if (item.kind === 'folder') await this.deps.tmux.killSession(sessionName(theme.slug, item.slug))
    return this.commit(next)
  }

  async createTask(themeId: string, repoId: string, name: string): Promise<AppState> {
    const { git, tmux } = this.deps
    const theme = m.getTheme(this.state, themeId)
    const repo = m.getRepo(this.state, themeId, repoId)
    const slug = m.requireSlug(name, 'Task')
    m.assertTaskSlugFree(repo, slug)
    const branch = branchName(theme.slug, slug)
    const worktreePath = taskWorktreePath(theme.slug, repo.slug, slug, this.deps.worktreesRoot)
    const session = sessionName(theme.slug, repo.slug, slug)

    try {
      await git.fetch(repo.path)
    } catch {
      // Offline or auth problem: branch from the last fetched refs instead of failing.
    }
    const baseRef = await git.resolveBaseRef(repo.path)
    await git.addWorktree(repo.path, worktreePath, branch, baseRef)
    try {
      await tmux.newSession(session, worktreePath, CLAUDE_WINDOW, CLAUDE_CMD)
      const task: Task = { id: randomUUID(), name: name.trim(), slug, branch, worktreePath, baseRef, createdAt: new Date().toISOString() }
      return await this.commit(m.addTask(this.state, themeId, repoId, task))
    } catch (err) {
      await tmux.killSession(session).catch(() => {})
      await git.removeWorktree(repo.path, worktreePath).catch(() => {})
      await git.deleteBranch(repo.path, branch).catch(() => {})
      throw err
    }
  }

  async checkTaskRemoval(themeId: string, repoId: string, taskId: string): Promise<UnsavedWork> {
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    return this.deps.git.getUnsavedWork(repo.path, task.worktreePath, task.branch, task.baseRef)
  }

  async removeTask(themeId: string, repoId: string, taskId: string, deleteBranch: boolean): Promise<AppState> {
    const theme = m.getTheme(this.state, themeId)
    const repo = m.getRepo(this.state, themeId, repoId)
    const task = m.getTask(this.state, themeId, repoId, taskId)
    this.detachIf((t) => t.taskId === taskId)
    await this.deps.tmux.killSession(sessionName(theme.slug, repo.slug, task.slug))
    await this.deps.git.removeWorktree(repo.path, task.worktreePath)
    if (deleteBranch) await this.deps.git.deleteBranch(repo.path, task.branch).catch(() => {}) // may already be gone
    return this.commit(m.removeTask(this.state, themeId, repoId, taskId))
  }

  async openTarget(target: Target): Promise<TabInfo[]> {
    const { session, cwd } = this.resolve(target)
    if (!this.deps.pathExists(cwd)) throw new Error(`Folder not found: ${cwd}`)
    if (!(await this.deps.tmux.hasSession(session))) {
      await this.deps.tmux.newSession(session, cwd, CLAUDE_WINDOW, CLAUDE_CONTINUE_CMD)
    }
    const { file, args } = this.deps.tmux.attachCommand(session)
    this.deps.pty.attach(file, args, cwd)
    this.current = target
    return this.deps.tmux.listWindows(session)
  }

  async listTabs(target: Target): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    return this.deps.tmux.listWindows(session).catch(() => [])
  }

  async newTab(target: Target): Promise<TabInfo[]> {
    const { session, cwd } = this.resolve(target)
    const names = new Set((await this.deps.tmux.listWindows(session)).map((t) => t.name))
    let name = 'shell'
    for (let n = 2; names.has(name); n++) name = `shell ${n}`
    await this.deps.tmux.newWindow(session, cwd, name)
    return this.deps.tmux.listWindows(session)
  }

  async selectTab(target: Target, index: number): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    await this.deps.tmux.selectWindow(session, index)
    return this.deps.tmux.listWindows(session)
  }

  async closeTab(target: Target, index: number): Promise<TabInfo[]> {
    const { session } = this.resolve(target)
    await this.deps.tmux.killWindow(session, index)
    return this.listTabs(target)
  }

  async restartClaude(target: Target): Promise<TabInfo[]> {
    const { session, cwd } = this.resolve(target)
    if (!(await this.deps.tmux.hasSession(session))) return this.openTarget(target)
    const existing = (await this.deps.tmux.listWindows(session)).find((t) => t.name === CLAUDE_WINDOW)
    if (existing) await this.deps.tmux.selectWindow(session, existing.index)
    else await this.deps.tmux.newWindow(session, cwd, CLAUDE_WINDOW, CLAUDE_CONTINUE_CMD)
    return this.deps.tmux.listWindows(session)
  }
}
```

**Step 4:** Run `npx vitest run src/main/app && npm run typecheck`. Expected:
PASS.

**Step 5: Commit.**

```bash
git add src/main/app && git commit -m "feat(app): orchestrate themes, repos and task lifecycle"
```

### Task F.3: Sessions, tabs and status (TDD)

**Files:**
- Test: `src/main/app/orchestrator.test.ts` (append)

**Step 1: Append the tests.** They should already pass against F.2's code. If
one fails, fix the code, not the test.

```ts
describe('Orchestrator: sessions and tabs', () => {
  async function withTask() {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    const target = { themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id }
    return { ...ctx, task, target }
  }

  it('attaches to an existing session without recreating it', async () => {
    const { orch, tmux, pty, target } = await withTask()
    tmux.calls = []
    const tabs = await orch.openTarget(target)
    expect(tmux.calls).toEqual([])
    expect(pty.attached?.args).toEqual(['attach', 'mmt_client-x_my-api_fix'])
    expect(pty.attached?.cwd).toBe('/wt/client-x/my-api/fix')
    expect(tabs).toEqual([{ index: 0, name: 'claude', active: true }])
  })

  it('recreates a missing session with claude --continue', async () => {
    const { orch, tmux, target } = await withTask()
    tmux.sessions.clear() // e.g. after a reboot
    await orch.openTarget(target)
    expect(tmux.calls).toContain(`newSession mmt_client-x_my-api_fix ${CLAUDE_CONTINUE_CMD}`)
  })

  it('refuses to open a task whose worktree is missing', async () => {
    const ctx = await setup()
    const task = taskOf(await ctx.orch.createTask(ctx.themeId, ctx.repoId, 'fix'))
    ctx.deps.pathExists = () => false
    await expect(ctx.orch.openTarget({ themeId: ctx.themeId, itemId: ctx.repoId, taskId: task.id })).rejects.toThrow(/Folder not found/)
  })

  it('names new shell tabs uniquely', async () => {
    const { orch, target } = await withTask()
    await orch.newTab(target)
    const tabs = await orch.newTab(target)
    expect(tabs.map((t) => t.name)).toEqual(['claude', 'shell', 'shell 2'])
    expect(tabs[2].active).toBe(true)
  })

  it('restarts claude in a new window when it was closed', async () => {
    const { orch, target } = await withTask()
    await orch.newTab(target)
    await orch.closeTab(target, 0)
    const tabs = await orch.restartClaude(target)
    expect(tabs.map((t) => t.name)).toEqual(['shell', 'claude'])
  })

  it('returns no tabs after the last window closes', async () => {
    const { orch, target } = await withTask()
    await expect(orch.closeTab(target, 0)).resolves.toEqual([])
  })

  it('reports running sessions and missing paths', async () => {
    const ctx = await withTask()
    let status = await ctx.orch.getStatus()
    expect(status).toEqual({ running: [ctx.task.id], missing: [] })
    ctx.tmux.sessions.clear()
    ctx.deps.pathExists = (p) => p !== '/wt/client-x/my-api/fix'
    status = await ctx.orch.getStatus()
    expect(status).toEqual({ running: [], missing: [ctx.task.id] })
  })
})
```

**Step 2:** Run `npx vitest run src/main/app`. Expected: PASS.

**Step 3: Commit.**

```bash
git add src/main/app && git commit -m "test(app): cover sessions, tabs and live status"
```

---

## Track G: Electron wiring

Connects everything: main entry, IPC, preload and the prerequisite check. This
code is hard to unit-test, so it's verified with typecheck, build and a launch
check.

### Task G.1: Prerequisite check

**Files:**
- Create: `src/main/prereqs.ts`

```ts
import type { PrereqResult } from '../shared/types'
import { run } from './exec'

export async function checkPrereqs(): Promise<PrereqResult> {
  const mac = process.platform === 'darwin'
  const tools = [
    { tool: 'git', args: ['--version'], hint: mac ? 'xcode-select --install' : 'sudo apt install git' },
    { tool: 'tmux', args: ['-V'], hint: mac ? 'brew install tmux' : 'sudo apt install tmux' },
    { tool: 'claude', args: ['--version'], hint: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup' },
  ]
  const missing: PrereqResult['missing'] = []
  for (const t of tools) {
    try {
      await run(t.tool, t.args, { timeoutMs: 10_000 })
    } catch {
      missing.push({ tool: t.tool, hint: t.hint })
    }
  }
  return { ok: missing.length === 0, missing }
}
```

Commit: `git add src/main/prereqs.ts && git commit -m "feat(main): add prerequisite check"`

### Task G.2: IPC registration

**Files:**
- Create: `src/main/ipc.ts`

```ts
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { INVOKE_METHODS, invokeChannel, PTY_DATA, PTY_EXIT, PTY_RESIZE, PTY_WRITE, type InvokeMethod } from '../shared/ipc'
import type { AppService, PtyApi } from './contracts'
import { checkPrereqs } from './prereqs'

type Handler = (...args: unknown[]) => unknown

export function registerIpc(opts: { app: AppService; pty: PtyApi; getWindow: () => BrowserWindow | null }): void {
  const { app, pty, getWindow } = opts

  const special: Partial<Record<InvokeMethod, Handler>> = {
    checkPrereqs: () => checkPrereqs(),
    pickDirectory: async () => {
      const win = getWindow()
      const options = { properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
  }

  for (const method of INVOKE_METHODS) {
    const handler: Handler =
      special[method] ?? ((...args) => (app[method as keyof AppService] as unknown as Handler).apply(app, args))
    ipcMain.handle(invokeChannel(method), (_event, ...args: unknown[]) => handler(...args))
  }

  ipcMain.on(PTY_WRITE, (_event, data: string) => pty.write(data))
  ipcMain.on(PTY_RESIZE, (_event, cols: number, rows: number) => pty.resize(cols, rows))
  pty.onData((data) => getWindow()?.webContents.send(PTY_DATA, data))
  pty.onExit((code) => getWindow()?.webContents.send(PTY_EXIT, code))
}
```

Commit: `git add src/main/ipc.ts && git commit -m "feat(main): register IPC handlers"`

### Task G.3: Preload

**Files:**
- Replace: `src/preload/index.ts`

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_METHODS, invokeChannel, PTY_DATA, PTY_EXIT, PTY_RESIZE, PTY_WRITE } from '../shared/ipc'
import type { MeManagerApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invokers = Object.fromEntries(
  INVOKE_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(invokeChannel(method), ...args)]),
)

const api = {
  ...invokers,
  ptyWrite: (data: string) => ipcRenderer.send(PTY_WRITE, data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.send(PTY_RESIZE, cols, rows),
  onPtyData: (cb: (data: string) => void) => subscribe(PTY_DATA, cb),
  onPtyExit: (cb: (code: number) => void) => subscribe(PTY_EXIT, cb),
} as unknown as MeManagerApi

contextBridge.exposeInMainWorld('api', api)
```

If `@electron-toolkit/preload` is no longer imported anywhere, leave it in
`package.json`; Phase 3 can clean it up.

Commit: `git add src/preload/index.ts && git commit -m "feat(preload): expose typed window.api"`

### Task G.4: Main entry

**Files:**
- Replace: `src/main/index.ts`. Keep the template's `createWindow` details that
  differ from below: the preload filename (`index.js` vs `index.mjs`), the icon
  import and the dev-URL loading.

```ts
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as nodePty from 'node-pty'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Orchestrator } from './app/orchestrator'
import { GitService } from './git/gitService'
import { registerIpc } from './ipc'
import { stateFile, tmuxConfFile, TMUX_SOCKET, worktreesRoot } from './paths'
import { PtyService } from './pty/ptyService'
import { loadLoginShellPath } from './shellEnv'
import { FileStore } from './store/fileStore'
import { TmuxService } from './tmux/tmuxService'

let mainWindow: BrowserWindow | null = null
let ptyService: PtyService | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#1e1e1e',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * macOS: standard menus so Cmd+C/V/Q work (the terminal uses Ctrl, so there is no conflict).
 * Linux: no menu, because accelerators like Ctrl+C / Ctrl+R would be stolen from the terminal.
 */
function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId('com.me-manager.app')
  // If launched from inside a Claude Code session, don't let `claude` think it is nested.
  delete process.env.CLAUDECODE
  await loadLoginShellPath()

  const tmux = new TmuxService(TMUX_SOCKET, tmuxConfFile())
  await tmux.ensureConfig()
  ptyService = new PtyService(nodePty.spawn)
  const orchestrator = new Orchestrator({
    store: new FileStore(stateFile()),
    git: new GitService(),
    tmux,
    pty: ptyService,
    worktreesRoot: worktreesRoot(),
    pathExists: existsSync,
  })
  await orchestrator.init()

  registerIpc({ app: orchestrator, pty: ptyService, getWindow: () => mainWindow })
  buildMenu()

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

app.whenReady().then(bootstrap, (err) => {
  console.error(err)
  app.quit()
})

// Detach only: tmux sessions (and Claude) keep running after the app closes.
app.on('before-quit', () => ptyService?.detach())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

**Verify:**

```bash
npm run typecheck && npm run build
```

Expected: PASS.

Then run the app briefly. Launch `npm run dev` with the Bash tool's
`run_in_background` option, so the process isn't attached to your shell.
Watch its output for about 20 seconds, then stop it. Expected: the window
opens and the logs show no uncaught errors. Problems to look out for:

- **node-pty ABI errors** ("was compiled against a different Node.js version")
  mean the Electron rebuild failed. Run `npx electron-builder install-app-deps`.
- **Preload path errors** mean the preload filename differs from the
  template's. Use the template's name.

Commit: `git add src/main/index.ts && git commit -m "feat(main): wire services, IPC, menus and window"`

---

# Phase 3 — Integration, smoke test, packaging (1 agent + user)

### Task 3.1: Merge and verify

```bash
git checkout main && git merge --no-ff track/f-orchestrator && git merge --no-ff track/g-wiring
npm ci && npm test && npm run typecheck && npm run build
git tag phase-2
```

Expected: everything passes, with no skipped tmux tests.

### Task 3.2: Manual smoke test (user, ~10 min)

Run `npm run dev` and check each item:

1. A missing tool shows the prerequisite screen. To test it, temporarily run
   `PATH=/usr/bin:/bin npm run dev` on a machine where `claude` lives
   elsewhere.
2. Create theme "Client X". Add a repository (any local clone) and add a
   folder.
3. Create task "try it". The terminal shows Claude starting in
   `~/.me-manager/worktrees/client-x/<repo>/try-it`, and
   `git -C <repo> worktree list` shows it on `claude/client-x/try-it`.
4. Type into Claude and confirm Ctrl+C reaches it (Linux) and that Cmd+C/V
   copy and paste (macOS). On Linux, Ctrl+Shift+C/V should copy and paste.
5. Add a shell tab, run `ls`, switch back to the claude tab, close the shell
   tab.
6. Add the same repo to a second theme and create a task with the same name.
   Both must work side by side.
7. Quit the app. `tmux -L me-manager ls` still lists the sessions. Reopen the
   app: tasks show ● and clicking one reattaches with the conversation intact.
8. Run `tmux -L me-manager kill-server`, then click a task. It restarts with
   `claude --continue`.
9. Make an uncommitted change in a task and remove the task. The dialog lists
   the file. Remove a clean task: it goes away without a dialog.
10. Try to remove a theme that has tasks. A toast explains why it can't.
11. Delete a worktree folder manually. The task shows ⚠ within a few seconds.

Fix anything that fails using superpowers:systematic-debugging, with a
regression test where possible.

### Task 3.3: Packaging

**Files:**
- Modify: `electron-builder.yml`

1. **Set the metadata:** `appId: com.me-manager.app` and
   `productName: me-manager`.
2. **Unpack node-pty from the asar,** so it can load its native binary and
   helper:

   ```yaml
   asarUnpack:
     - resources/**
     - node_modules/node-pty/**
   ```

3. **Set the targets:**
   - `mac.target`: `dmg` for `arm64` and `x64`
   - `linux.target`: `AppImage` and `deb`

   Leave signing and notarization unset.
4. **Build and check on Linux:** run `npm run build:linux`, then launch the
   AppImage and repeat smoke steps 2, 3 and 7.
5. **Build and check on macOS (on a Mac):** run `npm run build:mac`. The first
   launch needs right-click → Open, because the app is unsigned. Repeat smoke
   steps 2, 3, 4 and 7. Confirm tmux and claude are found when the app is
   launched from Finder, which exercises the login-shell PATH lookup.
6. **Commit:** `chore: configure electron-builder for linux and mac`

### Task 3.4: README

**Files:**
- Create: `README.md`

Cover: what the app does (one paragraph), the per-platform prerequisites (from
this plan), `npm install`, `npm run dev`, `npm test`, the build commands, and
where data lives (`~/.me-manager`). Also note that sessions persist in
`tmux -L me-manager` and can be attached from any terminal with
`tmux -L me-manager attach -t <session>`.

Commit: `docs: add README`
