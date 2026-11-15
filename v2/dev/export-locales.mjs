// Copies the Electron client's translations into v2/assets/locales as JSON: node v2/dev/export-locales.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'client', 'src', 'renderer', 'locales');
const target = join(here, '..', 'assets', 'locales');
mkdirSync(target, { recursive: true });

const { LANGUAGES } = await import(pathToFileURL(join(source, 'index.js')));
for (const { code } of LANGUAGES) {
  const { default: strings } = await import(pathToFileURL(join(source, `${code}.js`)));
  writeFileSync(join(target, `${code}.json`), JSON.stringify(strings));
}
writeFileSync(join(target, 'languages.json'), JSON.stringify(LANGUAGES.map(({ code, name }) => ({ code, name }))));
