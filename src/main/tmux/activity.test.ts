import { describe, expect, it } from 'vitest'
import { BUSY_WINDOW_S, classifyActivity, isRecentlyActive, looksWaiting, paneTail, PANE_TAIL_LINES } from './activity'

// Screens as `capture-pane -p` returns them (trailing blank lines included, as tmux prints the whole height).
const blank = '\n'.repeat(12)

/** Captured from Claude Code 2.1.292 (the login method menu of a fresh config). */
const LOGIN_MENU = ` Welcome to Claude Code v2.1.292
..........................................................
       █████████                                        *
      ██▄█████▄██                        *
 Claude Code can be used with your Claude subscription or billed based on API usage through your
 Console account.

 Select login method:

 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise

   2. Anthropic Console account · API usage billing

   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI
${blank}`

/** A Bash permission prompt (2.1: no box, the prompt input is hidden while it shows). */
const PERMISSION = `⏺ I'll remove the build output first.

⏺ Bash(rm -rf build)
  ⎿  Running…

────────────────────────────────────────────────────────────────────────────────
 Bash command

   rm -rf build
   Remove the build folder

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /home/me/code/api
   3. No, and tell Claude what to do differently (esc)
${blank}`

/** The same prompt as older (1.x) versions drew it, inside a rounded box. */
const PERMISSION_BOXED = `╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                 │
│                                                              │
│   npm test                                                   │
│   Run the tests                                              │
│                                                              │
│ Do you want to proceed?                                      │
│ ❯ 1. Yes                                                     │
│   2. Yes, and don't ask again for npm test commands          │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
${blank}`

const EDIT_PROMPT = `────────────────────────────────────────────────────────────────────────────────
 Edit file
 src/parser.ts
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  12 -  return null
  12 +  return { ok: false }
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to parser.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
`

/** AskUserQuestion: options have description lines, and a select footer. */
const QUESTION = `────────────────────────────────────────────────────────────────────────────────
 ☐ Database

 Which database should the service use?

 ❯ 1. PostgreSQL
      Relational and mature
   2. SQLite
      Embedded, no server
   3. Type something.

 Enter to select · ↑/↓ to navigate · Esc to cancel
${blank}`

const PLAN_APPROVAL = ` Claude has written up a plan and is ready to execute. Would you like to proceed?

 ❯ 1. Yes, and auto-accept edits
   2. Yes, and manually approve edits
   3. No, keep planning
`

/** Claude finished: its reply, then the empty prompt input between two rules and the mode line. */
const IDLE = `❯ fix the failing parser test

⏺ Fixed: parseHeader now returns an error object instead of null. All 42 tests pass.

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
${blank}`

const IDLE_BOXED = `> fix the failing parser test

⏺ Fixed.

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts
`

/** A reply that itself asks a question with a numbered list: old output above the prompt input, not a dialog. */
const REPLY_WITH_QUESTION = `⏺ There are two ways to do this:

  1. Patch the parser in place
  2. Rewrite the header handling

  Do you want to proceed?

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts
`

/** The user's own earlier message was a numbered list; Claude Code shows it with the ❯ pointer. */
const USER_LIST_MESSAGE = `❯ 1. rename the flag
  2. update the docs

⏺ Done.

────────────────────────────────────────────────────────────────────────────────
❯ thanks, now run the tests
────────────────────────────────────────────────────────────────────────────────
`

const WORKING = `⏺ Reading the parser…

✻ Cogitating… (12s · ↓ 1.2k tokens)

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
`

describe('looksWaiting', () => {
  it.each([
    ['the login menu (captured)', LOGIN_MENU],
    ['a permission prompt', PERMISSION],
    ['a boxed permission prompt (older versions)', PERMISSION_BOXED],
    ['an edit prompt', EDIT_PROMPT],
    ['an AskUserQuestion menu', QUESTION],
    ['plan approval', PLAN_APPROVAL],
  ])('detects %s', (_name, pane) => {
    expect(looksWaiting(pane)).toBe(true)
  })

  it.each([
    ['the empty prompt input', IDLE],
    ['the boxed prompt input (older versions)', IDLE_BOXED],
    ['a reply that asks a question above the prompt input', REPLY_WITH_QUESTION],
    ['an earlier numbered-list message from the user', USER_LIST_MESSAGE],
    ['the spinner above the prompt input', WORKING],
    ['an empty screen', blank],
    ['a plain shell', '$ ls\nREADME.md  src\n$ '],
  ])('does not treat %s as waiting', (_name, pane) => {
    expect(looksWaiting(pane)).toBe(false)
  })

  it('looks only at the bottom of the screen', () => {
    const scrolledAway = `${PERMISSION}${Array.from({ length: PANE_TAIL_LINES }, (_, i) => `line ${i}`).join('\n')}`
    expect(looksWaiting(scrolledAway)).toBe(false)
  })
})

describe('paneTail', () => {
  it('drops blank lines and box borders, keeping the last lines', () => {
    expect(paneTail('a\n\n│ b │\n  \n')).toEqual(['a', 'b'])
    expect(paneTail(Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'))).toHaveLength(PANE_TAIL_LINES)
  })
})

describe('classifyActivity', () => {
  const now = 1_700_000_000_000
  const sec = now / 1000

  it(`is busy when the window printed within the last ${BUSY_WINDOW_S} s, whatever the screen shows`, () => {
    expect(classifyActivity({ activitySec: sec, nowMs: now })).toBe('busy')
    expect(classifyActivity({ activitySec: sec - BUSY_WINDOW_S, nowMs: now + 999, pane: PERMISSION })).toBe('busy')
    expect(isRecentlyActive(sec - BUSY_WINDOW_S - 1, now)).toBe(false)
  })

  it('is waiting when quiet with a dialog on screen', () => {
    expect(classifyActivity({ activitySec: sec - 10, nowMs: now, pane: PERMISSION })).toBe('waiting')
  })

  it('is idle when quiet at the prompt input, or when the screen could not be read', () => {
    expect(classifyActivity({ activitySec: sec - 10, nowMs: now, pane: IDLE })).toBe('idle')
    expect(classifyActivity({ activitySec: sec - 10, nowMs: now, pane: null })).toBe('idle')
    expect(classifyActivity({ activitySec: sec - 10, nowMs: now })).toBe('idle')
  })
})
