import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const DEMO_CREDITS_SCHEMA_VERSION = 1;

export function createEmptyDemoCreditsState() {
  return {
    schemaVersion: DEMO_CREDITS_SCHEMA_VERSION,
    accounts: {},
    reservations: [],
    ledger: [],
  };
}

function validateState(state) {
  if (!state || state.schemaVersion !== DEMO_CREDITS_SCHEMA_VERSION) {
    throw new Error('DEMO_CREDITS_STORE_SCHEMA_INVALID');
  }
  if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
    throw new Error('DEMO_CREDITS_ACCOUNTS_INVALID');
  }
  if (!Array.isArray(state.reservations) || !Array.isArray(state.ledger)) {
    throw new Error('DEMO_CREDITS_LEDGER_INVALID');
  }
  Object.values(state.accounts).forEach((account) => {
    for (const field of ['availableBalance', 'reservedBalance']) {
      if (!Number.isFinite(account?.[field]) || account[field] < 0) {
        throw new Error('DEMO_BALANCE_INCONSISTENCY');
      }
    }
  });
  return state;
}

export class DemoCreditsRepository {
  constructor({ filePath = null, initialState = null, clock = Date.now } = {}) {
    this.filePath = filePath ? String(filePath) : null;
    this.clock = clock;
    this.state = initialState ? validateState(structuredClone(initialState)) : this.load();
  }

  isPersistent() {
    return Boolean(this.filePath);
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return createEmptyDemoCreditsState();
    try {
      return validateState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (String(error?.message || '').startsWith('DEMO_')) throw error;
      throw new Error(`DEMO_CREDITS_STORE_INVALID: ${error.message}`);
    }
  }

  acquireFileLock() {
    if (!this.filePath) return null;
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      return { descriptor: openSync(lockPath, 'wx', 0o600), lockPath };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        try {
          const ageMs = this.clock() - statSync(lockPath).mtimeMs;
          if (ageMs > 30_000) {
            unlinkSync(lockPath);
            return { descriptor: openSync(lockPath, 'wx', 0o600), lockPath };
          }
        } catch {
          // A segunda tentativa abaixo produz um erro controlado.
        }
        throw new Error('DEMO_CREDITS_STORE_BUSY');
      }
      throw error;
    }
  }

  releaseFileLock(lock) {
    if (!lock) return;
    try { closeSync(lock.descriptor); } catch {}
    try { unlinkSync(lock.lockPath); } catch {}
  }

  persist(nextState) {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    if (existsSync(this.filePath)) copyFileSync(this.filePath, `${this.filePath}.bak`);
    writeFileSync(temporaryPath, JSON.stringify(nextState, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  transaction(mutator) {
    const lock = this.acquireFileLock();
    try {
      if (this.filePath && existsSync(this.filePath)) this.state = this.load();
      const nextState = structuredClone(this.state);
      const result = mutator(nextState);
      validateState(nextState);
      this.persist(nextState);
      this.state = nextState;
      return structuredClone(result);
    } finally {
      this.releaseFileLock(lock);
    }
  }

  snapshot() {
    if (this.filePath && existsSync(this.filePath)) this.state = this.load();
    return structuredClone(this.state);
  }
}

export default DemoCreditsRepository;
