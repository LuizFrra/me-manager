import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isTerminalEditor } from '../shared/editor'
import { createLauncher, editorLaunch, NO_EDITOR_FOUND, spawnDetached, whichOnPath, type LaunchDeps } from './launch'

const P = '/wt/client-x/my-api/fix'

function fakeDeps(
  opts: { onPath?: string[]; files?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): LaunchDeps & { spawned: { file: string; args: string[]; cwd: string }[] } {
  const onPath = new Set(opts.onPath ?? [])
  const files = new Set(opts.files ?? [])
  const spawned: { file: string; args: string[]; cwd: string }[] = []
  return {
    platform: opts.platform ?? 'linux',
    env: opts.env ?? {},
    homedir: '/home/me',
    which: (cmd) => (onPath.has(cmd) ? `/usr/bin/${cmd}` : null),
    exists: (path) => files.has(path),
    spawn: async (file, args, cwd) => {
      spawned.push({ file, args, cwd })
    },
    openPath: async () => '',
    spawned,
  }
}

describe('isTerminalEditor', () => {
  it('flags editors that need a terminal, by basename', () => {
    for (const cmd of ['vi', 'vim', 'nvim', 'nano', '/usr/bin/vim', 'micro', 'hx', 'kak'])
      expect(isTerminalEditor([cmd]), cmd).toBe(true)
    expect(isTerminalEditor(['emacs', '-nw'])).toBe(true)
    expect(isTerminalEditor(['emacsclient', '-t'])).toBe(true)
  })
  it('lets GUI editors through, including plain emacs', () => {
    for (const argv of [['code'], ['code', '-n'], ['gvim'], ['nvim-qt'], ['subl'], ['emacs'], ['emacsclient', '-c']])
      expect(isTerminalEditor(argv), argv.join(' ')).toBe(false)
    expect(isTerminalEditor([])).toBe(false)
  })
})

describe('editorLaunch: the editor from Settings', () => {
  it('splits the command shell-like and appends the path as one argument', () => {
    const deps = fakeDeps({ onPath: ['subl', 'code'] })
    expect(editorLaunch(P, 'subl -n', deps)).toEqual({ file: 'subl', args: ['-n', P] })
    expect(editorLaunch('/a b/$(x)', `code --profile "My Profile"`, deps)).toEqual({
      file: 'code',
      args: ['--profile', 'My Profile', '/a b/$(x)'],
    })
  })
  it('takes an absolute path to the program', () => {
    const deps = fakeDeps({ files: ['/opt/Zed/zed'] })
    expect(editorLaunch(P, "'/opt/Zed/zed'", deps)).toEqual({ file: '/opt/Zed/zed', args: [P] })
  })
  it('wins over auto-detection', () => {
    const deps = fakeDeps({ onPath: ['code', 'gedit'] })
    expect(editorLaunch(P, 'gedit', deps).file).toBe('gedit')
  })
  it('refuses terminal editors, missing programs and bad quoting', () => {
    const deps = fakeDeps({ onPath: ['vim', 'code'] })
    expect(() => editorLaunch(P, 'vim', deps)).toThrow(/vim runs in a terminal.*Settings/)
    expect(() => editorLaunch(P, 'emacs -nw', fakeDeps({ onPath: ['emacs'] }))).toThrow(/terminal/)
    expect(() => editorLaunch(P, 'nope', deps)).toThrow(/Editor not found: nope/)
    expect(() => editorLaunch(P, './code', deps)).toThrow(/Editor not found/)
    expect(() => editorLaunch(P, `code "x`, deps)).toThrow(/invalid.*double quote/)
  })
})

describe('editorLaunch: auto-detection', () => {
  it('prefers code, then cursor', () => {
    expect(editorLaunch(P, '', fakeDeps({ onPath: ['code', 'cursor'] }))).toEqual({ file: 'code', args: [P] })
    expect(editorLaunch(P, '', fakeDeps({ onPath: ['cursor'] }))).toEqual({ file: 'cursor', args: [P] })
  })
  it('then $VISUAL, then $EDITOR, split shell-like', () => {
    const env = { VISUAL: 'subl -w', EDITOR: 'gedit' }
    expect(editorLaunch(P, '', fakeDeps({ onPath: ['subl', 'gedit'], env }))).toEqual({
      file: 'subl',
      args: ['-w', P],
    })
    expect(editorLaunch(P, '', fakeDeps({ onPath: ['gedit'], env }))).toEqual({ file: 'gedit', args: [P] })
  })
  it('skips terminal editors in $VISUAL and $EDITOR', () => {
    const deps = fakeDeps({ onPath: ['vim', 'nano', 'gedit'], env: { VISUAL: 'vim', EDITOR: 'gedit' } })
    expect(editorLaunch(P, '', deps).file).toBe('gedit')
    const none = fakeDeps({ onPath: ['vim', 'nano'], env: { VISUAL: '/usr/bin/vim', EDITOR: 'nano' } })
    expect(() => editorLaunch(P, '', none)).toThrow(NO_EDITOR_FOUND)
  })
  it('skips $VISUAL / $EDITOR when the program is missing or the value is unparsable', () => {
    const deps = fakeDeps({ onPath: ['gedit'], env: { VISUAL: 'missing-editor', EDITOR: `"gedit` } })
    expect(() => editorLaunch(P, '', deps)).toThrow(NO_EDITOR_FOUND)
  })
  it('on macOS, opens the VS Code app when its code shim is not on PATH', () => {
    const app = '/Applications/Visual Studio Code.app'
    const mac = fakeDeps({ platform: 'darwin', files: [app], onPath: ['cursor'] })
    expect(editorLaunch(P, '', mac)).toEqual({ file: 'open', args: ['-a', 'Visual Studio Code', P] })
    const userApp = fakeDeps({ platform: 'darwin', files: ['/home/me/Applications/Visual Studio Code.app'] })
    expect(editorLaunch(P, '', userApp).file).toBe('open')
    expect(editorLaunch(P, '', fakeDeps({ platform: 'darwin', files: [app], onPath: ['code'] })).file).toBe('code')
    expect(() => editorLaunch(P, '', fakeDeps({ platform: 'linux', files: [app] }))).toThrow(NO_EDITOR_FOUND)
  })
  it('reports when nothing is found', () => {
    expect(() => editorLaunch(P, '', fakeDeps())).toThrow('No editor found — set one in Settings')
  })
})

describe('createLauncher', () => {
  it('spawns the chosen editor in the folder', async () => {
    const deps = fakeDeps({ onPath: ['code'] })
    await createLauncher(deps).openInEditor(P, '')
    expect(deps.spawned).toEqual([{ file: 'code', args: [P], cwd: P }])
  })
  it('explains a failed spawn', async () => {
    const deps = fakeDeps({ onPath: ['code'] })
    deps.spawn = async () => Promise.reject(new Error('spawn code EACCES'))
    await expect(createLauncher(deps).openInEditor(P, '')).rejects.toThrow('Could not start code: spawn code EACCES')
  })
  it('opens the file manager and surfaces its error string', async () => {
    const deps = fakeDeps()
    const openPath = vi.fn(async () => '')
    deps.openPath = openPath
    await createLauncher(deps).openInFileManager(P)
    expect(openPath).toHaveBeenCalledWith(P)
    deps.openPath = async () => 'Failed to open path'
    await expect(createLauncher(deps).openInFileManager(P)).rejects.toThrow(
      'Could not open the file manager: Failed to open path',
    )
  })
})

describe('system helpers', () => {
  it('whichOnPath finds executables only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-which-'))
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n')
    await chmod(join(dir, 'tool'), 0o755)
    await writeFile(join(dir, 'plain'), '')
    await mkdir(join(dir, 'folder'))
    expect(whichOnPath('tool', `/nonexistent:${dir}`)).toBe(join(dir, 'tool'))
    expect(whichOnPath('plain', dir)).toBeNull()
    expect(whichOnPath('folder', dir)).toBeNull()
    expect(whichOnPath('tool', '')).toBeNull()
  })
  it('spawnDetached runs without a shell and rejects for a missing program', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-spawn-'))
    const marker = join(dir, 'ran $(echo x)')
    await spawnDetached('touch', [marker], dir)
    await vi.waitFor(async () => expect((await import('node:fs')).existsSync(marker)).toBe(true))
    await expect(spawnDetached('/nonexistent/editor', [], dir)).rejects.toThrow(/ENOENT/)
  })
})
