import React, { useState } from 'react';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';

/** Hinweisleiste, wenn eine neue Version verfügbar ist. */
export function UpdateBanner(): React.ReactElement | null {
  const status = useUi((s) => s.updateStatus);
  const appInfo = useUi((s) => s.appInfo);
  const [hidden, setHidden] = useState<string | null>(null);
  const isMac = appInfo?.platform === 'darwin';

  if (status.state === 'idle' || status.state === 'checking' || status.state === 'not-available') return null;
  if (hidden === (status.version ?? status.state)) return null;

  let text = '';
  let action: React.ReactNode = null;
  switch (status.state) {
    case 'available':
      text = fmt(t.update.available, { v: status.version ?? '' });
      action = <button className="btn sm primary" onClick={() => void window.panocut.downloadUpdate()}>{t.update.download}</button>;
      break;
    case 'downloading':
      text = fmt(t.update.downloading, { p: status.percent ?? 0 });
      break;
    case 'downloaded':
      text = t.update.downloaded;
      action = <button className="btn sm primary" onClick={() => void window.panocut.installUpdate()}>{isMac ? t.update.installMac : t.update.install}</button>;
      break;
    case 'error':
      text = fmt(t.update.error, { m: status.message ?? '' });
      break;
  }

  return (
    <div className="update-banner">
      <span style={{ flex: 1 }}>{text}</span>
      {action}
      <button className="btn sm ghost" onClick={() => setHidden(status.version ?? status.state)}>{t.update.later}</button>
    </div>
  );
}
