// The languages the app speaks.
//
// To add one:
//   1. copy locales/en.js to locales/<code>.js and translate the values
//      (leave the keys, and anything in {braces}, as they are)
//   2. add a line below
//
// `name` is the language in its own language, because that is how somebody
// who does not read the current one finds theirs. The first entry is English
// and is the fallback for anything a language has not translated.
//
// Files load when chosen, so a language nobody uses costs nothing to start.

export const LANGUAGES = [
  { code: 'en', name: 'English', load: () => import('./en.js') },
  { code: 'pt-BR', name: 'Português (Brasil)', load: () => import('./pt-BR.js') },
  { code: 'es', name: 'Español', load: () => import('./es.js') },
];
