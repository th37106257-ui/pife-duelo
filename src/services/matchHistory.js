import { getServerUrl } from './serverUrl.js';

async function readJson(response) {
  if (!response.ok) {
    throw new Error('Nao foi possivel carregar o historico.');
  }
  return response.json();
}

export async function fetchMatchHistory() {
  const payload = await fetch(`${getServerUrl()}/api/match-history`).then(readJson);
  return payload.history ?? [];
}

export async function fetchMatchAudit(matchId) {
  const payload = await fetch(`${getServerUrl()}/api/match-history/${matchId}/audit`).then(readJson);
  return payload.audit ?? null;
}
