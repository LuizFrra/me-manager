import type { ChangeList } from '../../../shared/types'

/** A small demo project served by the mock API, so the files panel shows something in a browser. */
export const DEMO_FILES: Record<string, string> = {
  'README.md': `# Demo project

A tiny project served by the **mock API**, so the files panel has something to show.

- Read the [guide](docs/guide.md)
- Browse [the source](src/app.ts)
- Visit [the Mermaid docs](https://mermaid.js.org)

![Logo](assets/logo.svg)

## Status

| Area     | State   | Owner |
| -------- | ------- | ----- |
| Login    | Done    | Ana   |
| Payments | Ongoing | Bruno |
| Reports  | To do   | —     |

## Flow

\`\`\`mermaid
flowchart LR
  A[Request] --> B{Logged in?}
  B -- yes --> C[Dashboard]
  B -- no --> D[Login page]
\`\`\`

## Example

\`\`\`ts
export const greet = (name: string): string => \`Hello, \${name}!\`
\`\`\`

> Tip: press Ctrl+Shift+E to toggle this panel.
`,
  'docs/guide.md': `# Guide

Back to the [README](../README.md).

1. Install dependencies with \`npm ci\`.
2. Run \`npm run dev\`.
3. Open a task and press **Ctrl+Shift+E**.

- [x] Files tab
- [x] Changes tab
- [ ] Editing (out of scope)
`,
  'src/app.ts': `import { formatName } from './util/format'

export interface User {
  id: number
  name: string
}

// Greets every user, one per line.
export function greetAll(users: User[]): string {
  return users.map((u) => \`Hello, \${formatName(u.name)}!\`).join('\\n')
}

console.log(greetAll([{ id: 1, name: 'ana' }]))
`,
  'src/util/format.ts': `export function formatName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}
`,
  'package.json': `{
  "name": "demo-project",
  "version": "1.0.0",
  "scripts": { "start": "node dist/app.js" }
}
`,
  'notes.txt': 'Remember to add tests for formatName.\n',
  'assets/logo.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="8" fill="#4fa3ff"/><text x="60" y="26" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">demo</text></svg>\n',
}

/** Shown as binary in the viewer. */
export const DEMO_BINARY: Record<string, number> = { 'assets/icon.png': 2048 }

export const DEMO_PATHS = [...Object.keys(DEMO_FILES), ...Object.keys(DEMO_BINARY)].sort()

export const DEMO_CHANGES: ChangeList = {
  files: [
    { path: 'notes.txt', status: 'U', added: 1, removed: 0, binary: false },
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1, binary: false },
    { path: 'src/legacy.ts', status: 'D', added: 0, removed: 3, binary: false },
    { path: 'src/util/format.ts', status: 'A', added: 3, removed: 0, binary: false },
  ],
}

export const DEMO_DIFFS: Record<string, string> = {
  'notes.txt': `diff --git a/notes.txt b/notes.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1 @@
+Remember to add tests for formatName.
`,
  'src/app.ts': `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
+import { formatName } from './util/format'
+
 export interface User {
   id: number
   name: string
@@ -6,7 +8,7 @@ export interface User {
 
 // Greets every user, one per line.
 export function greetAll(users: User[]): string {
-  return users.map((u) => \`Hello, \${u.name}!\`).join('\\n')
+  return users.map((u) => \`Hello, \${formatName(u.name)}!\`).join('\\n')
 }
 
 console.log(greetAll([{ id: 1, name: 'ana' }]))
`,
  'src/legacy.ts': `diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 9f8e7d6..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function oldGreet(name: string): string {
-  return 'Hi ' + name
-}
`,
  'src/util/format.ts': `diff --git a/src/util/format.ts b/src/util/format.ts
new file mode 100644
index 0000000..c0ffee1
--- /dev/null
+++ b/src/util/format.ts
@@ -0,0 +1,3 @@
+export function formatName(name: string): string {
+  return name.charAt(0).toUpperCase() + name.slice(1)
+}
`,
}
