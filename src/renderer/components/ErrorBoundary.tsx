import React from 'react';

interface State { error: Error | null }

/** Fängt Fehler in der Oberfläche ab, damit nie ein leeres Fenster bleibt. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Oberflächen-Fehler', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 720, margin: '60px auto', fontFamily: 'inherit' }}>
        <h2 style={{ marginTop: 0 }}>Da ist etwas schiefgelaufen</h2>
        <p>PanoCut hat einen internen Fehler bemerkt. Dein Projekt wird regelmäßig automatisch gespeichert.</p>
        <pre className="error-box" style={{ maxHeight: 240, overflow: 'auto' }}>{this.state.error.message}{'\n'}{this.state.error.stack}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>Oberfläche neu laden</button>
          <button className="btn" onClick={() => this.setState({ error: null })}>Weiter versuchen</button>
        </div>
      </div>
    );
  }
}
