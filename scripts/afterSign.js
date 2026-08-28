'use strict';
/**
 * Notarize and staple the .app, between signing it and wrapping it in a dmg.
 *
 * Stapling only the dmg leaves the app itself ticketless: it then validates
 * by asking Apple's servers, which is fine until someone opens it for the
 * first time on a Mac that is offline. A stapled app carries its own proof.
 *
 * Credentials never appear here — only the NAME of a keychain profile the
 * user created with `notarytool store-credentials`. With no profile stored,
 * this is a no-op, so a build without credentials still succeeds and simply
 * produces an un-notarized app.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const PROFILE = process.env.NOTARY_PROFILE || 'limen-notary';

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.NOTARIZE === '0') {
    console.log('  • notarization skipped  reason=NOTARIZE=0');
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', timeout: 30 * 60 * 1000 });

  try {
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], { stdio: 'ignore' });
  } catch (_) {
    console.log(`  • notarization skipped  reason=no keychain profile "${PROFILE}"`);
    return;
  }

  // notarytool takes an archive, not a bundle. ditto --keepParent preserves
  // the .app wrapper, which is what the service expects to unpack.
  const zip = `${app}.zip`;
  console.log(`  • notarizing app  file=${app}`);
  run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('rm', ['-f', zip]);
  console.log('  • app notarized and stapled');
};
