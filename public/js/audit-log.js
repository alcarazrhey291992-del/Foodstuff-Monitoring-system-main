import { getAuditLogs, LOTS } from "./db.js";
import { requireAppAccess } from "./auth.js";

const fromDate = document.getElementById("auditFromDate");
const toDate = document.getElementById("auditToDate");
const authorFilter = document.getElementById("auditAuthorFilter");
const lotFilter = document.getElementById("auditLotFilter");
const auditRows = document.getElementById("auditRows");
const auditStatus = document.getElementById("auditStatus");
const timestampFormat = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila"
});

let entries = [];

function dateValueInManila(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Manila"
  }).formatToParts(date);
  const part = type => parts.find(entry => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatTimestamp(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? timestampFormat.format(date) : "Time unavailable";
}

function populateFilters() {
  const authors = [...new Set(entries.map(entry => entry.who).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  for (const author of authors) {
    const option = document.createElement("option");
    option.value = author;
    option.textContent = author;
    authorFilter.append(option);
  }
  for (const lot of LOTS) {
    const option = document.createElement("option");
    option.value = lot.id;
    option.textContent = lot.description ? `${lot.name} · ${lot.description}` : lot.name;
    lotFilter.append(option);
  }
}

function filteredEntries() {
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
    auditStatus.textContent = "The start date must be on or before the end date.";
    return [];
  }
  return entries.filter(entry => {
    const date = dateValueInManila(entry.createdAt);
    return (!fromDate.value || (date && date >= fromDate.value))
      && (!toDate.value || (date && date <= toDate.value))
      && (!authorFilter.value || entry.who === authorFilter.value)
      && (!lotFilter.value || entry.lotId === lotFilter.value);
  });
}

function render() {
  const visible = filteredEntries();
  auditRows.replaceChildren();
  if (!(fromDate.value && toDate.value && fromDate.value > toDate.value)) {
    auditStatus.textContent = visible.length
      ? `${visible.length} change${visible.length === 1 ? "" : "s"}`
      : "No audit entries match these filters.";
  }
  for (const entry of visible) {
    const row = document.createElement("tr");
    const when = document.createElement("td");
    when.textContent = formatTimestamp(entry.createdAt);
    const who = document.createElement("td");
    who.textContent = entry.who || "Unknown";
    const lot = document.createElement("td");
    const lotDefinition = LOTS.find(candidate => candidate.id === entry.lotId);
    lot.textContent = `${lotDefinition?.name || entry.lotId || "Unknown lot"} · ${entry.year || "?"}-${String(entry.month || 0).padStart(2, "0")}`;
    const change = document.createElement("td");
    change.textContent = entry.what || entry.action || "Updated record";
    const values = document.createElement("td");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "View old / new values";
    const content = document.createElement("pre");
    content.textContent = `Old: ${JSON.stringify(entry.oldValue, null, 2)}\nNew: ${JSON.stringify(entry.newValue, null, 2)}`;
    details.append(summary, content);
    values.append(details);
    row.append(when, who, lot, change, values);
    auditRows.append(row);
  }
}

for (const filter of [fromDate, toDate, authorFilter, lotFilter]) {
  filter.addEventListener("change", render);
}

try {
  if (await requireAppAccess()) {
    entries = await getAuditLogs();
    populateFilters();
    render();
  }
} catch (error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  auditStatus.textContent = error instanceof Error ? error.message : "Unable to load audit history.";
}
