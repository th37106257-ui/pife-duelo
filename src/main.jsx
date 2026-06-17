import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';

class StartupBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
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

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <StartupBoundary>
      <App />
    </StartupBoundary>
  </React.StrictMode>,
);
