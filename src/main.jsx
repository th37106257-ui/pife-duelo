import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';
import { installClientErrorReporting, reportClientError } from './services/errorReporter.js';

function getStartupFailurePayload(error, extra = {}) {
  return {
    message: error?.message || String(error || 'Erro inesperado ao carregar o jogo.'),
    stack: error?.stack || null,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    buildVersion: import.meta.env.VITE_APP_VERSION || import.meta.env.VITE_COMMIT_SHA || 'unknown',
    ...extra,
  };
}

function logStartupFailure(error, extra = {}) {
  const payload = getStartupFailurePayload(error, extra);
  console.error('APP_STARTUP_FAILED', payload);
  reportClientError(error instanceof Error ? error : new Error(payload.message), 'APP_STARTUP_FAILED', payload);
}

function showStartupError() {
  const root = document.getElementById('root');
  if (!root) return;

  root.innerHTML = `
    <main class="startup-error">
      <strong>Pife Duelo nao iniciou</strong>
      <span>Nao foi possivel iniciar o Pife Duelo. Atualize a pagina ou tente novamente em instantes.</span>
    </main>
  `;
}

window.__PIFE_DUELO_BOOTED__ = true;
let startupCompleted = false;
installClientErrorReporting();
window.addEventListener('error', (event) => {
  if (!startupCompleted) {
    const error = event.error || new Error(event.message);
    logStartupFailure(error, { source: 'window.error' });
    showStartupError();
  }
});
window.addEventListener('unhandledrejection', (event) => {
  if (!startupCompleted) {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    logStartupFailure(error, { source: 'unhandledrejection' });
    showStartupError();
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
    logStartupFailure(error, { source: 'react-boundary', componentStack: info?.componentStack });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="startup-error">
          <strong>Pife Duelo nao iniciou</strong>
          <span>Nao foi possivel iniciar o Pife Duelo. Atualize a pagina ou tente novamente em instantes.</span>
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
  logStartupFailure(error, { source: 'bootstrap-catch' });
  showStartupError();
}
