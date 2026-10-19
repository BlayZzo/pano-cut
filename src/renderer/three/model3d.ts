// 3D-Modelle (glTF/GLB, OBJ, FBX, STL) mit three.js darstellen und Bild für Bild mit Transparenz rendern.
// three.js wird erst geladen, wenn es gebraucht wird (hält den Programmstart schlank).
import type * as THREE from 'three';
import type { Model3DSpec } from '@shared/types';
import { modelPose } from '@shared/model3d';

type ThreeModule = typeof import('three');
interface Libs {
  T: ThreeModule;
  GLTFLoader: typeof import('three/addons/loaders/GLTFLoader.js').GLTFLoader;
  DRACOLoader: typeof import('three/addons/loaders/DRACOLoader.js').DRACOLoader;
  MeshoptDecoder: unknown;   // Typen kommen aus dem Paket „meshoptimizer“ – hier reicht „unbekannt“
  OBJLoader: typeof import('three/addons/loaders/OBJLoader.js').OBJLoader;
  FBXLoader: typeof import('three/addons/loaders/FBXLoader.js').FBXLoader;
  STLLoader: typeof import('three/addons/loaders/STLLoader.js').STLLoader;
}

let libsP: Promise<Libs> | null = null;
function libs(): Promise<Libs> {
  if (!libsP) {
    libsP = (async () => {
      const [T, g, o, f, s, d, mo] = await Promise.all([
        import('three'),
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/loaders/OBJLoader.js'),
        import('three/addons/loaders/FBXLoader.js'),
        import('three/addons/loaders/STLLoader.js'),
        import('three/addons/loaders/DRACOLoader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ]);
      return { T, GLTFLoader: g.GLTFLoader, OBJLoader: o.OBJLoader, FBXLoader: f.FBXLoader, STLLoader: s.STLLoader, DRACOLoader: d.DRACOLoader, MeshoptDecoder: (mo as unknown as { MeshoptDecoder: unknown }).MeshoptDecoder };
    })();
  }
  return libsP;
}

const url = (p: string) => window.panocut.toMediaUrl(p);

/** Ort des Draco-Dekoders (komprimierte glTF-Modelle). Im fertigen Programm über pcmedia:, da file:// kein fetch erlaubt. */
function dracoPath(): string {
  const base = new URL('./draco/', location.href);
  if (base.protocol !== 'file:') return base.href;
  let p = decodeURIComponent(base.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);   // Windows: /C:/… → C:/…
  return url(p.replace(/\/$/, '')) + '/';
}

let draco: InstanceType<Libs['DRACOLoader']> | null = null;

export interface LoadedModel { object: THREE.Object3D; clips: THREE.AnimationClip[]; hasMaterial: boolean; triangles: number }

/** Lädt eine 3D-Datei. Mehrteilige glTF-Dateien holen ihre .bin/Texturen relativ zum Speicherort. */
export async function loadModelFile(file: string, format: Model3DSpec['format']): Promise<LoadedModel> {
  const L = await libs();
  const T = L.T;
  let object: THREE.Object3D;
  let clips: THREE.AnimationClip[] = [];
  let hasMaterial = true;
  if (format === 'glb' || format === 'gltf') {
    const loader = new L.GLTFLoader();
    if (!draco) { draco = new L.DRACOLoader(); draco.setDecoderPath(dracoPath()); }
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(L.MeshoptDecoder as Parameters<typeof loader.setMeshoptDecoder>[0]);
    const gltf = await loader.loadAsync(url(file));
    object = gltf.scene;
    clips = gltf.animations ?? [];
  } else if (format === 'fbx') {
    object = await new L.FBXLoader().loadAsync(url(file));
    clips = (object as THREE.Object3D & { animations?: THREE.AnimationClip[] }).animations ?? [];
  } else if (format === 'obj') {
    object = await new L.OBJLoader().loadAsync(url(file));
    // OBJ ohne .mtl hat nur ein Standard-Material → eigene Farbe benutzen
    hasMaterial = false;
  } else {
    const geo = await new L.STLLoader().loadAsync(url(file));
    geo.computeVertexNormals();
    object = new T.Mesh(geo, new T.MeshStandardMaterial({ color: 0xb8bcc4 }));
    hasMaterial = false;
  }
  let triangles = 0;
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      const g = m.geometry as THREE.BufferGeometry;
      triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    }
  });
  return { object, clips, hasMaterial, triangles: Math.round(triangles) };
}

/** Szene mit Modell, Licht und Schattenboden. Rendert ins eigene Canvas (Vorschau) oder Bild für Bild (Export). */
export class ModelStage {
  readonly canvas: HTMLCanvasElement;
  private L!: Libs;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private holder!: THREE.Group;      // nimmt Bewegung/Drehung auf
  private model: LoadedModel | null = null;
  private loadedKey = '';
  private mixer: THREE.AnimationMixer | null = null;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ground!: THREE.Mesh;
  private radius = 1;
  private height = 1;

  private constructor() {
    this.canvas = document.createElement('canvas');
  }

  static async create(): Promise<ModelStage> {
    const s = new ModelStage();
    await s.init();
    return s;
  }

  private async init(): Promise<void> {
    this.L = await libs();
    const T = this.L.T;
    // Gerades Alpha (nicht vormultipliziert), damit die Kanten im Video sauber sind
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(30, 1, 0.05, 200);
    this.holder = new T.Group();
    this.scene.add(this.holder);
    this.hemi = new T.HemisphereLight(0xffffff, 0x404040, 0.8);
    this.scene.add(this.hemi);
    this.sun = new T.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // Boden, der nur den Schatten zeigt (sonst durchsichtig)
    this.ground = new T.Mesh(new T.PlaneGeometry(40, 40), new T.ShadowMaterial({ opacity: 0.5, transparent: true }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  get info(): { triangles: number; clips: string[] } | null {
    return this.model ? { triangles: this.model.triangles, clips: this.model.clips.map((c, i) => c.name || `Animation ${i + 1}`) } : null;
  }

  /** Modell laden (nur wenn sich die Datei geändert hat) und auf Größe 2 normieren, Boden bei y = 0. */
  async load(spec: Model3DSpec): Promise<void> {
    const key = `${spec.file}|${spec.format}`;
    if (key === this.loadedKey && this.model) return;
    const T = this.L.T;
    if (this.model) this.holder.remove(this.model.object);
    this.mixer = null;
    const m = await loadModelFile(spec.file, spec.format);
    // Modelle aus CAD/Druck (STL) liegen oft mit Z nach oben → aufrichten, wenn sie flach und hoch sind
    if (spec.format === 'stl') {
      const pre = new T.Box3().setFromObject(m.object).getSize(new T.Vector3());
      if (pre.z > pre.y * 1.2) m.object.rotation.x = -Math.PI / 2;
    }
    // Größe im eigenen Koordinatensystem messen (noch nicht in der Szene → keine fremde Drehung)
    const wrap = new T.Group();
    wrap.add(m.object);
    const box = new T.Box3().setFromObject(m.object);
    const size = box.getSize(new T.Vector3());
    const center = box.getCenter(new T.Vector3());
    const k = 2 / Math.max(1e-6, size.x, size.y, size.z);
    m.object.position.sub(center);
    m.object.position.y += size.y / 2;           // auf den Boden stellen (Unterkante bei y = 0)
    wrap.scale.setScalar(k);
    this.holder.add(wrap);
    this.model = { ...m, object: wrap };
    this.loadedKey = key;
    this.radius = Math.max(0.5, (Math.hypot(size.x, size.y, size.z) * k) / 2);
    this.height = size.y * k;
    if (m.clips.length) this.mixer = new T.AnimationMixer(m.object);
  }

  /** Licht, Material und Kamera nach den Einstellungen setzen. */
  private applySpec(spec: Model3DSpec, w: number, h: number): void {
    const T = this.L.T;
    this.renderer.toneMappingExposure = Math.pow(2, spec.exposure);
    this.hemi.intensity = spec.ambient;
    this.sun.intensity = spec.lightStrength;
    this.sun.color.set(spec.lightColor);
    const ly = (spec.lightYaw * Math.PI) / 180, lp = (spec.lightPitch * Math.PI) / 180;
    const d = 8;
    this.sun.position.set(Math.sin(ly) * Math.cos(lp) * d, Math.sin(lp) * d, Math.cos(ly) * Math.cos(lp) * d);
    this.sun.target.position.set(0, 0.5, 0);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3; sc.near = 0.5; sc.far = 20;
    sc.updateProjectionMatrix();
    (this.ground.material as THREE.ShadowMaterial).opacity = spec.shadow;
    this.ground.visible = spec.shadow > 0.01;
    // Modelle ohne eigenes Material: Farbe und Metall aus den Einstellungen
    if (this.model && !this.model.hasMaterial) {
      this.model.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) mesh.material = new T.MeshStandardMaterial();
        const mm = mesh.material as THREE.MeshStandardMaterial;
        mm.color.set(spec.color ?? '#b8bcc4');
        mm.metalness = spec.metal;
        mm.roughness = 0.45 - 0.25 * spec.metal;
      });
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Bild zur Zeit t zeichnen. */
  draw(spec: Model3DSpec, t: number, w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
    this.applySpec(spec, w, h);
    const p = modelPose(spec, t);
    const rad = Math.PI / 180;
    this.holder.rotation.set(0, p.yaw * rad, p.roll * rad);
    this.holder.position.set(p.x, p.y, p.z);
    this.holder.scale.setScalar(p.scale);
    if (this.mixer && this.model && spec.animation === 'embedded') {
      const clip = this.model.clips[Math.min(this.model.clips.length - 1, Math.max(0, spec.clipIndex))];
      this.mixer.stopAllAction();
      const action = this.mixer.clipAction(clip);
      action.play();
      this.mixer.setTime((t * spec.speed) % Math.max(0.001, clip.duration));
    }
    // Kamera: Blick von schräg oben auf das Modell, Abstand so, dass es gut ins Bild passt
    const fov = this.camera.fov * rad;
    const fit = this.radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2) * 1.08;
    const orbit = (p.camOrbit) * rad, pitch = spec.pitch * rad;
    const target = new this.L.T.Vector3(0, this.height / 2, 0);
    this.camera.position.set(Math.sin(orbit) * Math.cos(pitch) * fit, target.y + Math.sin(pitch) * fit, Math.cos(orbit) * Math.cos(pitch) * fit);
    this.camera.lookAt(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Bild als RGBA (gerades Alpha, Zeilen von unten nach oben – wie WebGL; der Kodierer dreht es). */
  readPixels(w: number, h: number): Uint8Array {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Kanten der Kantenglättung sind vormultipliziert (gegen durchsichtiges Schwarz gemischt) → zurückrechnen
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a > 0 && a < 255) {
        const k = 255 / a;
        px[i] = Math.min(255, px[i] * k); px[i + 1] = Math.min(255, px[i + 1] * k); px[i + 2] = Math.min(255, px[i + 2] * k);
      }
    }
    return px;
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
