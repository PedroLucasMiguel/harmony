// A log that was at its end stays at its end when the box it scrolls in changes height.
//
// That happens whenever something around it does: the message box growing a line as it is typed in, and going back to
// one when the message is sent; the keyboard coming up on a phone and going again. The log is a flex item, so its
// own height gives way to theirs -- and since nothing about its CONTENT changed, it stays where it was scrolled to,
// which is no longer the end. The next message then found it "not at the end" and was not scrolled to, so after a few
// lines of typing the chat stopped following anything.
//
// Whether it was at the end is worked out when the size changes, from where it is scrolled to and how tall it WAS: the
// scroll position has not moved yet, and a shorter box is exactly what makes it look as if it were up.

/** How near the end counts as at it, in px: a line or so, as the log's own check (see renderChat). */
const AT_END_PX = 40;

/**
 * @param {HTMLElement} log  the box with the scroll bar
 */
export function keepEnd(log) {
  let height = log.clientHeight;
  new ResizeObserver(() => {
    const before = height;
    height = log.clientHeight;
    // Hidden (a view put away) or shown again is not a change that means anything: nothing was being looked at.
    if (!before || !height || height === before) return;
    if (log.scrollHeight - log.scrollTop - before < AT_END_PX) log.scrollTop = log.scrollHeight;
  }).observe(log);
}
