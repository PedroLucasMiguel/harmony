// Translations.
//
//   import { t } from './i18n.js';
//   t('chat.empty')                        // a string
//   t('files.tooBig', { name, limit })     // {name} and {limit} filled in
//   t('members', { count: 3 })             // a plural: see below
//
// Each language is one file in locales/ -- a flat object of key -> text -- and
// one line in locales/index.js. English is the language every key exists in
// and the one a missing key falls back to, so a half-finished translation is a
// working app with some English in it rather than an app with holes.
//
// A value is a string, or an object of plural forms picked by `count`:
//
//   'members': { one: '{count} member', other: '{count} members' }
//
// using Intl.PluralRules, so a language with more forms (Russian, Arabic) can
// name them -- zero, one, two, few, many, other -- without code changing here.
//
// The static text in index.html is marked up rather than written in JS:
//
//   <h3 data-i18n="settings.profile.title">Profile</h3>
//   <input data-i18n-placeholder="..." data-i18n-title="..." data-i18n-aria-label="...">
//
// The English left in the markup is what shows before this loads, and what is
// there if a language file fails to. See applyDom.
//
// Adding a language: README.md, "Translating".

import en from './locales/en.js';
import { LANGUAGES } from './locales/index.js';

const CACHE_KEY = 'harmony.language';
// A QA switch: with this set, every string that went through t() is wrapped in
// brackets, so anything on screen without them was never translated. Set it in
// the console: localStorage['harmony.pseudo'] = '1', and reload.
const PSEUDO = (() => {
  try { return localStorage.getItem('harmony.pseudo') === '1'; } catch { return false; }
})();

let code = 'en';
let table = en;
let plurals = new Intl.PluralRules('en');
const listeners = new Set();
const warned = new Set();

/** The languages on offer, each as { code, name } -- the name in its own language. */
export const languages = () => LANGUAGES.map(({ code: c, name }) => ({ code: c, name }));

/** The language in use, as one of the codes in languages(). */
export const currentLanguage = () => code;

/**
 * What a preference means: a code in the list, or 'auto' for the system's.
 *
 * "pt-PT" is not in the list but "pt-BR" is the nearest thing that is, and
 * "es-MX" is Spanish: a person's system language is matched on its first part
 * when the whole of it is not there.
 */
export function resolveLanguage(preference = 'auto', wanted = navigator.languages ?? [navigator.language]) {
  const known = (c) => LANGUAGES.find((l) => l.code.toLowerCase() === String(c).toLowerCase());
  if (preference && preference !== 'auto') return (known(preference) ?? LANGUAGES[0]).code;
  for (const candidate of wanted ?? []) {
    const exact = known(candidate);
    if (exact) return exact.code;
    const primary = String(candidate).toLowerCase().split('-')[0];
    const near = LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === primary);
    if (near) return near.code;
  }
  return LANGUAGES[0].code;
}

/** `{name}` in a string, from `vars`. An unknown name is left as written. */
const fill = (text, vars) => (vars
  ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
  : text);

function lookup(source, key, vars) {
  let value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === 'object') {
    const form = plurals.select(Number(vars?.count ?? 0));
    value = value[form] ?? value.other ?? Object.values(value)[0];
  }
  return fill(String(value), vars);
}

/**
 * The text for a key, in the language in use.
 *
 * Falls back to English, and then to the key itself so that a typo shows as
 * itself on screen instead of as nothing. Said once on the console, because a
 * missing key is a bug somebody wants to hear about.
 */
export function t(key, vars) {
  const text = lookup(table, key, vars) ?? lookup(en, key, vars);
  if (text !== undefined) return PSEUDO ? `\u27E6${text}\u27E7` : text;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] no text for "${key}"`);
  }
  return key;
}

/**
 * Every key starting with `prefix`, translated, as { key: text }.
 *
 * For the code that has to hand a table of words to somebody else: the main
 * process puts a few on screen itself (main/strings.js), and is sent them
 * under "main." whenever the language changes.
 */
export const texts = (prefix) => Object.fromEntries(
  Object.keys(en).filter((key) => key.startsWith(prefix)).map((key) => [key, t(key)]),
);

/** Whether a key exists at all, for the code that has a better fallback than the key. */
export const hasText = (key) => key in table || key in en;

/**
 * Translate the marked-up elements under `root`.
 *
 *   data-i18n="key"                 its text
 *   data-i18n-title="key"           title, and so the tooltip
 *   data-i18n-placeholder="key"     placeholder
 *   data-i18n-aria-label="key"      aria-label
 *   data-i18n-alt="key"             alt
 *
 * Only elements whose text JavaScript never sets are marked this way; the rest
 * are written by their own render function with t(), so that a language change
 * does not put a stale label over a live one.
 */
export function applyDom(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const text = t(node.dataset.i18n);
    // An icon button's words are its accessible name, not something drawn: the
    // icon helper empties them on purpose, and putting them back would draw
    // them beside the icon.
    if (node.hasAttribute('data-icon')) node.setAttribute('aria-label', text);
    else node.textContent = text;
  }
  for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
    const dataset = `data-i18n-${attribute}`;
    for (const node of root.querySelectorAll(`[${dataset}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(dataset)));
    }
  }
}

/**
 * Switch language: load it, translate what is on the page, tell the code that
 * draws the rest. Resolves to the code that is now in use.
 *
 * A language file that will not load leaves English in place rather than
 * failing -- the app is usable in a language the person did not pick, and is
 * not usable at all if this throws during start-up.
 */
export async function setLanguage(preference = 'auto') {
  const next = resolveLanguage(preference);
  let loaded = en;
  try {
    const entry = LANGUAGES.find((l) => l.code === next);
    loaded = (await entry.load()).default;
  } catch (err) {
    console.warn(`[i18n] could not load ${next}:`, err);
  }
  code = loaded === en ? 'en' : next;
  table = loaded;
  try {
    plurals = new Intl.PluralRules(code);
  } catch {
    plurals = new Intl.PluralRules('en');
  }
  document.documentElement.lang = code;
  try {
    localStorage.setItem(CACHE_KEY, preference);
  } catch { /* private window, or storage blocked: the setting still saves */ }
  applyDom(document);
  for (const listener of listeners) {
    try { listener(code); } catch (err) { console.warn('[i18n] listener failed:', err); }
  }
  return code;
}

/** Called after every language change; returns a function that stops listening. */
export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The preference saved last time, readable before settings have loaded. */
export function cachedPreference() {
  try {
    return localStorage.getItem(CACHE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
