import { calculatePrize } from '../../../src/shared/economy.js';
import { maskPhone } from '../payments/PaymentService.js';
import { buildPublicMatchReference } from './publicMatchReference.js';

function money(value) {
  return `R$${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, '0');
  const remainingSeconds = Math.floor(safeSeconds % 60).toString().padStart(2, '0');
  return `${minutes}m${remainingSeconds}s`;
}

function formatClock(value) {
  if (!value) return '--:--:--';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return '--:--:--';
  }
}

function victoryReasonLabel(reason) {
  const normalized = String(reason || '').toLowerCase();
  if (normalized.includes('knock')) return 'Batida normal';
  if (normalized.includes('disconnect') || normalized.includes('abandon')) return 'Abandono/desconexão';
  if (normalized.includes('timeout')) return 'Timeout';
  if (normalized.includes('admin')) return 'Admin';
  if (normalized.includes('surrender')) return 'Desistência';
  if (normalized.includes('forfeit')) return 'Desistência';
  if (normalized.includes('cancel')) return 'Cancelamento antes do início';
  if (normalized.includes('abort')) return 'Partida abortada antes do início';
  return 'Partida finalizada';
}

function findPlayer(gameState, playerId) {
  return (gameState?.players ?? []).find((player) => player.id === playerId) ?? null;
}

function buildReport(gameState, reason) {
  const finishedAt = gameState?.finishedAt || gameState?.result?.finishedAt || new Date().toISOString();
  const startedAt = gameState?.startedAt || null;
  const durationSeconds = startedAt
    ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000))
    : 0;
  const winnerId = gameState?.result?.winnerId ?? null;
  const loserId = gameState?.result?.loserId ?? null;
  const tableValue = gameState?.tableValue ?? gameState?.economy?.tableValue ?? null;
  const economy = gameState?.economy ?? calculatePrize(tableValue);

  return {
    matchId: gameState?.matchId ?? null,
    publicReference: gameState?.publicMatchReference || buildPublicMatchReference(gameState?.matchId),
    roomId: gameState?.roomId ?? null,
    table: tableValue,
    tableLabel: money(tableValue),
    prizeLabel: money(economy?.winnerPrize),
    startedAt,
    finishedAt,
    startedAtLabel: formatClock(startedAt),
    finishedAtLabel: formatClock(finishedAt),
    durationSeconds,
    durationLabel: formatDuration(durationSeconds),
    reason: reason || gameState?.result?.reason || gameState?.finishReason || 'match_finished',
    reasonLabel: victoryReasonLabel(reason || gameState?.result?.reason),
    terminalStatus: 'finished',
    winnerId,
    loserId,
    winner: findPlayer(gameState, winnerId),
    loser: findPlayer(gameState, loserId),
    players: (gameState?.players ?? []).map((player) => ({
      playerId: player.id,
      name: player.name ?? player.playerName ?? 'Jogador',
    })),
  };
}

function resultText(report, won) {
  return [
    won ? '🏆 Você venceu no Pife Duelo!' : '🎴 Partida encerrada no Pife Duelo',
    '',
    `Mesa: ${report.tableLabel}`,
    `Resultado: ${won ? 'Vitória' : 'Derrota'}`,
    `Duração: ${report.durationLabel}`,
    '',
    won
      ? 'Sua partida foi encerrada com sucesso.'
      : 'Sua entrada foi finalizada.',
    won
      ? 'Sua entrada foi liberada.'
      : 'Você já pode jogar novamente.',
    '',
    'O que deseja fazer agora?',
    '',
    '1️⃣ Jogar novamente',
    '2️⃣ Ver mesas',
    '3️⃣ Regras',
    '4️⃣ Suporte',
  ].join('\n');
}

function adminReportText(report, { queueCleaned, entriesReleased, entryStatuses = [] }) {
  const winnerName = report.winner?.name ?? 'Não identificado';
  const loserName = report.loser?.name ?? 'Não identificado';
  const participants = report.participantLabels?.length
    ? report.participantLabels.join(' / ')
    : 'não identificados';

  return [
    '📋 PARTIDA FINALIZADA',
    '',
    `Referência: ${report.publicReference}`,
    `Mesa: ${report.tableLabel}`,
    `Início: ${report.startedAtLabel}`,
    `Fim: ${report.finishedAtLabel}`,
    `Duração: ${report.durationLabel}`,
    `Jogadores: ${participants}`,
    '',
    'Vencedor:',
    `${winnerName} / ${report.winnerLabel || 'não identificado'}`,
    '',
    'Perdedor:',
    `${loserName} / ${report.loserLabel || 'não identificado'}`,
    '',
    'Motivo:',
    report.reasonLabel,
    '',
    `Fila limpa: ${queueCleaned ? 'SIM' : 'NÃO/APENAS WEB'}`,
    `Entradas liberadas: ${entriesReleased ? 'SIM' : 'NÃO/APENAS WEB'}`,
    `Status das entradas: ${entryStatuses.length ? entryStatuses.join(' / ') : 'não vinculado'}`,
    `Estado da partida: ${report.terminalStatus || 'finished'}`,
  ].join('\n');
}

function entryForPlayer(entries, playerId) {
  if (!playerId) return null;
  return entries.find((entry) => entry.playerId === playerId) ?? null;
}

export function createPostMatchFlow({
  entryService = null,
  whatsappBot = null,
  whatsappMatchQueue = null,
  whatsappEnabled = true,
  adminSummaryEnabled = false,
  logInfo = () => {},
  logWarn = () => {},
  logError = () => {},
} = {}) {
  const processedMatches = new Set();
  const adminSummaries = new Set();

  async function notifyPlayer(entry, report, won) {
    const target = entry?.notifyTo;
    if (!target || !whatsappBot?.send) return false;
    await whatsappBot.send(target, resultText(report, won));
    logInfo(won ? 'WHATSAPP_RESULT_SENT_TO_WINNER' : 'WHATSAPP_RESULT_SENT_TO_LOSER', {
      matchId: report.matchId,
      playerId: won ? report.winnerId : report.loserId,
      entryId: entry.entryId,
      phone: entry.phoneMasked ?? maskPhone(target),
      table: report.table,
    });
    return true;
  }

  async function notifyAdmins(report, cleanup) {
    const summaryKey = report.publicReference || buildPublicMatchReference(report.matchId);
    if (!adminSummaryEnabled) {
      logInfo('ADMIN_MATCH_SUMMARY_SKIPPED_DISABLED', { publicReference: summaryKey, reason: report.reason });
      return false;
    }
    if (adminSummaries.has(summaryKey)) return false;
    const adminNumbers = whatsappBot?.adminNumbers ?? [];
    if (!whatsappBot?.send || !adminNumbers.length) {
      logError('ADMIN_MATCH_SUMMARY_FAILED', { publicReference: summaryKey, reason: 'admin_or_sender_not_configured' });
      return false;
    }

    logInfo('ADMIN_MATCH_SUMMARY_ATTEMPT', {
      publicReference: summaryKey,
      reason: report.reason,
      admins: adminNumbers.map(maskPhone),
    });
    const text = adminReportText(report, cleanup);
    const results = await Promise.allSettled(adminNumbers.map((phone) => whatsappBot.send(phone, text)));
    const sent = results.some((result) => result.status === 'fulfilled');
    if (sent) {
      adminSummaries.add(summaryKey);
      logInfo('ADMIN_MATCH_SUMMARY_SUCCESS', {
        publicReference: summaryKey,
        admins: adminNumbers.map(maskPhone),
      });
      logInfo('ADMIN_MATCH_REPORT_SENT', {
        publicReference: summaryKey,
        admins: adminNumbers.map(maskPhone),
      });
    } else {
      logError('ADMIN_MATCH_SUMMARY_FAILED', {
        publicReference: summaryKey,
        reason: 'all_delivery_attempts_failed',
      });
    }
    return sent;
  }

  async function finishMatchAndNotify(gameState, reason = 'match_finished', { emitResult = null } = {}) {
    const matchId = String(gameState?.matchId || '').trim();
    if (!matchId) return { ok: false, reason: 'missing_match_id' };

    logInfo('MATCH_FINISH_STARTED', {
      matchId,
      table: gameState?.tableValue ?? gameState?.economy?.tableValue ?? null,
      reason,
    });

    if (processedMatches.has(matchId)) {
      logWarn('MATCH_FINISH_ALREADY_PROCESSED', { matchId, reason });
      if (typeof emitResult === 'function') emitResult(gameState, 'matchFinished');
      const repeatedReport = buildReport(gameState, reason);
      const adminSent = await notifyAdmins(repeatedReport, {
        queueCleaned: true,
        entriesReleased: true,
        entryStatuses: [],
      });
      return { ok: true, alreadyProcessed: true, report: repeatedReport, adminSent };
    }

    processedMatches.add(matchId);
    let releasedEntries = [];
    let queueCleanup = [];
    let winnerSent = false;
    let loserSent = false;
    let adminSent = false;

    try {
      releasedEntries = entryService?.finishEntriesForMatch?.({
        matchId,
        winnerId: gameState?.result?.winnerId ?? null,
        loserId: gameState?.result?.loserId ?? null,
        reason,
        includeNotificationTarget: true,
      }) ?? [];

      releasedEntries.forEach((entry) => {
        const payload = {
          playerId: entry.playerId ?? entry.phoneMasked ?? entry.entryId,
          entryId: entry.entryId,
          matchId,
          table: entry.selectedTable ?? gameState?.tableValue ?? null,
          status: entry.status,
          reason,
        };
        logInfo('PLAYER_RELEASE_AFTER_MATCH', payload);
        logInfo('PLAYER_RELEASED_AFTER_MATCH', payload);
        logInfo('PLAYER_ENTRY_RELEASED_AFTER_MATCH', payload);
      });

      queueCleanup = whatsappMatchQueue?.releaseActiveMatch?.(matchId) ?? [];
    } catch (error) {
      logError('POST_MATCH_CLEANUP_ERROR', {
        matchId,
        reason,
        message: error?.message ?? String(error),
        stack: error?.stack,
      });
    }

    const report = buildReport(gameState, reason);
    report.participantLabels = releasedEntries.map((entry) => entry.phoneMasked).filter(Boolean);
    report.winnerLabel = entryForPlayer(releasedEntries, report.winnerId)?.phoneMasked ?? null;
    report.loserLabel = entryForPlayer(releasedEntries, report.loserId)?.phoneMasked ?? null;
    if (typeof emitResult === 'function') emitResult(gameState, 'matchFinished');

    if (!whatsappEnabled) {
      logInfo('POST_MATCH_WHATSAPP_SKIPPED_DISABLED', {
        matchId,
        table: report.table,
        reason,
      });
      logWarn('POST_MATCH_WHATSAPP_DISABLED', {
        matchId,
        table: report.table,
        reason,
      });
    } else try {
      const winnerEntry = entryForPlayer(releasedEntries, report.winnerId);
      const loserEntry = entryForPlayer(releasedEntries, report.loserId);

      winnerSent = await notifyPlayer(winnerEntry, report, true);
      loserSent = await notifyPlayer(loserEntry, report, false);

      if (!winnerSent || !loserSent) {
        logWarn('POST_MATCH_FALLBACK_WEB_USED', {
          matchId,
          winnerHasWhatsApp: Boolean(winnerEntry?.notifyTo),
          loserHasWhatsApp: Boolean(loserEntry?.notifyTo),
          winnerSent,
          loserSent,
        });
      }

    } catch (error) {
      logError('POST_MATCH_CLEANUP_ERROR', {
        matchId,
        reason: 'whatsapp_notification_failed',
        message: error?.message ?? String(error),
        stack: error?.stack,
      });
      logWarn('POST_MATCH_FALLBACK_WEB_USED', {
        matchId,
        reason: 'whatsapp_notification_failed',
      });
    }

    try {
      adminSent = await notifyAdmins(report, {
        queueCleaned: queueCleanup.length > 0 || releasedEntries.length > 0,
        entriesReleased: releasedEntries.length > 0,
        entryStatuses: releasedEntries.map((entry) => entry.status).filter(Boolean),
      });
    } catch (error) {
      logError('ADMIN_MATCH_SUMMARY_FAILED', {
        publicReference: report.publicReference,
        reason: 'summary_exception',
        message: error?.message ?? String(error),
      });
    }

    logInfo('MATCH_FINISH_COMPLETED', {
      matchId,
      table: report.table,
      winnerId: report.winnerId,
      loserId: report.loserId,
      reason: report.reason,
      duration: report.durationSeconds,
      releasedEntries: releasedEntries.length,
      queueRemoved: queueCleanup.length,
      winnerSent,
      loserSent,
      adminSent,
      whatsappDisabled: !whatsappEnabled,
    });

    return {
      ok: true,
      alreadyProcessed: false,
      report,
      releasedEntries,
      queueCleanup,
      winnerSent,
      loserSent,
      adminSent,
      whatsappDisabled: !whatsappEnabled,
    };
  }

  async function notifyPendingMatchTerminal(result = {}) {
    const matchId = String(result.matchId || '').trim();
    if (!matchId) return { ok: false, reason: 'missing_match_id' };
    const participants = result.participants ?? [];
    const finishedAt = new Date().toISOString();
    const report = {
      matchId,
      publicReference: buildPublicMatchReference(matchId),
      table: result.table ?? participants[0]?.selectedTable ?? null,
      tableLabel: money(result.table ?? participants[0]?.selectedTable),
      startedAt: null,
      finishedAt,
      startedAtLabel: '--:--:--',
      finishedAtLabel: formatClock(finishedAt),
      durationLabel: '00m00s',
      reason: result.reason || 'pre_start_match_aborted',
      reasonLabel: victoryReasonLabel(result.reason || 'pre_start_match_aborted'),
      terminalStatus: 'aborted',
      winnerId: null,
      loserId: null,
      winner: null,
      loser: null,
      participantLabels: participants.map((entry) => entry.phoneMasked).filter(Boolean),
      winnerLabel: null,
      loserLabel: null,
    };
    const sent = await notifyAdmins(report, {
      queueCleaned: true,
      entriesReleased: participants.length > 0,
      entryStatuses: participants.map((entry) => entry.status).filter(Boolean),
    });
    return { ok: true, sent, report };
  }

  return { finishMatchAndNotify, notifyPendingMatchTerminal };
}

export default createPostMatchFlow;
