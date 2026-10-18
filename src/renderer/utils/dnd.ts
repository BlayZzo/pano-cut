// Drag & Drop aus der Mediathek in die Timeline.
// Chromium erlaubt in `dragover` kein Lesen der Drag-Daten, deshalb merken wir uns die ID zusätzlich hier.
export const DRAG_MIME = 'application/x-panocut-media';

let draggingMediaId: string | null = null;

export function setDraggingMedia(id: string | null): void {
  draggingMediaId = id;
}

export function getDraggingMedia(): string | null {
  return draggingMediaId;
}
