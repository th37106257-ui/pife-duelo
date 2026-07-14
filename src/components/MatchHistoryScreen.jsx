import { useEffect, useMemo, useState } from 'react';
import { fetchMatchAudit, fetchMatchHistory } from '../services/matchHistory.js';
import { formatMoney } from '../shared/economy.js';

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(seconds = 0) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, '0');
  const remaining = Math.floor(safeSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remaining}`;
}

function getReasonLabel(reason) {
  const labels = {
    beat: 'Bateu',
    timeout: 'Tempo esgotado',
    disconnect: 'Abandono',
    surrender: 'Desistencia',
    player_forfeit: 'Desistencia',
    integrity_error: 'Erro de integridade',
  };
  return labels[reason] ?? reason ?? '-';
}

function getShortId(id = '') {
  return String(id).replace(/^match-?/, '').slice(-6).toUpperCase() || '-';
}

export default function MatchHistoryScreen({ onBack }) {
  const [history, setHistory] = useState([]);
  const [selectedMatchId, setSelectedMatchId] = useState(null);
  const [audit, setAudit] = useState(null);
  const [status, setStatus] = useState('loading');
  const [errorMessage, setErrorMessage] = useState('');

  const selectedRecord = useMemo(
    () => history.find((record) => record.matchId === selectedMatchId) ?? null,
    [history, selectedMatchId],
  );

  useEffect(() => {
    let active = true;
    setStatus('loading');
    fetchMatchHistory()
      .then((items) => {
        if (!active) return;
        setHistory(items);
        setStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setErrorMessage(error.message || 'Nao foi possivel carregar o historico.');
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedMatchId) {
      setAudit(null);
      return undefined;
    }

    let active = true;
    fetchMatchAudit(selectedMatchId)
      .then((payload) => {
        if (active) setAudit(payload);
      })
      .catch(() => {
        if (active) setAudit(null);
      });

    return () => {
      active = false;
    };
  }, [selectedMatchId]);

  const detail = audit ?? selectedRecord;

  return (
    <main className="matchmaking-shell">
      <section className="matchmaking-panel match-history-panel" aria-label="Historico de partidas">
        <header>
          <span>Pife Duelo</span>
          <h1>Historico</h1>
        </header>

        <button type="button" className="history-back-button" onClick={onBack}>
          Voltar
        </button>

        {status === 'loading' ? <p className="history-empty">Carregando partidas...</p> : null}
        {status === 'error' ? <p className="matchmaking-error">{errorMessage}</p> : null}
        {status === 'ready' && history.length === 0 ? (
          <p className="history-empty">Nenhuma partida finalizada ainda.</p>
        ) : null}

        <div className="history-list">
          {history.map((record) => (
            <button
              key={record.matchId}
              type="button"
              className={record.matchId === selectedMatchId ? 'history-card is-selected' : 'history-card'}
              onClick={() => setSelectedMatchId(record.matchId)}
            >
              <strong>Partida #{getShortId(record.matchId)}</strong>
              <span>Mesa: {formatMoney(record.tableValue)}</span>
              <span>Vencedor: {record.winnerName}</span>
              <span>Premio: {formatMoney(record.winnerPrize)}</span>
              <small>
                {getReasonLabel(record.finishReason)} - {formatDuration(record.durationSeconds)}
              </small>
              <small>{formatDate(record.finishedAt)}</small>
            </button>
          ))}
        </div>

        {detail ? (
          <article className="history-detail">
            <h2>Detalhe da partida</h2>
            <dl>
              <div><dt>Match ID</dt><dd>{detail.matchId}</dd></div>
              <div><dt>Room ID</dt><dd>{detail.roomId}</dd></div>
              <div><dt>Jogador 1</dt><dd>{detail.player1Name} ({detail.player1Id})</dd></div>
              <div><dt>Jogador 2</dt><dd>{detail.player2Name} ({detail.player2Id})</dd></div>
              <div><dt>Vencedor</dt><dd>{detail.winnerName}</dd></div>
              <div><dt>Perdedor</dt><dd>{detail.loserName}</dd></div>
              <div><dt>Mesa</dt><dd>{formatMoney(detail.tableValue)}</dd></div>
              <div><dt>Total</dt><dd>{formatMoney(detail.totalPot)}</dd></div>
              <div><dt>Taxa</dt><dd>{formatMoney(detail.platformFeeAmount)} ({detail.platformFeePercent}%)</dd></div>
              <div><dt>Premio</dt><dd>{formatMoney(detail.winnerPrize)}</dd></div>
              <div><dt>Fim</dt><dd>{getReasonLabel(detail.finishReason)}</dd></div>
              <div><dt>Inicio</dt><dd>{formatDate(detail.startedAt)}</dd></div>
              <div><dt>Fim em</dt><dd>{formatDate(detail.finishedAt)}</dd></div>
              <div><dt>Duracao</dt><dd>{formatDuration(detail.durationSeconds)}</dd></div>
              <div><dt>Status</dt><dd>{detail.status}</dd></div>
            </dl>

            {audit?.logs?.length ? (
              <div className="audit-log-list">
                <h3>Auditoria</h3>
                {audit.logs.slice(-12).map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className="audit-log-row">
                    <span>{entry.action}</span>
                    <strong>{entry.accepted ? 'Aceita' : 'Rejeitada'}</strong>
                    <small>{entry.reasonIfRejected || formatDate(entry.timestamp)}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ) : null}
      </section>
    </main>
  );
}
