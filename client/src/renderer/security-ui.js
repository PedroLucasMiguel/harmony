// The Security page of Settings: changing the password, and the three
// questions that get an account back when the password is forgotten.
//
// The server judges everything -- what makes a usable question, a usable
// answer, a right password -- and this only carries the words. Setting or
// removing the questions and changing the password all ask for the CURRENT
// password: a window left open on somebody's computer must not be enough to
// take the account away from them.

const PASSWORD_MIN = 6;
const SLOTS = [1, 2, 3];
/** The server's codes this page has its own words for. */
const KNOWN_ERRORS = [
  'need_three', 'bad_question', 'repeated_question', 'bad_answer', 'bad_credentials', 'locked_out', 'weak_password',
];

/**
 * @param {object} deps
 * @param {object} deps.harmony
 * @param {(key: string, values?: object) => string} deps.t
 * @param {() => string} deps.server  the server being used
 * @param {() => boolean} deps.signedIn
 * @param {(token: string) => Promise<void>} deps.adoptSession  keeps the new session after a password change
 * @param {(password: string) => Promise<void>} deps.rememberPassword  refreshes a remembered password
 * @param {(node: HTMLElement, text: string, isError?: boolean) => void} deps.note
 */
export function createSecurityUi({ harmony, t, server, signedIn, adoptSession, rememberPassword, note }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    current: $('sec-current'),
    next: $('sec-new'),
    confirm: $('sec-confirm'),
    change: $('sec-change'),
    changeNote: $('sec-change-note'),
    status: $('sec-rec-status'),
    questions: SLOTS.map((n) => $(`sec-q${n}`)),
    answers: SLOTS.map((n) => $(`sec-a${n}`)),
    recCurrent: $('sec-rec-current'),
    save: $('sec-rec-save'),
    clear: $('sec-rec-clear'),
    recNote: $('sec-rec-note'),
  };

  /** The sentence for an error from the server: ours if we have one for its code. */
  const explain = (err) => (KNOWN_ERRORS.includes(err.code) ? t(`security.err_${err.code}`) : err.message);

  const busy = (on) => {
    for (const button of [el.change, el.save, el.clear]) button.disabled = on;
  };

  // ---- the password ----------------------------------------------------------------------

  async function changePassword() {
    note(el.changeNote, '');
    const current = el.current.value;
    const password = el.next.value;
    if (!current || !password) return note(el.changeNote, t('security.fill_everything'), true);
    if (password.length < PASSWORD_MIN) return note(el.changeNote, t('security.too_short'), true);
    if (password !== el.confirm.value) return note(el.changeNote, t('security.passwords_differ'), true);

    busy(true);
    try {
      const result = await harmony.api.changePassword(server(), current, password);
      // Every session of this account ended with the old password, this one
      // included: the server hands back a new one in the same breath.
      await adoptSession(result.token);
      await rememberPassword(password);
      el.current.value = '';
      el.next.value = '';
      el.confirm.value = '';
      note(el.changeNote, t('security.password_changed'));
    } catch (err) {
      note(el.changeNote, explain(err), true);
    } finally {
      busy(false);
    }
  }

  // ---- the questions -----------------------------------------------------------------------

  function paint({ configured, questions }) {
    el.status.textContent = configured ? t('security.recovery_on') : t('security.recovery_off');
    el.status.toggleAttribute('data-on', configured);
    SLOTS.forEach((_, i) => {
      el.questions[i].value = configured ? (questions[i] ?? '') : el.questions[i].value;
      el.answers[i].value = '';
      el.answers[i].placeholder = configured ? t('security.answer_again') : t('security.answer_placeholder');
    });
    el.clear.hidden = !configured;
  }

  /** Drawn each time Settings opens. */
  async function render() {
    note(el.changeNote, '');
    note(el.recNote, '');
    el.recCurrent.value = '';
    if (!signedIn()) return;
    try {
      paint(await harmony.api.recoveryStatus(server()));
    } catch (err) {
      note(el.recNote, explain(err), true);
    }
  }

  async function saveQuestions() {
    note(el.recNote, '');
    const items = SLOTS.map((_, i) => ({ question: el.questions[i].value, answer: el.answers[i].value }));
    if (items.some((item) => !item.question.trim() || !item.answer.trim()) || !el.recCurrent.value) {
      return note(el.recNote, t('security.fill_everything'), true);
    }
    busy(true);
    try {
      paint(await harmony.api.setRecovery(server(), el.recCurrent.value, items));
      el.recCurrent.value = '';
      note(el.recNote, t('security.recovery_saved'));
    } catch (err) {
      note(el.recNote, explain(err), true);
    } finally {
      busy(false);
    }
  }

  async function removeQuestions() {
    note(el.recNote, '');
    if (!el.recCurrent.value) return note(el.recNote, t('security.type_current_password'), true);
    busy(true);
    try {
      await harmony.api.clearRecovery(server(), el.recCurrent.value);
      for (const input of [...el.questions, ...el.answers]) input.value = '';
      paint({ configured: false, questions: [] });
      el.recCurrent.value = '';
      note(el.recNote, t('security.recovery_removed'));
    } catch (err) {
      note(el.recNote, explain(err), true);
    } finally {
      busy(false);
    }
  }

  el.change.addEventListener('click', changePassword);
  el.save.addEventListener('click', saveQuestions);
  el.clear.addEventListener('click', removeQuestions);

  return { render };
}
