import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';
import { installClientErrorReporting, reportClientError } from './services/errorReporter.js';

function showStartupError(error) {
  const root = document.getElementById('root');
  if (!root) return;

  root.innerHTML = `
    <main class="startup-error">
      <strong>Pife Duelo nao iniciou</strong>
      <span>${error?.message || 'Erro inesperado ao carregar o jogo.'}</span>
    </main>
  `;
}

window.__PIFE_DUELO_BOOTED__ = true;
let startupCompleted = false;
installClientErrorReporting();
window.addEventListener('error', (event) => {
  if (!startupCompleted) {
    showStartupError(event.error || new Error(event.message));
  }
});
window.addEventListener('unhandledrejection', (event) => {
  if (!startupCompleted) {
    showStartupError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
  }
});

class StartupBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportClientError(error, 'react-render', { componentStack: info?.componentStack });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="startup-error">
          <strong>Pife Duelo nao iniciou</strong>
          <span>{this.state.error.message || 'Erro inesperado ao carregar o jogo.'}</span>
        </main>
      );
    }

    return this.props.children;
  }
}

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Elemento raiz nao encontrado.');
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <StartupBoundary>
        <App />
      </StartupBoundary>
    </React.StrictMode>,
  );
  startupCompleted = true;
} catch (error) {
  showStartupError(error);
}
