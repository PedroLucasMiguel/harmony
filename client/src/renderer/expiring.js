// A message that says something went wrong, or what was done, and then goes away.
//
// The error line and the note under the message box were set to a text and never cleared by anything but the next
// thing that happened to set them -- so "Could not play ..." stayed up for as long as the window did. What is said is
// said once: it stays long enough to be read, and a new one starts the time again. Whatever puts a text there needs
// no change; it is watched, not called.

/** How long a text stays up, ms. Long enough for a sentence to be read twice. */
export const EXPIRES_MS = 9000;

/**
 * @param {HTMLElement} node   where the text is shown
 * @param {() => void} clear   what takes it away (setting the text empty, hiding the node)
 * @param {number} [ms]
 * @returns {() => void}  stops watching
 */
export function expiring(node, clear, ms = EXPIRES_MS) {
  let timer = null;
  let shown = null;
  const watch = new MutationObserver(() => {
    const now = node.hidden ? '' : node.textContent;
    // Only a change of what is said starts the time again: clearing is not news, and neither is a node of the same
    // words that was drawn again.
    if (now === shown) return;
    shown = now;
    clearTimeout(timer);
    if (!now) return;
    timer = setTimeout(() => {
      shown = null;
      clear();
    }, ms);
  });
  watch.observe(node, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  return () => {
    watch.disconnect();
    clearTimeout(timer);
  };
}
