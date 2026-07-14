import { useEffect, useMemo, useState } from 'react';
import {
  adminConfirmPayment,
  adminApproveWhatsAppEntry,
  adminEndMatch,
  adminExpireWhatsAppEntry,
  adminForceWinner,
  adminRejectPayment,
  adminRejectWhatsAppEntry,
  adminRemoveRoom,
  getAdminMatchAudit,
  getAdminSnapshot,
  loginAdmin,
} from '../services/adminApi.js';
import { formatMoney } from '../shared/economy.js';

const ADMIN_PASSWORD_KEY = 'pifeDuelo.adminPassword';

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

function reasonLabel(reason) {
  const labels = {
    beat: 'Bateu',
    timeout: 'Timeout',
    disconnect: 'Abandono',
    surrender: 'Desistencia',
    player_forfeit: 'Desistencia',
    integrity_error: 'Integridade',
    admin_closed: 'Admin',
    stuck_match: 'Travada',
    player_report: 'Denuncia',
    admin_decision: 'Decisao admin',
  };
  return labels[reason] ?? reason ?? '-';
}

function getShortId(id = '') {
  return String(id).replace(/^match-?/, '').slice(-6).toUpperCase() || '-';
}

export default function AdminPanel() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '');
  const [isAuthorized, setIsAuthorized] = useState(Boolean(sessionStorage.getItem(ADMIN_PASSWORD_KEY)));
  const [snapshot, setSnapshot] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedAudit, setSelectedAudit] = useState(null);
  const [filters, setFilters] = useState({ table: '', player: '', reason: '', date: '', matchId: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [monitorFilters, setMonitorFilters] = useState({ level: '', source: '', query: '' });

  const loadDashboard = async (currentPassword = password) => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const payload = await getAdminSnapshot(currentPassword);
      setSnapshot(payload);
    } catch (error) {
      setErrorMessage(error.message || 'Nao foi possivel carregar o admin.');
      if (String(error.message).includes('unauthorized')) {
        setIsAuthorized(false);
        sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthorized) loadDashboard();
  }, [isAuthorized]);

  const filteredHistory = useMemo(() => {
    const history = snapshot?.history ?? [];
    return history.filter((record) => {
      const tableOk = !filters.table || String(record.tableValue) === filters.table;
      const playerOk = !filters.player || [
        record.player1Id,
        record.player2Id,
        record.player1Name,
        record.player2Name,
        record.winnerName,
        record.loserName,
      ].some((value) => String(value || '').toLowerCase().includes(filters.player.toLowerCase()));
      const reasonOk = !filters.reason || record.finishReason === filters.reason;
      const dateOk = !filters.date || String(record.finishedAt || '').startsWith(filters.date);
      const matchOk = !filters.matchId || String(record.matchId || '').toLowerCase().includes(filters.matchId.toLowerCase());
      return tableOk && playerOk && reasonOk && dateOk && matchOk;
    });
  }, [snapshot, filters]);

  const filteredMonitoringLogs = useMemo(() => {
    const monitoring = snapshot?.monitoring ?? {};
    const logs = [
      ...(monitoring.serverErrors ?? []),
      ...(monitoring.clientErrors ?? []),
      ...(monitoring.events ?? []),
    ];
    const unique = [...new Map(logs.map((entry) => [entry.id, entry])).values()];
    return unique
      .filter((entry) => !monitorFilters.level || entry.level === monitorFilters.level)
      .filter((entry) => !monitorFilters.source || entry.source === monitorFilters.source)
      .filter((entry) => {
        if (!monitorFilters.query) return true;
        const haystack = `${entry.message} ${entry.matchId} ${entry.playerId} ${entry.event}`.toLowerCase();
        return haystack.includes(monitorFilters.query.toLowerCase());
      })
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  }, [snapshot, monitorFilters]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    try {
      await loginAdmin(password);
      sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
      setIsAuthorized(true);
    } catch (error) {
      setErrorMessage('Senha admin incorreta.');
      setIsAuthorized(false);
    }
  };

  const openAudit = async (matchId) => {
    try {
      const payload = await getAdminMatchAudit(password, matchId);
      setSelectedAudit(payload.audit);
    } catch (error) {
      setErrorMessage(error.message || 'Auditoria nao encontrada.');
    }
  };

  const runCriticalAction = async (message, action) => {
    if (!window.confirm(message)) return;
    try {
      await action();
      setSelectedAudit(null);
      await loadDashboard();
    } catch (error) {
      setErrorMessage(error.message || 'Acao admin falhou.');
    }
  };

  const copyMonitoringReport = async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      metrics: snapshot?.metrics ?? {},
      stuckMatches: snapshot?.monitoring?.stuckMatches ?? [],
      errors: {
        server: snapshot?.monitoring?.serverErrors ?? [],
        client: snapshot?.monitoring?.clientErrors ?? [],
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setErrorMessage('Relatorio copiado.');
    } catch {
      setErrorMessage('Nao foi possivel copiar o relatorio.');
    }
  };

  if (!isAuthorized) {
    return (
      <main className="admin-shell">
        <form className="admin-login" onSubmit={handleLogin}>
          <span>Pife Duelo</span>
          <h1>Admin</h1>
          <label>
            Senha
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </label>
          <button type="submit">Entrar</button>
          {errorMessage ? <p>{errorMessage}</p> : null}
        </form>
      </main>
    );
  }

  const dashboard = snapshot?.dashboard ?? {};

  return (
    <main className="admin-shell">
      <section className="admin-panel">
        <header className="admin-header">
          <div>
            <span>Pife Duelo</span>
            <h1>Painel admin</h1>
          </div>
          <button type="button" onClick={() => loadDashboard()} disabled={isLoading}>
            {isLoading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </header>

        {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

        <nav className="admin-tabs" aria-label="Secoes do painel">
          <button type="button" className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Visao geral</button>
          <button type="button" className={activeTab === 'monitoring' ? 'active' : ''} onClick={() => setActiveTab('monitoring')}>Erros / Monitoramento</button>
        </nav>

        <section className="admin-metrics">
          <article><span>Jogadores online</span><strong>{dashboard.onlinePlayers ?? 0}</strong></article>
          <article><span>Partidas ativas</span><strong>{dashboard.activeMatches ?? 0}</strong></article>
          <article><span>Finalizadas hoje</span><strong>{dashboard.finishedToday ?? 0}</strong></article>
          <article><span>Total hoje</span><strong>{formatMoney(dashboard.totalPotToday ?? 0)}</strong></article>
          <article><span>Taxa hoje</span><strong>{formatMoney(dashboard.platformFeeToday ?? 0)}</strong></article>
          <article><span>Travadas</span><strong>{dashboard.stuckMatches ?? 0}</strong></article>
        </section>

        {activeTab === 'monitoring' ? (
          <>
            <section className="admin-metrics admin-monitor-metrics">
              <article><span>Iniciadas hoje</span><strong>{snapshot?.metrics?.startedMatchesToday ?? 0}</strong></article>
              <article><span>Reconexoes</span><strong>{snapshot?.metrics?.reconnectCountToday ?? 0}</strong></article>
              <article><span>Desconexoes</span><strong>{snapshot?.metrics?.disconnectCountToday ?? 0}</strong></article>
              <article><span>Timeouts automaticos</span><strong>{snapshot?.metrics?.autoTimeoutTurnsToday ?? 0}</strong></article>
              <article><span>Erros de integridade</span><strong>{snapshot?.metrics?.integrityErrorsToday ?? 0}</strong></article>
              <article><span>Fila media</span><strong>{formatDuration(snapshot?.metrics?.averageQueueTimeSeconds ?? 0)}</strong></article>
              <article><span>Partida media</span><strong>{formatDuration(snapshot?.metrics?.averageMatchDurationSeconds ?? 0)}</strong></article>
            </section>

            <section className="admin-section">
              <div className="admin-section-heading">
                <h2>Erros / Monitoramento</h2>
                <button type="button" onClick={copyMonitoringReport}>Copiar relatorio</button>
              </div>
              <div className="admin-filters">
                <select value={monitorFilters.level} onChange={(event) => setMonitorFilters({ ...monitorFilters, level: event.target.value })}>
                  <option value="">Nivel</option><option value="error">Error</option><option value="warn">Warn</option><option value="info">Info</option>
                </select>
                <select value={monitorFilters.source} onChange={(event) => setMonitorFilters({ ...monitorFilters, source: event.target.value })}>
                  <option value="">Origem</option><option value="server">Server</option><option value="socket">Socket</option><option value="match">Match</option><option value="queue">Queue</option><option value="admin">Admin</option><option value="frontend">Frontend</option>
                </select>
                <input placeholder="Match, jogador ou mensagem" value={monitorFilters.query} onChange={(event) => setMonitorFilters({ ...monitorFilters, query: event.target.value })} />
              </div>
              <div className="admin-log-list admin-monitor-list">
                {filteredMonitoringLogs.slice(0, 200).map((entry) => (
                  <div key={entry.id} className={`monitor-log monitor-${entry.level}`}>
                    <strong>{entry.level.toUpperCase()} · {entry.source}</strong>
                    <span>{entry.message}</span>
                    <small>{entry.matchId || entry.playerId || entry.event || '-'} · {formatDate(entry.timestamp)}</small>
                  </div>
                ))}
                {filteredMonitoringLogs.length === 0 ? <p className="admin-empty">Nenhum registro para estes filtros.</p> : null}
              </div>
            </section>

            <section className="admin-section">
              <h2>Partidas suspeitas</h2>
              <div className="admin-card-list">
                {(snapshot?.monitoring?.stuckMatches ?? []).map((match) => (
                  <article key={match.matchId} className="admin-match-card monitor-warning">
                    <strong>#{getShortId(match.matchId)}</strong>
                    <span>{match.player1?.name ?? '-'} x {match.player2?.name ?? '-'}</span>
                    <span>{(match.stuckReasons ?? []).join(', ')}</span>
                  </article>
                ))}
                {(snapshot?.monitoring?.stuckMatches ?? []).length === 0 ? <p className="admin-empty">Nenhuma partida suspeita.</p> : null}
              </div>
            </section>
          </>
        ) : null}

        {activeTab === 'overview' ? (
          <>

        <section className="admin-section">
          <h2>Entradas WhatsApp pendentes</h2>
          <div className="admin-card-list">
            {(snapshot?.pendingWhatsAppEntries ?? []).map((entry) => (
              <article key={entry.entryId} className="admin-match-card">
                <strong>#{entry.entryId}</strong>
                <span>Telefone: {entry.phoneMasked}</span>
                <span>Mesa: {formatMoney(entry.tableAmount)} · Prêmio: {formatMoney(entry.prizeAmount)}</span>
                <span>Status: {entry.status}</span>
                <span>Modo: teste seguro sem Pix</span>
                <span>Criado em: {formatDate(entry.createdAt)}</span>
                <div className="admin-actions">
                  <button
                    type="button"
                    onClick={() => runCriticalAction(
                      `Liberar a entrada #${entry.entryId} para a fila?`,
                      () => adminApproveWhatsAppEntry(password, entry.entryId),
                    )}
                  >
                    Liberar para fila
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const reason = window.prompt('Motivo da rejeição:');
                      if (!reason?.trim()) return;
                      runCriticalAction(
                        `Rejeitar a entrada #${entry.entryId}?`,
                        () => adminRejectWhatsAppEntry(password, entry.entryId, reason.trim()),
                      );
                    }}
                  >
                    Rejeitar
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => runCriticalAction(
                      `Expirar a entrada #${entry.entryId}?`,
                      () => adminExpireWhatsAppEntry(password, entry.entryId),
                    )}
                  >
                    Expirar
                  </button>
                </div>
              </article>
            ))}
            {(snapshot?.pendingWhatsAppEntries ?? []).length === 0
              ? <p className="admin-empty">Nenhuma entrada WhatsApp pendente.</p>
              : null}
          </div>
        </section>

        <section className="admin-section">
          <h2>Pagamentos pendentes</h2>
          <div className="admin-card-list">
            {(snapshot?.pendingPayments ?? []).map((payment) => (
              <article key={payment.paymentId} className="admin-match-card">
                <strong>#{payment.paymentId}</strong>
                <span>Mesa: {formatMoney(payment.selectedTable)} · Valor: {formatMoney(payment.amount)}</span>
                <span>Telefone: {payment.phone}</span>
                <span>Comprovante: {payment.receiptReceived ? 'recebido' : 'ainda nao recebido'}</span>
                <span>Criado em: {formatDate(payment.createdAt)}</span>
                <div className="admin-actions">
                  <button
                    type="button"
                    disabled={!payment.receiptReceived}
                    onClick={() => runCriticalAction(
                      `Confirmar manualmente o pagamento #${payment.paymentId}?`,
                      () => adminConfirmPayment(password, payment.paymentId),
                    )}
                  >
                    Confirmar pagamento
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const reason = window.prompt('Motivo da rejeicao:');
                      if (!reason?.trim()) return;
                      runCriticalAction(
                        `Rejeitar o pagamento #${payment.paymentId}?`,
                        () => adminRejectPayment(password, payment.paymentId, reason.trim()),
                      );
                    }}
                  >
                    Rejeitar
                  </button>
                </div>
              </article>
            ))}
            {(snapshot?.pendingPayments ?? []).length === 0 ? <p className="admin-empty">Nenhum pagamento pendente.</p> : null}
          </div>
        </section>

        <section className="admin-section">
          <h2>Partidas em andamento</h2>
          <div className="admin-card-list">
            {(snapshot?.activeMatches ?? []).map((match) => (
              <article key={match.matchId} className="admin-match-card">
                <strong>#{getShortId(match.matchId)}</strong>
                <span>Sala: {match.roomId}</span>
                <span>Mesa: {formatMoney(match.tableValue)} - Premio: {formatMoney(match.prize)}</span>
                <span>{match.player1?.name ?? '-'} x {match.player2?.name ?? '-'}</span>
                <span>Vez: {match.currentTurnPlayerId}</span>
                <span>Tempo: {match.turnSecondsLeft ?? '-'}s - Total: {formatDuration(match.durationSeconds)}</span>
                <span>Status: {match.status}</span>
                <span>Conexao: {match.player1?.isConnected ? 'P1 online' : 'P1 off'} / {match.player2?.isConnected ? 'P2 online' : 'P2 off'}</span>
                <div className="admin-actions">
                  <button type="button" onClick={() => setSelectedAudit(match)}>Ver detalhes</button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => runCriticalAction(
                      'Encerrar esta partida?',
                      () => adminEndMatch(password, match.matchId, 'admin_closed'),
                    )}
                  >
                    Encerrar
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => runCriticalAction(
                      'Forcar vitoria do jogador 1?',
                      () => adminForceWinner(password, match.matchId, match.player1?.playerId, 'admin_decision'),
                    )}
                  >
                    Vitoria P1
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => runCriticalAction(
                      'Forcar vitoria do jogador 2?',
                      () => adminForceWinner(password, match.matchId, match.player2?.playerId, 'admin_decision'),
                    )}
                  >
                    Vitoria P2
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => runCriticalAction(
                      'Remover sala vinculada a esta partida?',
                      () => adminRemoveRoom(password, match.roomId, { reason: 'stuck_match', confirmActiveMatch: true }),
                    )}
                  >
                    Remover sala
                  </button>
                </div>
              </article>
            ))}
            {snapshot?.activeMatches?.length === 0 ? <p className="admin-empty">Nenhuma partida ativa.</p> : null}
          </div>
        </section>

        <section className="admin-section">
          <h2>Jogadores online</h2>
          <div className="admin-table">
            {(snapshot?.players ?? []).map((player) => (
              <div key={player.playerId}>
                <span>{player.name}</span>
                <span>{player.status}</span>
                <small>{player.playerId}</small>
                <small>{player.matchId ?? player.socketId ?? '-'}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="admin-section">
          <h2>Historico</h2>
          <div className="admin-filters">
            <select value={filters.table} onChange={(event) => setFilters({ ...filters, table: event.target.value })}>
              <option value="">Mesa</option>
              <option value="2">R$2</option>
              <option value="5">R$5</option>
              <option value="10">R$10</option>
              <option value="20">R$20</option>
            </select>
            <input placeholder="Jogador" value={filters.player} onChange={(event) => setFilters({ ...filters, player: event.target.value })} />
            <input placeholder="Motivo" value={filters.reason} onChange={(event) => setFilters({ ...filters, reason: event.target.value })} />
            <input type="date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })} />
            <input placeholder="Match ID" value={filters.matchId} onChange={(event) => setFilters({ ...filters, matchId: event.target.value })} />
          </div>
          <div className="admin-card-list">
            {filteredHistory.map((record) => (
              <button key={record.matchId} type="button" className="admin-history-card" onClick={() => openAudit(record.matchId)}>
                <strong>#{getShortId(record.matchId)} - {reasonLabel(record.finishReason)}</strong>
                <span>{formatDate(record.finishedAt)} - Mesa {formatMoney(record.tableValue)}</span>
                <span>{record.winnerName} venceu {record.loserName}</span>
                <span>Premio {formatMoney(record.winnerPrize)} - Taxa {formatMoney(record.platformFeeAmount)}</span>
                <small>{formatDuration(record.durationSeconds)}</small>
              </button>
            ))}
            {filteredHistory.length === 0 ? <p className="admin-empty">Nenhum historico encontrado.</p> : null}
          </div>
        </section>

        {selectedAudit ? (
          <section className="admin-section admin-detail">
            <h2>Auditoria</h2>
            <dl>
              <div><dt>Match</dt><dd>{selectedAudit.matchId}</dd></div>
              <div><dt>Sala</dt><dd>{selectedAudit.roomId}</dd></div>
              <div><dt>Vencedor</dt><dd>{selectedAudit.winnerName ?? selectedAudit.player1?.name ?? '-'}</dd></div>
              <div><dt>Perdedor</dt><dd>{selectedAudit.loserName ?? selectedAudit.player2?.name ?? '-'}</dd></div>
              <div><dt>Mesa</dt><dd>{formatMoney(selectedAudit.tableValue)}</dd></div>
              <div><dt>Total</dt><dd>{formatMoney(selectedAudit.totalPot)}</dd></div>
              <div><dt>Taxa</dt><dd>{formatMoney(selectedAudit.platformFeeAmount)}</dd></div>
              <div><dt>Premio</dt><dd>{formatMoney(selectedAudit.winnerPrize)}</dd></div>
              <div><dt>Motivo</dt><dd>{reasonLabel(selectedAudit.finishReason ?? selectedAudit.result?.reason)}</dd></div>
              <div><dt>Duracao</dt><dd>{formatDuration(selectedAudit.durationSeconds)}</dd></div>
              <div><dt>Status</dt><dd>{selectedAudit.status}</dd></div>
            </dl>
            <div className="admin-log-list">
              {(selectedAudit.logs ?? []).slice(-20).map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`}>
                  <strong>{entry.action}</strong>
                  <span>{entry.accepted ? 'Aceita' : 'Rejeitada'}</span>
                  <small>{entry.reasonIfRejected || formatDate(entry.timestamp)}</small>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="admin-section">
          <h2>Logs admin</h2>
          <div className="admin-log-list">
            {(snapshot?.adminLogs ?? []).map((log) => (
              <div key={`${log.timestamp}-${log.adminAction}-${log.targetId}`}>
                <strong>{log.adminAction}</strong>
                <span>{log.result}</span>
                <small>{log.targetId} - {log.reason || formatDate(log.timestamp)}</small>
              </div>
            ))}
          </div>
        </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
