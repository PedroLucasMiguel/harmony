---
paths:
  - "v2/**"
---

# Harmony v2 client: hard guidelines

v2 is a rewrite of the **client only**, in Go with raylib, living in `v2/` beside the Electron client. The **server stays
as it is**: v2 speaks the protocol the server already has. These rules are decided by the owner; do not relax them
without being told to. The reason for the rewrite is long term (fewer bugs, less weight), not any single bug.

## What the rewrite is for

1. Really low resource use, above all RAM.
2. Better use of several threads.
3. Streaming that does not need a pile of fixes to the browser's engine: we own the media pipeline.
4. A smaller application.
5. Much faster load times.
6. A codebase that is easy to read, and stays that way.

## Rules

**Performance first, human readability second.** Never trade measurable performance for tidiness; never trade readability
for a gain nobody measured. When adding anything, weigh its cost in RAM, startup and binary size.

**Simplicity.** Use the simplest approach that works. Make something complex only when it is actually needed. No
speculative abstraction, no configuration nobody asked for, no layers that only forward calls.

**Structure.** Each feature and each module lives in its own package, with one purpose. Small files with clear names. A
reader should find the code for a feature by its name. Packages depend downward only; screens depend on components, not
the other way round.

**Comments.** The code explains itself through names and shape. A comment is allowed in two places only: a short summary at
the top of a package or file saying what it is, and the rare line that explains a magic number or a non-trivial fix whose
reason is not visible in the code. No narration, no restating the code, no history, no commented-out code.

**UI is component based.** Every visual element is a reusable component (button, text field, list row, avatar, panel, ...)
defined once and used everywhere, so the interface stays consistent in looks and behaviour. A screen is built only from
components and layout helpers; it never draws raw primitives or hard-codes colours, sizes or fonts. All design values
come from one theme.

**Looks are 1:1 with the Electron client; the logic is not.** The Electron client is the specification for the *layout*
only: same layout, spacing, sizes, fonts, colours, radii and states, screen by screen. Check each ported screen against a
screenshot of the Electron one. The client *logic* is always rewritten from what the Electron client does, never
transliterated: do not carry over its structure, workarounds or bad habits. Write it the way Go and this pipeline want
it, optimised from the start.

**Reactive, and cheap to draw.** The interface adapts to the window size (layout is computed from the available
space, never fixed to one size). Rendering is optimised as far as possible: draw only what changed, avoid redraws and
needless relayout (idle frames cost nothing), cache what is expensive (shaped text, glyphs, textures), and allocate
nothing per frame. Low resource use and speed are the top priority, above looks-related convenience.

**Tests.** Only useful tests. Do not write tests for large feature sets or end-to-end flows. Small tests are fine while
developing; a test that only covers something small or obvious is removed completely before the work is finished. What
stays covers logic that is easy to break and costly to find by eye (codecs, parsers, protocol framing, mixing).

**Versions.** Go is **1.27.4**. Every dependency is at its latest version; when adding or touching one, update it.

**Process.** Port screen by screen. Commit and push only when asked. Never edit `server/` for v2.
