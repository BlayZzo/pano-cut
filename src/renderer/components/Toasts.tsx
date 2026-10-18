import React from 'react';
import { useUi } from '../store/ui';

export function Toasts(): React.ReactElement {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((tst) => (
        <div key={tst.id} className={`toast ${tst.kind}`} onClick={() => dismiss(tst.id)}>{tst.text}</div>
      ))}
    </div>
  );
}
