import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Automatischer Oberflächen-Test (CI): Zugriff auf Projekt, Engine und Import
if (window.panocut?.testMode) void import('./testHook').then((m) => m.installTestHook());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
