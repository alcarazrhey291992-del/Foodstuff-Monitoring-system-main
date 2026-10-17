import { LOTS } from "./db.js";
import { getItemTotals } from "./matrix.js";
import { formatDate } from "./ui.js";

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadFile(filename, content, type) {
  const parts = type.startsWith("text/csv") ? ["\uFEFF", content] : [content];
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportCurrentLot({ monthData, lotId, year, monthNumber }) {
  const lot = LOTS.find(entry => entry.id === lotId);
  const lotData = monthData.lots[lotId];
  const headers = [
    "Unit", "Item", "Unit Price (PHP)", "Total Amount (PHP)", "Monthly Order Quantity"
  ];
  for (const date of lotData.deliveryDates) {
    headers.push(`${formatDate(date.date)} Proposed`, `${formatDate(date.date)} Actual`);
  }
  headers.push(
    "Total Proposed Amount (PHP)", "Total Actually Delivered Amount (PHP, includes catch-up)",
    "Total Proposed Quantity", "Total Actually Delivered Quantity (includes catch-up)",
    "Undelivered Quantity", "Undelivered Amount (PHP)", "Status", "Last Delivery Date",
    "Catch-up Delivery History"
  );

  const rows = lotData.items.map(item => {
    const totals = getItemTotals(item, lotData.deliveryDates);
    const status = totals.overDelivered
      ? "Over-delivered"
      : totals.undelivered === 0 && totals.proposed > 0
        ? "Fully Delivered"
        : totals.actual > 0
          ? `Partially Delivered (${totals.undelivered} remaining)`
          : "Undelivered";
    const deliveryCells = lotData.deliveryDates.flatMap(date => {
      const quantity = item.quantities?.[date.id] || {};
      return [quantity.proposed || 0, quantity.actual || 0];
    });
    const catchUps = (item.catchUps || [])
      .map(entry => `${formatDate(entry.date)}: ${entry.qty} ${item.unit}${entry.receivedBy ? ` (received by ${entry.receivedBy})` : ""}${entry.remarks ? ` — ${entry.remarks}` : ""}`)
      .join(" | ");
    return [
      item.unit, item.name, item.unitPrice, Number(item.unitPrice || 0) * Number(item.orderQty || 0),
      item.orderQty, ...deliveryCells, totals.proposedAmount, totals.actualAmount,
      totals.proposed, totals.actual, totals.undelivered,
      totals.undeliveredAmount, status, totals.lastDeliveryDate ? formatDate(totals.lastDeliveryDate) : "",
      catchUps
    ];
  });
  const content = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(
    `foodstuff-${year}-${String(monthNumber).padStart(2, "0")}-${lot.id}.csv`,
    content,
    "text/csv;charset=utf-8"
  );
}

export function exportAllData({ yearFilter, months, units, comments, notifications, auditLogs, format }) {
  if (format !== "json" && format !== "csv") throw new Error("Choose JSON or CSV for the export.");
  const yearLabel = yearFilter === null ? "all-years" : String(yearFilter);
  const dataset = {
    exportedAt: new Date().toISOString(),
    year: yearFilter ?? "all",
    units,
    months,
    comments,
    notifications,
    auditLogs
  };
  if (format === "json") {
    downloadFile(
      `foodstuff-${yearLabel}.json`,
      JSON.stringify(dataset, null, 2),
      "application/json;charset=utf-8"
    );
    return;
  }

  const headers = [
    "Record Type", "Year", "Month", "Lot ID", "Lot", "Author", "Action",
    "Status", "Resolved By", "Resolved At", "Cell Reference", "Delivery Date ID",
    "Delivery Date", "Item ID", "Item", "Unit", "Unit Price (PHP)",
    "Monthly Order Quantity", "Proposed Quantity", "Actual Quantity", "Record ID",
    "Record Quantity", "Received By", "Remarks", "Old Value", "New Value", "Created At"
  ];
  const fieldKeys = [
    "year", "month", "lotId", "lotName", "author", "action", "status",
    "resolvedBy", "resolvedAt", "cellRef", "deliveryDateId", "deliveryDate",
    "itemId", "itemName", "unit", "unitPrice", "orderQty", "proposedQty",
    "actualQty", "recordId", "recordQty", "receivedBy", "remarks",
    "oldValue", "newValue", "createdAt"
  ];
  const rows = [];
  const addRow = (type, fields = {}) => {
    const values = fieldKeys.map(key => {
      const value = fields[key];
      if (["createdAt", "resolvedAt"].includes(key) && value?.toDate) return value.toDate().toISOString();
      if (key === "cellRef" && value) return JSON.stringify(value);
      return value ?? "";
    });
    rows.push([type, ...values]);
  };

  for (const month of months) {
    for (const lot of LOTS) {
      const lotData = month.lots[lot.id] || { deliveryDates: [], items: [] };
      for (const date of lotData.deliveryDates) {
        addRow("delivery-date", {
          year: month.year, month: month.month, lotId: lot.id, lotName: lot.name,
          deliveryDateId: date.id, deliveryDate: date.date
        });
      }
      for (const item of lotData.items) {
        addRow("item", {
          year: month.year, month: month.month, lotId: lot.id, lotName: lot.name,
          itemId: item.id, itemName: item.name, unit: item.unit,
          unitPrice: item.unitPrice, orderQty: item.orderQty
        });
        for (const date of lotData.deliveryDates) {
          const quantity = item.quantities?.[date.id] || {};
          addRow("scheduled-delivery", {
            year: month.year, month: month.month, lotId: lot.id, lotName: lot.name,
            deliveryDateId: date.id, deliveryDate: date.date, itemId: item.id,
            itemName: item.name, unit: item.unit, unitPrice: item.unitPrice,
            orderQty: item.orderQty, proposedQty: quantity.proposed ?? 0,
            actualQty: quantity.actual ?? 0
          });
        }
        for (const catchUp of item.catchUps || []) {
          addRow("catch-up-delivery", {
            year: month.year, month: month.month, lotId: lot.id, lotName: lot.name,
            deliveryDate: catchUp.date, itemId: item.id, itemName: item.name,
            unit: item.unit, unitPrice: item.unitPrice, orderQty: item.orderQty,
            recordId: catchUp.id, recordQty: catchUp.qty,
            receivedBy: catchUp.receivedBy, remarks: catchUp.remarks
          });
        }
      }
    }
  }

  for (const comment of comments) {
    addRow("comment", {
      year: comment.year, month: comment.month, lotId: comment.lotId,
      author: comment.authorName, action: "comment", status: comment.status,
      resolvedBy: comment.resolvedBy, resolvedAt: comment.resolvedAt,
      cellRef: comment.cellRef, itemId: comment.cellRef?.itemId,
      itemName: comment.itemName, recordId: comment.id,
      remarks: comment.text, newValue: comment.text, createdAt: comment.createdAt
    });
    for (const reply of comment.replies || []) {
      addRow("comment-reply", {
        year: comment.year, month: comment.month, lotId: comment.lotId,
        author: reply.authorName, action: `reply-to-${comment.id}`, status: comment.status,
        cellRef: comment.cellRef, itemId: comment.cellRef?.itemId,
        itemName: comment.itemName, recordId: reply.id,
        remarks: reply.text, newValue: reply.text, createdAt: reply.createdAt
      });
    }
  }

  for (const entry of auditLogs) {
    addRow("audit-log", {
      year: entry.year, month: entry.month, lotId: entry.lotId,
      author: entry.who, action: entry.action, cellRef: entry.cellRef,
      itemId: entry.itemId, itemName: entry.itemName, recordId: entry.id,
      remarks: entry.what, oldValue: JSON.stringify(entry.oldValue),
      newValue: JSON.stringify(entry.newValue), createdAt: entry.createdAt
    });
  }

  for (const notification of notifications) {
    addRow("notification", {
      year: notification.year, month: notification.month, lotId: notification.lotId,
      author: notification.authorName, action: notification.kind,
      cellRef: notification.cellRef, itemId: notification.cellRef?.itemId,
      itemName: notification.itemName, recordId: notification.id,
      remarks: notification.text, createdAt: notification.createdAt
    });
  }

  const content = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(`foodstuff-${yearLabel}.csv`, content, "text/csv;charset=utf-8");
}
