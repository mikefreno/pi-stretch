// Reads a reply with stretches in place: a click on a phrase opens its long
// form around it, a click on « shrinks it back, and the words already read never
// move. Ported from the Claude Code plugin's reply Client (hooks/reply.tsx);
// here it runs as a pi overlay component, where it owns the screen's frame
// clock and its mouse, so a press answers at once.

import type { Theme, ThemeStyle } from '@earendil-works/pi-coding-agent'
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui'

import { grow, lengthOf } from './grow'
import { layout, link, linkAt } from './layout'
import type { Row, Run } from './layout'
import { KEY_SEPARATOR, parse, stretches } from './parse'
import type { Segment, Stretch } from './parse'

type Growth = { key: string; isOpening: boolean; progress: number; duration: number }
type State = { open: string[]; growth: Growth | null }

const FRAME_MS = 16
/** The header line above the reply, and the hint line below it. */
const CHROME = 2

/** Draws one reply for the reader: `text` is its markdown, `open` the stretch keys already open. */
export class StretchReader implements Component {
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly done: (open: string[]) => void
  private readonly segments: Segment[]
  private state: State
  /** Where the keyboard cursor stands, an index into the openable stretches. */
  private cursor = 0
  private scroll = 0
  private rows: Row[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(tui: TUI, theme: Theme, done: (open: string[]) => void, text: string, open: string[]) {
    this.tui = tui
    this.theme = theme
    this.done = done
    this.segments = parse(text)
    this.state = { open: [...open], growth: null }
    this.timer = setInterval(() => this.tick(), FRAME_MS)
  }

  /** The stretches open when the reader closed, for the note to the model. */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  finish(): void {
    // A stretch still growing is left as it stands; its key was added on open.
    this.dispose()
    this.done(this.state.open)
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.finish()
      return
    }
    const order = this.openable()
    const at = order[this.cursor]
    if (order.length === 0 || at === undefined) return
    if (matchesKey(data, 'j') || matchesKey(data, 'down')) {
      this.cursor = Math.min(order.length - 1, this.cursor + 1)
      this.showCursor()
    } else if (matchesKey(data, 'k') || matchesKey(data, 'up')) {
      this.cursor = Math.max(0, this.cursor - 1)
      this.showCursor()
    } else if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      this.toggle(at)
    } else if (matchesKey(data, 'o')) {
      this.state = { ...this.state, open: order.map(stretch => stretch.key) }
      this.tui.requestRender()
    } else if (matchesKey(data, 'c')) {
      this.state = { open: [], growth: null }
      this.tui.requestRender()
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') {
      this.scroll = clamp(this.scroll + (event.wheelDelta ?? 0) * 3, this.rows.length)
      return { handled: true }
    }
    // A press, not a click: pi synthesizes a click after press and release, so acting on both
    // would open and close a stretch with one tap. cc-stretch pressed on pointer down too.
    if (event.type === 'press' && event.button === 'left' && event.y >= CHROME - 1) {
      // The reply's rows start under the header line and one column in.
      const target = linkAt(this.rows, event.x - 1, event.y - 1 + this.scroll)
      const stretch = target === undefined ? undefined : stretches(this.segments).find(one => one.key === target.key)
      if (stretch !== undefined) {
        this.cursor = Math.max(0, this.openable().findIndex(one => one.key === stretch.key))
        this.toggle(stretch)
      }
    }
    return { handled: true }
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2)
    // A reply often opens or ends on a blank line; the reader has no use for those rows.
    const all = layout(this.compose(), inner)
    while (all.length > 0 && all[0]?.length === 0) all.shift()
    while (all.length > 0 && all.at(-1)?.length === 0) all.pop()
    this.rows = all
    const height = Math.max(3, this.tui.terminal.rows - 4)
    this.scroll = clamp(this.scroll, Math.max(0, this.rows.length - (height - CHROME)))

    const shown = this.rows.slice(this.scroll, this.scroll + height - CHROME)
    const cursorKey = this.openable()[this.cursor]?.key
    return [this.header(inner), ...shown.map(row => ` ${this.draw(row, cursorKey)}`), this.footer(inner)].map(line => pad(line, width))
  }

  invalidate(): void {}

  /** The reply as the reader sees it now: closed stretches as pressable short forms, open ones in full. */
  private compose(): string {
    const write = (parts: Segment[]): string => parts.map(part => (typeof part === 'string' ? part : draw(part))).join('')
    const draw = (stretch: Stretch): string => {
      if (stretch.long === undefined || !stretch.isClosed) return stretch.short
      if (this.state.growth?.key === stretch.key) return grow(stretch.short, stretch.long, easeInOut(this.state.growth.progress), draw)
      if (!this.state.open.includes(stretch.key)) return link('open', stretch.key, stretch.short)
      return `${write(stretch.long)} ${link('close', stretch.key, '«')}`
    }

    return write(this.segments)
  }

  private draw(row: Row, cursorKey: string | undefined): string {
    if (row.length === 0) return ' '
    return row.map(run => this.styleOf(run, cursorKey)).join('')
  }

  private styleOf(run: Run, cursorKey: string | undefined): string {
    const style: ThemeStyle = {
      ...(run.bold && { bold: true }),
      ...(run.italic && { italic: true }),
      ...(run.underline && { underline: true }),
      ...(run.dim && { dim: true }),
    }
    // Underlined marks what a press acts on; code keeps the markdown code colour.
    if (run.code) style.fg = 'mdCode'
    if (run.link) {
      style.fg = 'mdLink'
      style.underline = true
    }
    // The keyboard cursor stands on its stretch's phrases the way a mouse hover would.
    if (cursorKey !== undefined && run.link?.key === cursorKey) style.inverse = true

    return this.theme.style(run.text, style)
  }

  private header(width: number): string {
    const title = this.theme.fg('accent', ' stretch ')
    const room = Math.max(0, width - visibleWidth(title))
    const more = this.scroll > 0 ? this.theme.fg('dim', ` ↑${this.scroll}`) : ''
    const dashes = '─'.repeat(Math.max(0, room - visibleWidth(more)))
    return this.theme.fg('border', dashes.slice(0, Math.ceil(room / 2))) + title + this.theme.fg('border', '─'.repeat(Math.max(0, room - Math.ceil(room / 2)))) + more
  }

  private footer(width: number): string {
    const hint = ' click a phrase · j/k move · enter open · o all · c none · esc done '
    if (hint.length > width) return this.theme.fg('dim', hint.slice(0, width))
    const pad = '─'.repeat(Math.floor((width - hint.length) / 2))
    return this.theme.fg('dim', pad + hint)
  }

  private toggle(stretch: Stretch): void {
    if (stretch.long === undefined) return
    const isOpen = this.state.open.includes(stretch.key)

    // A stretch still shrinking when another press lands is closed at once.
    const open =
      this.state.growth !== null && !this.state.growth.isOpening ? closed(this.state.open, this.state.growth.key) : this.state.open
    const duration = 1000 * Math.min(1.4, 0.45 + lengthOf(stretch.long) / 70)
    if (!isOpen) {
      this.state = {
        open: [...open.filter(key => key !== stretch.key), stretch.key],
        growth: { key: stretch.key, isOpening: true, progress: 0, duration },
      }
    } else {
      this.state = { open, growth: { key: stretch.key, isOpening: false, progress: 1, duration } }
    }
    this.tui.requestRender()
  }

  private tick(): void {
    const { growth } = this.state
    if (growth === null) return
    const progress = growth.progress + ((growth.isOpening ? 1 : -1) * FRAME_MS) / growth.duration
    if (progress > 0 && progress < 1) {
      this.state = { ...this.state, growth: { ...growth, progress } }
      this.tui.requestRender()
      return
    }
    // A shrunk stretch, and every stretch inside it, leaves the open list as its growth ends.
    const open = growth.isOpening ? this.state.open : closed(this.state.open, growth.key)
    this.state = { open, growth: null }
    this.tui.requestRender()
  }

  private openable(): Stretch[] {
    return stretches(this.segments).filter(stretch => stretch.long !== undefined && stretch.isClosed)
  }

  /** Scrolls so the keyboard cursor's stretch is on screen. */
  private showCursor(): void {
    const key = this.openable()[this.cursor]?.key
    if (key === undefined) return
    const at = this.rows.findIndex(row => row.some(run => run.link?.key === key))
    if (at === -1) return
    const room = Math.max(3, this.tui.terminal.rows - 4) - CHROME
    if (at < this.scroll) this.scroll = at
    else if (at >= this.scroll + room) this.scroll = at - room + 1
    this.tui.requestRender()
  }
}

/** A shrunk stretch takes every stretch inside it out of the open list with it. */
function closed(open: string[], key: string): string[] {
  return open.filter(k => k !== key && !k.startsWith(`${key}${KEY_SEPARATOR}`))
}

function clamp(scroll: number, max: number): number {
  return Math.max(0, Math.min(max, scroll))
}

/** A line short of the width lets the session behind the reader show through. */
function pad(line: string, width: number): string {
  const room = width - visibleWidth(line)
  return room > 0 ? line + ' '.repeat(room) : line
}

function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
}
