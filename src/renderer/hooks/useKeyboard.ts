import { useEffect } from 'react';
import { useUi } from '../store/ui';
import { isEditingText } from '../utils/dom';
import { clearRange, deleteSelection, goEnd, goStart, setRangeIn, setRangeOut, splitAtPlayhead, stepFrames } from '../actions';
import { playPause } from '../engine/instance';

/**
 * Globale Einzeltasten-Kürzel. Alles mit Cmd/Strg (Speichern, Rückgängig, …)
 * läuft über das Programm-Menü, damit es nicht doppelt ausgelöst wird.
 */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (ui.dialog !== 'none') {
        if (e.key === 'Escape') ui.openDialog('none');
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditingText()) {
        if (e.key === 'Escape') (document.activeElement as HTMLElement)?.blur();
        return;
      }
      switch (e.key) {
        case ' ': e.preventDefault(); playPause(); break;
        case 'ArrowLeft': e.preventDefault(); stepFrames(e.shiftKey ? -30 : -1); break;
        case 'ArrowRight': e.preventDefault(); stepFrames(e.shiftKey ? 30 : 1); break;
        case 'Home': e.preventDefault(); goStart(); break;
        case 'End': e.preventDefault(); goEnd(); break;
        case 'Delete':
        case 'Backspace': e.preventDefault(); deleteSelection(); break;
        case 'Escape': ui.clearSelection(); break;
        case 's': case 'S': e.preventDefault(); splitAtPlayhead(); break;
        case 'i': case 'I': e.preventDefault(); setRangeIn(); break;
        case 'o': case 'O': e.preventDefault(); setRangeOut(); break;
        case 'x': case 'X': e.preventDefault(); clearRange(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
