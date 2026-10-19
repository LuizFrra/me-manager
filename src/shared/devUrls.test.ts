import { describe, expect, it } from 'vitest'
import { devUrlLabel, findDevUrls, stripAnsi } from './devUrls'

const ESC = '\x1b'

// What the servers print when they start, as they print it (colours included where they use them).
const VITE = [
  `  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v5.2.11${ESC}[39m  ${ESC}[2mready in ${ESC}[0m${ESC}[1m312${ESC}[22m${ESC}[2m${ESC}[0m ms${ESC}[22m`,
  '',
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`,
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: ${ESC}[2muse ${ESC}[22m${ESC}[1m--host${ESC}[22m${ESC}[2m to expose${ESC}[22m`,
  `  ${ESC}[2m${ESC}[32m➜${ESC}[39m${ESC}[22m${ESC}[2m  press ${ESC}[22m${ESC}[1mh + enter${ESC}[22m${ESC}[2m to show help${ESC}[22m`,
].join('\n')

const NEXT = [
  '  ▲ Next.js 14.2.3',
  '  - Local:        http://localhost:3000',
  '  - Network:      http://192.168.1.23:3000',
  '',
  ' ✓ Starting...',
  ' ✓ Ready in 1843ms',
].join('\n')

const CRA = [
  'Compiled successfully!',
  '',
  'You can now view my-app in the browser.',
  '',
  '  Local:            http://localhost:3000',
  '  On Your Network:  http://192.168.1.23:3000',
  '',
  'Note that the development build is not optimized.',
  'To create a production build, use npm run build.',
].join('\n')

const DJANGO = [
  'Watching for file changes with StatReloader',
  'Performing system checks...',
  '',
  'System check identified no issues (0 silenced).',
  'May 14, 2024 - 10:21:07',
  "Django version 5.0.6, using settings 'mysite.settings'",
  'Starting development server at http://127.0.0.1:8000/',
  'Quit the server with CONTROL-C.',
].join('\n')

const RAILS = [
  '=> Booting Puma',
  '=> Rails 7.1.3 application starting in development ',
  '=> Run `bin/rails server --help` for more startup options',
  'Puma starting in single mode...',
  '* Puma version: 6.4.2 (ruby 3.3.0-p0) ("The Eagle of Durango")',
  '*  Min threads: 5',
  '*  Environment: development',
  '*          PID: 12345',
  '* Listening on http://127.0.0.1:3000',
  '* Listening on http://[::1]:3000',
  'Use Ctrl-C to stop',
].join('\n')

const FLASK = [
  " * Serving Flask app 'app'",
  ' * Debug mode: on',
  'WARNING: This is a development server. Do not use it in a production deployment.',
  ' * Running on all addresses (0.0.0.0)',
  ' * Running on http://127.0.0.1:5000',
  ' * Running on http://192.168.1.23:5000',
  'Press CTRL+C to quit',
].join('\n')

describe('findDevUrls on what dev servers print', () => {
  it.each([
    ['Vite (coloured, the port in bold)', VITE, ['http://localhost:5173/']],
    ['Next.js', NEXT, ['http://localhost:3000/']],
    ['Create React App', CRA, ['http://localhost:3000/']],
    ['Django', DJANGO, ['http://127.0.0.1:8000/']],
    ['Rails (Puma), newest first', RAILS, ['http://[::1]:3000/', 'http://127.0.0.1:3000/']],
    ['Flask', FLASK, ['http://127.0.0.1:5000/']],
    [
      'Uvicorn on 0.0.0.0',
      'INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)',
      ['http://localhost:8000/'],
    ],
    [
      'Angular',
      '** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **',
      ['http://localhost:4200/'],
    ],
    ['Next.js 12', 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000', ['http://localhost:3000/']],
  ])('%s', (_name, text, urls) => {
    expect(findDevUrls(text)).toEqual(urls)
  })

  it('lists the newest first, once each, across several restarts', () => {
    const log = [NEXT, 'Port 3000 is in use, trying 3001 instead.', '  - Local:        http://localhost:3001', NEXT]
    expect(findDevUrls(log.join('\n'))).toEqual(['http://localhost:3000/', 'http://localhost:3001/'])
    expect(findDevUrls(`${DJANGO}\n${VITE}`)).toEqual(['http://localhost:5173/', 'http://127.0.0.1:8000/'])
  })
})

describe('findDevUrls', () => {
  it('keeps a path, query and fragment, and drops punctuation around the URL', () => {
    expect(findDevUrls('docs at http://localhost:8080/api/docs?x=1&y=2#top.')).toEqual([
      'http://localhost:8080/api/docs?x=1&y=2#top',
    ])
    expect(findDevUrls('(see http://localhost:3000/admin), or <http://127.0.0.1:4000>')).toEqual([
      'http://127.0.0.1:4000/',
      'http://localhost:3000/admin',
    ])
    expect(findDevUrls(`open "http://localhost:9000/a" or 'http://localhost:9001/b';`)).toEqual([
      'http://localhost:9001/b',
      'http://localhost:9000/a',
    ])
    expect(findDevUrls('[http://localhost:6006/?path=/story/button]')).toEqual([
      'http://localhost:6006/?path=/story/button',
    ])
  })

  it('takes https, any case, and a long URL on one (joined) line', () => {
    expect(findDevUrls('Local: HTTPS://LocalHost:8443/')).toEqual(['https://localhost:8443/'])
    const long = `http://localhost:3000/${'segment/'.repeat(30)}end`
    expect(findDevUrls(`  - Local:  ${long}${' '.repeat(40)}\n`)).toEqual([long])
  })

  it('never glues a URL to the next line, and reads CRLF and carriage-return redraws as line ends', () => {
    expect(findDevUrls('Local: http://localhost:3000/very/long/pa\nth continues here')).toEqual([
      'http://localhost:3000/very/long/pa',
    ])
    expect(findDevUrls('Local: http://localhost:3000\r\nNetwork: off\r\n')).toEqual(['http://localhost:3000/'])
    expect(findDevUrls('building 10%\rbuilding 100%\rready on http://localhost:4321\r')).toEqual([
      'http://localhost:4321/',
    ])
  })

  it('reads URLs inside OSC 8 hyperlinks and other escape sequences', () => {
    const link = `${ESC}]8;;http://localhost:3000/${ESC}\\http://localhost:3000/${ESC}]8;;${ESC}\\`
    expect(findDevUrls(`Local: ${link}`)).toEqual(['http://localhost:3000/'])
    expect(findDevUrls(`${ESC}[2K${ESC}[1Ghttp://localhost:${ESC}[1m3000${ESC}[22m`)).toEqual([
      'http://localhost:3000/',
    ])
  })

  it('takes loopback hosts only, with an explicit port from 1 to 65535', () => {
    expect(
      findDevUrls(
        [
          'http://192.168.1.23:3000',
          'http://example.com:3000/',
          'http://localhost.example.com:3000/',
          'http://127.0.0.2:3000/',
          'http://[::2]:3000/',
          'http://localhost/',
          'http://localhost:0/',
          'http://localhost:65536/',
          'http://localhost:123456/',
          'tcp://0.0.0.0:3000',
          'ftp://localhost:21/',
          'ws://localhost:24678/',
          'file://localhost:3000/etc/passwd',
          'http://localhost:65535/',
          'http://localhost:1',
        ].join('\n'),
      ),
    ).toEqual(['http://localhost:1/', 'http://localhost:65535/'])
  })

  it('refuses what only starts like a loopback URL: another host behind it, letters after the port', () => {
    expect(findDevUrls('http://localhost:3000@evil.example/')).toEqual([])
    expect(findDevUrls('http://localhost:3000abc')).toEqual([])
    expect(findDevUrls('http://localhost:3000.evil.example/')).toEqual([])
    expect(findDevUrls('xhttp://localhost:3000/')).toEqual([])
    // A backslash would be read as a slash by URL parsers: never part of one here.
    expect(findDevUrls('http://localhost:3000\\@evil.example')).toEqual(['http://localhost:3000/'])
  })

  it('finds nothing in text without URLs', () => {
    expect(findDevUrls('')).toEqual([])
    expect(findDevUrls('listening on port 3000\nhttp://\nlocalhost:3000')).toEqual([])
  })
})

describe('stripAnsi', () => {
  it('removes CSI, OSC and two-character escapes, keeping the text and line breaks', () => {
    expect(stripAnsi(`${ESC}[1;31mred${ESC}[0m\n${ESC}]0;title\u0007x${ESC}(By${ESC}]2;t${ESC}\\z${ESC}=`)).toBe(
      'red\nxyz',
    )
    expect(stripAnsi('plain\ttext')).toBe('plain\ttext')
  })
})

describe('devUrlLabel', () => {
  it('shows host, port and path without http:// or a lone trailing slash', () => {
    expect(devUrlLabel('http://localhost:5173/')).toBe('localhost:5173')
    expect(devUrlLabel('http://127.0.0.1:8000/admin/')).toBe('127.0.0.1:8000/admin/')
    expect(devUrlLabel('https://localhost:8443/')).toBe('https://localhost:8443')
    expect(devUrlLabel('http://[::1]:3000/?x=1')).toBe('[::1]:3000/?x=1')
  })
})
