#!/usr/bin/env bash
# Typprüfung OHNE npm-Zugang (z. B. in der Cloud-Umgebung): nutzt ein global installiertes TypeScript
# und holt die nötigen Typdefinitionen per git (React 18 von DefinitelyTyped, csstype, zustand, zundo).
# Electron/electron-log/electron-updater werden durch einen kleinen Stub ersetzt (electron-stub.d.ts).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
T="${PANOCUT_TYPES_DIR:-$HOME/_types}"
TSC="${TSC:-$(command -v tsc || echo /opt/npm-tools/node_modules/typescript/bin/tsc)}"
mkdir -p "$T"
if [ ! -d "$T/definitelytyped/types/react/v18" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --sparse https://github.com/DefinitelyTyped/definitelytyped "$T/definitelytyped"
  git -C "$T/definitelytyped" sparse-checkout set types/react types/react-dom types/prop-types
fi
[ -d "$T/csstype" ] || git clone --depth 1 https://github.com/frenic/csstype "$T/csstype"
[ -d "$T/zustand" ] || git clone --depth 1 https://github.com/pmndrs/zustand "$T/zustand"
[ -d "$T/zundo" ] || git clone --depth 1 https://github.com/charkour/zundo "$T/zundo"
# three.js-Typen (gleiche Version wie in package.json)
if [ ! -d "$T/three-types/types/three" ]; then
  git -c advice.detachedHead=false clone --depth 1 --branch r170 --filter=blob:none --sparse https://github.com/three-types/three-ts-types "$T/three-types"
  git -C "$T/three-types" sparse-checkout set types/three
fi
DT="$T/definitelytyped/types"
cat > "$T/tsconfig.renderer.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "strict": true, "noFallthroughCasesInSwitch": true, "skipLibCheck": true, "esModuleInterop": true,
    "resolveJsonModule": true, "isolatedModules": true, "allowImportingTsExtensions": true, "noEmit": true, "types": [], "typeRoots": [],
    "paths": {
      "@shared/*": ["$ROOT/src/shared/*"],
      "react": ["$DT/react/v18/index.d.ts"], "react/jsx-runtime": ["$DT/react/v18/jsx-runtime.d.ts"],
      "react-dom": ["$DT/react-dom/v18/index.d.ts"], "react-dom/client": ["$DT/react-dom/v18/client.d.ts"],
      "csstype": ["$T/csstype/index.d.ts"], "prop-types": ["$DT/prop-types/index.d.ts"],
      "zustand": ["$T/zustand/src/index.ts"], "zustand/*": ["$T/zustand/src/*"], "zundo": ["$T/zundo/src/index.ts"],
      "three": ["$T/three-types/types/three/index.d.ts"], "three/addons/*": ["$T/three-types/types/three/examples/jsm/*"]
    }
  },
  "files": ["$HERE/electron-stub.d.ts"],
  "include": ["$ROOT/src/renderer", "$ROOT/src/shared"]
}
JSON
cat > "$T/tsconfig.main.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM"], "module": "CommonJS", "moduleResolution": "Node", "ignoreDeprecations": "6.0",
    "strict": true, "skipLibCheck": true, "esModuleInterop": true, "resolveJsonModule": true, "noEmit": true,
    "types": ["node"], "typeRoots": ["${NODE_TYPES:-/opt/npm-tools/node_modules/@types}"],
    "paths": { "@shared/*": ["$ROOT/src/shared/*"] }
  },
  "files": ["$HERE/electron-stub.d.ts"],
  "include": ["$ROOT/src/main", "$ROOT/src/shared"]
}
JSON
echo "== Oberfläche"; node "$TSC" -p "$T/tsconfig.renderer.json"
echo "== Hauptprozess"; node "$TSC" -p "$T/tsconfig.main.json"
echo "== OK"
