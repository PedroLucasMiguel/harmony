// The little menu behind the microphone and headphone buttons: which device, and how loud.
//
// Pressing the arrow beside either button opens it, and so does right-clicking the button itself. The
// microphone's is the input device and the input volume; the headphones' is the output device and the master
// volume. Both end with a way into the full voice settings.
//
// It only draws. Which devices there are, what is chosen and what a volume does are app.js's to say, through
// what `open()` is handed; nothing here reads or writes a setting.

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * @param {object} deps
 * @param {HTMLElement} deps.root  the menu's element (`.peer-menu`, so it looks like the others)
 * @param {(key: string, params?: object) => string} deps.t
 * @param {(slider: HTMLInputElement, label: HTMLElement, percent: number) => void} deps.paintVolume  the fill, the 100% tick and the number
 * @param {() => void} deps.onSettings  "Voice settings" was pressed
 */
export function createAudioMenu({
  root, t, paintVolume, onSettings,
}) {
  /** What is open: its kind, the button it hangs from, and what it was handed. */
  let current = null;

  const close = () => {
    if (!current) return;
    root.hidden = true;
    root.replaceChildren();
    current.trigger?.removeAttribute('aria-expanded');
    current = null;
  };

  /** Above the button it came from when there is room (the buttons are at the foot of the window), else below. */
  function place(anchor) {
    root.style.left = '-9999px';
    root.style.top = '0px';
    root.hidden = false;
    const box = anchor.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(box.left, window.innerWidth - size.width - margin));
    const above = box.top - gap - size.height;
    const top = above >= margin ? above : Math.min(box.bottom + gap, Math.max(margin, window.innerHeight - size.height - margin));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  /**
   * @param {object} spec
   * @param {'input'|'output'} spec.kind
   * @param {HTMLElement} spec.anchor  what it is placed against
   * @param {HTMLElement} [spec.trigger]  the arrow that opened it, which closes it when pressed again (a right-click has none)
   * @param {{id: string, name: string}[]} spec.devices  '' is the system's own
   * @param {string} spec.selected  the id of the one in use
   * @param {(id: string) => void} spec.onPick
   * @param {{value: number, max: number, onInput: (percent: number) => void, onChange: (percent: number) => void}} spec.volume
   */
  function open(spec) {
    // The arrow that opened it, pressed again, closes it.
    if (current && spec.trigger && current.trigger === spec.trigger) {
      close();
      return;
    }
    close();
    const { kind } = spec;
    current = { kind, trigger: spec.trigger ?? null };
    spec.trigger?.setAttribute('aria-expanded', 'true');
    root.dataset.kind = kind;
    root.classList.add('audio-menu');
    root.setAttribute('role', 'menu');
    root.setAttribute('aria-label', kind === 'input' ? t('audio_menu.input_title') : t('audio_menu.output_title'));

    const body = make('div', 'peer-menu-body');

    // The devices, one row each; the one in use has the dot.
    body.append(make('div', 'audio-menu-title', kind === 'input' ? t('audio_menu.input_device') : t('audio_menu.output_device')));
    const list = make('div', 'audio-menu-devices');
    list.setAttribute('role', 'group');
    const rows = spec.devices.map((device) => {
      const row = make('button', 'ghost menu-item audio-menu-device');
      row.type = 'button';
      row.dataset.icon = kind === 'input' ? 'microphone' : 'speaker-high';
      row.dataset.device = device.id;
      row.setAttribute('role', 'menuitemradio');
      row.title = device.name;
      row.append(make('span', 'audio-menu-name', device.name), make('span', 'audio-menu-radio'));
      row.addEventListener('click', () => {
        for (const other of rows) other.setAttribute('aria-checked', String(other === row));
        spec.onPick(device.id);
      });
      return row;
    });
    const chosen = rows.some((row) => row.dataset.device === spec.selected) ? spec.selected : '';
    for (const row of rows) row.setAttribute('aria-checked', String(row.dataset.device === chosen));
    list.append(...rows);
    body.append(list, make('hr'));

    // The volume.
    body.append(make('div', 'audio-menu-title', kind === 'input' ? t('audio_menu.input_volume') : t('audio_menu.output_volume')));
    const line = make('div', 'peer-menu-row audio-menu-volume-row');
    const slider = make('input', 'audio-menu-volume');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(spec.volume.max);
    slider.step = '1';
    slider.setAttribute('aria-label', kind === 'input' ? t('audio_menu.input_volume') : t('audio_menu.output_volume'));
    const label = make('output', 'volume-value');
    label.setAttribute('for', 'audio-menu-volume');
    slider.id = 'audio-menu-volume';
    line.append(slider, label);
    paintVolume(slider, label, spec.volume.value);
    slider.addEventListener('input', () => {
      const percent = Number(slider.value);
      paintVolume(slider, label, percent);
      spec.volume.onInput(percent);
    });
    slider.addEventListener('change', () => spec.volume.onChange(Number(slider.value)));
    body.append(line, make('hr'));

    const settings = make('button', 'ghost menu-item audio-menu-settings', t('audio_menu.voice_settings'));
    settings.type = 'button';
    settings.dataset.icon = 'gear-six';
    settings.addEventListener('click', () => {
      close();
      onSettings();
    });
    body.append(settings);

    root.replaceChildren(body);
    place(spec.anchor);
  }

  // Closed by a press anywhere else, by Escape, and by the window losing the focus or changing size.
  document.addEventListener('pointerdown', (event) => {
    if (!current || root.contains(event.target)) return;
    // The arrow it hangs from toggles it itself.
    if (current.trigger?.contains(event.target) && event.button === 0) return;
    close();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  return {
    open,
    close,
    get isOpen() { return Boolean(current); },
    get kind() { return current?.kind ?? null; },
  };
}
