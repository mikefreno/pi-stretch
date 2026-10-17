// Drives the extension the way pi does: its markdown transformer feeds a real pi-tui Markdown,
// and a press is the URL pi's fullscreen TUI finds under the pointer and hands to `openUrl`.
// Run with `npm test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Container, getOsc8LinkAtColumn, Markdown, ScrollView, Text, setCapabilities, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
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
function load(mode: 'fullscreen' | 'regular', view: { width?: number; viewport?: number; above?: number } = {}, replyMarkdown: string = REPLY) {
  const { width = 200, viewport = 1000, above = 0 } = view
  const handlers = new Map<string, Handler>()
  let transform: (markdown: string, context: any) => string = markdown => markdown
  stretch({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerMarkdownTransformer: (fn: typeof transform) => (transform = fn),
  } as any)

  const browsed: string[] = []
  const markdown = new Markdown(replyMarkdown, 0, 0, THEME, undefined, {
    transform: (text: string, availableWidth: number) => transform(text, { messageType: 'assistant', isStreaming: false, availableWidth }),
  })
  const document = new Container()
  if (above > 0) document.addChild(new Text(Array.from({ length: above }, () => '…').join('\n'), 0, 0))
  document.addChild(markdown)
  const transcript = new ScrollView(document, { follow: 'end' })
  const root = new Container()
  root.addChild(transcript)
  const tui: any = {
    mode,
    children: [],
    openUrl: (url: string) => browsed.push(url),
    getMountedRoots: () => [root],
    // The TUI's render pass, reduced to the layout it ends in: content height meets viewport height.
    requestRender: () => transcript.updateLayout(document.render(width).length, viewport, () => {}),
  }

  const reply = { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: replyMarkdown } ] } }
  const ctx: any = {
    mode: 'tui',
    sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'why?' } }, reply] },
    ui: { setWidget: (_key: string, factory: (tui: any, theme: any) => unknown) => factory(tui, undefined) },
  }
  handlers.get('session_start')?.({}, ctx)

  const screen = () => markdown.render(width)
  /** The run pi starts on the reader's message. Whatever it returns is persisted to the session. */
  const turn = () => handlers.get('before_agent_start')?.({ messageType: 'user', systemPromptOptions: { sections: {} } }, ctx)
  /** One request of that run: the reader's message, the reply so far, and whatever has come after it. */
  const request = (...since: any[]): any[] => {
    const messages = [
      { role: 'user', content: 'why?', timestamp: 0 },
      { role: 'assistant', content: [{ type: 'text', text: REPLY }], timestamp: 0 },
      ...since,
    ]
    handlers.get('context')?.({ type: 'context', messages }, ctx)
    return messages
  }
  /** What the model is told alongside the reader's message, across a turn's first request. */
  const note = (): string | undefined => {
    turn()
    const sent = request()
    return sent[1]?.role === 'user' ? sent[1].content : undefined
  }
  return { tui, transcript, browsed, screen, turn, request, note, shutdown: () => handlers.get('session_shutdown')?.({}, ctx) }
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
    // The transcript keeps following its end: its own layout scrolls it down with the growth.
    assert.equal(pi.transcript.isFollowingEnd, true)
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

test('a scrolled-up view scrolls down with the growth and up with the shrink', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  // A narrow width, so the long form takes more lines than the short one, and enough content
  // above the reply that the growth cannot push the view to the transcript's end.
  const pi = load('fullscreen', { width: 24, viewport: 5, above: 20 })
  try {
    const closed = pi.screen().length
    pi.tui.requestRender()
    pi.transcript.scrollToStart()
    assert.equal(pi.transcript.isFollowingEnd, false)

    pi.tui.openUrl(linkOver(pi.screen(), 'stale cache'))
    await settle()
    const grown = pi.screen().length - closed
    assert.ok(grown > 0, 'the growth adds lines')
    assert.equal(pi.transcript.scrollTop, grown)

    pi.tui.openUrl(linkOver(pi.screen(), '«'))
    await settle()
    assert.equal(pi.transcript.scrollTop, 0)
  } finally {
    pi.shutdown()
  }
})

test('a manual scroll stops the auto-scrolling', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen', { width: 24, viewport: 5, above: 20 })
  try {
    pi.screen()
    pi.tui.requestRender()
    pi.transcript.scrollToStart()

    pi.tui.openUrl(linkOver(pi.screen(), 'stale cache'))
    // Let the growth run a while, then take the wheel: the view keeps the growth on screen
    // but stops moving, where the reader left it.
    await new Promise(resolve => setTimeout(resolve, 400))
    pi.transcript.scrollBy(1)
    const leftAt = pi.transcript.scrollTop
    await settle()
    assert.equal(
      text(pi.screen()).replaceAll('\n', ' '),
      'The build fails on a stale dependency cache keyed only by package.json «. Rerun it.',
    )
    assert.equal(pi.transcript.scrollTop, leftAt)
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
    assert.match(pi.note() ?? '', /opened no stretch/)
    pi.tui.openUrl(linkOver(pi.screen(), 'stale cache'))
    assert.equal(pi.note(), 'Stretchtext: since your last reply the reader opened "on a stale cache".')
    // Told once: the message after that reports a fresh start.
    assert.match(pi.note() ?? '', /opened no stretch/)
    await settle()
  } finally {
    pi.shutdown()
  }
})

test('the note reaches the model and never the session', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen')
  try {
    // Nothing comes back to persist: no session entry, so no row for the history tree to draw.
    assert.equal(pi.turn(), undefined)
    const sent = pi.request()
    assert.deepEqual(sent.map(message => message.role), ['user', 'user', 'assistant'])
    assert.match(sent[1].content, /opened no stretch/)
  } finally {
    pi.shutdown()
  }
})

test('the note keeps its place on every request of the run', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen')
  try {
    pi.turn()
    const first = pi.request()
    const second = pi.request({ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: 0 })
    // Right after the reader's message in both, so the run's prompt cache never moves.
    assert.deepEqual(second.map(message => message.role), ['user', 'user', 'assistant', 'toolResult'])
    assert.equal(second[1].content, first[1].content)
    assert.equal(second[1].timestamp, first[1].timestamp)
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
      assert.match(pi.note() ?? '', /drawn open/)
    } finally {
      pi.shutdown()
    }
  }
})

// The pair that reported MISC-43 (session 01a146ca): a long form that continues the reply rather
// than expanding its short form, with none of the short form's words in it — and the status stretch
// at the reply's end, whose long form is a non-sequitur.
const CONTINUATION_SHORT =
  'Done looks like: an About panel listing every crate from `third_party_crates()` with its version and the SPDX expression verbatim, sorted and scrollable, with the full licence text reachable per entry — the text the dependency ships, not a paraphrase, and MPL-2.0 rows included.'
const CONTINUATION_LONG =
  'It reads the generated list only, a test asserts every entry renders, and the panel is keyboard accessible. No hand-maintained copy anywhere.'
const STATUS_SHORT = 'Status: AUDI-83 claimed and held at the go-ahead gate; no product code touched.'
const STATUS_LONG = 'Ready to start on your word.'
const CONTINUATION = `{{${CONTINUATION_SHORT}|${CONTINUATION_LONG}}}\n\n{{${STATUS_SHORT}|${STATUS_LONG}}}`

/** The words a reader reads in `text`: markdown marks stripped, punctuation-only tokens dropped. */
const wordsOf = (source: string) =>
  source
    .replace(/[`*]/g, '')
    .split(/\s+/)
    .filter(word => /[\p{L}\p{N}]/u.test(word))

/** The words of `short` that do not appear on the screen — empty when the screen keeps all of them. */
const lostWords = (screen: string, short: string) => wordsOf(short).filter(word => !screen.includes(word))

test('opening a stretch keeps every word of its short form (MISC-43)', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen', { width: 320 }, CONTINUATION)
  try {
    assert.deepEqual(lostWords(text(pi.screen()), CONTINUATION_SHORT), [])
    pi.tui.openUrl(linkOver(pi.screen(), 'Done looks like') ?? '')
    // The growth's first frame already carries the whole short form, not anchor fragments.
    assert.deepEqual(lostWords(text(pi.screen()), CONTINUATION_SHORT), [])
    await settle()
    const grown = text(pi.screen())
    assert.deepEqual(lostWords(grown, CONTINUATION_SHORT), [], 'the open form keeps every short word')
    assert.deepEqual(lostWords(grown, CONTINUATION_LONG), [], 'and every long word')
    // A long form that shares little with its short form grows after it, so both read whole.
    assert.ok(grown.includes(CONTINUATION_SHORT.replace(/[`*]/g, '')), 'the short form stands whole before the long form')

    // The stretch at the reply's end, whose long form shares no words with its short form.
    pi.tui.openUrl(linkOver(pi.screen(), 'Status: AUDI-83') ?? '')
    await settle()
    const shown = text(pi.screen())
    assert.deepEqual(lostWords(shown, STATUS_SHORT), [])
    assert.deepEqual(lostWords(shown, STATUS_LONG), [])
  } finally {
    pi.shutdown()
  }
})

test('opening and closing a stretch returns the screen it began on (MISC-43)', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen', {}, CONTINUATION)
  try {
    const before = text(pi.screen())
    pi.tui.openUrl(linkOver(pi.screen(), 'Done looks like') ?? '')
    await settle()
    pi.tui.openUrl(linkOver(pi.screen(), '«') ?? '')
    await settle()
    assert.equal(text(pi.screen()), before)
  } finally {
    pi.shutdown()
  }
})

const NESTED = 'Outer {{alpha short|alpha long words {{beta short|beta long tail}} omega}} end.'

test('a nested stretch survives the growth and still opens (MISC-43)', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen', {}, NESTED)
  try {
    const before = text(pi.screen())
    pi.tui.openUrl(linkOver(pi.screen(), 'alpha short') ?? '')
    await settle()
    const shown = text(pi.screen())
    assert.deepEqual(lostWords(shown, 'alpha short'), [])
    assert.ok(shown.includes('beta short') && shown.includes('omega'), 'the nested short form is there')
    const nested = linkOver(pi.screen(), 'beta short')
    assert.ok(nested, 'the nested short form is a link')
    pi.tui.openUrl(nested)
    await settle()
    assert.deepEqual(lostWords(text(pi.screen()), 'beta long tail'), [], 'the nested stretch opens without losing words')
    pi.tui.openUrl(linkOver(pi.screen(), '«') ?? '')
    await settle()
    pi.tui.openUrl(linkOver(pi.screen(), '«') ?? '')
    await settle()
    assert.equal(text(pi.screen()), before)
  } finally {
    pi.shutdown()
  }
})

test('a stretch closed with one brace keeps the reply\'s tail (MISC-44)', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  // Real model output (Nook session 01a1409e): a long form closed with one brace swallowed the
  // rest of the reply — the plan, the stretch after it and the sign-off all vanished.
  const typo = 'Head {{short one|long one text}\n\nPara two with {{short two|long two}} and tail words.'
  const pi = load('fullscreen', {}, typo)
  try {
    const shown = text(pi.screen())
    assert.ok(shown.includes('Para two with') && shown.includes('tail words'), 'the tail after it is on the screen')
    // The repaired stretch itself still opens and shrinks.
    pi.tui.openUrl(linkOver(pi.screen(), 'short one') ?? '')
    await settle()
    assert.deepEqual(lostWords(text(pi.screen()), 'long one text'), [], 'and its long form opens')
    pi.tui.openUrl(linkOver(pi.screen(), '«') ?? '')
    await settle()
    // And the stretch after the typo is still there and still opens.
    const later = linkOver(pi.screen(), 'short two')
    assert.ok(later, 'the later stretch is a link')
    pi.tui.openUrl(later)
    await settle()
    assert.deepEqual(lostWords(text(pi.screen()), 'long two'), [])
  } finally {
    pi.shutdown()
  }
})

test('a stretch the reply never closes shows all of its text (MISC-44)', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const pi = load('fullscreen', {}, 'Head {{short one|long one text and more')
  try {
    const shown = text(pi.screen())
    assert.ok(shown.includes('short one'), 'the short form is on the screen')
    assert.ok(shown.includes('long one text and more'), 'and the text it would have swallowed')
  } finally {
    pi.shutdown()
  }
})
