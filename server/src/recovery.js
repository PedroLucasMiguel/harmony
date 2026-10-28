// Getting back into an account with three questions the person chose.
//
// The shape: while signed in, somebody writes three questions and their
// answers. Later, from the sign-in screen, they name the account, are shown the
// questions, and answer all three. If every answer is right they get a
// one-use, short-lived token that lets them set a new password -- and that is
// all it lets them do.
//
// What this module is careful about:
//
//  - ANSWERS ARE COMPARED NORMALISED. "São Paulo", "  sao   paulo " and
//    "SAO PAULO!" are one answer. Normalisation happens on the way in and on
//    the way out, here, on the server, so no client has to agree with another
//    about it.
//  - ANSWERS ARE STORED AS PASSWORDS ARE (salted scrypt), and all three are
//    always checked, so how long a wrong attempt takes says nothing about
//    which answer was wrong. Nor does the reply: it never says which.
//  - GUESSING IS EXPENSIVE: a few wrong tries and the account's recovery is
//    locked for a while, escalating (see mountRecovery).
//  - A SIGNED-IN SESSION IS NOT ENOUGH TO PLANT ANSWERS. Setting or clearing
//    them asks for the current password: otherwise whoever picks up an
//    unlocked computer could set answers they know and take the account.

import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

import { hashPassword, verifyPassword } from './accounts.js';
import { LoginLimiter } from './auth.js';
import { Throttle } from './throttle.js';

export const QUESTIONS_REQUIRED = 3;
export const QUESTION_MIN = 5;
export const QUESTION_MAX = 140;
/** After normalising: an answer shorter than this is guessable by anybody. */
export const ANSWER_MIN = 2;
export const ANSWER_MAX = 200;

/** How long somebody has to choose a new password once they have answered. */
const TOKEN_TTL_MS = 10 * 60_000;

/**
 * An answer as it is compared.
 *
 * Accents are dropped (decomposed, then the combining marks removed), case is
 * folded, and everything that is not a letter or a digit -- spaces, runs of
 * spaces, punctuation, quotes -- becomes one space, trimmed. Only the Latin,
 * Greek and Cyrillic diacritics (U+0300..036F) are removed: stripping every
 * combining mark would also fold distinct Japanese and Korean letters into
 * each other.
 */
export function normalizeAnswer(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/** A question as it is shown: trimmed, with runs of whitespace made one space. */
export function cleanQuestion(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

const sha = (value) => createHash('sha256').update(value).digest('hex');

export class Recovery {
  #db;
  #now;
  #q;
  /** @type {Map<string, {userId: number, expires: number}>} */
  #tokens = new Map();

  constructor(db, { now = Date.now } = {}) {
    this.#db = db;
    this.#now = now;
    this.#q = {
      list: db.prepare('SELECT slot, question, answer_hash FROM recovery_answers WHERE user_id = ? ORDER BY slot'),
      add: db.prepare(
        'INSERT INTO recovery_answers (user_id, slot, question, answer_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      clear: db.prepare('DELETE FROM recovery_answers WHERE user_id = ?'),
    };
  }

  /** The questions for an account, in order: [] when it has none. Never the answers. */
  questions(userId) {
    return this.#q.list.all(userId).map((row) => row.question);
  }

  configured(userId) {
    return this.#q.list.all(userId).length === QUESTIONS_REQUIRED;
  }

  /**
   * Replace the account's questions and answers, all three together.
   *
   * @param {number} userId
   * @param {Array<{question: string, answer: string}>} items
   * @returns {Promise<{ok: true} | {ok: false, error: string}>}
   */
  async set(userId, items) {
    if (!Array.isArray(items) || items.length !== QUESTIONS_REQUIRED) {
      return { ok: false, error: 'need_three' };
    }
    const questions = items.map((item) => cleanQuestion(item?.question));
    if (questions.some((q) => q.length < QUESTION_MIN || q.length > QUESTION_MAX)) {
      return { ok: false, error: 'bad_question' };
    }
    // The same question three times is one question, however it is spelled.
    if (new Set(questions.map(normalizeAnswer)).size !== QUESTIONS_REQUIRED) {
      return { ok: false, error: 'repeated_question' };
    }
    const answers = items.map((item) => normalizeAnswer(item?.answer));
    if (items.some((item) => String(item?.answer ?? '').length > ANSWER_MAX)
      || answers.some((a) => a.length < ANSWER_MIN)) {
      return { ok: false, error: 'bad_answer' };
    }

    // Hashed before the transaction opens: scrypt is async and the database
    // is not to be held open across it.
    const hashes = await Promise.all(answers.map((a) => hashPassword(a)));

    const now = this.#now();
    this.#db.exec('BEGIN');
    try {
      this.#q.clear.run(userId);
      questions.forEach((question, i) => this.#q.add.run(userId, i + 1, question, hashes[i], now));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true };
  }

  clear(userId) {
    this.#q.clear.run(userId);
  }

  /**
   * Whether every answer is right.
   *
   * All three are checked whatever the first ones say, so the time taken
   * and the reply give nothing away about which was wrong.
   */
  async check(userId, answers) {
    const rows = this.#q.list.all(userId);
    if (rows.length !== QUESTIONS_REQUIRED || !Array.isArray(answers) || answers.length !== QUESTIONS_REQUIRED) {
      return false;
    }
    const results = await Promise.all(rows.map(
      (row, i) => verifyPassword(normalizeAnswer(answers[i]), row.answer_hash),
    ));
    return results.every(Boolean);
  }

  /** A token that lets this account choose a new password, once, soon. */
  issueToken(userId) {
    const now = this.#now();
    for (const [key, entry] of this.#tokens) {
      if (entry.expires <= now) this.#tokens.delete(key);
    }
    // One at a time per account: answering again replaces the last.
    for (const [key, entry] of this.#tokens) {
      if (entry.userId === userId) this.#tokens.delete(key);
    }
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(sha(token), { userId, expires: now + TOKEN_TTL_MS });
    return token;
  }

  /** Whose token this is, if it is good. Does not use it up. */
  tokenUser(token) {
    const entry = this.#tokens.get(sha(String(token ?? '')));
    if (!entry || entry.expires <= this.#now()) return null;
    return entry.userId;
  }

  spendToken(token) {
    this.#tokens.delete(sha(String(token ?? '')));
  }
}

/**
 * Mount the routes.
 *
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.requireLogin
 * @param {import('./accounts.js').Accounts} deps.accounts
 * @param {Recovery} deps.recovery
 * @param {LoginLimiter} deps.loginLimiter  cleared when somebody proves who they are
 * @param {LoginLimiter} deps.passwordLimiter  wrong "current password" tries, by account
 * @param {(user: object) => object} deps.publicUser
 */
export function mountRecovery(app, {
  requireLogin, accounts, recovery, loginLimiter, passwordLimiter, publicUser,
}) {
  // Wrong answers, by account. Tighter than a password's limit and slower to
  // forgive: an answer comes from a much smaller space than a password does.
  const answerLimiter = new LoginLimiter({ maxAttempts: 5, lockoutMinutes: [10, 30, 120, 720] });
  // Asking for somebody's questions, by address: reading them is not a secret
  // worth guarding, but harvesting every account's is not what it is for.
  const asking = new Throttle({ burst: 10, perSecond: 1 / 6 });

  const NO_RECOVERY = {
    error: 'no_recovery',
    message: 'Password recovery is not set up for that account.',
  };

  const locked = (res, retryAfterSec) => {
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec,
      message: 'Too many tries. Wait a while and try again.',
    });
  };

  const nicknameOf = (req) => String(req.body?.nickname ?? '').trim().toLowerCase();

  /** The account in the body, if it has questions; null looks the same as no such account. */
  const withQuestions = (nickname) => {
    const user = accounts.find(nickname);
    return user && recovery.configured(user.id) ? user : null;
  };

  /** Check "current password" for somebody already signed in, counting the wrong ones. */
  const confirmPassword = async (req, res) => {
    const key = `u${req.user.id}`;
    const gate = passwordLimiter.check(key);
    if (!gate.allowed) {
      locked(res, gate.retryAfterSec);
      return false;
    }
    if (await accounts.verify(req.user.nickname, req.body?.current)) {
      passwordLimiter.succeed(key);
      return true;
    }
    const result = passwordLimiter.fail(key);
    if (result.locked) locked(res, result.retryAfterSec);
    else res.status(401).json({ error: 'bad_credentials', message: 'Current password is wrong.' });
    return false;
  };

  // ---- signed in: set, read, clear --------------------------------------------------------

  app.get('/api/accounts/recovery', requireLogin, (req, res) => {
    res.json({
      configured: recovery.configured(req.user.id),
      questions: recovery.questions(req.user.id),
    });
  });

  app.post('/api/accounts/recovery', requireLogin, async (req, res) => {
    if (!(await confirmPassword(req, res))) return undefined;
    const result = await recovery.set(req.user.id, req.body?.items);
    if (!result.ok) {
      const messages = {
        need_three: 'Write three questions and their answers.',
        bad_question: `Each question needs ${QUESTION_MIN} to ${QUESTION_MAX} characters.`,
        repeated_question: 'The three questions must be different.',
        bad_answer: `Each answer needs at least ${ANSWER_MIN} letters or digits.`,
      };
      return res.status(400).json({ error: result.error, message: messages[result.error] });
    }
    return res.json({ configured: true, questions: recovery.questions(req.user.id) });
  });

  app.post('/api/accounts/recovery/clear', requireLogin, async (req, res) => {
    if (!(await confirmPassword(req, res))) return undefined;
    recovery.clear(req.user.id);
    return res.json({ configured: false, questions: [] });
  });

  // ---- signed out: ask, answer, choose ----------------------------------------------------------

  app.post('/api/accounts/recovery/start', (req, res) => {
    const gate = asking.take(req.ip);
    if (!gate.allowed) return locked(res, gate.retryAfterSec);
    const user = withQuestions(nicknameOf(req));
    // No such account and an account with no questions answer alike.
    if (!user) return res.status(404).json(NO_RECOVERY);
    return res.json({ questions: recovery.questions(user.id) });
  });

  app.post('/api/accounts/recovery/verify', async (req, res) => {
    const nickname = nicknameOf(req);
    const user = withQuestions(nickname);
    if (!user) return res.status(404).json(NO_RECOVERY);

    const key = `r${user.id}`;
    const gate = answerLimiter.check(key);
    if (!gate.allowed) return locked(res, gate.retryAfterSec);

    if (!(await recovery.check(user.id, req.body?.answers))) {
      const result = answerLimiter.fail(key);
      if (result.locked) return locked(res, result.retryAfterSec);
      // Which one was wrong is not said.
      return res.status(401).json({
        error: 'wrong_answers',
        attemptsLeft: result.attemptsLeft,
        message: 'One or more answers are wrong.',
      });
    }
    answerLimiter.succeed(key);
    return res.json({ resetToken: recovery.issueToken(user.id) });
  });

  app.post('/api/accounts/recovery/reset', async (req, res) => {
    const userId = recovery.tokenUser(req.body?.resetToken);
    if (!userId) {
      return res.status(401).json({
        error: 'reset_expired',
        message: 'That took too long. Answer the questions again.',
      });
    }
    const result = await accounts.changePassword(userId, req.body?.password);
    if (!result.ok) {
      // The token is kept: a password that was too short is fixed, not started over.
      return res.status(400).json({ error: result.error, message: 'Use at least 6 characters.' });
    }
    recovery.spendToken(req.body?.resetToken);

    const user = accounts.byId(userId);
    // They have shown who they are: whatever locked them out of signing in no
    // longer applies.
    loginLimiter.succeed(user.nickname);
    passwordLimiter.succeed(`u${userId}`);
    const token = accounts.startSession(userId);
    return res.json({ user: publicUser(accounts.find(user.nickname)), token });
  });
}
