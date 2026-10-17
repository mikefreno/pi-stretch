// cc-stretch for pi: replies that arrive short and grow where they stand. The
// model writes stretchtext ({{short|long}}) under the guide below, and pi's
// transcript draws every stretch closed, as a link on its short form. A click
// on one grows its long form in place, the transcript scrolling with the
// growth, and `«` shrinks it back. What the
// reader opened is told to the model with their next message, so it never
// assumes they read the rest — told in the request alone, never written to
// the session, so no history row, export or summary ever carries it. Ported
// from the Claude Code plugin:
// github.com/pro-vi/cc-stretch (parse.ts, grow.ts and guide.ts here are its,
// unchanged).
//
// A press reaches the extension the way a press on any link reaches pi: in
// fullscreen mode pi finds the terminal hyperlink under the pointer and hands
// its URL to the TUI's `openUrl`. That is wrapped here; URLs of ours open or
// close a stretch, and every other URL still goes to the browser.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCapabilities, Markdown, ScrollView } from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'

import { lengthOf } from './grow'
import { GUIDE } from './guide'
import { blockOf, closed, drawOpen, drawPressable, targetOf } from './inline'
import type { Growth } from './inline'
import { hideLongForms, isOpenable, newStreamState, parse, stretches } from './parse'

const FRAME_MS = 16

/** The fields of pi's components this extension reaches past their types for. */
type Host = { openUrl?: (url: string) => void; getMountedRoots?: () => Component[] }
type Node = Component & { children?: Component[] }

export default function stretch(pi: ExtensionAPI) {
  // The TUI, once a widget hands it over, and the `openUrl` pi gave it, for every URL not ours.
  let tui: TUI | undefined
  let follow: ((url: string) => void) | undefined
  // Each text block's markdown and its open stretches, by block name.
  const texts = new Map<string, string>()
  const open = new Map<string, string[]>()
  let growth: Growth | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  // Auto-scroll state of a growth: the lines each scroll view could not take yet (it had
  // reached its end before the layout caught up), retried on the next frame and once it ends,
  // and the scrollTop our own scrolling last left each view at. A scrollTop that moved on its
  // own means the reader scrolled: that view is released and left alone for the rest of the growth.
  const pending = new Map<ScrollView, number>()
  const at = new Map<ScrollView, number>()
  const released = new Set<ScrollView>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  // The short forms the reader opened since their last message.
  let seen: string[] = []
  // The note owed the model with the run in flight. It rides the run's requests and is never persisted.
  let note: { text: string; at: number } | undefined

  /** Whether a press on a stretch reaches us: pi's fullscreen mode, drawing hyperlinks, with `openUrl` wrapped. */
  const hook = (): boolean => {
    if (tui === undefined || tui.mode !== 'fullscreen' || !getCapabilities().hyperlinks) return false
    // pi can swap the renderer for a new one; its `openUrl` is wrapped again the first time it draws.
    // SAFETY: pi's TUI has an `openUrl` its type does not declare; Host names only the fields read here.
    const host = tui as unknown as Host
    if (host.openUrl !== press) {
      follow = host.openUrl
      host.openUrl = press
    }
    return true
  }

  const press = (url: string): void => {
    const target = targetOf(url)
    if (target === undefined) follow?.(url)
    else toggle(target.block, target.key)
  }

  const toggle = (block: string, key: string): void => {
    const stretch = stretches(parse(texts.get(block) ?? '')).find(one => one.key === key)
    if (stretch?.long === undefined) return
    // A stretch still shrinking when another press lands is closed at once; one still opening
    // jumps to open, since its key is already in the list.
    const was = growth
    if (was !== undefined && !was.isOpening) open.set(was.block, closed(open.get(was.block) ?? [], was.key))

    const list = open.get(block) ?? []
    const duration = 1000 * Math.min(1.4, 0.45 + lengthOf(stretch.long) / 70)
    if (list.includes(key)) {
      growth = { block, key, isOpening: false, progress: 1, duration }
    } else {
      open.set(block, [...list, key])
      growth = { block, key, isOpening: true, progress: 0, duration }
      const short = stretch.short.trim()
      if (!seen.includes(short)) seen.push(short)
    }

    pending.clear()
    at.clear()
    released.clear()
    if (was !== undefined && was.block !== block) redraw(was.block, true)
    redraw(block, true)
    timer ??= setInterval(tick, FRAME_MS)
  }

  const tick = (): void => {
    if (growth === undefined) return stop()
    const progress = growth.progress + ((growth.isOpening ? 1 : -1) * FRAME_MS) / growth.duration
    if (progress > 0 && progress < 1) {
      growth = { ...growth, progress }
      return redraw(growth.block, true)
    }
    // A shrunk stretch, and every stretch inside it, leaves the open list as its growth ends.
    const done = growth
    if (!done.isOpening) open.set(done.block, closed(open.get(done.block) ?? [], done.key))
    growth = undefined
    stop()
    redraw(done.block, true)
    flushTimer ??= setTimeout(flush, FRAME_MS * 2)
  }

  /** Take the lines a finished growth still owed its scroll views, once the last layout landed. */
  const flush = (): void => {
    flushTimer = undefined
    for (const [scroll, owed] of pending) {
      const taken = scroll.isFollowingEnd || released.has(scroll) || (at.has(scroll) && scroll.scrollTop !== at.get(scroll))
      if (owed === 0 || taken) pending.delete(scroll)
      else pending.set(scroll, scroll.scrollBy(owed))
    }
    at.clear()
    released.clear()
  }

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  /** The transcript's Markdown components drawing `block`, each with the ScrollView it sits in. */
  const drawnOf = (block: string) => markdownsWhere(markdown => blockOf(markdown) === block)

  const markdownsWhere = (test: (markdown: string) => boolean): { markdown: Markdown; scroll: ScrollView | undefined }[] => {
    if (tui === undefined) return []
    const found: { markdown: Markdown; scroll: ScrollView | undefined }[] = []
    const visit = (node: Node, scroll: ScrollView | undefined) => {
      if (node instanceof Markdown) {
        // SAFETY: Markdown's `text` is the source string it was constructed with; its type hides it.
        const text = (node as unknown as { text: string }).text
        if (test(text)) found.push({ markdown: node, scroll })
        return
      }
      const within = node instanceof ScrollView ? node : scroll
      for (const child of node.children ?? []) visit(child, within)
    }
    // SAFETY: pi's TUI has `getMountedRoots` its type does not declare; Host names only the fields read here.
    const host = tui as unknown as Host
    for (const root of host.getMountedRoots?.() ?? tui.children) visit(root, undefined)
    return found
  }

  // pi's Markdown keeps its lines until its text changes; a stretch growing changes only what
  // the transformer makes of the text, so its blocks are told to draw again. With `scrollWith`
  // the view scrolls with the lines the growth gains or loses: down as the long form opens, up
  // as it shrinks, so the words being read keep their place on the screen — until the reader
  // scrolls, which hands the view back to them. A view following its end is left to its own
  // layout, which scrolls the same way on its own.
  const redraw = (block: string, scrollWith = false): void => {
    for (const { markdown, scroll } of drawnOf(block)) {
      // SAFETY: Markdown caches its last render's width and lines under these names; its type hides them.
      const cache = markdown as unknown as { cachedWidth?: number; cachedLines?: string[] }
      const width = cache.cachedWidth
      const before =
        scrollWith && scroll !== undefined && !scroll.isFollowingEnd && !released.has(scroll) && width !== undefined
          ? cache.cachedLines?.length
          : undefined
      markdown.invalidate()
      if (before === undefined || scroll === undefined || width === undefined) continue
      if (at.has(scroll) && scroll.scrollTop !== at.get(scroll)) {
        released.add(scroll)
        pending.delete(scroll)
        at.delete(scroll)
        continue
      }
      const owed = markdown.render(width).length - before + (pending.get(scroll) ?? 0)
      if (owed === 0) pending.delete(scroll)
      else pending.set(scroll, scroll.scrollBy(owed))
      at.set(scroll, scroll.scrollTop)
    }
    tui?.requestRender()
  }

  pi.on('session_start', (_event, ctx) => {
    seen = []
    note = undefined
    if (ctx.mode !== 'tui') return
    // Extensions are not handed the TUI; a widget's factory is. This one draws nothing.
    ctx.ui.setWidget(
      'pi-stretch',
      host => {
        tui = host
        // Replies drawn before the TUI was known were drawn open; they draw again, pressable.
        for (const { markdown } of markdownsWhere(markdown => markdown.includes('{{'))) markdown.invalidate()
        host.requestRender()
        return { render: () => [], invalidate: () => {} }
      },
      { placement: 'belowEditor' },
    )
  })

  pi.on('session_shutdown', () => {
    stop()
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    pending.clear()
    at.clear()
    released.clear()
    // SAFETY: pi's TUI has an `openUrl` its type does not declare; Host names only the fields read here.
    const host = tui as unknown as Host | undefined
    if (host !== undefined && host.openUrl === press) host.openUrl = follow
    tui = undefined
  })

  // The stretchtext guide rides with the system prompt. cc-stretch's benchmark rewrites replies under
  // this same text, so it stays word for word what guide.ts has. What the reader opened is worked
  // out here too, at the run's start, but only into `note` — returning it as a message would make
  // pi persist a session entry the history tree, exports and summaries would all carry forever.
  pi.on('before_agent_start', (event, ctx) => {
    event.systemPromptOptions.sections['stretchtext'] = GUIDE

    if (event.messageType !== 'user') return
    const opened = seen
    seen = []
    const written = stretches(parse(lastReplyOf(ctx))).filter(isOpenable).map(stretch => stretch.short.trim())
    const unopened = written.filter(short => !opened.includes(short))
    note = undefined
    if (opened.length === 0 && unopened.length === 0) return

    const quote = (list: string[]) => list.map(short => `"${short}"`).join(', ')
    note = {
      at: Date.now(),
      text:
        opened.length > 0
          ? `Stretchtext: since your last reply the reader opened ${quote(opened)}.` +
            (unopened.length > 0 ? ` They did not open ${quote(unopened)}.` : '')
          : hook()
            ? 'Stretchtext: the reader opened no stretch of your last reply. They read only its short forms; do not assume they read any long form.'
            : 'Stretchtext: this screen cannot take a click on a stretch, so every stretch of your last reply was drawn open.',
    }
  })

  // The note rides every request of the run, spliced right after the person's prompt so its place
  // never moves as tool results arrive and the prompt cache stays warm. Pi restores the transcript
  // once the request is sent, so the model reads the note and nothing else ever does.
  pi.on('context', event => {
    if (note === undefined) return
    const after = event.messages.map(message => message.role).lastIndexOf('user')
    if (after === -1) return
    event.messages.splice(after + 1, 0, { role: 'user', content: note.text, timestamp: note.at })
  })

  // Every assistant text block pi draws runs through here. While a reply streams its stretches
  // show as short forms, raw markup kept off the screen; once it stands they become pressable,
  // or, where a press cannot land, they are all drawn open.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== 'assistant') return markdown
    if (context.isStreaming) return hideLongForms(markdown, newStreamState())
    if (!markdown.includes('{{')) return markdown
    if (!hook()) return drawOpen(markdown)

    const block = blockOf(markdown)
    texts.set(block, markdown)
    return drawPressable(markdown, block, open.get(block) ?? [], growth?.block === block ? growth : undefined)
  })
}

/** The text of the model's last reply: its assistant texts after the person's last prompt. */
function lastReplyOf(ctx: ExtensionContext): string {
  const texts: string[] = []
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'user') break
    if (message.role !== 'assistant') continue
    texts.unshift(message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'))
  }

  return texts.join('\n')
}
