export function isEditingText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['range', 'checkbox', 'button', 'color'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function mediaUrl(p: string | undefined): string {
  return p ? window.panocut.toMediaUrl(p) : '';
}

export function cssUrl(p: string | undefined): string {
  return p ? `url("${window.panocut.toMediaUrl(p)}")` : 'none';
}
