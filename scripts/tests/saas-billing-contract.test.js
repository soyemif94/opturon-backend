const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalizeContractAmount, normalizeContractCurrency,
  captureLocalBillingContract, resolveLocalBillingContract
} = require('../../src/services/saas-billing-contract');

const id = '00000000-0000-4000-8000-000000000001';
const clinicId = '00000000-0000-4000-8000-000000000002';
const capturedAt = '2026-09-29T00:00:00.000Z';
function legacy() {
  return {
    id, clinicId, externalTenantId: 'tenant-a', externalReference: `opturon:tenant-a:${id}`,
    planCode: 'inicial', amount: 40600, currency: 'ARS', billingInterval: 'monthly',
    metadata: { billingModel: 'pending_link', plan: { code: 'inicial', label: 'Plan Inicial', amount: 10000, currency: 'ARS' } }
  };
}
function native() {
  const row = legacy();
  row.metadata.contract = captureLocalBillingContract({
    plan: row.metadata.plan, subscriptionId: id, clinicId, externalTenantId: row.externalTenantId,
    externalReference: row.externalReference, capturedAt
  });
  return row;
}

test('exact NUMERIC(12,2) representation accepts equivalent decimals without arithmetic', () => {
  for (const value of [40600, '40600', '40600.00', ' 040600.0 ']) {
    assert.equal(canonicalizeContractAmount(value), '40600.00');
  }
  assert.equal(canonicalizeContractAmount(0.29), '0.29');
  assert.equal(canonicalizeContractAmount('0.01'), '0.01');
  assert.equal(canonicalizeContractAmount('9999999999.99'), '9999999999.99');
});
test('exact decimal parser rejects malformed, nonpositive, overflow and excess precision', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, '-1', 0, -0, '0.00', '', ' ', null,
    undefined, true, {}, [], '1e2', '1E+2', '+1', '1,20', '.20', '1.', '1.001', '1.000',
    '10000000000', 10000000000, 1e-7, 0.1 + 0.2, 'NaN', 'Infinity']) {
    assert.equal(canonicalizeContractAmount(value), null, `must reject ${String(value)}`);
  }
});
test('currency is explicit, normalized and recognized; missing never defaults to ARS', () => {
  assert.equal(normalizeContractCurrency(' ars '), 'ARS');
  assert.equal(normalizeContractCurrency('usd'), 'USD');
  for (const value of [null, undefined, '', 'ZZZ', 'AR', 1]) assert.equal(normalizeContractCurrency(value), null);
});
test('capture rejects invalid expectations before a contract can be stored', () => {
  const row = native();
  const input = { plan: row.metadata.plan, subscriptionId: id, clinicId, externalTenantId: 'tenant-a',
    externalReference: row.externalReference, capturedAt };
  for (const change of [{ plan: { ...input.plan, amount: '1.001' } }, { plan: { ...input.plan, currency: '' } },
    { externalReference: 'other' }, { capturedAt: '2026-02-30T00:00:00.000Z' }]) {
    assert.throws(() => captureLocalBillingContract({ ...input, ...change }), /invalid_local_billing_contract/);
  }
});
test('CASE I: native contract takes priority and resolver does not mutate or alias input', () => {
  const row = native();
  row.metadata.plan.amount = 123;
  const before = JSON.stringify(row);
  const resolved = resolveLocalBillingContract(row);
  assert.equal(resolved.status, 'KNOWN');
  assert.equal(resolved.source, 'contract');
  assert.equal(resolved.contract.amount, '10000.00');
  assert.equal(resolved.contract.capturedAt, capturedAt);
  assert.notEqual(resolved.contract, row.metadata.contract);
  assert.equal(Object.isFrozen(resolved.contract), true);
  assert.equal(JSON.stringify(row), before);
});
test('CASE J: coherent legacy snapshot and monthly pending-link provenance are known', () => {
  const row = legacy();
  row.metadata.plan.amount = '10000.0'; row.metadata.plan.currency = ' ars ';
  const resolved = resolveLocalBillingContract(row);
  assert.equal(resolved.status, 'KNOWN');
  assert.equal(resolved.source, 'legacy_metadata_plan');
  assert.equal(resolved.contract.amount, '10000.00');
  assert.equal(resolved.contract.frequency, 1);
  assert.equal(resolved.contract.frequencyType, 'months');
  assert.equal(resolved.contract.capturedAt, null, 'do not fabricate a capture timestamp');
});
test('CASE K: no local snapshot remains unknown even if row/provider values are present', () => {
  const row = legacy(); delete row.metadata.plan;
  row.metadata.mercadoPagoPreapproval = { auto_recurring: { transaction_amount: 40600, currency_id: 'ARS' } };
  assert.equal(resolveLocalBillingContract(row).status, 'UNKNOWN');
});
test('CASE L: contradictory plan codes are conflict', () => {
  const row = legacy(); row.metadata.plan.code = 'empresa';
  assert.deepEqual(resolveLocalBillingContract(row), {
    status: 'CONFLICT', source: 'legacy_metadata_plan', reasons: ['plan_code_conflict'], contract: null
  });
});
test('CASE M: malformed legacy amount is insufficient evidence, not a proven mismatch', () => {
  const row = legacy(); row.metadata.plan.amount = '12.345';
  assert.equal(resolveLocalBillingContract(row).status, 'UNKNOWN');
  assert.deepEqual(resolveLocalBillingContract(row).reasons, ['invalid_expected_amount']);
});
test('CASE N: missing legacy currency is unknown', () => {
  const row = legacy(); delete row.metadata.plan.currency;
  assert.equal(resolveLocalBillingContract(row).status, 'UNKNOWN');
});
test('CASE O: historical price survives current catalogue price differences', () => {
  const row = legacy(); row.metadata.plan.amount = '1234.56';
  assert.equal(resolveLocalBillingContract(row).contract.amount, '1234.56');
});
test('CASE P: mutable row drift is ignored as authority, in native and legacy modes', () => {
  for (const row of [native(), legacy()]) {
    row.amount = 1; row.currency = 'USD';
    const resolved = resolveLocalBillingContract(row);
    assert.equal(resolved.status, 'KNOWN');
    assert.equal(resolved.contract.amount, '10000.00');
    assert.equal(resolved.contract.currency, 'ARS');
  }
});
test('legacy generation or interval without proof stays unknown', () => {
  for (const change of ['billingModel', 'label', 'interval']) {
    const row = legacy();
    if (change === 'billingModel') delete row.metadata.billingModel;
    if (change === 'label') delete row.metadata.plan.label;
    if (change === 'interval') row.billingInterval = 'yearly';
    assert.equal(resolveLocalBillingContract(row).status, 'UNKNOWN');
  }
});
test('identity contradictions are conflicts; missing identity is unknown', () => {
  const row = legacy(); row.externalReference = `opturon:tenant-b:${id}`;
  assert.equal(resolveLocalBillingContract(row).status, 'CONFLICT');
  delete row.externalReference;
  assert.equal(resolveLocalBillingContract(row).status, 'UNKNOWN');
  for (const key of ['subscriptionId', 'clinicId', 'externalTenantId', 'externalReference']) {
    const other = native(); other.metadata.contract = { ...other.metadata.contract, [key]: 'other' };
    assert.equal(resolveLocalBillingContract(other).status, 'CONFLICT');
  }
});
test('B2: capture canonicalizes equivalent UUID casing without changing tenant or prefix', () => {
  const subscriptionId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const clinic = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
  const input = { plan: legacy().metadata.plan, subscriptionId: subscriptionId.toUpperCase(),
    clinicId: clinic.toUpperCase(), externalTenantId: 'Tenant-A',
    externalReference: `opturon:Tenant-A:${subscriptionId.toUpperCase()}`, capturedAt };
  const before = JSON.stringify(input);
  const contract = captureLocalBillingContract(input);
  assert.equal(contract.subscriptionId, subscriptionId);
  assert.equal(contract.clinicId, clinic);
  assert.equal(contract.externalTenantId, 'Tenant-A');
  assert.equal(contract.externalReference, `opturon:Tenant-A:${subscriptionId}`);
  assert.equal(JSON.stringify(input), before);
});

test('B2: native and legacy resolution accept independent UUID casing in rows and references', () => {
  const subscriptionId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const clinic = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
  for (const useNative of [false, true]) {
    for (const uppercaseRow of [false, true]) {
      for (const uppercaseReference of [false, true]) {
        const row = legacy();
        row.id = uppercaseRow ? subscriptionId.toUpperCase() : subscriptionId;
        row.clinicId = uppercaseRow ? clinic.toUpperCase() : clinic;
        row.externalReference = `opturon:tenant-a:${uppercaseReference ? subscriptionId.toUpperCase() : subscriptionId}`;
        if (useNative) row.metadata.contract = { ...native().metadata.contract,
          subscriptionId: uppercaseRow ? subscriptionId : subscriptionId.toUpperCase(),
          clinicId: uppercaseRow ? clinic : clinic.toUpperCase(),
          externalReference: `opturon:tenant-a:${uppercaseReference ? subscriptionId : subscriptionId.toUpperCase()}` };
        const before = JSON.stringify(row);
        const resolved = resolveLocalBillingContract(row);
        assert.equal(resolved.status, 'KNOWN');
        assert.equal(resolved.contract.subscriptionId, subscriptionId);
        assert.equal(resolved.contract.clinicId, clinic);
        assert.equal(resolved.contract.externalReference, `opturon:tenant-a:${subscriptionId}`);
        assert.equal(JSON.stringify(row), before);
      }
    }
  }
});

test('B2: UUID normalization does not accept another tenant, prefix, subscription or malformed reference', () => {
  for (const reference of [`Opturon:tenant-a:${id}`, `opturon:Tenant-a:${id}`,
    `opturon:tenant-b:${id}`, `opturon:tenant-a:${clinicId}`, `opturon:tenant-a:${id}:extra`,
    `opturon:tenant-a:${id.slice(1)}`, `prefix:opturon:tenant-a:${id}`]) {
    for (const row of [legacy(), native()]) {
      row.externalReference = reference;
      assert.equal(resolveLocalBillingContract(row).status, 'CONFLICT', reference);
    }
    const row = native(); row.metadata.contract = { ...row.metadata.contract, externalReference: reference };
    assert.equal(resolveLocalBillingContract(row).status, 'CONFLICT', reference);
  }
});

test('unknown/malformed native contract never downgrades to legacy evidence', () => {
  for (const contract of [null, [], {}, { ...native().metadata.contract, version: 2 },
    { ...native().metadata.contract, currency: '' }, { ...native().metadata.contract, source: 'provider' },
    { ...native().metadata.contract, frequency: 2 }, { ...native().metadata.contract, capturedAt: 'invalid' }]) {
    const row = legacy(); row.metadata.contract = contract;
    const resolved = resolveLocalBillingContract(row);
    assert.equal(resolved.status, 'UNKNOWN');
    assert.equal(resolved.source, 'contract');
    assert.equal(resolved.contract, null);
  }
});
