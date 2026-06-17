export const OFFICIAL_TABLES = {
  2: { tableValue: 2, platformFeePercent: 10 },
  5: { tableValue: 5, platformFeePercent: 10 },
  10: { tableValue: 10, platformFeePercent: 15 },
  20: { tableValue: 20, platformFeePercent: 18 },
};

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calculatePrize(tableValue) {
  const normalizedTableValue = Number(tableValue);
  const config = OFFICIAL_TABLES[normalizedTableValue];

  if (!config) {
    return null;
  }

  const totalPot = roundCurrency(normalizedTableValue * 2);
  const platformFeeAmount = roundCurrency(totalPot * (config.platformFeePercent / 100));
  const winnerPrize = roundCurrency(totalPot - platformFeeAmount);

  return {
    tableValue: normalizedTableValue,
    playerEntry: roundCurrency(normalizedTableValue),
    totalPot,
    platformFeePercent: config.platformFeePercent,
    platformFeeAmount,
    winnerPrize,
  };
}

export function listOfficialTables() {
  return Object.keys(OFFICIAL_TABLES)
    .map((value) => calculatePrize(Number(value)))
    .filter(Boolean);
}

export function formatMoney(value) {
  return `R$${Number(value ?? 0).toFixed(2).replace('.', ',')}`;
}
