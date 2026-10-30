Strong noise suppression (Settings > Voice & video).

rnnoise-sync.js is RNNoise -- a small neural network that tells a voice from the
rest of the sound, made by Jean-Marc Valin (Mozilla / Xiph.Org, BSD-3-Clause) -- built
to WebAssembly by Jitsi (@jitsi/rnnoise-wasm 0.2.1, Apache-2.0, the licence beside this
file; the WebAssembly binary is inlined in the script). It is vendored as it came out of the
package, unmodified.

It runs in the microphone worker (gate-worker.js, through denoise.js), on this computer.
Nothing is sent anywhere. Loaded only when the option is switched on.

RNNoise licence:
  Copyright (c) 2017, Mozilla
  Copyright (c) 2007-2017, Jean-Marc Valin
  Copyright (c) 2005-2017, Xiph.Org Foundation
  Copyright (c) 2003-2004, Mark Borgerding
  Redistribution and use in source and binary forms, with or without modification, are
  permitted provided that the copyright notice, this list of conditions and the following
  disclaimer in the documentation and/or other materials provided with the distribution are
  kept. THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT ANY WARRANTY (full text:
  https://github.com/xiph/rnnoise/blob/main/COPYING).
