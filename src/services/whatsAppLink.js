function normalizeWhatsAppPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

export function buildWhatsAppChatUrl({ phone, message = 'jogar' } = {}) {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  if (!normalizedPhone) return null;

  const normalizedMessage = String(message || 'jogar').trim() || 'jogar';
  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(normalizedMessage)}`;
}

export function getOfficialWhatsAppBotNumber() {
  const viteNumber = import.meta.env?.VITE_WHATSAPP_BOT_NUMBER ?? '';
  const buildTimeNumber = typeof __PIFE_PUBLIC_WHATSAPP_BOT_NUMBER__ === 'undefined'
    ? ''
    : __PIFE_PUBLIC_WHATSAPP_BOT_NUMBER__;
  return normalizeWhatsAppPhone(viteNumber || buildTimeNumber);
}

export function buildOfficialWhatsAppLink({ message = 'jogar' } = {}) {
  return buildWhatsAppChatUrl({
    phone: getOfficialWhatsAppBotNumber(),
    message,
  });
}

export function buildWhatsAppMenuLink() {
  return buildOfficialWhatsAppLink({ message: 'menu' });
}

export function buildWhatsAppPlayLink() {
  return buildOfficialWhatsAppLink({ message: 'jogar' });
}

export function isWhatsAppFirstLobbyEnabled() {
  const viteValue = import.meta.env?.VITE_WHATSAPP_FIRST_LOBBY_ENABLED;
  if (typeof viteValue === 'string' && viteValue.trim()) {
    return viteValue.trim().toLowerCase() === 'true';
  }
  return typeof __PIFE_WHATSAPP_FIRST_LOBBY_ENABLED__ !== 'undefined'
    && __PIFE_WHATSAPP_FIRST_LOBBY_ENABLED__ === true;
}

export function resolveWhatsAppEntryBootstrapAction({
  hasEntryToken = false,
  hasStoredEntrySession = false,
  hasStoredMatchSession = false,
  entryAccess = null,
} = {}) {
  if (hasStoredEntrySession) {
    return entryAccess?.entryId && entryAccess?.linkedMatchId ? 'resume_match' : 'blocked';
  }
  if (hasEntryToken) {
    if (hasStoredMatchSession && entryAccess?.entryId && entryAccess?.linkedMatchId) return 'resume_match';
    return entryAccess?.entryId ? 'join_queue' : 'blocked';
  }
  return 'lobby';
}
