import type { StitchSettings } from '@shared/types';

/**
 * FFmpeg-Filterkette, die ein 360°-Rohvideo in ein Equirectangular-Bild verwandelt.
 * `inputs` sind die Eingangs-Labels (ein Label bei Side-by-Side, zwei bei zwei Streams).
 * Rückgabe ist die Filterkette OHNE Ausgangs-Label.
 */
export function stitchChain(stitch: StitchSettings, inputs: string[], outW?: number, outH?: number): string {
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

export function needsStitching(stitch?: StitchSettings): boolean {
  if (!stitch) return false;
  if (stitch.mode !== 'equirect') return true;
  return Math.abs(stitch.yaw) + Math.abs(stitch.pitch) + Math.abs(stitch.roll) > 1e-6;
}

function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}
