export function getItemTotals(item, deliveryDates) {
  let proposed = 0;
  let scheduledActual = 0;
  for (const date of deliveryDates) {
    const quantities = item.quantities?.[date.id] || {};
    proposed += toQuantity(quantities.proposed);
    scheduledActual += toQuantity(quantities.actual);
  }
  const catchUpActual = (item.catchUps || []).reduce((total, entry) => total + toQuantity(entry.qty), 0);
  const actual = scheduledActual + catchUpActual;
  const undelivered = Math.max(0, proposed - actual);
  const lastDeliveryDate = [
    ...deliveryDates
      .filter(date => toQuantity(item.quantities?.[date.id]?.actual) > 0)
      .map(date => date.date),
    ...(item.catchUps || []).filter(entry => toQuantity(entry.qty) > 0).map(entry => entry.date)
  ].sort().at(-1) || "";

  return {
    proposed,
    scheduledActual,
    catchUpActual,
    actual,
    proposedAmount: proposed * toQuantity(item.unitPrice),
    actualAmount: actual * toQuantity(item.unitPrice),
    undelivered,
    undeliveredAmount: undelivered * toQuantity(item.unitPrice),
    overDelivered: actual > proposed,
    lastDeliveryDate
  };
}

export function getRowStatus(item, deliveryDates) {
  const totals = getItemTotals(item, deliveryDates);
  if (totals.actual >= totals.proposed && totals.proposed > 0) return "fully";
  if (totals.actual > 0) return "partial";
  return "undelivered";
}

export function getLotTotals(lotData) {
  const totals = {
    proposed: 0,
    actual: 0,
    proposedAmount: 0,
    actualAmount: 0,
    undelivered: 0,
    undeliveredAmount: 0,
    byUnit: {}
  };
  for (const item of lotData.items) {
    const itemTotals = getItemTotals(item, lotData.deliveryDates);
    const unit = item.unit || "Unspecified";
    if (!totals.byUnit[unit]) {
      totals.byUnit[unit] = {
        proposed: 0,
        actual: 0,
        proposedAmount: 0,
        actualAmount: 0,
        undelivered: 0,
        undeliveredAmount: 0
      };
    }
    totals.byUnit[unit].proposed += itemTotals.proposed;
    totals.byUnit[unit].actual += itemTotals.actual;
    totals.byUnit[unit].proposedAmount += itemTotals.proposedAmount;
    totals.byUnit[unit].actualAmount += itemTotals.actualAmount;
    totals.byUnit[unit].undelivered += itemTotals.undelivered;
    totals.byUnit[unit].undeliveredAmount += itemTotals.undeliveredAmount;
    totals.proposed += itemTotals.proposed;
    totals.actual += itemTotals.actual;
    totals.proposedAmount += itemTotals.proposedAmount;
    totals.actualAmount += itemTotals.actualAmount;
    totals.undelivered += itemTotals.undelivered;
    totals.undeliveredAmount += itemTotals.undeliveredAmount;
  }
  return totals;
}

export function getMonthTotals(monthData, lots) {
  const totals = { undeliveredAmount: 0, lots: {} };
  if (!monthData || !monthData.lots || !Array.isArray(lots)) {
    return totals;
  }
  for (const lot of lots) {
    const lotData = monthData.lots[lot.id] || { items: [], deliveryDates: [] };
    const lotTotals = getLotTotals(lotData);
    totals.lots[lot.id] = lotTotals;
    totals.undeliveredAmount += lotTotals.undeliveredAmount;
  }
  return totals;
}

function toQuantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
