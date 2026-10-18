import React, { useMemo, useState } from 'react';
import type { MediaItem } from '@shared/types';
import { untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { addMediaToTimeline, addTitleToTimeline, applyTransitionToClip, importDialog, importFiles } from '../actions';
import { t } from '../i18n/de';
import { IconImport } from './Icons';
import { MediaCard } from './MediaCard';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { TITLE_TEMPLATES, TRANSITIONS, defaultTitle } from '@shared/pano';
import { DRAG_TITLE, DRAG_TRANSITION, setDragging } from '../utils/dnd';
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
      .filter((m) => !m.isObject)
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
        <div className="coming-soon">
          <div className="big">🚧</div>
          <strong>{t.library.tabEffects}</strong>
          <div>Kommt in Version 0.4</div>
        </div>
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
  } else if (type === 'fadeblack' || type === 'fadewhite') {
    inner = <><rect x="0" y="0" width="28" height="32" fill={a} /><rect x="28" y="0" width="28" height="32" fill={type === 'fadeblack' ? '#000' : '#fff'} /></>;
  } else {
    inner = <><defs><linearGradient id={`g-${type}`} x1="0" x2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient></defs><rect x="0" y="0" width="56" height="32" fill={`url(#g-${type})`} /></>;
  }
  return <svg {...common} style={{ borderRadius: 4 }}>{inner}</svg>;
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
  const items = Object.values(media).filter((m) => m.isObject).sort((a, b) => b.addedAt - a.addedAt);
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
