import React, { useMemo, useState } from 'react';
import type { MediaItem } from '@shared/types';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { addMediaToTimeline, importDialog, importFiles } from '../actions';
import { t } from '../i18n/de';
import { IconImport } from './Icons';
import { MediaCard } from './MediaCard';
import { ContextMenu, type MenuEntry } from './ContextMenu';

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
      </div>
      {tab !== 'media' ? (
        <div className="coming-soon">
          <div className="big">🚧</div>
          <strong>{tab === 'transitions' ? t.library.tabTransitions : tab === 'effects' ? t.library.tabEffects : t.library.tabTitles}</strong>
          <div>{t.library.comingSoon}</div>
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
