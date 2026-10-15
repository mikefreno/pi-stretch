// A reply is markdown in which `{{short|long}}` marks a stretch: the reader
// sees `short`, and opening it puts `long` in its place. `long` may hold
// further stretches. Code spans and fences are copied as written, so braces in
// code never open a stretch.

export type Segment = string | Stretch

export type Stretch = {
  /**
   * Names the stretch by its short form and its parents' (`cache › key`), so a
   * stretch added elsewhere in the reply leaves every other key as it was. A
   * short form repeated among siblings takes `~2`, `~3`.
   */
  key: string
  short: string
  /** Undefined when no `|` was written: then there is nothing to open, and `short` is plain text. */
  long: Segment[] | undefined
  /** False while the reply streams and the closing braces have not arrived. */
  isClosed: boolean
}

type Frame = { stretch: Stretch; siblings: Map<string, number> }

export const KEY_SEPARATOR = ' › '

export function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined
}

export function parse(text: string): Segment[] {
  const root: Segment[] = []
  const stack: Frame[] = []
  const rootSiblings = new Map<string, number>()

  const write = (chunk: string) => {
    const frame = stack.at(-1)
    if (frame && frame.stretch.long === undefined) {
      frame.stretch.short += chunk
      return
    }
    const segments = frame?.stretch.long ?? root
    const last = segments.at(-1)
    if (typeof last === 'string') segments[segments.length - 1] = last + chunk
    else segments.push(chunk)
  }

  let i = 0
  while (i < text.length) {
    const frame = stack.at(-1)
    const isInShort = frame !== undefined && frame.stretch.long === undefined

    const fenceStop = i === 0 || text[i - 1] === '\n' ? fenceEnd(text, i) : undefined
    if (fenceStop !== undefined) {
      write(text.slice(i, fenceStop))
      i = fenceStop
      continue
    }

    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`'
      const end = text.indexOf(run, i + run.length)
      const stop = end === -1 ? text.length : end + run.length
      write(text.slice(i, stop))
      i = stop
      continue
    }

    if (text.startsWith('{{', i) && !isInShort) {
      const stretch: Stretch = {
        key: '',
        short: '',
        long: undefined,
        isClosed: false,
      }
      ;(frame?.stretch.long ?? root).push(stretch)
      stack.push({ stretch, siblings: new Map() })
      i += 2
      continue
    }

    if (isInShort && text[i] === '|') {
      frame.stretch.key = keyOf(frame.stretch.short, stack.at(-2), rootSiblings)
      frame.stretch.long = []
      i += 1
      continue
    }

    if (frame && text.startsWith('}}', i)) {
      frame.stretch.isClosed = true
      stack.pop()
      i += 2
      continue
    }

    write(text[i] ?? '')
    i += 1
  }

  return root
}

function keyOf(short: string, parent: Frame | undefined, rootSiblings: Map<string, number>): string {
  const name = short.trim()
  const siblings = parent?.siblings ?? rootSiblings
  const seen = (siblings.get(name) ?? 0) + 1
  siblings.set(name, seen)
  const own = seen === 1 ? name : `${name}~${seen}`

  return parent ? `${parent.stretch.key}${KEY_SEPARATOR}${own}` : own
}

/** Where a fenced code block opening at `start` ends (past its closing line), or undefined when no fence opens there. */
function fenceEnd(text: string, start: number): number | undefined {
  const lineEnd = (from: number) => {
    const end = text.indexOf('\n', from)
    return end === -1 ? text.length : end
  }
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(start, lineEnd(start)))?.[1]
  if (opening === undefined) return undefined

  for (let at = lineEnd(start) + 1; at < text.length; at = lineEnd(at) + 1) {
    const line = text.slice(at, lineEnd(at)).trim()
    if (line.length >= opening.length && [...line].every(c => c === opening[0])) return Math.min(lineEnd(at) + 1, text.length)
  }

  return text.length
}

/** Every stretch, outermost first, in the order the reply writes them. */
export function stretches(segments: Segment[]): Stretch[] {
  return segments.flatMap(segment =>
    typeof segment === 'string' ? [] : [segment, ...stretches(segment.long ?? [])],
  )
}

/** Where a streaming filter stands between flushes: open stretches and an open code fence. */
export type StreamState = { open: { isLong: boolean }[]; fence: string | undefined }

/**
 * A streaming reply's newly finished lines with each stretch shown as its short form, as the
 * finished reply will first show it. `state` carries open stretches and fences from one flush to
 * the next. A line that held only long-form text is left out, so the stream does not grow blank
 * lines where hidden depth goes.
 */
export function hideLongForms(lines: string, state: StreamState): string {
  return lines
    .split('\n')
    .flatMap(line => {
      const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]
      if (state.fence !== undefined || fence !== undefined) {
        const isShown = state.open.length === 0 || (state.open.length === 1 && state.open[0]?.isLong === false)
        if (state.fence === undefined) state.fence = fence
        else if (fence !== undefined && fence[0] === state.fence[0] && fence.length >= state.fence.length) state.fence = undefined
        return isShown ? [line] : []
      }
      let out = ''
      for (let i = 0; i < line.length; i++) {
        const top = state.open.at(-1)
        const isShown = state.open.length === 0 || (state.open.length === 1 && top?.isLong === false)
        if (line[i] === '`') {
          const run = /^`+/.exec(line.slice(i))?.[0] ?? '`'
          const end = line.indexOf(run, i + run.length)
          const stop = end === -1 ? line.length : end + run.length
          if (isShown) out += line.slice(i, stop)
          i = stop - 1
        } else if (line.startsWith('{{', i) && top?.isLong !== false) {
          state.open.push({ isLong: false })
          i++
        } else if (top?.isLong === false && line[i] === '|') {
          top.isLong = true
        } else if (top !== undefined && line.startsWith('}}', i)) {
          state.open.pop()
          i++
        } else if (isShown) {
          out += line[i]
        }
      }
      return out.trim() === '' && line.trim() !== '' ? [] : [out]
    })
    .join('\n')
}

/** A run of the reply between blank lines, and whether it holds a stretch. */
export type Paragraph = { text: string; hasStretch: boolean }

/**
 * The reply cut at the blank lines that stand outside every stretch and code fence, so a paragraph
 * holding a stretch can be drawn apart from the rest. Neighbouring paragraphs without one are kept
 * together.
 */
export function paragraphsOf(text: string): Paragraph[] {
  const pieces: string[] = []
  let current: string[] = []
  let depth = 0
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      current.push(line)
      continue
    }
    if (marker !== undefined) {
      fence = marker
      current.push(line)
      continue
    }
    if (line.trim() === '' && depth === 0) {
      if (current.length > 0) pieces.push(current.join('\n'))
      current = []
      continue
    }
    depth = depthAfter(line, depth)
    current.push(line)
  }
  if (current.length > 0) pieces.push(current.join('\n'))

  const paragraphs: Paragraph[] = []
  for (const piece of pieces) {
    const hasStretch = stretches(parse(piece)).length > 0
    const last = paragraphs.at(-1)
    if (!hasStretch && last !== undefined && !last.hasStretch) last.text += `\n\n${piece}`
    else paragraphs.push({ text: piece, hasStretch })
  }

  return paragraphs
}

/** How many stretches stand open after `line`, given `depth` open before it; code spans are skipped. */
function depthAfter(line: string, depth: number): number {
  let open = depth
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') {
      const run = /^`+/.exec(line.slice(i))?.[0] ?? '`'
      const end = line.indexOf(run, i + run.length)
      i = end === -1 ? line.length : end + run.length - 1
    } else if (line.startsWith('{{', i)) {
      open += 1
      i += 1
    } else if (open > 0 && line.startsWith('}}', i)) {
      open -= 1
      i += 1
    }
  }

  return open
}
