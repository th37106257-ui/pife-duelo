export function getOfficialWhatsAppBotNumber() {
  return String(import.meta.env.VITE_WHATSAPP_BOT_NUMBER || '').replace(/\D/g, '');
}

export function buildOfficialWhatsAppLink({ message = 'menu' } = {}) {
  const botNumber = getOfficialWhatsAppBotNumber();
  const encodedText = encodeURIComponent(String(message || 'menu'));

  return botNumber
    ? `https://wa.me/${botNumber}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;
}

export function buildWhatsAppMenuLink() {
  return buildOfficialWhatsAppLink({ message: 'menu' });
}

export function buildWhatsAppPlayLink() {
  return buildOfficialWhatsAppLink({ message: 'jogar' });
}
