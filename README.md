# pi-stretch

[cc-stretch](https://github.com/pro-vi/cc-stretch) — the Claude Code stretchtext plugin — as a
pi extension. Replies arrive short; click a linked phrase and it grows right where it stands.

- **Guide**: `before_agent_start` adds cc-stretch's stretchtext guide to the system prompt as a
  `stretchtext` section, so the model writes replies as `{{short|long}}` stretchtext.
- **Inline**: a markdown transformer draws each closed stretch as a link on its short form and
  each open one with a `«` after it. A click grows the long form in place in the transcript,
  the view scrolling down with the growth and back up as `«` shrinks it — until the reader
  scrolls, which hands the view back to them. Stretches nest, and any reply in the transcript
  can be read this way, not only the last.
- **Streaming**: while a reply streams, its stretches show as their short forms.
- **Feedback**: with the reader's next message, the model is told which stretches they opened
  since its last reply, so it never assumes they read a long form they did not open. The note is
  spliced into that request alone, right after the reader's message, and pi restores the transcript
  once the request is sent: nothing is written to the session, so the history tree, exports and
  compaction summaries never see it.

Clicks need pi's fullscreen mode (the default `tuiMode`) and a terminal that draws OSC 8
hyperlinks. pi answers a click on a hyperlink by handing its URL to the TUI's `openUrl`; the
extension wraps that, so its own `https://pi-stretch.invalid/…` links open and close stretches
and every other link still opens in the browser. Where a click cannot land (regular mode, or no
hyperlinks), every stretch is drawn open, as cc-stretch does on Claude Code's classic renderer.

`parse.ts`, `grow.ts` and `guide.ts` are cc-stretch's, vendored unchanged; `inline.ts` writes
stretches into pi's markdown. `npm test` drives the extension against pi-tui's own Markdown;
`npm run typecheck` checks it against the installed pi.
