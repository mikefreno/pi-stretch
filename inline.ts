// Writes a reply's stretches into the markdown pi draws, so they grow in the
// transcript itself. A closed stretch becomes a link on its short form and an
// open one ends in a `«` link; pi draws both as terminal hyperlinks, and a
// press on one comes back as its URL. The URL names the reply's text block and
// the stretch, under a reserved host that resolves nowhere, as cc-stretch's do.

import { createHash } from 'node:crypto'

import { grow, woven } from './grow'
import { closeAfter, isLinkable, KEY_SEPARATOR, parse } from './parse'
import type { Segment, Stretch } from './parse'

const ORIGIN = 'https://pi-stretch.invalid/'

/** A stretch opening (progress rising to 1) or shrinking (falling to 0) in one block. */
export type Growth = { block: string; key: string; isOpening: boolean; progress: number; duration: number }

/** Names a text block of a reply by its markdown, so the same block drawn again keeps its open stretches. */
export function blockOf(markdown: string): string {
  return createHash('sha1').update(markdown).digest('hex').slice(0, 16)
}

/** The URL a press on stretch `key` of `block` comes back as. */
export function hrefOf(block: string, key: string): string {
  // Parentheses would end a markdown link's destination early.
  return `${ORIGIN}${block}/${encodeURIComponent(key).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
}

/** The stretch a pressed URL names, or undefined for any other URL. */
export function targetOf(url: string): { block: string; key: string } | undefined {
  if (!url.startsWith(ORIGIN)) return undefined
  const [block, key] = url.slice(ORIGIN.length).split('/')
  if (block === undefined || key === undefined) return undefined
  try {
    return { block, key: decodeURIComponent(key) }
  } catch {
    return undefined
  }
}

/** A block as the reader sees it now: closed stretches as links, open ones in full with a `«` to shrink them. */
export function drawPressable(markdown: string, block: string, open: string[], growth: Growth | undefined): string {
  const write = (parts: Segment[]): string => parts.map(part => (typeof part === 'string' ? part : draw(part))).join('')
  const draw = (stretch: Stretch): string => {
    if (stretch.long === undefined || !stretch.isClosed) return stretch.short
    // The long form with its short form's words woven back in: an open stretch never takes a word
    // the reader could see off the screen, even when the long form is not an expansion of it.
    const long = woven(stretch.short, stretch.long)
    // A short form over several lines is drawn open: a terminal link cannot span rows.
    if (!isLinkable(stretch)) return stretch.long.length === 0 ? stretch.short : grow(stretch.short, long, 1, draw)
    if (growth?.key === stretch.key) return grow(stretch.short, long, easeInOut(growth.progress), draw)
    if (!open.includes(stretch.key)) return linked(stretch.short, hrefOf(block, stretch.key))
    return closeAfter(grow(stretch.short, long, 1, draw), `[«](${hrefOf(block, stretch.key)})`, '\n\n')
  }

  return write(parse(markdown))
}

/** A block with every stretch drawn as its long form, for screens where a press cannot land. */
export function drawOpen(markdown: string): string {
  const write = (parts: Segment[]): string => parts.map(part => (typeof part === 'string' ? part : draw(part))).join('')
  const draw = (part: Stretch): string =>
    part.long === undefined ? part.short : grow(part.short, woven(part.short, part.long), 1, draw)

  return write(parse(markdown))
}

/** A shrunk stretch takes every stretch inside it out of the open list with it. */
export function closed(open: string[], key: string): string[] {
  return open.filter(k => k !== key && !k.startsWith(`${key}${KEY_SEPARATOR}`))
}

export function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
}

/** A short form as a link, with its outer spaces left outside so the underline covers only the words. */
function linked(short: string, href: string): string {
  const [, lead = '', words = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(short) ?? []
  return words === '' ? short : `${lead}[${words}](${href})${trail}`
}
