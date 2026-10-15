# pi-stretch

[cc-stretch](https://github.com/pro-vi/cc-stretch) — the Claude Code stretchtext plugin — as a
pi extension. Replies arrive short; click a linked phrase and it grows right where it stands.

- **Guide**: `before_agent_start` adds cc-stretch's stretchtext guide to the system prompt as a
  `stretchtext` section, so the model writes replies as `{{short|long}}` stretchtext.
- **Skim**: a markdown transformer hides every stretch's long form, in the transcript and while
  a reply streams.
- **Reader**: `/stretch` opens the last reply as an overlay. A click on a phrase opens its long
  form around it (the words already read never move), `«` shrinks it back; `j`/`k` + `enter`
  work where there is no mouse. Stretches nest.
- **Feedback**: what the reader opened is kept in the session (a `pi-stretch:read` entry) and,
  with their next message, told to the model as a hidden note — it is never left assuming they
  read a long form they did not open.

`parse.ts`, `grow.ts`, `layout.ts` and `guide.ts` are cc-stretch's, vendored unchanged. The
one difference from the plugin: pi draws assistant markdown itself, so stretches cannot grow
inline in the transcript — the interactive reading lives in the `/stretch` overlay instead.
Tracked as MISC-40 on Plane.
