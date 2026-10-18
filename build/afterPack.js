// Wird von electron-builder nach dem Packen aufgerufen.
// Auf dem Mac signieren wir die App "ad hoc" (ohne Apple-Entwicklerkonto), damit sie
// auf Apple-Silicon-Macs überhaupt startet. Mit einem echten Zertifikat (CSC_LINK) wird
// dieser Schritt übersprungen, weil electron-builder dann selbst signiert.
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/** Entfernt die ONNX-Runtime-Binaries der anderen Systeme/Architekturen (spart ~100 MB pro Installer). */
function pruneOnnxRuntime(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const arch = ARCH_NAMES[context.arch] || 'x64';
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const binRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin');
  if (!fs.existsSync(binRoot)) return;
  // Je nach Version liegen die Binaries unter bin/napi-v3 oder bin/napi-v6
  for (const napi of fs.readdirSync(binRoot)) {
    const bin = path.join(binRoot, napi);
    if (!fs.statSync(bin).isDirectory()) continue;
    for (const p of fs.readdirSync(bin)) {
      const pDir = path.join(bin, p);
      if (!fs.statSync(pDir).isDirectory()) continue;
      if (p !== platform) { fs.rmSync(pDir, { recursive: true, force: true }); console.log(`  • entfernt onnxruntime ${napi}/${p}`); continue; }
      for (const a of fs.readdirSync(pDir)) {
        if (a !== arch && arch !== 'universal') { fs.rmSync(path.join(pDir, a), { recursive: true, force: true }); console.log(`  • entfernt onnxruntime ${napi}/${p}/${a}`); }
      }
    }
  }
}

exports.default = async function afterPack(context) {
  try { pruneOnnxRuntime(context); } catch (err) { console.warn('  • onnxruntime-Bereinigung fehlgeschlagen:', err.message); }
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
