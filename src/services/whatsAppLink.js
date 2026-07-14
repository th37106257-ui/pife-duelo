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
