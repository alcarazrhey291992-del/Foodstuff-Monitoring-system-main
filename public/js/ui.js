import { LOTS } from "./db.js";
import { getItemTotals, getLotTotals, getMonthTotals, getRowStatus } from "./matrix.js";

const moneyFormat = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const quantityFormat = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 3 });
const dateFormat = new Intl.DateTimeFormat("en-PH", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Manila"
});

export function formatMoney(value) {
  return moneyFormat.format(Number.isFinite(value) ? value : 0);
}

export function formatQuantity(value) {
  return quantityFormat.format(Number.isFinite(value) ? value : 0);
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

function textElement(tagName, text, className) {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function lotLabel(lot) {
  return lot.description ? `${lot.name} · ${lot.description}` : lot.name;
}

function makeInput({ value, type = "text", className = "", min, step, maxLength, rowIndex, columnIndex, field, label }) {
  const input = document.createElement("input");
  input.type = type;
  input.value = value ?? "";
  input.className = className;
  input.setAttribute("aria-label", label);
  input.dataset.rowIndex = String(rowIndex);
  input.dataset.columnIndex = String(columnIndex);
  input.dataset.field = field;
  if (type === "number") {
    input.min = String(min ?? 0);
    input.step = String(step ?? "any");
    input.inputMode = "decimal";
  }
  if (maxLength) input.maxLength = maxLength;
  return input;
}

function makeUnitSelect(units, value, rowIndex, label) {
  const select = document.createElement("select");
  select.className = "unit-input";
  select.setAttribute("aria-label", label);
  select.dataset.rowIndex = String(rowIndex);
  select.dataset.columnIndex = "0";
  select.dataset.field = "unit";
  for (const unit of units) {
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = unit;
    option.selected = unit === value;
    select.append(option);
  }
  return select;
}

function makeCell(content, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else if (content !== undefined && content !== null) cell.textContent = String(content);
  return cell;
}

function makeHeader(label, options = {}) {
  const th = document.createElement("th");
  th.textContent = label;
  if (options.rowSpan) th.rowSpan = options.rowSpan;
  if (options.colSpan) th.colSpan = options.colSpan;
  if (options.className) th.className = options.className;
  return th;
}

function dateCellHeader(date, dateIndex, totalDates) {
  const th = makeHeader("", { colSpan: 2, className: "date-group" });
  const wrapper = document.createElement("div");
  wrapper.className = "date-heading";
  wrapper.append(textElement("span", formatDate(date.date), "date-label"));
  const actions = document.createElement("span");
  actions.className = "date-actions";
  const up = document.createElement("button");
  up.type = "button";
  up.textContent = "↑";
  up.disabled = dateIndex === 0;
  up.setAttribute("aria-label", `Move ${formatDate(date.date)} earlier`);
  up.dataset.action = "move-date";
  up.dataset.dateId = date.id;
  up.dataset.direction = "-1";
  const down = document.createElement("button");
  down.type = "button";
  down.textContent = "↓";
  down.disabled = dateIndex === totalDates - 1;
  down.setAttribute("aria-label", `Move ${formatDate(date.date)} later`);
  down.dataset.action = "move-date";
  down.dataset.dateId = date.id;
  down.dataset.direction = "1";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Delete ${formatDate(date.date)} delivery date`);
  remove.dataset.action = "delete-date";
  remove.dataset.dateId = date.id;
  actions.append(up, down, remove);
  wrapper.append(actions);
  th.append(wrapper);
  return th;
}

function createRow(item, rowIndex, lotData, units) {
  const row = document.createElement("tr");
  row.className = `row-${getRowStatus(item, lotData.deliveryDates)}-delivered`;
  row.dataset.itemId = item.id;
  const unitCell = makeCell();
  unitCell.className = "sticky-unit";
  unitCell.append(makeUnitSelect(units, item.unit, rowIndex, `${item.name || "Item"} unit`));
  makeCommentable(unitCell, item.id, "unit");
  row.append(unitCell);

  const nameCell = makeCell();
  nameCell.className = "sticky-item";
  nameCell.append(makeInput({
    value: item.name, className: "item-input", rowIndex, columnIndex: 1, field: "name",
    label: "Item name", maxLength: 160
  }));
  const history = document.createElement("ul");
  history.className = "item-history";
  history.setAttribute("aria-label", "Catch-up delivery history");
  const entries = [...(item.catchUps || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length) {
    for (const entry of entries) {
      const line = document.createElement("li");
      line.textContent = `${formatDate(entry.date)} · ${formatQuantity(Number(entry.qty))} ${item.unit}`;
      if (entry.remarks) line.title = entry.remarks;
      makeCommentable(line, item.id, "catchUp", "", entry.id);
      history.append(line);
    }
    nameCell.append(history);
  } else {
    nameCell.append(textElement("div", "No catch-up records", "empty-history"));
  }
  makeCommentable(nameCell, item.id, "item");
  row.append(nameCell);

  const price = makeInput({
    value: item.unitPrice, type: "number", className: "numeric-input", rowIndex, columnIndex: 2,
    field: "unitPrice", label: `${item.name || "Item"} unit price`
  });
  const priceCell = makeCell(price);
  makeCommentable(priceCell, item.id, "unitPrice");
  row.append(priceCell);
  const totalAmountCell = makeCell(formatMoney(Number(item.unitPrice || 0) * Number(item.orderQty || 0)), "money-cell");
  makeCommentable(totalAmountCell, item.id, "totalAmount");
  row.append(totalAmountCell);
  const orderQty = makeInput({
    value: item.orderQty, type: "number", className: "numeric-input", rowIndex, columnIndex: 3,
    field: "orderQty", label: `${item.name || "Item"} monthly order quantity`
  });
  const orderQtyCell = makeCell(orderQty, "qty-cell");
  makeCommentable(orderQtyCell, item.id, "orderQty");
  row.append(orderQtyCell);

  let spreadsheetColumn = 4;
  for (const date of lotData.deliveryDates) {
    const quantities = item.quantities?.[date.id] || { proposed: 0, actual: 0 };
    const proposed = makeInput({
      value: quantities.proposed, type: "number", className: "numeric-input", rowIndex,
      columnIndex: spreadsheetColumn++, field: `proposed:${date.id}`,
      label: `${item.name || "Item"} proposed quantity for ${formatDate(date.date)}`
    });
    const proposedCell = makeCell(proposed, "qty-cell");
    makeCommentable(proposedCell, item.id, "proposed", date.id);
    const actual = makeInput({
      value: quantities.actual, type: "number", className: "numeric-input", rowIndex,
      columnIndex: spreadsheetColumn++, field: `actual:${date.id}`,
      label: `${item.name || "Item"} actual quantity for ${formatDate(date.date)}`
    });
    const actualCell = makeCell(actual, "qty-cell");
    makeCommentable(actualCell, item.id, "actual", date.id);
    if (Number(quantities.actual || 0) < Number(quantities.proposed || 0)) actualCell.classList.add("discrepancy");
    row.append(proposedCell, actualCell);
  }

  const totals = getItemTotals(item, lotData.deliveryDates);
  const statusText = totals.overDelivered
    ? "Over-delivered"
    : totals.undelivered === 0 && totals.proposed > 0
      ? "Fully Delivered"
      : totals.actual > 0
        ? `Partially Delivered · ${formatQuantity(totals.undelivered)} remaining`
        : "Undelivered";
  const proposedTotalCell = makeCell(formatMoney(totals.proposedAmount), "money-cell");
  makeCommentable(proposedTotalCell, item.id, "totalProposed");
  row.append(proposedTotalCell);
  const actualTotalCell = makeCell(formatMoney(totals.actualAmount), "money-cell");
  makeCommentable(actualTotalCell, item.id, "totalActual");
  row.append(actualTotalCell);
  const undeliveredCell = document.createElement("td");
  undeliveredCell.className = `qty-cell${totals.overDelivered ? " over-delivered" : ""}`;
  makeCommentable(undeliveredCell, item.id, "undelivered");
  undeliveredCell.append(textElement("strong", formatQuantity(totals.undelivered)));
  undeliveredCell.append(textElement("div", statusText, "status-label"));
  const lastDelivery = totals.lastDeliveryDate
    ? `Last delivery: ${formatDate(totals.lastDeliveryDate)}`
    : "No delivery recorded";
  undeliveredCell.append(textElement("div", lastDelivery, "status-label"));
  const logButton = document.createElement("button");
  logButton.type = "button";
  logButton.className = "small-button";
  logButton.textContent = "Log Delivery";
  logButton.dataset.action = "log-catchup";
  logButton.dataset.itemId = item.id;
  undeliveredCell.append(logButton);
  row.append(undeliveredCell);
  const undeliveredAmountCell = makeCell(formatMoney(totals.undeliveredAmount), "money-cell");
  makeCommentable(undeliveredAmountCell, item.id, "undeliveredAmount");
  row.append(undeliveredAmountCell);

  const actions = document.createElement("td");
  actions.className = "cell-action";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small-button";
  remove.textContent = "Delete row";
  remove.dataset.action = "delete-item";
  remove.dataset.itemId = item.id;
  actions.append(remove);
  row.append(actions);
  return row;
}

function makeFooterCell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function makeCommentable(element, itemId, columnKey, deliveryDateId = "", catchUpId = "") {
  element.dataset.commentCell = "true";
  element.dataset.commentItemId = itemId;
  element.dataset.commentColumnKey = columnKey;
  if (deliveryDateId) element.dataset.commentDeliveryDateId = deliveryDateId;
  if (catchUpId) element.dataset.commentCatchUpId = catchUpId;
  element.classList.add("comment-target");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cell-comment-trigger";
  button.dataset.action = "open-comment";
  button.textContent = "＋";
  button.setAttribute("aria-label", "Open comments for this cell");
  element.append(button);
}

function renderFooter(foot, lotData) {
  foot.replaceChildren();
  const rows = Object.entries(getLotTotals(lotData).byUnit).sort(([a], [b]) => a.localeCompare(b));
  for (const [unit, totals] of rows) {
    const row = document.createElement("tr");
    const label = makeFooterCell(`TOTAL · ${unit}`);
    label.colSpan = 4;
    row.append(label, makeFooterCell("—", "qty-cell"));
    for (let index = 0; index < lotData.deliveryDates.length * 2; index += 1) row.append(makeFooterCell("—"));
    row.append(
      makeFooterCell(formatMoney(totals.proposedAmount), "money-cell"),
      makeFooterCell(formatMoney(totals.actualAmount), "money-cell"),
      makeFooterCell(formatQuantity(totals.undelivered), "qty-cell"),
      makeFooterCell(formatMoney(totals.undeliveredAmount), "money-cell")
    );
    row.append(makeFooterCell("—", "cell-action"));
    foot.append(row);
  }
  const grand = getLotTotals(lotData);
  const totalRow = document.createElement("tr");
  const label = makeFooterCell("LOT GRAND TOTAL");
  label.colSpan = 4;
  totalRow.append(label, makeFooterCell("—", "qty-cell"));
  for (let index = 0; index < lotData.deliveryDates.length * 2; index += 1) totalRow.append(makeFooterCell("—"));
  totalRow.append(
    makeFooterCell(formatMoney(grand.proposedAmount), "money-cell"),
    makeFooterCell(formatMoney(grand.actualAmount), "money-cell"),
    makeFooterCell("By unit above", "qty-cell"),
    makeFooterCell(formatMoney(grand.undeliveredAmount), "money-cell"),
    makeFooterCell("—", "cell-action")
  );
  foot.append(totalRow);
}

export function renderLotTabs(container, activeLotId, onSelect) {
  container.replaceChildren();
  for (const lot of LOTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `lot-tab${lot.id === activeLotId ? " active" : ""}`;
    button.textContent = lotLabel(lot);
    button.setAttribute("aria-pressed", String(lot.id === activeLotId));
    button.addEventListener("click", () => onSelect(lot.id));
    container.append(button);
  }
}

export function renderMatrix({ monthData, lotId, units, year, monthNumber }) {
  const safeMonthData = monthData && monthData.lots ? monthData : { lots: {} };
  for (const lot of LOTS) {
    if (!safeMonthData.lots[lot.id]) {
      safeMonthData.lots[lot.id] = { deliveryDates: [], items: [] };
    }
  }
  const lot = LOTS.find(entry => entry.id === lotId) || LOTS[0];
  const lotData = safeMonthData.lots[lotId] || { deliveryDates: [], items: [] };
  document.getElementById("periodHeading").textContent =
    `${new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" }).format(new Date(Date.UTC(year, monthNumber - 1, 1, 12)))} · Monthly market order and delivery monitoring`;
  document.getElementById("lotDescription").textContent = `Enter the complete monthly market order and track each ${(lot.description || lot.name).toLocaleLowerCase()} delivery.`;
  document.getElementById("activeLotHeading").textContent = lotLabel(lot);
  document.getElementById("itemCount").textContent = `${lotData.items.length} ${lotData.items.length === 1 ? "item" : "items"}`;
  const head = document.getElementById("matrixHead");
  head.replaceChildren();
  const firstRow = document.createElement("tr");
  for (const [label, className] of [["Unit", "sticky-unit"], ["Item", "sticky-item"], ["Unit Price", ""], ["Total Amount", ""], ["Quantity", ""]]) {
    firstRow.append(makeHeader(label, { rowSpan: 2, className }));
  }
  for (const [index, date] of lotData.deliveryDates.entries()) {
    firstRow.append(dateCellHeader(date, index, lotData.deliveryDates.length));
  }
  for (const label of [
    "Total Amount of Proposed Deliveries (PHP)",
    "Total Amount Actually Delivered (PHP)",
    "Quantity of Undelivered Items",
    "Undelivered Amount (PHP)"
  ]) {
    firstRow.append(makeHeader(label, { rowSpan: 2 }));
  }
  firstRow.append(makeHeader("Actions", { rowSpan: 2 }));
  const secondRow = document.createElement("tr");
  for (let index = 0; index < lotData.deliveryDates.length; index += 1) {
    secondRow.append(makeHeader("Proposed", { className: "date-subhead" }), makeHeader("Actual", { className: "date-subhead" }));
  }
  head.append(firstRow, secondRow);

  const body = document.getElementById("matrixBody");
  body.replaceChildren();
  if (lotData.items.length === 0) {
    const row = document.createElement("tr");
    const cell = makeFooterCell("No items in this lot yet. Add a row to enter the monthly market order.");
    cell.colSpan = 10 + lotData.deliveryDates.length * 2;
    cell.className = "empty-row";
    row.append(cell);
    body.append(row);
  } else {
    const columnLabels = [
      "Unit", "Item", "Unit Price", "Total Amount", "Monthly Quantity",
      ...lotData.deliveryDates.flatMap(date => [
        `${formatDate(date.date)} · Proposed`, `${formatDate(date.date)} · Actual`
      ]),
      "Proposed Deliveries (PHP)", "Actually Delivered (PHP)",
      "Undelivered Quantity", "Undelivered Amount (PHP)", "Actions"
    ];
    lotData.items.forEach((item, index) => {
      const row = createRow(item, index, lotData, units);
      row.querySelectorAll("td").forEach((cell, cellIndex) => {
        cell.dataset.label = columnLabels[cellIndex] || "";
      });
      body.append(row);
    });
  }
  renderFooter(document.getElementById("matrixFoot"), lotData);
}

export function renderMonthSummary(container, monthData, onSelectLot = () => {}) {
  if (!monthData || !monthData.lots) {
    document.getElementById("monthUndeliveredAmount").textContent = formatMoney(0);
    document.getElementById("monthUndeliveredQuantity").textContent = "Across all lots: loading...";
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "summary-loading";
    loading.textContent = "Loading month data...";
    container.append(loading);
    return;
  }

  const totals = getMonthTotals(monthData, LOTS);
  document.getElementById("monthUndeliveredAmount").textContent = formatMoney(totals.undeliveredAmount);
  const byUnit = {};
  for (const summary of Object.values(totals.lots)) {
    for (const [unit, value] of Object.entries(summary.byUnit || {})) {
      byUnit[unit] = (byUnit[unit] || 0) + value.undelivered;
    }
  }
  const outstandingUnits = Object.entries(byUnit)
    .filter(([, quantity]) => quantity > 0)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([unit, quantity]) => `${formatQuantity(quantity)} ${unit}`);
  document.getElementById("monthUndeliveredQuantity").textContent = outstandingUnits.length
    ? `Across all lots: ${outstandingUnits.join(" · ")}`
    : "Across all lots: no undelivered quantity";
  container.replaceChildren();
  for (const lot of LOTS) {
    const summary = totals.lots[lot.id] || { byUnit: {}, undeliveredAmount: 0 };
    const card = document.createElement("button");
    card.type = "button";
    card.className = "lot-summary-card";
    card.setAttribute("aria-label", `Open ${lotLabel(lot)} in the monthly matrix`);
    card.addEventListener("click", () => onSelectLot(lot.id));
    card.append(textElement("strong", lotLabel(lot)));
    const unitTotals = Object.entries(summary.byUnit || {})
      .filter(([, value]) => value.undelivered > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const qtyText = unitTotals.length
      ? unitTotals.map(([unit, value]) => `${formatQuantity(value.undelivered)} ${unit}`).join(" · ")
      : "No undelivered quantity";
    card.append(textElement("div", qtyText, "summary-qty"));
    card.append(textElement("div", `${formatMoney(summary.undeliveredAmount)} undelivered`, "summary-amount"));
    container.append(card);
  }
}
