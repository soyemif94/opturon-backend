const MOJIBAKE_REPLACEMENTS = [
  ['Ã¡', 'á'],
  ['Ã©', 'é'],
  ['Ã­', 'í'],
  ['Ã³', 'ó'],
  ['Ãº', 'ú'],
  ['Ã', 'Á'],
  ['Ã‰', 'É'],
  ['Ã', 'Í'],
  ['Ã“', 'Ó'],
  ['Ãš', 'Ú'],
  ['Ã±', 'ñ'],
  ['Ã‘', 'Ñ'],
  ['Ã¼', 'ü'],
  ['Ãœ', 'Ü'],
  ['Â¿', '¿'],
  ['Â¡', '¡'],
  ['â', '"'],
  ['â', '"'],
  ['â', "'"],
  ['â', "'"],
  ['â', '-'],
  ['â', '-'],
  ['â¦', '...'],
  ['Â', '']
];

function normalizeString(value) {
  return String(value || '').trim();
}

function repairPotentialMojibake(value) {
  let nextValue = String(value || '');
  for (const [broken, repaired] of MOJIBAKE_REPLACEMENTS) {
    if (nextValue.includes(broken)) {
      nextValue = nextValue.split(broken).join(repaired);
    }
  }

  return nextValue;
}

function normalizeHumanText(value) {
  const safe = repairPotentialMojibake(value);
  return safe.normalize ? safe.normalize('NFC').trim() : safe.trim();
}

function normalizeTransferFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const safe = normalizeHumanText(value).toLowerCase();
  if (!safe) return fallback;
  return safe === 'true' || safe === '1' || safe === 'yes' || safe === 'si' || safe === 'sí';
}

function normalizeTransferConfig(rawConfig, fallbackEnabled = false) {
  const safe = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const alias = normalizeHumanText(safe.alias);
  const cbu = normalizeString(safe.cbu).replace(/\s+/g, '');
  const titular = normalizeHumanText(safe.titular || safe.holderName);
  const bank = normalizeHumanText(safe.bank || safe.bankName);
  const instructions = normalizeHumanText(safe.instructions);
  const destinationId = normalizeString(safe.destinationId) || null;
  const reference = normalizeHumanText(safe.reference) || null;
  const enabled = normalizeTransferFlag(safe.enabled, fallbackEnabled);

  return {
    enabled,
    alias,
    cbu,
    titular,
    bank,
    instructions,
    destinationId,
    reference,
    holderName: titular,
    bankName: bank
  };
}

function hasConfiguredTransferData(transferConfig) {
  if (!transferConfig || typeof transferConfig !== 'object') return false;
  return Boolean(
    normalizeHumanText(transferConfig.alias) ||
    normalizeString(transferConfig.cbu) ||
    normalizeHumanText(transferConfig.titular || transferConfig.holderName) ||
    normalizeHumanText(transferConfig.bank || transferConfig.bankName)
  );
}

function validateTransferConfig(rawConfig) {
  const config = normalizeTransferConfig(rawConfig, false);
  const errors = {};

  if (config.enabled && !config.alias && !config.cbu) {
    errors.general = 'Para activar transferencia, cargá al menos alias o CBU.';
  }

  if (config.alias && !/^[a-z0-9._-]{6,40}$/i.test(config.alias)) {
    errors.alias = 'El alias tiene que tener entre 6 y 40 caracteres y usar solo letras, números, punto, guion o guion bajo.';
  }

  if (config.cbu && !/^\d{22}$/.test(config.cbu)) {
    errors.cbu = 'El CBU debe tener 22 dígitos numéricos.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    config
  };
}

function buildTransferInstructionsText(rawConfig) {
  const transferConfig = normalizeTransferConfig(rawConfig, false);
  const lines = [
    'Perfecto.',
    '',
    'Podés pagar por transferencia con estos datos:'
  ];

  if (transferConfig.alias) lines.push(`- Alias: ${transferConfig.alias}`);
  if (transferConfig.cbu) lines.push(`- CBU: ${transferConfig.cbu}`);
  if (transferConfig.titular) lines.push(`- Titular: ${transferConfig.titular}`);
  if (transferConfig.bank) lines.push(`- Banco: ${transferConfig.bank}`);
  if (transferConfig.reference) lines.push(`- Referencia: ${transferConfig.reference}`);

  lines.push('');
  lines.push(
    transferConfig.instructions ||
    'Cuando hagas la transferencia, mandame el comprobante por acá y lo dejo registrado para revision.'
  );

  return lines.join('\n');
}

module.exports = {
  buildTransferInstructionsText,
  hasConfiguredTransferData,
  normalizeHumanText,
  normalizeTransferConfig,
  normalizeTransferFlag,
  validateTransferConfig
};
