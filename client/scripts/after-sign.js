// Re-signs the macOS app with the release certificate, when there is one.
//
// electron-builder signs ad-hoc ("-" in electron-builder.yml), which has no
// identity: every build is a different app to macOS, so permissions are asked
// for again after each update and Squirrel.Mac will not swap one build for
// the next. When the build machine has the project's certificate in a
// keychain (scripts/mac-signing-keychain.sh, which the release workflow runs),
// this replaces that signature with one from the certificate, and the app's
// designated requirement becomes "signed by this certificate" -- the same for
// every release. See scripts/make-mac-signing-cert.sh.
//
// Without the certificate nothing changes: the ad-hoc build is still made,
// and the app falls back to sending people to the download page
// (src/main/updater.js).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function codesign(args, keychain) {
  const result = spawnSync('codesign', [...args, ...(keychain ? ['--keychain', keychain] : [])], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`codesign ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
}

exports.default = async function afterSign({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== 'darwin') return;

  const hash = process.env.HARMONY_MAC_SIGN_HASH;
  const keychain = process.env.HARMONY_MAC_KEYCHAIN;
  if (!hash) {
    console.log(
      '  • no release certificate (HARMONY_MAC_SIGN_HASH): the app stays ad-hoc signed and will not update itself',
    );
    return;
  }

  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);

  // The audio helper is a program in Resources/, which --deep does not
  // treat as nested code. Sign it first, so the app's seal covers the final one.
  const helper = path.join(app, 'Contents', 'Resources', 'harmony-audio-capture');
  if (fs.existsSync(helper)) codesign(['--force', '--sign', hash, helper], keychain);

  console.log(`  • signing ${path.basename(app)} with the release certificate ${hash.slice(0, 8)}…`);
  codesign(['--force', '--deep', '--sign', hash, app], keychain);
  codesign(['--verify', '--deep', '--strict', app]);

  const requirement = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  const text = `${requirement.stdout}${requirement.stderr}`;
  if (/cdhash/.test(text)) {
    throw new Error(`The app is still ad-hoc signed after signing:\n${text}`);
  }
};
