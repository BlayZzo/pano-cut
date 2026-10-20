import { PlaybackEngine } from './playback';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';

/** Eine Engine für die ganze App; sie folgt dem Projekt-Store automatisch. */
export const engine = new PlaybackEngine(useProject.getState().project);

useProject.subscribe((s) => engine.setProject(s.project));

engine.onTime = (t) => {
  useUi.getState().setPlayhead(t);
};
engine.onEnded = () => useUi.getState().setPlaying(false);
engine.onNeedReversed = (media) => {
  void window.panocut.prepareMedia(media, { reversed: true });
};
engine.onNeedProxy = (media) => {
  useUi.getState().toast(t.toast.needProxy, 'info');
  void window.panocut.prepareMedia({ ...media, status: 'processing' }, { forceProxy: true });
};
engine.onNeedStabilized = (media, strength) => {
  void window.panocut.prepareMedia(media, { stabilized: strength });
};

useUi.subscribe((s, prev) => {
  if (s.loop !== prev.loop) engine.loop = s.loop;
});

export function playPause(): void {
  const ui = useUi.getState();
  if (engine.isPlaying) {
    engine.pause();
    ui.setPlaying(false);
  } else {
    engine.seek(ui.playhead);
    engine.play();
    ui.setPlaying(engine.isPlaying);
  }
}

export function seekTo(t: number): void {
  engine.seek(t);
}

export function stopPlayback(): void {
  if (engine.isPlaying) {
    engine.pause();
    useUi.getState().setPlaying(false);
  }
}
