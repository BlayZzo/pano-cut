// Wird von electron-builder nach dem Packen aufgerufen.
// Auf dem Mac signieren wir die App "ad hoc" (ohne Apple-Entwicklerkonto), damit sie
// auf Apple-Silicon-Macs überhaupt startet. Mit einem echten Zertifikat (CSC_LINK) wird
// dieser Schritt übersprungen, weil electron-builder dann selbst signiert.
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc Signatur für ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  } catch (err) {
    console.warn('  • ad-hoc Signatur fehlgeschlagen:', err.message);
  }
};
