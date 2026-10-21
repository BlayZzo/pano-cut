import type { StitchSettings } from '@shared/types';
import { blendWidth, COVER_FADE, coverHalf, eulerFromMatrix, lensModel, mul3 } from '@shared/stitchModel';
import { escapeFilterPath } from './fonts';
import { MAP_H, MAP_W } from './seamFlow';
import { panoMatrix } from '@shared/pano';

let labelSeq = 0;

/** Braucht das Zusammensetzen das genauere Verfahren (weiche Naht, Kameradaten, Farbausgleich)? */
function advanced(stitch: StitchSettings): boolean {
  return blendWidth(stitch) > 0 || !!stitch.lens;
}

/**
 * FFmpeg-Filterkette, die ein 360°-Rohvideo in ein Equirectangular-Bild verwandelt.
 * `inputs` sind die Eingangs-Labels (ein Label bei Side-by-Side, zwei bei zwei Streams).
 * Rückgabe ist die Filterkette OHNE Ausgangs-Label.
 */
export function stitchChain(stitch: StitchSettings, inputs: string[], outW?: number, outH?: number, deep = false, seamMap?: string): string {
  if (stitch.mode !== 'equirect' && outW && outH && (advanced(stitch) || seamMap)) return lensStitchChain(stitch, inputs, outW, outH, deep, seamMap);
  const size = outW && outH ? `:w=${outW}:h=${outH}` : '';
  const rot = `:yaw=${f(stitch.yaw)}:pitch=${f(stitch.pitch)}:roll=${f(stitch.roll)}`;
  const fov = `:ih_fov=${f(stitch.fov)}:iv_fov=${f(stitch.fov)}`;
  switch (stitch.mode) {
    case 'dualfisheye-2streams':
      return `${inputs[0]}${inputs[1]}hstack,v360=input=dfisheye:output=equirect${fov}${rot}${size}`;
    case 'dualfisheye-sbs':
      return `${inputs[0]}v360=input=dfisheye:output=equirect${fov}${rot}${size}`;
    case 'equirect':
    default: {
      const needsRot = Math.abs(stitch.yaw) + Math.abs(stitch.pitch) + Math.abs(stitch.roll) > 1e-6;
      if (!needsRot && !size) return `${inputs[0]}null`;
      return `${inputs[0]}v360=input=equirect:output=equirect${rot}${size}`;
    }
  }
}

/**
 * Genaues Zusammensetzen (gleiche Mathematik wie die Vorschau, shared/stitchModel.ts): jede Linse einzeln mit v360
 * (Mittelpunkt per Zuschnitt, eigenes Sichtfeld und Drehung, Farbe), dann weiche Naht per maskedmerge.
 * Die Maske ist EIN Bild (einmal per geq berechnet); maskedmerge wiederholt das letzte Maskenbild von selbst.
 */
function lensStitchChain(stitch: StitchSettings, inputs: string[], W: number, H: number, deep: boolean, seamMap?: string): string {
  const id = `st${++labelSeq}`;
  const two = stitch.mode === 'dualfisheye-2streams';
  const head = two ? `${inputs[0]}${inputs[1]}hstack,` : `${inputs[0]}`;
  // In YUV rechnen (halb so viele Bildpunkte wie RGB); die Maske wird direkt in YUV erzeugt (alle Ebenen = Gewicht)
  const fmt = deep ? 'yuv420p10le' : 'yuv420p';
  const max = deep ? 1023 : 255;
  const g = lensModel({ ...stitch, lens: undefined }, 1).matrix; // = Grund-Ausrichtung
  const identity = Math.abs(stitch.yaw) + Math.abs(stitch.pitch) + Math.abs(stitch.roll) < 1e-6;
  const B = blendWidth(stitch);
  const cover = coverHalf(stitch);
  // Schnell: ohne Grund-Drehung berechnet jede Linse nur ihren Teil des Panoramas (Breite wp, Vielfaches von 4)
  const wp = Math.min(W, Math.ceil((W * (2 * cover + 1)) / 360 / 4) * 4);
  const partial = identity && W % 4 === 0 && H % 2 === 0 && wp < W;
  const lens = (i: 0 | 1) => {
    const m = lensModel(stitch, i);
    const parts = [
      `crop=w=iw/2:h=ih:x=${i === 0 ? 0 : 'iw/2'}:y=0`,
      `crop=w=iw*${f(m.crop.w, 6)}:h=ih*${f(m.crop.h, 6)}:x=iw*${f(m.crop.x, 6)}:y=ih*${f(m.crop.y, 6)}`,
    ];
    // Helligkeit: gleichmäßiger Anteil direkt in YUV (exakt und schnell), nur ein deutlicher Farbstich über RGB
    const gm = (m.gain[0] + m.gain[1] + m.gain[2]) / 3;
    if (Math.abs(gm - 1) > 1e-4) {
      const yo = deep ? 64 : 16, co = deep ? 512 : 128;
      parts.push(`lutyuv=y='clip((val-${yo})*${f(gm, 5)}+${yo},minval,maxval)':u='clip((val-${co})*${f(gm, 5)}+${co},minval,maxval)':v='clip((val-${co})*${f(gm, 5)}+${co},minval,maxval)'`);
    }
    const res = m.gain.map((x) => x / gm);
    if (res.some((x) => Math.abs(x - 1) > 0.015)) parts.push(`colorchannelmixer=rr=${f(res[0], 5)}:gg=${f(res[1], 5)}:bb=${f(res[2], 5)}`, `format=${fmt}`);
    // Teilbild: hintere Linse um 180° gedreht ausgeben (Mitte = Rückseite), dann unten wieder an die Ränder legen
    const e = partial && i === 0 ? eulerFromMatrix(mul3(m.matrix, panoMatrix(180, 0, 0))) : m.euler;
    const fovs = partial ? `:h_fov=${f((360 * wp) / W, 6)}:v_fov=180:w=${wp}:h=${H}` : `:w=${W}:h=${H}`;
    parts.push(`v360=input=fisheye:output=equirect:ih_fov=${f(m.ihFov, 4)}:iv_fov=${f(m.ihFov, 4)}:yaw=${f(e.yaw, 4)}:pitch=${f(e.pitch, 4)}:roll=${f(e.roll, 4)}${fovs}`);
    return parts.join(',');
  };
  // Gewicht der vorderen Linse je Ausgabepunkt (wie frontWeight in stitchModel.ts)
  const ux = `(${f(g[0], 8)}*cos(ld(1))*sin(ld(0))+${f(g[1], 8)}*sin(ld(1))+${f(g[2], 8)}*cos(ld(1))*cos(ld(0)))`;
  const uz = `(${f(g[6], 8)}*cos(ld(1))*sin(ld(0))+${f(g[7], 8)}*sin(ld(1))+${f(g[8], 8)}*cos(ld(1))*cos(ld(0)))`;
  const seam = B > 0
    ? `st(2,clip((asin(${uz})*180/PI+${f(B / 2, 4)})/${f(B, 4)},0,1));st(2,ld(2)*ld(2)*(3-2*ld(2)))`
    : `st(2,gte(${uz},0))`;
  // wie frontWeight: Naht weich, Linsen-Grenzen (Längengrad) weich ausgeblendet
  const expr = `st(0,((2*X+1)/W-1)*PI);st(1,((2*Y+1)/H-1)*PI/2);st(3,abs(atan2(${ux},${uz}))*180/PI);${seam};`
    + `st(4,ld(2)*clip((${f(cover, 4)}-ld(3))/${COVER_FADE},0,1));st(5,(1-ld(2))*clip((ld(3)-${f(180 - cover, 4)})/${COVER_FADE},0,1));`
    + `if(gt(ld(4)+ld(5),0),ld(4)/(ld(4)+ld(5)),lt(ld(3),90))*${max}`;
  // Maske in Viertel-Größe rechnen (geq ist langsam) und weich hochskalieren
  const mw = Math.max(64, Math.round(W / 8) * 2), mh = Math.max(32, Math.round(H / 8) * 2);
  const mask = `color=c=black:s=${mw}x${mh}:r=1:d=1,format=${fmt},geq=lum='${expr}':cb='${expr}':cr='${expr}',scale=${W}:${H}:flags=bilinear[${id}m];`;
  // Bewegte Naht: beide Linsen per displace zueinander verschieben (Karten aus seamFlow.writeSeamMaps)
  const disp = (e: string) => {
    if (!seamMap) return '';
    const sc = `scale=${W}:${H}:flags=bilinear`;
    return `movie='${escapeFilterPath(seamMap)}',format=${fmt},split=4[${id}k0][${id}k1][${id}k2][${id}k3];`
      + [0, 1, 2, 3].map((k) => `[${id}k${k}]crop=${MAP_W}:${MAP_H}:0:${k * MAP_H},${sc}[${id}q${k}];`).join('')
      + `[${e}0][${id}q0][${id}q1]displace=edge=smear[${e}0d];[${e}1][${id}q2][${id}q3]displace=edge=smear[${e}1d];`;
  };
  const merge = (e: string) => seamMap ? `${disp(e)}[${e}0d][${e}1d][${id}m]maskedmerge` : `[${e}0][${e}1][${id}m]maskedmerge`;
  if (!partial) {
    return `${head}format=${fmt},split=2[${id}a][${id}b];`
      + `[${id}a]${lens(0)}[${id}e0];[${id}b]${lens(1)}[${id}e1];` + mask
      + merge(`${id}e`);
  }
  const hw = wp / 2;
  return `${head}format=${fmt},split=2[${id}a][${id}b];`
    + `[${id}a]${lens(0)},split=2[${id}p][${id}q];`
    + `[${id}p]crop=${hw}:${H}:${hw}:0,pad=${W - hw}:${H}:0:0:black[${id}r];[${id}q]crop=${hw}:${H}:0:0[${id}l];[${id}r][${id}l]hstack[${id}e0];`
    + `[${id}b]${lens(1)},pad=${W}:${H}:${(W - wp) / 2}:0:black[${id}e1];` + mask
    + merge(`${id}e`);
}

/**
 * Unsichtbarer Selfie-Stick: im Equirect-Bild (Kamera-Ausrichtung) den Bereich ab Breite 90−size nach unten mit der
 * Bildzeile des Rings darüber auffüllen, weicher Übergang über `feather` Grad (gleiche Formel wie panogl uNadir).
 */
export function nadirChain(W: number, H: number, size: number, feather: number, deep: boolean): string {
  const id = `nd${++labelSeq}`;
  const fmt = deep ? 'yuv420p10le' : 'yuv420p';
  const max = deep ? 1023 : 255;
  const fe = Math.max(0.01, feather);
  const r0 = 90 - size - fe;
  const ring = Math.max(0, Math.min(H - 2, Math.floor((H * (0.5 + r0 / 180)) / 2) * 2));
  const expr = `st(0,clip(((((2*Y+1)/H-1)*90)-${f(r0, 4)})/${f(fe, 4)},0,1));ld(0)*ld(0)*(3-2*ld(0))*${max}`;
  return `format=${fmt},split=2[${id}a][${id}b];[${id}b]crop=${W}:2:0:${ring},scale=${W}:${H}:flags=neighbor[${id}r];`
    + `color=c=black:s=${W}x${H}:r=1:d=1,format=${fmt},geq=lum='${expr}':cb='${expr}':cr='${expr}'[${id}m];`
    + `[${id}a][${id}r][${id}m]maskedmerge`;
}

export function needsStitching(stitch?: StitchSettings): boolean {
  if (!stitch) return false;
  if (stitch.mode !== 'equirect') return true;
  return Math.abs(stitch.yaw) + Math.abs(stitch.pitch) + Math.abs(stitch.roll) > 1e-6;
}

function f(n: number, digits = 3): string {
  const k = 10 ** digits;
  return (Math.round(n * k) / k).toString();
}
