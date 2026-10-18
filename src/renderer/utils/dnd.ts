// Drag & Drop aus der Mediathek in die Timeline.
// Chromium erlaubt in `dragover` kein Lesen der Drag-Daten, deshalb merken wir uns die Daten zusätzlich hier.
export const DRAG_MIME = 'application/x-panocut-media';
export const DRAG_TRANSITION = 'application/x-panocut-transition';
export const DRAG_TITLE = 'application/x-panocut-title';

export type DragPayload = { kind: 'media'; id: string } | { kind: 'transition'; type: string } | { kind: 'title'; templateId: string };

let current: DragPayload | null = null;

export function setDragging(p: DragPayload | null): void {
  current = p;
}

export function getDragging(): DragPayload | null {
  return current;
}

/** Kompatibilität: nur die Medien-ID. */
export function setDraggingMedia(id: string | null): void {
  current = id ? { kind: 'media', id } : null;
}

export function getDraggingMedia(): string | null {
  return current?.kind === 'media' ? current.id : null;
}
