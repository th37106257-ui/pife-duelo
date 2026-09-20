import assert from 'node:assert/strict';
import { AsaasSandboxProvider } from '../server/src/financial/paymentProviders/AsaasSandboxProvider.js';

const apiKey = '$aact_hmlg_test_only';
const publicId = 'PD-TEST01';
const baseCustomer = { id: 'cus_test_001', externalReference: publicId };
const testCpfDigits = '1'.repeat(11);
const testCpfFormatted = `${testCpfDigits.slice(0, 3)}.${testCpfDigits.slice(3, 6)}.${testCpfDigits.slice(6, 9)}-${testCpfDigits.slice(9)}`;
const testCnpjDigits = '2'.repeat(14);
const testCnpjFormatted = `${testCnpjDigits.slice(0, 2)}.${testCnpjDigits.slice(2, 5)}.${testCnpjDigits.slice(5, 8)}/${testCnpjDigits.slice(8, 12)}-${testCnpjDigits.slice(12)}`;
const testPhone = `55${'3'.repeat(11)}`;
const response = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function providerWith(fetchImpl, sandboxTestCpfCnpj = '') {
  return new AsaasSandboxProvider({ apiKey, sandboxTestCpfCnpj, fetchImpl });
}

let calls = [];
let provider = providerWith(async (url, options = {}) => {
  calls.push({ url: new URL(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  return response({ data: [], totalCount: 0 });
});
await assert.rejects(
  () => provider.createOrFindCustomer({ publicId, name: 'Teste', phone: testPhone }),
  /ASAAS_SANDBOX_CUSTOMER_DOCUMENT_REQUIRED/,
);
assert.equal(calls.length, 1);
assert.equal(calls[0].method, 'GET');

calls = [];
provider = providerWith(async (url, options = {}) => {
  const call = { url: new URL(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
  calls.push(call);
  return call.method === 'GET'
    ? response({ data: [], totalCount: 0 })
    : response({ id: 'cus_test_new', ...call.body });
}, testCpfFormatted);
const created = await provider.createOrFindCustomer({ publicId, name: 'Teste', phone: testPhone });
assert.equal(created.id, 'cus_test_new');
assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
assert.equal(calls.find((call) => call.method === 'POST').body.cpfCnpj, testCpfDigits);

calls = [];
provider = providerWith(async (url, options = {}) => {
  calls.push({ url: new URL(url), method: options.method || 'GET' });
  return response({ data: [], totalCount: 0 });
}, '123.invalid.456');
await assert.rejects(
  () => provider.createOrFindCustomer({ publicId, name: 'Teste', phone: testPhone }),
  /ASAAS_SANDBOX_CUSTOMER_DOCUMENT_INVALID/,
);
assert.equal(calls.filter((call) => call.method === 'POST').length, 0);

calls = [];
provider = providerWith(async (url, options = {}) => {
  calls.push({ url: new URL(url), method: options.method || 'GET' });
  return response({ data: [{ ...baseCustomer, cpfCnpj: '***' }], totalCount: 1 });
});
assert.equal((await provider.createOrFindCustomer({ publicId })).id, baseCustomer.id);
assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);

calls = [];
provider = providerWith(async (url, options = {}) => {
  const call = { url: new URL(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
  calls.push(call);
  if (call.method === 'GET') return response({ data: [baseCustomer], totalCount: 1 });
  return response({ id: baseCustomer.id });
}, testCnpjFormatted);
const updated = await provider.createOrFindCustomer({ publicId });
assert.equal(updated.id, baseCustomer.id);
const puts = calls.filter((call) => call.method === 'PUT');
assert.equal(puts.length, 1);
assert.equal(puts[0].url.pathname, `/v3/customers/${baseCustomer.id}`);
assert.deepEqual(puts[0].body, { cpfCnpj: testCnpjDigits });

provider = providerWith(async () => response({
  data: [baseCustomer, { ...baseCustomer, id: 'cus_test_002' }],
  totalCount: 2,
}));
await assert.rejects(() => provider.findCustomerByExternalReference(publicId), /ASAAS_CUSTOMER_NOT_UNIQUE/);

provider = providerWith(async () => response({
  errors: [{
    code: 'invalid_object',
    description: 'Para criar esta cobrança é necessário preencher o CPF ou CNPJ do cliente.',
  }, {
    code: 'private_data',
    description: `Documento ${testCpfFormatted}, telefone ${testPhone} e teste@example.com inválidos.`,
  }],
}, { status: 400 }));
const requestError = await provider.request('/payments').then(
  () => null,
  (error) => error,
);
assert.equal(requestError.message, 'ASAAS_REQUEST_FAILED:400');
assert.equal(requestError.status, 400);
assert.equal(requestError.details[0].code, 'invalid_object');
assert.equal(requestError.details[0].description, 'Para criar esta cobrança é necessário preencher o CPF ou CNPJ do cliente.');
assert.match(requestError.details[1].description, /Documento \[REDACTED\]/);
assert.ok(!requestError.details[1].description.includes(testCpfFormatted));
assert.ok(!requestError.details[1].description.includes(testPhone));
assert.ok(!requestError.details[1].description.includes('teste@example.com'));

calls = [];
provider = providerWith(async (url, options = {}) => {
  calls.push({ url: new URL(url), method: options.method || 'GET', body: options.body });
  return response({ deleted: true });
});
await provider.cancelPayment('pay_test_001');
assert.equal(calls.length, 1);
assert.equal(calls[0].method, 'DELETE');
assert.equal(calls[0].url.pathname, '/v3/payments/pay_test_001');
assert.equal(calls[0].body, undefined);

console.log('Asaas Sandbox customer document and sanitized error tests passed.');
