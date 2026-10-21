// Fenster über der Vorschau (Bild-Assistent, Effekt-Studio, KI, 3D …) verschiebbar machen:
// an der Kopfzeile ziehen = verschieben (frei im ganzen Programmfenster), Doppelklick = einklappen.
// Die Position wird je Fenster-Art gemerkt (nur in diesem Browser-Profil – reine Bequemlichkeit).

import { t } from '../i18n/de';

const KEY = 'pc.panelPos';
type Pos = { x: number; y: number; collapsed?: boolean };

function load(): Record<string, Pos> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Pos>; } catch { return {}; }
}
function save(all: Record<string, Pos>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* egal */ }
}

/** Name der Fenster-Art: zweite Klasse (z. B. „image-panel“), sonst „ai-panel“. */
function panelKey(el: HTMLElement): string {
  return [...el.classList].find((c) => c !== 'ai-panel' && c.endsWith('-panel')) ?? 'ai-panel';
}

function clampPos(el: HTMLElement, x: number, y: number): { x: number; y: number } {
  const w = el.offsetWidth || 320;
  return { x: Math.max(-w + 80, Math.min(window.innerWidth - 80, x)), y: Math.max(0, Math.min(window.innerHeight - 32, y)) };
}

function place(el: HTMLElement, p: Pos): void {
  const c = clampPos(el, p.x, p.y);
  el.style.position = 'fixed';
  el.style.left = `${c.x}px`;
  el.style.top = `${c.y}px`;
  el.style.right = 'auto';
  el.style.maxHeight = `calc(100vh - ${Math.round(c.y) + 12}px)`;
  el.classList.toggle('collapsed', !!p.collapsed);
}

function restore(el: HTMLElement): void {
  if (el.dataset.pcPlaced) return;
  el.dataset.pcPlaced = '1';
  el.querySelector('.ai-panel-header')?.setAttribute('title', t.view.panelMoveHint);
  const p = load()[panelKey(el)];
  if (p) place(el, p);
}

export function installFloatingPanels(): () => void {
  const onDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    const head = target.closest('.ai-panel-header') as HTMLElement | null;
    if (!head || e.button !== 0) return;
    if (target.closest('button, input, select, textarea, a, label')) return;
    const panel = head.closest('.ai-panel') as HTMLElement | null;
    if (!panel) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    panel.classList.add('moving');
    const move = (ev: PointerEvent) => place(panel, { x: ev.clientX - dx, y: ev.clientY - dy, collapsed: panel.classList.contains('collapsed') });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      panel.classList.remove('moving');
      const rr = panel.getBoundingClientRect();
      const all = load();
      all[panelKey(panel)] = { x: rr.left, y: rr.top, collapsed: panel.classList.contains('collapsed') };
      save(all);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onDbl = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const head = target.closest('.ai-panel-header');
    if (!head || target.closest('button, input, select, textarea')) return;
    const panel = head.closest('.ai-panel') as HTMLElement | null;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const collapsed = !panel.classList.contains('collapsed');
    place(panel, { x: r.left, y: r.top, collapsed });
    const all = load();
    all[panelKey(panel)] = { x: r.left, y: r.top, collapsed };
    save(all);
  };
  // Neu geöffnete Fenster an ihre gemerkte Stelle setzen
  const mo = new MutationObserver(() => document.querySelectorAll<HTMLElement>('.ai-panel').forEach(restore));
  mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('dblclick', onDbl);
  return () => { mo.disconnect(); document.removeEventListener('pointerdown', onDown); document.removeEventListener('dblclick', onDbl); };
}

/** Alle Fenster wieder an ihren Standardplatz. */
export function resetFloatingPanels(): void {
  try { localStorage.removeItem(KEY); } catch { /* egal */ }
  document.querySelectorAll<HTMLElement>('.ai-panel').forEach((el) => {
    el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.maxHeight = '';
    el.classList.remove('collapsed');
  });
}
