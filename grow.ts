import type { Segment, Stretch } from './parse'

// A long form grows around its short form. The short form's words, found in
// the long form in order, are anchors and never move; the words between them
// arrive from the anchors outward, so the sentence widens at every seam at
// once, to the left of an anchor as much as to its right. Words arrive whole:
// a terminal has no room to fade one in, and half a word reads as a typo.

type Token = { kind: 'word' | 'space'; text: string } | { kind: 'nested'; stretch: Stretch }

/** A word or a run of spaces of the long form, or a nested stretch. */
type Atom = string | Stretch

/** Where a run of new words sits relative to the anchors around it. */
type Side = 'before' | 'between' | 'after'

/**
 * The long form at `progress`: 0 shows only the anchors, 1 shows all of it.
 * `draw` writes a nested stretch, which is never shown in part.
 */
export function grow(short: string, long: Segment[], progress: number, draw: (nested: Stretch) => string): string {
  const tokens = tokenize(long)
  const anchors = anchorsOf(short, tokens)
  const shown = (atoms: Atom[]) => atoms.map(atom => (typeof atom === 'string' ? atom : draw(atom))).join('')

  let out = ''
  let run: Atom[] = []
  let hasAnchorBefore = false
  const flush = (hasAnchorAfter: boolean) => {
    if (run.length === 0) return
    const side: Side = !hasAnchorBefore ? (hasAnchorAfter ? 'before' : 'after') : hasAnchorAfter ? 'between' : 'after'
    out += shown(reveal(run, side, progress))
    run = []
  }

  tokens.forEach((token, i) => {
    if (anchors.has(i) && token.kind !== 'space') {
      flush(true)
      out += token.kind === 'nested' ? draw(token.stretch) : token.text
      hasAnchorBefore = true
      return
    }
    run.push(token.kind === 'nested' ? token.stretch : token.text)
  })
  flush(false)

  return out
}

/** How many words and nested stretches a growth adds, to pace it. */
export function lengthOf(long: Segment[]): number {
  return tokenize(long).filter(token => token.kind !== 'space').length
}

function reveal(run: Atom[], side: Side, progress: number): Atom[] {
  // Two anchors stay a space apart from the start, as they stood in the short form.
  const isSpace = (atom: Atom | undefined) => typeof atom === 'string' && /^\s+$/.test(atom)
  if (side === 'between' && run.length > 1 && isSpace(run[0]) && isSpace(run.at(-1))) {
    const middle = reveal(run.slice(1, -1), side, progress)
    return middle.length === 0 ? [run[0] ?? ' '] : [run[0] ?? ' ', ...middle, run.at(-1) ?? ' ']
  }
  if (side === 'between' && isSpace(run[0])) return [run[0] ?? ' ', ...reveal(run.slice(1), side, progress)]
  const count = Math.round(run.length * Math.min(1, Math.max(0, progress)))
  if (side === 'after') return run.slice(0, count)
  if (side === 'before') return run.slice(run.length - count)
  const left = run.slice(0, Math.ceil(count / 2))
  const right = run.slice(run.length - Math.floor(count / 2))
  if (left.length + right.length === run.length) return [...left, ...right]
  // The two halves meet where words are still missing: exactly one space between them.
  const isSpaceAtom = (atom: Atom | undefined) => typeof atom === 'string' && /^\s+$/.test(atom)
  if (isSpaceAtom(left.at(-1)) && isSpaceAtom(right[0])) return [...left, ...right.slice(1)]
  if (!isSpaceAtom(left.at(-1)) && !isSpaceAtom(right[0]) && left.length > 0 && right.length > 0) return [...left, ' ', ...right]

  return [...left, ...right]
}

function tokenize(long: Segment[]): Token[] {
  return long.flatMap((part): Token[] =>
    typeof part === 'string'
      ? part
          .split(/(\s+)/)
          .filter(text => text !== '')
          .map(text => ({ kind: /^\s+$/.test(text) ? 'space' : 'word', text }))
      : [{ kind: 'nested', stretch: part }],
  )
}

/**
 * The token indexes of the long form that carry the short form's words, as many as can be kept in
 * order (a longest common subsequence). A nested stretch shows its own short form, so its words
 * count where it stands.
 */
function anchorsOf(short: string, tokens: Token[]): Set<number> {
  const want = short.split(/\s+/).map(bare).filter(word => word !== '')
  const have: { token: number; word: string }[] = []
  tokens.forEach((token, i) => {
    const words = token.kind === 'word' ? [token.text] : token.kind === 'nested' ? token.stretch.short.split(/\s+/) : []
    for (const word of words.map(bare).filter(w => w !== '')) have.push({ token: i, word })
  })

  // lengths[i][j]: the longest common run of want[i..] and have[j..].
  const lengths = Array.from({ length: want.length + 1 }, () => new Array<number>(have.length + 1).fill(0))
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = have.length - 1; j >= 0; j--) {
      const row = lengths[i] ?? [], below = lengths[i + 1] ?? []
      row[j] = want[i] === have[j]?.word ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const anchors = new Set<number>()
  for (let i = 0, j = 0; i < want.length && j < have.length; ) {
    if (want[i] === have[j]?.word) {
      anchors.add(have[j]?.token ?? -1)
      i++
      j++
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) i++
    else j++
  }
  // Punctuation standing on its own right after an anchor (`{{...}}.`) belongs to that anchor.
  let last = -1
  tokens.forEach((token, i) => {
    if (token.kind === 'space') return
    if (token.kind === 'word' && bare(token.text) === '' && anchors.has(last)) anchors.add(i)
    last = i
  })

  return anchors
}

/** A word without its surrounding punctuation or markdown marks, lowercased, so `cache.` meets `**cache**`. */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
}
