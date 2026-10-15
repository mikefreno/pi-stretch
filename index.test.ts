// Drives the extension the way pi does: its markdown transformer feeds a real pi-tui Markdown,
// and a press is the URL pi's fullscreen TUI finds under the pointer and hands to `openUrl`.
// Run with `npm test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Container, getOsc8LinkAtColumn, Markdown, ScrollView, setCapabilities, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { MarkdownTheme } from '@earendil-works/pi-tui'

import stretch from './index'

const REPLY = 'The build fails {{on a stale cache|on a stale dependency cache keyed only by `package.json`}}. Rerun it.'

const plain = (text: string) => text
const THEME: MarkdownTheme = {
  heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain, codeBlockBorder: plain, quote: plain,
  quoteBorder: plain, hr: plain, listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
}

type Handler = (event: any, ctx: any) => any

/** The extension loaded into a stand-in for pi: one reply in a transcript, on a TUI in `mode`. */
function load(mode: 'fullscreen' | 'regular') {
  const handlers = new Map<string, Handler>()
  let transform: (markdown: string, context: any) => string = markdown => markdown
  stretch({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerMarkdownTransformer: (fn: typeof transform) => (transform = fn),
  } as any)

  const browsed: string[] = []
  const markdown = new Markdown(REPLY, 0, 0, THEME, undefined, {
    transform: (text: string, availableWidth: number) => transform(text, { messageType: 'assistant', isStreaming: false, availableWidth }),
  })
  const document = new Container()
  document.addChild(markdown)
  const transcript = new ScrollView(document, { follow: 'end' })
  const root = new Container()
  root.addChild(transcript)
  const tui: any = {
    mode,
    children: [],
    openUrl: (url: string) => browsed.push(url),
    getMountedRoots: () => [root],
    requestRender: () => {},
  }

  const reply = { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } }
  const ctx: any = {
    mode: 'tui',
    sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'why?' } }, reply] },
    ui: { setWidget: (_key: string, factory: (tui: any, theme: any) => unknown) => factory(tui, undefined) },
  }
  handlers.get('session_start')?.({}, ctx)

  const screen = () => markdown.render(200)
  const note = () => handlers.get('before_agent_start')?.({ messageType: 'user', systemPromptOptions: { sections: {} } }, ctx)?.message?.content
  return { tui, transcript, browsed, screen, note, shutdown: () => handlers.get('session_shutdown')?.({}, ctx) }
}

/** The URL of the link drawn over `words`, as pi's TUI finds it under a click there. */
function linkOver(lines: string[], words: string): string | undefined {
  for (const line of lines) {
    const at = stripTerminalSequences(line).indexOf(words)
    if (at !== -1) return getOsc8LinkAtColumn(line, visibleWidth(stripTerminalSequences(line).slice(0, at)))
  }
  return undefined
}

const text = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd()).join('\n').trim()

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1600))
}

test('a click on a stretch grows it in place and « shrinks it back', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen')
  try {
    assert.equal(text(pi.screen()), 'The build fails on a stale cache. Rerun it.')

    const opener = linkOver(pi.screen(), 'stale cache')
    assert.ok(opener, 'the short form is a link')
    assert.equal(pi.transcript.isFollowingEnd, true)
    pi.tui.openUrl(opener)
    // The transcript stops following its end, so the words already read do not move up.
    assert.equal(pi.transcript.isFollowingEnd, false)
    await settle()
    assert.equal(text(pi.screen()), 'The build fails on a stale dependency cache keyed only by package.json «. Rerun it.')
    assert.deepEqual(pi.browsed, [], 'our link never reaches the browser')

    const closer = linkOver(pi.screen(), '«')
    assert.equal(closer, opener)
    pi.tui.openUrl(closer)
    await settle()
    assert.equal(text(pi.screen()), 'The build fails on a stale cache. Rerun it.')
  } finally {
    pi.shutdown()
  }
})

test('any other link still goes to the browser', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen')
  try {
    pi.screen()
    pi.tui.openUrl('https://example.com/')
    assert.deepEqual(pi.browsed, ['https://example.com/'])
  } finally {
    pi.shutdown()
  }
})

test('the next message tells the model what was opened', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen')
  try {
    assert.match(pi.note(), /opened no stretch/)
    pi.tui.openUrl(linkOver(pi.screen(), 'stale cache'))
    assert.equal(pi.note(), 'Stretchtext: since your last reply the reader opened "on a stale cache".')
    // Told once: the message after that reports a fresh start.
    assert.match(pi.note(), /opened no stretch/)
    await settle()
  } finally {
    pi.shutdown()
  }
})

test('where a click cannot land, every stretch is drawn open', () => {
  for (const [mode, hyperlinks] of [['regular', true], ['fullscreen', false]] as const) {
    setCapabilities({ images: null, trueColor: true, hyperlinks })
    const pi = load(mode)
    try {
      assert.equal(text(pi.screen()), 'The build fails on a stale dependency cache keyed only by package.json. Rerun it.')
      assert.match(pi.note(), /drawn open/)
    } finally {
      pi.shutdown()
    }
  }
})
