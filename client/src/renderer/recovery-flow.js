// Getting back into an account from the sign-in screen: the three questions the
// person wrote while signed in, asked one at a time.
//
// Written against the app's own one-question dialog (ask) rather than a dialog
// of its own: each step IS a question and an answer. The server does the
// judging -- including the normalising, so "São Paulo" and "sao  paulo" are the
// same answer -- and never says which answer was wrong, so nothing here
// could either.

/** Whatever the person typed for the account, as the rest of the app names accounts. */
const nameOf = (raw) => String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');

/** Short of this the server says no; saying so here saves a trip. */
const PASSWORD_MIN = 6;

/**
 * @param {object} deps
 * @param {(spec: object) => Promise<Record<string, string> | null>} deps.ask
 * @param {object} deps.harmony  the bridge
 * @param {(key: string, values?: object) => string} deps.t
 * @param {string} deps.server
 * @param {string} [deps.nickname]  what was already typed on the sign-in screen
 * @returns {Promise<{user: object, token: string, password: string, nickname: string} | null>}
 *   the signed-in account, or null if it was given up on or could not be done
 */
export async function recoverAccount({ ask, harmony, t, server, nickname = '' }) {
  const title = t('security.forgot_title');
  /** A message that wants reading: in the dialog, not a toast that goes. */
  const inform = (text) => ask({ title, text, okLabel: t('security.close'), fields: [] });

  const named = await ask({
    title,
    text: t('security.forgot_intro'),
    okLabel: t('security.forgot_continue'),
    fields: [{ name: 'nickname', label: t('account_fields.username'), value: nickname, required: true }],
  });
  if (!named) return null;
  const who = nameOf(named.nickname);
  if (!who) return null;

  let questions;
  try {
    ({ questions } = await harmony.api.recoveryStart(server, who));
  } catch (err) {
    await inform(err.code === 'no_recovery' ? t('security.forgot_none', { name: who }) : err.message);
    return null;
  }

  // The answers, a question at a time -- and from the first again if they were
  // not right, since which of them was wrong is not something to be told.
  let resetToken = null;
  while (!resetToken) {
    const answers = [];
    for (let i = 0; i < questions.length; i += 1) {
      const last = i === questions.length - 1;
      const reply = await ask({
        title: t('security.forgot_question_of', { n: i + 1, total: questions.length }),
        text: questions[i],
        okLabel: last ? t('security.forgot_check') : t('security.forgot_next'),
        fields: [{ name: 'answer', label: t('security.answer'), required: true }],
      });
      if (!reply) return null;
      answers.push(reply.answer);
    }
    try {
      ({ resetToken } = await harmony.api.recoveryVerify(server, who, answers));
    } catch (err) {
      if (err.code === 'wrong_answers') {
        await inform(t('security.forgot_wrong'));
      } else {
        await inform(err.code === 'locked_out' ? t('security.forgot_locked') : err.message);
        return null;
      }
    }
  }

  // Right. A new password, asked until it is a usable one.
  let problem = t('security.forgot_right');
  for (;;) {
    const reply = await ask({
      title,
      text: problem,
      okLabel: t('security.forgot_save'),
      fields: [
        { name: 'password', label: t('security.new_password'), type: 'password', required: true },
        { name: 'confirm', label: t('security.confirm_password'), type: 'password', required: true },
      ],
    });
    if (!reply) return null;
    if (reply.password.length < PASSWORD_MIN) {
      problem = t('security.too_short');
      continue;
    }
    if (reply.password !== reply.confirm) {
      problem = t('security.passwords_differ');
      continue;
    }
    try {
      const result = await harmony.api.recoveryReset(server, resetToken, reply.password);
      return { ...result, password: reply.password, nickname: who };
    } catch (err) {
      if (err.code === 'weak_password') {
        problem = t('security.too_short');
        continue;
      }
      await inform(err.code === 'reset_expired' ? t('security.forgot_expired') : err.message);
      return null;
    }
  }
}
