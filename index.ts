// cc-stretch for pi: replies that arrive short and grow where they stand. The
// model writes stretchtext ({{short|long}}) under the guide below, pi's
// transcript draws every stretch closed, and the reader spends their attention
// one phrase at a time in the /stretch reader. What they opened is kept and
// told to the model with their next message, so it never assumes they read the
// rest. Ported from the Claude Code plugin: github.com/pro-vi/cc-stretch
// (parse.ts, grow.ts, layout.ts and guide.ts here are its, unchanged).

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { GUIDE } from './guide'
import { hideLongForms, isOpenable, parse, stretches } from './parse'
import { StretchReader } from './reader'

/** What the reader opened in one reply, kept under that reply's first entry id. */
type Read = { replyId: string; opened: string[] }

const READ_ENTRY = 'pi-stretch:read'
const NOTE_TYPE = 'pi-stretch:read-note'

export default function stretch(pi: ExtensionAPI) {
  // The reader's last reading, kept in memory and in the session file so it survives a
  // reload or a resumed session. Only the newest one matters.
  let lastRead: Read | undefined

  pi.on('session_start', (_event, ctx) => {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== 'custom' || entry.customType !== READ_ENTRY) continue
      const data = entry.data as Partial<Read> | undefined
      if (typeof data?.replyId === 'string' && Array.isArray(data.opened)) {
        lastRead = { replyId: data.replyId, opened: data.opened.filter((key): key is string => typeof key === 'string') }
      }
      break
    }
  })

  // The stretchtext guide rides with the system prompt. cc-stretch's benchmark rewrites
  // replies under this same text, so it stays word for word what guide.ts has.
  pi.on('before_agent_start', (event, ctx) => {
    event.systemPromptOptions.sections['stretchtext'] = GUIDE

    if (event.messageType !== 'user') return
    const reply = lastReplyOf(ctx)
    if (reply === undefined) return
    const openable = stretches(parse(reply.text)).filter(isOpenable)
    if (openable.length === 0) return

    // What the reader opened of this reply, in its terms: keys, matched back to short forms.
    const read = lastRead !== undefined && lastRead.replyId === reply.id ? lastRead : undefined
    const opened = read === undefined ? [] : openable.filter(stretch => read.opened.includes(stretch.key))
    const unopened = openable.filter(stretch => !opened.includes(stretch))
    const quote = (list: string[]) => list.map(short => `"${short}"`).join(', ')
    const note =
      opened.length > 0
        ? `Stretchtext: since your last reply the reader opened ${quote(opened.map(stretch => stretch.short.trim()))}.` +
          (unopened.length > 0 ? ` They did not open ${quote(unopened.map(stretch => stretch.short.trim()))}.` : '')
        : // The transcript drew the reply with every stretch closed, so nothing was read but the skim.
          'Stretchtext: the reader opened no stretch of your last reply. The transcript showed only its short forms; do not assume they read any long form.'

    return {
      message: { customType: NOTE_TYPE, content: note, display: false },
    }
  })

  // While a reply streams and once it stands, pi's markdown runs through here; hiding each
  // stretch's long form keeps the raw markup off the screen and leaves the skim. The
  // transformer sees the full text on every flush, so one pass with a fresh state is enough.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== 'assistant') return markdown
    return hideLongForms(markdown, { open: [], fence: undefined })
  })

  pi.registerCommand('stretch', {
    description: 'Read the last reply stretch by stretch',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return
      const reply = lastReplyOf(ctx)
      if (reply === undefined || stretches(parse(reply.text)).filter(isOpenable).length === 0) {
        ctx.ui.notify('No reply with stretches to read.', 'info')
        return
      }

      const open = lastRead !== undefined && lastRead.replyId === reply.id ? lastRead.opened : []
      const opened = await ctx.ui.custom<string[]>(
        (tui, theme, _keybindings, done) => new StretchReader(tui, theme, done, reply.text, open),
        { overlay: true, overlayOptions: { anchor: 'center', width: '96%', maxHeight: '92%' } },
      )

      lastRead = { replyId: reply.id, opened: opened ?? [] }
      pi.appendEntry(READ_ENTRY, lastRead)
    },
  })
}

/** The model's last reply: the assistant texts after the person's last prompt, and the id of the entry that starts them. */
function lastReplyOf(ctx: ExtensionContext): { id: string; text: string } | undefined {
  const texts: { id: string; text: string }[] = []
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'user') break
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n')
    if (text.trim() !== '') texts.unshift({ id: entry.id, text })
  }

  return texts.length > 0 ? { id: texts[0]?.id ?? '', text: texts.map(one => one.text).join('\n') } : undefined
}
