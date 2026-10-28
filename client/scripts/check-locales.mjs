// Checks every language file against English.
//
//   node scripts/check-locales.mjs          report; exit 1 if anything is wrong
//   node scripts/check-locales.mjs pt-BR    only that language
//
// For each language in src/renderer/locales/index.js it reports
//   missing      a key English has and this file does not (shows as English)
//   extra        a key this file has and English does not (a typo, or a string
//                that was removed)
//   placeholders {names} that differ from English's: the code fills them by
//                name, so a renamed or dropped one prints "{name}" on screen
//   plurals      a plural form where English has a plain string, or the reverse
// A language with missing keys is still a working language, so those are
// warnings and only the other three fail the run.

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The locale files are ES modules in a package that is not marked as one (the
// app loads them in a browser, where that does not matter); Node says so once
// per file, which is noise here.
process.emitWarning = () => {};

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'locales');
const load = async (file) => (await import(pathToFileURL(join(root, file)).href)).default;
const { LANGUAGES } = await import(pathToFileURL(join(root, 'index.js')).href);

const english = await load('en.js');
const names = (value) => {
  const forms = typeof value === 'object' ? Object.values(value) : [value];
  return [...new Set(forms.flatMap((text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort().join(',');
};

const only = process.argv[2];
let failed = 0;
for (const { code, name } of LANGUAGES) {
  if (code === 'en' || (only && only !== code)) continue;
  let table;
  try {
    table = await load(`${code}.js`);
  } catch (err) {
    console.log(`${code}: cannot be loaded -- ${err.message}`);
    failed += 1;
    continue;
  }
  const missing = Object.keys(english).filter((k) => !(k in table));
  const extra = Object.keys(table).filter((k) => !(k in english));
  const problems = [];
  for (const key of Object.keys(table)) {
    if (!(key in english)) continue;
    if (names(table[key]) !== names(english[key])) {
      problems.push(`placeholders in "${key}": English has {${names(english[key])}}, ${code} has {${names(table[key])}}`);
    }
    if ((typeof table[key] === 'object') !== (typeof english[key] === 'object')) {
      problems.push(`plurals in "${key}": English is ${typeof english[key] === 'object' ? 'plural' : 'a string'}, ${code} is not`);
    }
    if (typeof table[key] === 'string' && table[key].trim() === '') problems.push(`"${key}" is empty`);
  }
  console.log(`${code} (${name}): ${Object.keys(english).length - missing.length}/${Object.keys(english).length} translated`
    + `${missing.length ? `, ${missing.length} missing` : ''}${extra.length ? `, ${extra.length} extra` : ''}`);
  for (const key of missing.slice(0, 15)) console.log(`   missing ${key}`);
  if (missing.length > 15) console.log(`   ... and ${missing.length - 15} more`);
  for (const key of extra) { console.log(`   extra   ${key}`); failed += 1; }
  for (const problem of problems) { console.log(`   ${problem}`); failed += 1; }
}
process.exit(failed ? 1 : 0);
