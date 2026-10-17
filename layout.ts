// cc-stretch's hooks/layout.ts draws a reply as rows and breaks them where a language breaks; the
// breaking rules live here as their `breakables`, vendored unchanged from that file, so `grow.ts`
// (also cc-stretch's, unchanged) can grow a long form a word at a time in every language.

// A mark drawn on the letter before it, or a character no terminal draws, takes no cell.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/u

// Where a row may break in text without spaces. Chinese and Japanese break between any two
// characters. Korean spaces its words, so it breaks at spaces as Latin text does. Thai, Lao, Khmer
// and Burmese write words without spaces, and a row breaks between words where Intl.Segmenter
// finds them. Closing punctuation, a Japanese small kana, the long-vowel mark and a mark drawn on
// the letter before it never start a row; opening punctuation never ends one.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u
const SEGMENTED = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const NO_START = /[\p{Pe}\p{Pf},.:;!?，。、；：？！…·ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶーゝゞヽヾ々]/u
const NO_END = /[\p{Ps}\p{Pi}]/u
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

export function breakables(text: string): string[] {
  // Nothing below Thai breaks, so a Latin word or a run of spaces comes back whole without a look at
  // each character.
  if (!/[^\0-\u0dff]/.test(text)) return [text]
  const wordStarts = new Set<number>()
  if (SEGMENTED.test(text)) for (const word of SEGMENTER.segment(text)) wordStarts.add(word.index)
  const pieces: string[] = []
  let piece = ''
  let last = ''
  let isAfterUnspaced = false
  let at = 0
  for (const ch of text) {
    const isUnspaced = UNSPACED.test(ch)
    const isWordStart = wordStarts.has(at) && SEGMENTED.test(last + ch)
    if (piece !== '' && (isUnspaced || isAfterUnspaced || isWordStart) && !NO_START.test(ch) && !NO_END.test(last) && !ZERO_WIDTH.test(ch)) {
      pieces.push(piece)
      piece = ''
    }
    piece += ch
    last = ch
    isAfterUnspaced = isUnspaced || (isAfterUnspaced && NO_START.test(ch))
    at += ch.length
  }
  if (piece !== '') pieces.push(piece)

  return pieces
}
