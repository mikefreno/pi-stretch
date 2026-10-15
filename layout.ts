// Lays out a paragraph that holds stretches, for a Client to draw: its markdown as rows of styled
// runs, wrapped to the region's width, so a press can be matched to the phrase under it. Claude
// Code draws every paragraph without a stretch with its own markdown.

/** What a press on a pressable phrase does to its stretch. */
export type Action = 'open' | 'close'

export type Run = {
  text: string
  bold?: true
  italic?: true
  code?: true
  underline?: true
  dim?: true
  link?: { action: Action; key: string }
}

export type Row = Run[]

// Private-use characters frame a pressable phrase in composed text; a reply never writes them.
const START = ''
const SEP = ''
const END = ''

/** A pressable phrase for composed text: drawn as `label`, a press does `action` to stretch `key`. */
export function link(action: Action, key: string, label: string): string {
  return `${START}${action}${SEP}${key}${SEP}${label}${END}`
}

/** The rows `text` takes in a region `columns` cells wide. */
export function layout(text: string, columns: number): Row[] {
  const width = Math.max(10, columns)
  const rows: Row[] = []
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      else rows.push(...cutRows([{ text: `  ${line}`, code: true }], width))
      continue
    }
    if (marker !== undefined) {
      fence = marker
      continue
    }
    rows.push(...rowsOf(line, width))
  }

  return rows
}

/**
 * The phrase drawn at cell `x` of row `y`, if any. A one-cell `«` is hard to land on, so a press
 * a cell beside a closer counts as on it.
 */
export function linkAt(rows: Row[], x: number, y: number): Run['link'] {
  const spans: { from: number; to: number; link: Run['link'] }[] = []
  let at = 0
  for (const run of rows[y] ?? []) {
    const w = widthOf(run.text)
    spans.push({ from: at, to: at + w, link: run.link })
    at += w
  }
  const exact = spans.find(span => x >= span.from && x < span.to)?.link
  if (exact !== undefined) return exact

  return spans.find(span => span.link?.action === 'close' && x >= span.from - 1 && x < span.to + 1)?.link
}

/** Cells a string takes: two for wide East Asian characters and most emoji, else one. */
export function widthOf(text: string): number {
  let cells = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const isWide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff)
    cells += isWide ? 2 : 1
  }

  return cells
}

function rowsOf(line: string, width: number): Row[] {
  if (line.trim() === '') return [[]]
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [[{ text: '─'.repeat(Math.min(width, 60)), dim: true }]]
  // A table row keeps its columns: written as is, cut where the region ends.
  if (/^\s*\|/.test(line)) return cutRows(inline(line), width)
  const heading = /^#{1,6}\s+(.*)$/.exec(line)
  if (heading) return wrap(inline(heading[1] ?? '', true), width, '', '')
  const quote = /^>\s?(.*)$/.exec(line)
  if (quote) return wrap(inline(quote[1] ?? ''), width, '▎ ', '▎ ', true)
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (item) {
    const lead = `${item[1] ?? ''}${item[2] ?? ''} `
    return wrap(inline(item[3] ?? ''), width, lead, ' '.repeat(widthOf(lead)))
  }
  const indent = /^\s*/.exec(line)?.[0] ?? ''

  return wrap(inline(line.slice(indent.length)), width, indent, indent)
}

/** A line's inline markdown as runs: bold, italic, code spans, links, and pressable phrases. */
function inline(text: string, isBold = false): Run[] {
  const runs: Run[] = []
  let bold = isBold
  let italic = false
  let pressable: Run['link']
  const emit = (chunk: string, extra: Omit<Run, 'text'> = {}) => {
    if (chunk === '') return
    const run: Run = { text: chunk, ...(bold && { bold: true }), ...(italic && { italic: true }), ...(pressable && { link: pressable }), ...extra }
    const last = runs.at(-1)
    if (last !== undefined && isSameStyle(last, run)) last.text += chunk
    else runs.push(run)
  }

  for (let i = 0; i < text.length; ) {
    const ch = text[i] ?? ''
    if (ch === START) {
      const first = text.indexOf(SEP, i + 1)
      const second = text.indexOf(SEP, first + 1)
      pressable = { action: text.slice(i + 1, first) === 'close' ? 'close' : 'open', key: text.slice(first + 1, second) }
      i = second + 1
      continue
    }
    if (ch === END) {
      pressable = undefined
      i += 1
      continue
    }
    if (ch === '`') {
      const fence = /^`+/.exec(text.slice(i))?.[0] ?? '`'
      const end = text.indexOf(fence, i + fence.length)
      if (end !== -1) {
        emit(text.slice(i + fence.length, end), { code: true })
        i = end + fence.length
        continue
      }
    }
    if (text.startsWith('**', i)) {
      bold = !bold
      i += 2
      continue
    }
    if (ch === '*' && /\S/.test((italic ? text[i - 1] : text[i + 1]) ?? ' ')) {
      italic = !italic
      i += 1
      continue
    }
    const markdownLink = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i))
    if (markdownLink) {
      emit(markdownLink[1] ?? '', { underline: true })
      emit(` (${markdownLink[2] ?? ''})`, { dim: true })
      i += markdownLink[0].length
      continue
    }
    emit(ch)
    i += 1
  }

  return runs
}

/** Word-wraps runs into rows of `width` cells; the first row starts with `first`, later rows with `rest`. */
function wrap(runs: Run[], width: number, first: string, rest: string, isDimLead = false): Row[] {
  const rows: Row[] = []
  let row: Row = []
  let used = 0
  let isBare = true
  const begin = (lead: string) => {
    row = lead === '' ? [] : [{ text: lead, ...(isDimLead && { dim: true }) }]
    used = widthOf(lead)
    isBare = true
  }
  const put = (piece: Run) => {
    const last = row.at(-1)
    if (last !== undefined && isSameStyle(last, piece)) last.text += piece.text
    else row.push({ ...piece })
    used += widthOf(piece.text)
    isBare = false
  }
  const breakRow = () => {
    const last = row.at(-1)
    if (last !== undefined && !isBare) {
      last.text = last.text.trimEnd()
      if (last.text === '') row.pop()
    }
    rows.push(row)
    begin(rest)
  }

  begin(first)
  for (const run of runs) {
    for (const text of run.text.split(/( +)/)) {
      if (text === '') continue
      if (text.trim() === '') {
        if (isBare) continue
        if (used + widthOf(text) <= width) put({ ...run, text })
        else breakRow()
        continue
      }
      let word = text
      while (word !== '') {
        if (used + widthOf(word) <= width) {
          put({ ...run, text: word })
          break
        }
        if (!isBare) {
          breakRow()
          continue
        }
        // A word wider than a whole row is cut where the row ends.
        const [head, tail] = cut(word, width - used)
        put({ ...run, text: head })
        breakRow()
        word = tail
      }
    }
  }
  rows.push(row)

  return rows
}

/** Rows of text kept as written, cut every `width` cells. */
function cutRows(runs: Run[], width: number): Row[] {
  const rows: Row[] = []
  let row: Row = []
  let used = 0
  for (const run of runs) {
    let rest = run.text
    while (rest !== '') {
      if (used >= width) {
        rows.push(row)
        row = []
        used = 0
      }
      const [head, tail] = cut(rest, width - used)
      row.push({ ...run, text: head })
      used += widthOf(head)
      rest = tail
    }
  }
  rows.push(row)

  return rows
}

/** `text` split where it would pass `room` cells, keeping at least one character. */
function cut(text: string, room: number): [string, string] {
  const chars = [...text]
  let used = 0
  let count = 0
  for (const ch of chars) {
    if (count > 0 && used + widthOf(ch) > room) break
    used += widthOf(ch)
    count += 1
  }

  return [chars.slice(0, count).join(''), chars.slice(count).join('')]
}

function isSameStyle(a: Run, b: Run): boolean {
  return (
    a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.underline === b.underline && a.dim === b.dim &&
    a.link?.action === b.link?.action && a.link?.key === b.link?.key
  )
}
