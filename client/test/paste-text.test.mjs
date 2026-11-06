// When a paste is a file, and what the file is called.
//
//   node client/test/paste-text.test.mjs

import { reporter } from './cdp.mjs';
import { isHugePaste, pastedName, fileFromPaste, PASTE_AS_FILE_CHARS } from '../src/renderer/paste-text.js';

const { check, summary } = reporter();
const box = (value = '', maxLength = 4000, start = value.length, end = start) => ({ value, maxLength, selectionStart: start, selectionEnd: end });
const text = (n) => 'x'.repeat(n);

check('a short paste is text', !isHugePaste('hello', box()));
check('a paste right at the limit is still text', !isHugePaste(text(PASTE_AS_FILE_CHARS), box()));
check('one character over it is a file', isHugePaste(text(PASTE_AS_FILE_CHARS + 1), box()));
check('and so is a long one into a box that is somewhere else (no box to ask)', isHugePaste(text(9000)));
check('a paste that does not fit what is left of the box is a file, not a cut-off one', isHugePaste(text(1500), box(text(3000))));
check('unless it replaces what is selected, and then fits', !isHugePaste(text(1500), box(text(3000), 4000, 0, 3000)));
check('a short one is never a file for lack of room, however full the box', !isHugePaste('hi there', box(text(3999))));
check('a paste of 900 into a nearly full box is still text: it is not worth a file', !isHugePaste(text(900), box(text(3500))));
check('something that is not text is not asked about', !isHugePaste(null, box()) && !isHugePaste(undefined, box()));

check('the first file is message.txt', pastedName([]) === 'message.txt');
check('a second one going with the same message does not take its name', pastedName(['message.txt']) === 'message (2).txt');
check('and a third', pastedName(['message.txt', 'message (2).txt', 'a.png']) === 'message (3).txt');

const event = (plain, files = []) => ({ clipboardData: { files, getData: (type) => (type === 'text/plain' ? plain : '') } });
const made = fileFromPaste(event(text(5000)), box());
check('a huge paste makes a text file with all of it', made instanceof File && made.name === 'message.txt' && made.type === 'text/plain' && made.size === 5000, `${made?.name} ${made?.size}`);
check('the words are exactly what was pasted, in one piece', (await made.text()) === text(5000));
check('an ordinary paste makes nothing', fileFromPaste(event('hello'), box()) === null);
check('a paste that carries a file of its own is left to the box that takes files', fileFromPaste(event(text(9000), [new File(['a'], 'a.png')]), box()) === null);
check('no clipboard, no file', fileFromPaste({}, box()) === null);
const multi = fileFromPaste(event('é'.repeat(3000) + '\n'.repeat(2000)), box());
check('and what is not ASCII is kept as it is (UTF-8)', multi && multi.size === 6000 + 2000, `${multi?.size}`);

const failed = summary();
process.exit(failed ? 1 : 0);
