import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function createEmptyState() {
  return {
    version: 1,
    nextEntryNumber: 2000,
    entries: [],
    processedMessageIds: [],
  };
}

export class WhatsAppEntryStore {
  constructor({ filePath = null, initialState = null } = {}) {
    this.filePath = filePath;
    this.state = initialState ? structuredClone(initialState) : this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return createEmptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        ...createEmptyState(),
        ...parsed,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        processedMessageIds: Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : [],
      };
    } catch (error) {
      throw new Error(`WHATSAPP_ENTRY_STORE_INVALID: ${error.message}`);
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  nextEntryId() {
    const entryId = `E${this.state.nextEntryNumber}`;
    this.state.nextEntryNumber += 1;
    this.persist();
    return entryId;
  }

  listEntries() {
    return structuredClone(this.state.entries);
  }

  getEntry(entryId) {
    const entry = this.state.entries.find((item) => item.entryId === String(entryId));
    return entry ? structuredClone(entry) : null;
  }

  createEntry(entry) {
    if (this.state.entries.some((item) => item.entryId === entry.entryId)) {
      throw new Error('ENTRY_ID_ALREADY_EXISTS');
    }
    this.state.entries.push(structuredClone(entry));
    this.persist();
    return structuredClone(entry);
  }

  updateEntry(entryId, updater) {
    const index = this.state.entries.findIndex((item) => item.entryId === String(entryId));
    if (index < 0) throw new Error('ENTRY_NOT_FOUND');
    const next = updater(structuredClone(this.state.entries[index]));
    this.state.entries[index] = structuredClone(next);
    this.persist();
    return structuredClone(next);
  }

  hasProcessedMessage(messageId) {
    return this.state.processedMessageIds.includes(String(messageId));
  }

  markMessageProcessed(messageId) {
    const normalized = String(messageId || '').trim();
    if (!normalized || this.hasProcessedMessage(normalized)) return false;
    this.state.processedMessageIds.push(normalized);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-2000);
    this.persist();
    return true;
  }
}

export default WhatsAppEntryStore;
