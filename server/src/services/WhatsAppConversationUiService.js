import { maskPhone, normalizePhone } from '../payments/PaymentService.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function noop() {}

function isSafeBotMessageKey(messageKey) {
  return Boolean(
    messageKey
    && typeof messageKey.id === 'string'
    && messageKey.id.trim()
    && typeof messageKey.remoteJid === 'string'
    && messageKey.remoteJid.includes('@')
    && messageKey.fromMe === true,
  );
}

function safeError(error) {
  return error?.message || error?.reason || String(error || 'unknown_error');
}

export class WhatsAppConversationUiService {
  constructor({
    client,
    enabled = false,
    clock = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    logInfo = noop,
    logWarn = noop,
  } = {}) {
    this.client = client;
    this.enabled = Boolean(enabled);
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.panels = new Map();
    this.conversationQueues = new Map();
    this.latestSequence = new Map();
  }

  isEnabled() {
    return this.enabled;
  }

  cleanupExpired() {
    const threshold = this.clock() - this.ttlMs;
    for (const [phone, panel] of this.panels.entries()) {
      if (Date.parse(panel.updatedAt || panel.createdAt || 0) < threshold) this.panels.delete(phone);
    }
  }

  getPanel(phone) {
    this.cleanupExpired();
    return this.panels.get(normalizePhone(phone)) ?? null;
  }

  enqueue(phone, task) {
    const normalizedPhone = normalizePhone(phone);
    const previous = this.conversationQueues.get(normalizedPhone) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.conversationQueues.set(normalizedPhone, current);
    return current.finally(() => {
      if (this.conversationQueues.get(normalizedPhone) === current) this.conversationQueues.delete(normalizedPhone);
    });
  }

  async sendTrackedBotMessage({ phone, content, sendNew }) {
    const result = await sendNew(content);
    return {
      result,
      messageKey: isSafeBotMessageKey(result?.messageKey) ? result.messageKey : null,
    };
  }

  async editTrackedBotMessage({ phone, content, messageKey }) {
    if (!isSafeBotMessageKey(messageKey)) return { ok: false, reason: 'unsafe_bot_message_key' };
    return this.client?.editTrackedMessage?.({ phone, text: content, messageKey })
      ?? { ok: false, reason: 'edit_not_supported' };
  }

  async deleteTrackedBotMessage({ phone, messageKey }) {
    if (!isSafeBotMessageKey(messageKey)) return { ok: false, reason: 'unsafe_bot_message_key' };
    return this.client?.deleteTrackedMessage?.({ phone, messageKey })
      ?? { ok: false, reason: 'delete_not_supported' };
  }

  updateConversationPanel({ phone, state, content, sendNew, isStateCurrent = null }) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || typeof sendNew !== 'function') {
      return Promise.resolve({ ok: false, reason: 'invalid_panel_request' });
    }
    if (!this.enabled) return sendNew(content);

    const sequence = (this.latestSequence.get(normalizedPhone) ?? 0) + 1;
    this.latestSequence.set(normalizedPhone, sequence);

    return this.enqueue(normalizedPhone, async () => {
      if (sequence !== this.latestSequence.get(normalizedPhone) || (isStateCurrent && !isStateCurrent())) {
        this.logWarn('WHATSAPP_PANEL_STALE_UPDATE_IGNORED', {
          phone: maskPhone(normalizedPhone),
          state,
        });
        return { ok: false, ignored: true, reason: 'stale_panel_update' };
      }

      const previous = this.getPanel(normalizedPhone);
      if (previous?.messageKey && isSafeBotMessageKey(previous.messageKey)) {
        this.logInfo('WHATSAPP_PANEL_EDIT_ATTEMPT', {
          phone: maskPhone(normalizedPhone),
          fromState: previous.currentPanelState,
          toState: state,
        });
        try {
          const edited = await this.editTrackedBotMessage({
            phone: normalizedPhone,
            content,
            messageKey: previous.messageKey,
          });
          if (edited?.ok !== false) {
            const updatedAt = new Date(this.clock()).toISOString();
            this.panels.set(normalizedPhone, {
              ...previous,
              currentPanelState: state,
              updatedAt,
            });
            this.logInfo('WHATSAPP_PANEL_EDIT_SUCCESS', {
              phone: maskPhone(normalizedPhone),
              state,
            });
            return { ...edited, panelUpdated: true, panelState: state };
          }
          this.logWarn('WHATSAPP_PANEL_EDIT_FAILED', {
            phone: maskPhone(normalizedPhone),
            state,
            reason: edited?.reason || 'edit_failed',
          });
        } catch (error) {
          this.logWarn('WHATSAPP_PANEL_EDIT_FAILED', {
            phone: maskPhone(normalizedPhone),
            state,
            reason: safeError(error),
          });
        }
      }

      let tracked;
      try {
        tracked = await this.sendTrackedBotMessage({ phone: normalizedPhone, content, sendNew });
      } catch (error) {
        return { ok: false, reason: safeError(error) };
      }
      const { result, messageKey } = tracked;
      if (result?.ok === false) return result;

      if (previous) {
        this.logInfo('WHATSAPP_PANEL_FALLBACK_NEW_MESSAGE', {
          phone: maskPhone(normalizedPhone),
          state,
        });
      }
      if (messageKey) {
        const timestamp = new Date(this.clock()).toISOString();
        this.panels.set(normalizedPhone, {
          phone: normalizedPhone,
          messageKey,
          currentPanelMessageId: messageKey.id,
          currentPanelState: state,
          createdAt: previous?.createdAt || timestamp,
          updatedAt: timestamp,
        });
        this.logInfo('WHATSAPP_PANEL_CREATED', {
          phone: maskPhone(normalizedPhone),
          state,
        });
      } else {
        this.panels.delete(normalizedPhone);
      }

      if (previous?.messageKey && messageKey && previous.messageKey.id !== messageKey.id) {
        this.logInfo('WHATSAPP_PANEL_DELETE_ATTEMPT', {
          phone: maskPhone(normalizedPhone),
          state: previous.currentPanelState,
        });
        try {
          const deleted = await this.deleteTrackedBotMessage({
            phone: normalizedPhone,
            messageKey: previous.messageKey,
          });
          if (deleted?.ok === false) {
            this.logWarn('WHATSAPP_PANEL_DELETE_FAILED', {
              phone: maskPhone(normalizedPhone),
              state: previous.currentPanelState,
              reason: deleted.reason || 'delete_failed',
            });
          } else {
            this.logInfo('WHATSAPP_PANEL_DELETE_SUCCESS', {
              phone: maskPhone(normalizedPhone),
              state: previous.currentPanelState,
            });
          }
        } catch (error) {
          this.logWarn('WHATSAPP_PANEL_DELETE_FAILED', {
            phone: maskPhone(normalizedPhone),
            state: previous.currentPanelState,
            reason: safeError(error),
          });
        }
      }

      return { ...result, panelCreated: Boolean(messageKey), panelState: state };
    });
  }

  retirePanel(phone, { deleteMessage = false } = {}) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return Promise.resolve({ ok: false, reason: 'invalid_phone' });
    return this.enqueue(normalizedPhone, async () => {
      const panel = this.panels.get(normalizedPhone);
      this.panels.delete(normalizedPhone);
      if (!this.enabled || !deleteMessage || !panel?.messageKey) return { ok: true, retired: Boolean(panel) };
      this.logInfo('WHATSAPP_PANEL_DELETE_ATTEMPT', {
        phone: maskPhone(normalizedPhone),
        state: panel.currentPanelState,
      });
      try {
        const result = await this.deleteTrackedBotMessage({ phone: normalizedPhone, messageKey: panel.messageKey });
        if (result?.ok === false) {
          this.logWarn('WHATSAPP_PANEL_DELETE_FAILED', {
            phone: maskPhone(normalizedPhone),
            state: panel.currentPanelState,
            reason: result.reason || 'delete_failed',
          });
        } else {
          this.logInfo('WHATSAPP_PANEL_DELETE_SUCCESS', {
            phone: maskPhone(normalizedPhone),
            state: panel.currentPanelState,
          });
        }
        return result;
      } catch (error) {
        this.logWarn('WHATSAPP_PANEL_DELETE_FAILED', {
          phone: maskPhone(normalizedPhone),
          state: panel.currentPanelState,
          reason: safeError(error),
        });
        return { ok: false, reason: safeError(error) };
      }
    });
  }
}

export default WhatsAppConversationUiService;
