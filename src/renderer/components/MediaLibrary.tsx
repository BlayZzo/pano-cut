import React, { useMemo, useState } from 'react';
import type { MediaItem } from '@shared/types';
import { untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { addMediaToTimeline, addTitleToTimeline, applyEffectToClips, applyTransitionToClip, deleteUserEffect, importDialog, importFiles } from '../actions';
import { t } from '../i18n/de';
import { IconImport } from './Icons';
import { MediaCard } from './MediaCard';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { TITLE_TEMPLATES, TRANSITIONS, defaultTitle } from '@shared/pano';
import { DRAG_EFFECT, DRAG_TITLE, DRAG_TRANSITION, setDragging } from '../utils/dnd';
import { EFFECT_BLOCKS } from '@shared/effects';
import { VFX_KINDS } from '@shared/vfx';
import { defaultColor } from '@shared/timeline';
import { effectiveGrade, gradePixel } from '@shared/color';
import { drawStyledText } from '../engine/text';

type Filter = 'all' | 'video' | 'audio' | 'image';

export function MediaLibrary(): React.ReactElement {
  const media = useProject((s) => s.project.media);
  const removeMedia = useProject((s) => s.removeMedia);
  const tab = useUi((s) => s.libraryTab);
  const setTab = useUi((s) => s.setLibraryTab);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: MediaItem } | null>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(media)
      .filter((m) => !m.isObject && m.vfxRole !== 'light')
      .filter((m) => filter === 'all' || m.type === filter)
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => a.addedAt - b.addedAt);
  }, [media, filter, query]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const paths = files.map((f) => window.panocut.getPathForFile(f)).filter(Boolean);
    void importFiles(paths);
  };

  const menuEntries = (item: MediaItem): MenuEntry[] => [
    { label: t.library.addToTimeline, onClick: () => addMediaToTimeline(item) },
    { label: t.library.showInFolder, onClick: () => void window.panocut.showInFolder(item.path) },
    { sep: true },
    { label: t.library.remove, danger: true, onClick: () => removeMedia(item.id) },
  ];

  return (
    <aside
      className="panel"
      style={{ position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}
    >
      <div className="tabs">
        <div className={`tab${tab === 'media' ? ' active' : ''}`} onClick={() => setTab('media')}>{t.library.tabMedia}</div>
        <div className={`tab${tab === 'transitions' ? ' active' : ''}`} onClick={() => setTab('transitions')}>{t.library.tabTransitions}</div>
        <div className={`tab${tab === 'effects' ? ' active' : ''}`} onClick={() => setTab('effects')}>{t.library.tabEffects}</div>
        <div className={`tab${tab === 'titles' ? ' active' : ''}`} onClick={() => setTab('titles')}>{t.library.tabTitles}</div>
        <div className={`tab${tab === 'objects' ? ' active' : ''}`} onClick={() => setTab('objects')}>{t.ai.objectsTab}</div>
      </div>
      {tab === 'transitions' ? (
        <TransitionLibrary />
      ) : tab === 'objects' ? (
        <ObjectLibrary onContextMenu={(x, y, item) => { setSelected(item.id); setMenu({ x, y, item }); }} selected={selected} onSelect={setSelected} />
      ) : tab === 'titles' ? (
        <TitleLibrary />
      ) : tab === 'effects' ? (
        <EffectLibrary />
      ) : (
        <>
          <div className="library-toolbar">
            <button className="btn sm" onClick={() => void importDialog()}><IconImport />{t.library.import}</button>
            <input type="text" placeholder={t.library.search} value={query} onChange={(e) => setQuery(e.target.value)} style={{ height: 26 }} />
          </div>
          <div className="library-filters">
            {(['all', 'video', 'audio', 'image'] as Filter[]).map((f) => (
              <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>{t.library[f]}</button>
            ))}
          </div>
          <div className="panel-body" onClick={() => setSelected(null)}>
            {items.length === 0 ? (
              <div className="library-empty">
                <strong>{t.library.empty}</strong>
                {t.library.emptyHint}
              </div>
            ) : (
              <div className="media-grid">
                {items.map((m) => (
                  <MediaCard
                    key={m.id}
                    item={m}
                    selected={selected === m.id}
                    onSelect={() => setSelected(m.id)}
                    onOpen={() => addMediaToTimeline(m)}
                    onContextMenu={(x, y) => { setSelected(m.id); setMenu({ x, y, item: m }); }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {dragOver && <div className="drop-overlay">{t.library.dropHere}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.item)} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/** Übergänge: auf einen Clip ziehen oder bei Auswahl doppelklicken. */
function TransitionLibrary(): React.ReactElement {
  const selection = useUi((s) => s.selection);
  const groups = Array.from(new Set(TRANSITIONS.map((x) => x.group)));
  return (
    <div className="panel-body">
      <div className="hint" style={{ padding: '8px 10px' }}>{t.transition.libraryHint}</div>
      {groups.map((g) => (
        <div key={g}>
          <div className="panel-header" style={{ border: 'none', paddingBottom: 2 }}>{g}</div>
          <div className="transition-grid">
            {TRANSITIONS.filter((x) => x.group === g).map((tr) => (
              <div
                key={tr.type}
                className="transition-card"
                draggable
                onDragStart={(e) => { e.dataTransfer.setData(DRAG_TRANSITION, tr.type); e.dataTransfer.effectAllowed = 'copy'; setDragging({ kind: 'transition', type: tr.type }); }}
                onDragEnd={() => setDragging(null)}
                onDoubleClick={() => { if (selection[0]) applyTransitionToClip(selection[0], tr.type); }}
                title={tr.name}
              >
                <TransitionIcon type={tr.type} />
                <span>{tr.name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TransitionIcon({ type }: { type: string }): React.ReactElement {
  // Kleine schematische Darstellung: A (dunkel) → B (hell)
  const common = { width: 56, height: 32, viewBox: '0 0 56 32' } as const;
  const a = '#2b5f8f', b = '#3dd6c1';
  let inner: React.ReactNode;
  if (type.startsWith('wipe') || type.startsWith('smooth')) {
    const horiz = type.endsWith('left') || type.endsWith('right');
    inner = horiz
      ? <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x={type.endsWith('left') ? 28 : 0} y="0" width="28" height="32" fill={b} /></>
      : <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x="0" y={type.endsWith('up') ? 16 : 0} width="56" height="16" fill={b} /></>;
  } else if (type.startsWith('slide')) {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x={type === 'slideleft' ? 30 : type === 'slideright' ? -4 : 8} y={type === 'slideup' ? 18 : type === 'slidedown' ? -6 : 4} width="30" height="24" fill={b} rx="2" /></>;
  } else if (type.startsWith('circle') || type === 'radial') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={type === 'circleclose' ? b : a} /><circle cx="28" cy="16" r="10" fill={type === 'circleclose' ? a : b} /></>;
  } else if (type === 'zoomthrough') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x="10" y="6" width="36" height="20" fill="none" stroke={b} strokeWidth="2" /><rect x="20" y="11" width="16" height="10" fill={b} /></>;
  } else if (type.startsWith('whip')) {
    const vert = type === 'whipup' || type === 'whipdown';
    const lines = [6, 12, 18, 24].map((p, i) => vert
      ? <line key={i} x1={p * 2} y1="2" x2={p * 2} y2="30" stroke={b} strokeWidth="2" strokeOpacity={0.4 + i * 0.15} />
      : <line key={i} x1="4" y1={p + 1} x2="52" y2={p + 1} stroke={b} strokeWidth="2" strokeOpacity={0.4 + i * 0.15} />);
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} />{lines}</>;
  } else if (type === 'spin') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x="16" y="6" width="24" height="20" fill={b} transform="rotate(30 28 16)" /></>;
  } else if (type === 'flash') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><circle cx="28" cy="16" r="13" fill="#fff" opacity="0.9" /><circle cx="28" cy="16" r="7" fill="#fff" /></>;
  } else if (type === 'shake') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x="12" y="7" width="30" height="18" fill={b} opacity="0.5" /><rect x="16" y="9" width="30" height="18" fill={b} /></>;
  } else if (type === 'glitch') {
    inner = <><rect x="0" y="0" width="56" height="32" fill={a} /><rect x="10" y="6" width="34" height="20" fill="#ff3b6b" opacity="0.8" /><rect x="14" y="6" width="34" height="20" fill="#3bd5ff" opacity="0.8" /><rect x="12" y="13" width="34" height="5" fill={b} /></>;
  } else if (type === 'fadeblack' || type === 'fadewhite') {
    inner = <><rect x="0" y="0" width="28" height="32" fill={a} /><rect x="28" y="0" width="28" height="32" fill={type === 'fadeblack' ? '#000' : '#fff'} /></>;
  } else {
    inner = <><defs><linearGradient id={`g-${type}`} x1="0" x2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient></defs><rect x="0" y="0" width="56" height="32" fill={`url(#g-${type})`} /></>;
  }
  return <svg {...common} style={{ borderRadius: 4 }}>{inner}</svg>;
}

// ---------- Effekte & Animationen ----------

/** Beispielfarben (Himmel, Haut, Grün, Schatten, Licht) durch einen Look geschickt – als Farbstreifen auf der Kachel. */
const SWATCH = [[0.42, 0.62, 0.86], [0.86, 0.66, 0.54], [0.36, 0.56, 0.3], [0.16, 0.16, 0.2], [0.92, 0.9, 0.85]];
function lookSwatch(lookId: string): string {
  const e = effectiveGrade({ ...defaultColor(), look: lookId, lookStrength: 1 });
  const stops = SWATCH.map(([r, g, b], i) => {
    const [rr, gg, bb] = gradePixel(r, g, b, e);
    return `rgb(${Math.round(rr * 255)},${Math.round(gg * 255)},${Math.round(bb * 255)}) ${i * 25}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

const NO_EFFECTS: never[] = [];

function EffectLibrary(): React.ReactElement {
  const selection = useUi((s) => s.selection);
  const userEffects = useUi((s) => s.settings.userEffects) ?? NO_EFFECTS;
  const swatches = useMemo(() => Object.fromEntries(EFFECT_BLOCKS.filter((b) => b.kind === 'look').map((b) => [b.id, lookSwatch(b.id.slice(2))])), []);
  const tile = (id: string, name: string, icon: React.ReactNode, extra?: React.ReactNode, cls = '') => (
    <div
      key={id}
      className={`effect-tile ${cls}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_EFFECT, id); e.dataTransfer.effectAllowed = 'copy'; setDragging({ kind: 'effect', id }); }}
      onDragEnd={() => setDragging(null)}
      onDoubleClick={() => { if (selection.length) applyEffectToClips(id, selection); else useUi.getState().toast(t.effects.needClip, 'error'); }}
      title={name}
    >
      {icon}
      <span>{name}</span>
      {extra}
    </div>
  );
  const groups: Array<{ kind: 'motion' | 'look' | 'fx'; title: string }> = [
    { kind: 'motion', title: t.effects.groupAnimation },
    { kind: 'look', title: t.effects.groupLook },
    { kind: 'fx', title: t.effects.groupFx },
  ];
  return (
    <div className="panel-body" style={{ padding: '8px 10px' }}>
      <div className="effect-group">
        <div className="effect-group-title">{t.effects.groupSim}</div>
        <div className="effect-grid">
          {VFX_KINDS.map((k) => (
            <div key={k.kind} className="effect-tile" title={t.effects.simHint} onClick={() => useUi.getState().setVfxPanel(true, k.kind)}>
              <span className="effect-icon">{k.icon}</span><span>{k.name}</span>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{t.effects.simHint}</div>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>{t.effects.hint}</div>
      {groups.map((g) => (
        <div key={g.kind} className="effect-group">
          <div className="effect-group-title">{g.title}</div>
          <div className="effect-grid">
            {EFFECT_BLOCKS.filter((b) => b.kind === g.kind).map((b) =>
              b.kind === 'look'
                ? tile(b.id, b.name, <div className="effect-swatch" style={{ background: swatches[b.id] }} />, undefined, 'look-tile')
                : tile(b.id, b.name, <span className="effect-icon">{b.icon}</span>))}
          </div>
        </div>
      ))}
      <div className="effect-group">
        <div className="effect-group-title">{t.effects.groupOwn}</div>
        {userEffects.length === 0 ? <div className="hint">{t.effects.ownEmpty}</div> : (
          <div className="effect-grid">
            {userEffects.map((u) => tile(u.id, u.name, <span className="effect-icon">☆</span>,
              <button className="effect-del" title={t.effects.deleteOwn} onClick={(e) => { e.stopPropagation(); void deleteUserEffect(u.id); }}>×</button>))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Titel-Vorlagen: auf eine Videospur ziehen oder doppelklicken. */
function TitleLibrary(): React.ReactElement {
  return (
    <div className="panel-body">
      <div className="hint" style={{ padding: '8px 10px' }}>{t.title.libraryHint}</div>
      <div className="title-grid">
        {TITLE_TEMPLATES.map((tpl) => (
          <div
            key={tpl.id}
            className="title-card"
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(DRAG_TITLE, tpl.id); e.dataTransfer.effectAllowed = 'copy'; setDragging({ kind: 'title', templateId: tpl.id }); }}
            onDragEnd={() => setDragging(null)}
            onDoubleClick={() => addTitleToTimeline(tpl.id)}
          >
            <TitlePreview templateId={tpl.id} />
            <span>{tpl.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TitlePreview({ templateId }: { templateId: string }): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const tpl = TITLE_TEMPLATES.find((x) => x.id === templateId);
    const style = { ...defaultTitle(), ...(tpl?.style ?? {}) };
    ctx.fillStyle = '#1c2230';
    ctx.fillRect(0, 0, c.width, c.height);
    drawStyledText(ctx, style, style.text, c.width, c.height, { localT: 1, duration: 4, animate: false });
  }, [templateId]);
  return <canvas ref={ref} width={240} height={135} style={{ width: '100%', borderRadius: 4, background: '#1c2230' }} />;
}

/** Objekt-Mediathek: freigestellte Objekte (mit Transparenz) dieses Projekts. */
function ObjectLibrary({ selected, onSelect, onContextMenu }: { selected: string | null; onSelect: (id: string | null) => void; onContextMenu: (x: number, y: number, item: MediaItem) => void }): React.ReactElement {
  const media = useProject((s) => s.project.media);
  const settings = useUi((s) => s.settings);
  const toast = useUi((s) => s.toast);
  const addMedia = useProject((s) => s.addMedia);
  const [busy, setBusy] = React.useState<string | null>(null);
  const items = Object.values(media).filter((m) => m.isObject || m.model3d).sort((a, b) => b.addedAt - a.addedAt);
  const projectId = useProject((s) => s.project.id);

  const syncUp = async () => {
    if (!settings.cloud?.url) { toast(t.cloud.notConfigured, 'error'); return; }
    setBusy(t.cloud.uploading);
    try {
      for (const m of items) {
        await window.panocut.cloudUpload(settings.cloud, m.path, `objekte/${projectId}/${m.id}.webm`);
        if (m.thumb) await window.panocut.cloudUpload(settings.cloud, m.thumb, `objekte/${projectId}/${m.id}.png`);
        await window.panocut.cloudUpload(settings.cloud, await writeJsonTemp(m), `objekte/${projectId}/${m.id}.json`);
      }
      toast(t.cloud.uploaded, 'success');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(null); }
  };
  const syncDown = async () => {
    if (!settings.cloud?.url) { toast(t.cloud.notConfigured, 'error'); return; }
    setBusy(t.cloud.fetchObjects);
    try {
      const list = await window.panocut.cloudList(settings.cloud, `objekte/${projectId}`);
      const info = await window.panocut.getAppInfo();
      let n = 0;
      for (const e of list.filter((x) => x.name.endsWith('.json'))) {
        const id = e.name.replace(/\.json$/, '');
        if (media[id]) continue;
        const base = `${info.userData}/objects/${projectId}/${id}`;
        await window.panocut.cloudDownload(settings.cloud, `objekte/${projectId}/${id}.json`, `${base}.json`);
        await window.panocut.cloudDownload(settings.cloud, `objekte/${projectId}/${id}.webm`, `${base}.webm`);
        try { await window.panocut.cloudDownload(settings.cloud, `objekte/${projectId}/${id}.png`, `${base}.png`); } catch { /* ohne Vorschaubild */ }
        const item = await window.panocut.readJsonFile<MediaItem>(`${base}.json`);
        if (item) { untracked(() => addMedia([{ ...item, path: `${base}.webm`, proxy: `${base}.webm`, thumb: `${base}.png` }])); n++; }
      }
      toast(`${n} Objekt(e) geholt`, 'success');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(null); }
  };

  return (
    <>
      <div className="library-toolbar">
        <button className="btn sm primary" onClick={() => useUi.getState().setModelPanel({})}>{t.model3d.libraryButton}</button>
        <button className="btn sm" onClick={() => void syncUp()} disabled={!!busy || items.length === 0} title={t.cloud.syncObjects}>☁︎ {t.cloud.syncObjects}</button>
        <button className="btn sm" onClick={() => void syncDown()} disabled={!!busy} title={t.cloud.fetchObjects}>⇩</button>
      </div>
      {busy && <div className="hint" style={{ padding: '4px 10px' }}><span className="spinner" /> {busy}</div>}
      <div className="panel-body" onClick={() => onSelect(null)}>
        {items.length === 0 ? (
          <div className="library-empty"><strong>{t.ai.objectsTab}</strong>{t.ai.objectsEmpty}</div>
        ) : (
          <>
            <div className="hint" style={{ padding: '8px 10px 0' }}>{t.ai.objectsHint}</div>
            <div className="media-grid">
              {items.map((m) => (
                <div key={m.id} className="object-card" style={{ display: 'contents' }}>
                  <MediaCard item={m} selected={selected === m.id} onSelect={() => onSelect(m.id)} onOpen={() => addMediaToTimeline(m)} onContextMenu={(x, y) => onContextMenu(x, y, m)} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

async function writeJsonTemp(m: MediaItem): Promise<string> {
  return window.panocut.writeJsonFile(`${m.path}.json`, { ...m, proxy: undefined, thumb: undefined, path: undefined });
}
