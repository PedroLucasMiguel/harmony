// Tiny JSON-file settings store. Keeps the server address and the user's last
// username/quality choice between runs, which matters for the portable build --
// there is no installer to write them for us.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  serverUrl: '',
  username: '',
  // Only used when the server is configured to want one. Stored in the clear in
  // this file, like every other setting -- it is a shared room password, not a
  // credential that protects anything else, and the alternative (retyping it on
  // every launch) is what makes people pick a worse password.
  password: '',
  // The logged-in account's bearer token, kept when "remember me" is ticked.
  //
  // Deliberately the TOKEN and not the account password: it expires on its own,
  // the server can revoke it, and it is useless against any other service the
  // person may have reused that password on. The shared `password` above is a
  // different thing -- a room key, not a personal credential.
  sessionToken: '',
  rememberAccount: true,
  /*
   * Every server this client has connected to, each with ITS OWN credentials:
   * [{ url, password, username, sessionToken, rememberAccount, lastUsed }].
   *
   * The five fields above are the CURRENT server's, and the ones main sends
   * with every request; picking another server copies its profile up into
   * them. Kept apart per server because nothing about an account carries
   * over -- a session token from one server must never be sent to another,
   * and the same person usually has a different nickname on each.
   *
   * No server NAME is stored: it is asked for each time, so a rename shows.
   */
  servers: [],
  /*
   * Open the last server straight away when its saved session is still good,
   * instead of stopping on the account screen. Signing out ends the session, so
   * it is also the way to be asked again.
   */
  autoSignIn: true,
  // Disk budget for cached avatars, attachments and soundpad clips. Evicted
  // least-recently-used first, never touching pinned or soundpad files.
  mediaCacheMb: 512,
  // What to stream at. Empty until somebody picks, which makes the renderer
  // read the old bundled `quality` preset instead if a settings file still
  // has one -- otherwise 1080p at 30 fps.
  resolution: '',
  framerate: 0,
  // 'sharp' keeps resolution and drops frames; 'smooth' does the opposite.
  priority: 'sharp',
  // Last audio input used with a camera or capture card.
  audioInputId: '',
  /*
   * Voice-channel devices, kept apart from audioInputId on purpose.
   *
   * That one is the input paired with a capture card -- console audio, line
   * level, no echo cancellation. A microphone is the opposite of it in every
   * respect, and sharing one setting means picking a sensible microphone
   * silently breaks the capture card you set up last week.
   *
   * Empty means "whatever the system calls default". A specific id is a
   * PREFERENCE, not a requirement: if that device is unplugged the voice
   * falls back to the default and the preference is kept, so plugging the
   * headset back in restores it without anyone touching a menu.
   */
  voiceInputId: '',
  voiceOutputId: '',
  // The webcam used inside a voice channel. Same rule: a preference, not a
  // requirement, so unplugging it falls back to the default and plugging it
  // back in restores it.
  voiceCameraId: '',
  // How the webcam is captured and sent. Resolution is a key of CAMERA_SIZES in
  // the renderer ('360', '480', '720', '1080') or 'native' for the most the
  // camera offers; the framerate is 24, 30, 60, or 0 for native. The default is
  // what the camera always sent: small and light for a call.
  cameraResolution: '360',
  cameraFramerate: 24,
  /*
   * Input volume as a percentage, and the noise gate as a 0-100
   * sensitivity where 0 is off.
   *
   * Percentages rather than a gain and an RMS, so that what is stored is
   * what the sliders show. The RMS the gate actually uses is derived from
   * the sensitivity in the renderer, which keeps the curve in one place
   * and means changing it later does not have to migrate anybody's saved
   * number.
   */
  micGain: 100,
  micSensitivity: 0,
  /*
   * The browser's own processing of the microphone. Off by default: both
   * change the sound of a voice (echo cancellation ducks it whenever
   * anything is playing, noise suppression can clip the ends of words),
   * and are only worth it on speakers or in a noisy room.
   */
  micEchoCancellation: false,
  micNoiseSuppression: false,
  // The join / leave / went-live tones. On, because the whole point of
  // them is to tell you about something you were not looking at.
  voiceSounds: true,
  // Play other members' own join sounds, where they picked one, instead of the
  // ordinary tone. On: the sound is theirs to choose and the room's to hear;
  // this is the switch for the person who would rather not.
  customJoinSounds: true,
  /*
   * Push to talk: the microphone is silent unless this key is held. Off, so
   * nothing changes for anybody who never asks for it. The key is an Electron
   * accelerator as the hotkey recorder writes it ("V", "F13", "Ctrl+Space").
   */
  pushToTalk: false,
  /*
   * Stop watching other people's cameras while Harmony is out of sight
   * (minimised, in the tray, or covered). The relay's biggest bill after the
   * voices is video, and a window nobody can see is not showing it. On: it
   * costs nothing to anybody who is looking, and they come back at once.
   */
  pauseHiddenCameras: true,
  // The channel's streams as one small floating window instead of a stage: off,
  // because it changes where everything is. pipRect remembers where the person
  // left the window and how big they made it ({ x, y, w } in pixels).
  pictureInPicture: false,
  // Pop the picture-in-picture window out of Harmony, over everything else,
  // while Harmony is minimised or hidden, and put it back when it returns.
  pipPopOut: true,
  pipRect: null,
  pushToTalkKey: '',
  /*
   * The colour palette, by name. Purely local: it is never sent anywhere
   * and is not per server, so two people in the same channel can be
   * looking at different colours.
   *
   * A name rather than the colours themselves, so that adjusting a palette
   * in a later build reaches everybody already using it instead of leaving
   * them on a snapshot of how it looked the day they picked it.
   */
  theme: 'midnight',
  /*
   * The four colours of the Custom palette, used when theme is 'custom'.
   * Empty until somebody first picks Custom, which then starts from
   * whatever palette they were on -- a blank editor would be a worse
   * starting point than the colours they were already looking at.
   */
  customTheme: null,
  // The member column on the right. On by default: it is the answer to
  // "is anybody around", which is the question people open the app with.
  showMembers: true,
  /*
   * How loudly soundpad clips play, as a percentage.
   *
   * A number rather than a gain so that what is stored is what the slider
   * shows, and 0 is a genuine value -- `?? 100` would quietly turn a muted
   * soundpad back on, which is the one thing somebody who muted it does not
   * want to happen on the next launch.
   */
  soundpadVolume: 100,
  /*
   * The emoji you reached for last, newest first.
   *
   * Local, like every other preference here: it is about your hands, not
   * about the server. Nobody else's picker should reorder because of what
   * you clicked.
   */
  recentEmoji: [],
  /*
   * How big everything is, as a percentage.
   *
   * 115 rather than 100, because the first draft of this app was sized for
   * a developer sitting two feet from a laptop and everyone else reads it
   * from further away. It is Chromium's own zoom, so it scales the layout
   * as well as the type: icons, avatars, video controls, the lot.
   *
   * Clamped where it is applied rather than here, so a hand-edited
   * settings.json cannot leave somebody with a window they cannot read
   * well enough to fix.
   */
  // The language of the interface: 'auto' follows the system's, or a code from
  // renderer/locales/index.js ('en', 'pt-BR', 'es', ...).
  language: 'auto',
  uiScale: 115,
  /*
   * A sound when somebody writes your name.
   *
   * Separate from voiceSounds, because it is a different question: that
   * one is about a call you are already in, this one is the only thing
   * that will reach you in a channel you are not looking at.
   */
  mentionSound: true,
  /** A card under a link in a message: what the page says about itself, read by the server. */
  linkPreviews: true,
  /*
   * Whether your own camera's tile shows your picture. Remembered because it is
   * a choice about yourself rather than about one call; a screen share's
   * preview is not, and starts hidden every time.
   */
  cameraPreview: false,
  /*
   * How loud every cue is, as a percentage: joins, leaves, streams, mute,
   * mention. 100 is the designed level; up to 200 for a noisy room.
   */
  soundVolume: 100,
  /*
   * Global hotkeys, as Electron accelerators ("Ctrl+Shift+M"). Empty is
   * unbound. Soundpad clips are kept per SERVER, because a clip id is only
   * meaningful on the server that issued it: { [serverUrl]: { [clipId]: accel } }.
   */
  hotkeys: { mute: '', deafen: '' },
  clipHotkeys: {},
  // The update version "Later" was clicked on. That one stops asking; a
  // newer one asks again.
  updateDismissed: '',
  // Whether the "still running in the tray" balloon has been shown. Once.
  trayHintShown: false,
  /*
   * The channel and member columns, in CSS pixels, as last dragged. null is
   * the full width, which is also the widest either may be.
   */
  sideWidth: null,
  membersWidth: null,
  // The list of conversations on the private-messages page, dragged wider or narrower.
  dmListWidth: null,
  /*
   * The login screen's privacy mask: server addresses and names, the
   * username and the server list drawn as dots, like a password. For a
   * screen that is being shared or streamed.
   */
  hideDetails: false,
  // Rolling clip buffer. Off by default: it is memory the user did not ask for.
  clipsEnabled: false,
  // GPU video encoding (NVENC / AMF / Quick Sync). 'auto' leaves Chromium to
  // use it, which it does by default and which is measurably faster; 'off'
  // forces software H.264, for a machine whose driver misbehaves.
  hardwareEncoding: 'auto',
  // Which GPU Harmony runs on where there are two. 'auto' lets Chromium pick
  // (the dedicated one); 'integrated' keeps Harmony off the GPU a game is
  // using. See gpu.js for the measurement behind this.
  gpuPreference: 'auto',
  /*
   * What is behind you on the camera. Done on this machine, before a frame is
   * sent; see renderer/background.js. The picture, when there is one, is not
   * here -- a GIF can be megabytes -- but in the renderer's own storage, and
   * only its name is kept in this file.
   *
   *   mode: 'off' | 'blur' | 'color' | 'gradient' | 'image'
   */
  cameraBackground: {
    mode: 'off',
    blur: 60,
    color: '#1f6feb',
    gradient: { from: '#5b8cff', to: '#9a7bff', angle: 135 },
    imageName: '',
  },
  // What to do when a window is shared but per-application audio is not
  // available (non-Windows, or the native module is missing).
  //   'silent' -- send no audio, never leak other apps' sound
  //   'system' -- fall back to whole-system audio
  windowAudioFallback: 'silent',
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  cache = { ...read(), ...patch };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn('[settings] could not persist:', err.message);
  }
  return cache;
}

module.exports = { read, write, DEFAULTS };
