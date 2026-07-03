import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvolutionClient } from '../server/src/payments/EvolutionClient.js';
import { normalizePhone } from '../server/src/payments/PaymentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function mask(value) {
  const raw = String(value || '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
  if (!raw) return '';
  return '<present>';
}

loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(rootDir, 'server', '.env'));

const [, , targetArg, ...messageParts] = process.argv;
const targetPhone = normalizePhone(targetArg || '');
const message = messageParts.join(' ').trim() || 'teste pife duelo';

const baseUrl = process.env.EVOLUTION_API_URL || '';
const apiKey = process.env.EVOLUTION_API_KEY || '';
const instanceName = process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE || '';

const missing = [];
if (!baseUrl) missing.push('EVOLUTION_API_URL');
if (!apiKey) missing.push('EVOLUTION_API_KEY');
if (!instanceName) missing.push('EVOLUTION_INSTANCE_NAME');
if (!targetPhone) missing.push('NUMERO_DESTINO');

if (missing.length) {
  console.error('Falha: configuração ausente:', missing.join(', '));
  console.error('Uso: node scripts/test-evolution-send.js 5521999999999 "teste pife duelo"');
  process.exit(1);
}

const client = new EvolutionClient({
  baseUrl,
  apiKey,
  instanceName,
  timeoutMs: 15000,
});

console.log('Teste Evolution iniciado', {
  instanceName,
  targetPhone: mask(targetPhone),
  textLength: message.length,
});

try {
  const response = await client.sendText(targetPhone, message);
  console.log('Teste Evolution finalizado com sucesso', {
    instanceName,
    targetPhone: mask(targetPhone),
    response,
  });
} catch (error) {
  console.error('Teste Evolution falhou', {
    instanceName,
    targetPhone: mask(targetPhone),
    message: error.message,
  });
  process.exit(1);
}
