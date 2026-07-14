import { useEffect, useMemo, useRef, useState } from 'react';
import { buildOfficialWhatsAppLink } from '../services/whatsAppLink.js';

export default function WhatsAppLobbyFallback({
  title = 'Volte ao WhatsApp',
  message = 'Para encontrar uma partida, acesse o Pife Duelo pelo WhatsApp.',
  publicReference = null,
  autoRedirect = false,
  onRecover = null,
  whatsappMessage = 'menu',
} = {}) {
  const link = useMemo(() => buildOfficialWhatsAppLink({ message: whatsappMessage }), [whatsappMessage]);
  const [seconds, setSeconds] = useState(5);
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (!autoRedirect || !link) return undefined;
    const interval = window.setInterval(() => {
      setSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [autoRedirect, link]);

  useEffect(() => {
    if (!autoRedirect || !link || seconds > 0 || redirectedRef.current) return;
    redirectedRef.current = true;
    window.location.assign(link);
  }, [autoRedirect, link, seconds]);

  const openWhatsApp = () => {
    if (link) window.location.assign(link);
  };

  return (
    <main className="matchmaking-shell">
      <section className="matchmaking-panel matchmaking-message whatsapp-first-fallback" aria-label="Retorno ao WhatsApp">
        <header>
          <span>Pife Duelo</span>
          <h1>{title}</h1>
        </header>
        <p>{message}</p>
        {publicReference ? <strong>Código: {publicReference}</strong> : null}
        {autoRedirect && link ? <small>Abrindo o WhatsApp em {seconds}s...</small> : null}
        <button className="matchmaking-primary-action" type="button" onClick={openWhatsApp} disabled={!link}>
          Voltar ao WhatsApp
        </button>
        {onRecover ? (
          <button className="matchmaking-history-action" type="button" onClick={onRecover}>
            Tentar recuperar partida
          </button>
        ) : null}
        {!link ? <p className="matchmaking-error">O número oficial do WhatsApp não está configurado.</p> : null}
      </section>
    </main>
  );
}
