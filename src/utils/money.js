function pow10(exponent) {
  return 10n ** BigInt(exponent);
}

function parseScaledInteger(value, scale) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const match = raw.match(/^([+-])?(\d+)?(?:\.(\d+))?$/);
  if (!match) return null;

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] || '0';
  const fraction = match[3] || '';
  const padded = (fraction + '0'.repeat(scale + 1)).slice(0, scale + 1);
  const mainFraction = padded.slice(0, scale) || '';
  const roundDigit = Number(padded.slice(scale, scale + 1) || '0');

  let result = BigInt(whole) * pow10(scale);
  if (mainFraction) {
    result += BigInt(mainFraction);
  }
  if (roundDigit >= 5) {
    result += 1n;
  }

  return sign * result;
}

function scaledIntegerToNumber(value, scale) {
  const safe = BigInt(value || 0);
  const sign = safe < 0n ? '-' : '';
  const absolute = safe < 0n ? -safe : safe;
  const divisor = pow10(scale);
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  if (scale === 0) {
    return Number(`${sign}${whole.toString()}`);
  }

  return Number(`${sign}${whole.toString()}.${fraction.toString().padStart(scale, '0')}`);
}

function quantizeDecimal(value, scale, fallback = 0) {
  const parsed = parseScaledInteger(value, scale);
  if (parsed === null) return fallback;
  return scaledIntegerToNumber(parsed, scale);
}

function sumQuantized(values, scale) {
  const total = (Array.isArray(values) ? values : []).reduce((acc, value) => {
    const parsed = parseScaledInteger(value, scale);
    return acc + (parsed === null ? 0n : parsed);
  }, 0n);

  return scaledIntegerToNumber(total, scale);
}

function divideAndRound(numerator, denominator) {
  const safeNumerator = BigInt(numerator);
  const safeDenominator = BigInt(denominator);
  if (safeDenominator === 0n) {
    throw new Error('Cannot divide by zero.');
  }

  const quotient = safeNumerator / safeDenominator;
  const remainder = safeNumerator % safeDenominator;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const absoluteDenominator = safeDenominator < 0n ? -safeDenominator : safeDenominator;

  if (absoluteRemainder * 2n >= absoluteDenominator) {
    return quotient + (safeNumerator >= 0n ? 1n : -1n);
  }

  return quotient;
}

function calculateLineAmounts({ unitPrice, quantity, taxRate = 0, quantityScale = 0 }) {
  const unitPriceMinor = parseScaledInteger(unitPrice, 2);
  const quantityUnits = parseScaledInteger(quantity, quantityScale);
  const taxBasisPoints = parseScaledInteger(taxRate, 2);

  if (unitPriceMinor === null || quantityUnits === null || taxBasisPoints === null) {
    return null;
  }

  const quantityDivisor = pow10(quantityScale);
  const subtotalMinor = divideAndRound(unitPriceMinor * quantityUnits, quantityDivisor);
  const taxMinor = divideAndRound(subtotalMinor * taxBasisPoints, 10000n);
  const totalMinor = subtotalMinor + taxMinor;

  return {
    unitPrice: scaledIntegerToNumber(unitPriceMinor, 2),
    quantity: scaledIntegerToNumber(quantityUnits, quantityScale),
    taxRate: scaledIntegerToNumber(taxBasisPoints, 2),
    subtotalAmount: scaledIntegerToNumber(subtotalMinor, 2),
    taxAmount: scaledIntegerToNumber(taxMinor, 2),
    totalAmount: scaledIntegerToNumber(totalMinor, 2)
  };
}

module.exports = {
  quantizeDecimal,
  sumQuantized,
  calculateLineAmounts
};
