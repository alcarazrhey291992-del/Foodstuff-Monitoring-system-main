import {
  addUnit,
  ensureMonthData,
  ensureYear,
  getAllMonthData,
  getAuditLogs,
  getAvailableYears,
  getMonthData,
  getPreviousMonthKey,
  getUnits,
  LOTS,
  makeId,
  saveMonthData,
  subscribeToMonthData
} from "./db.js";
import {
  auth,
  authReady,
  changeSharedPassword,
  getMember,
  hashPassword,
  isAdminEmail,
  LOGIN_SESSION_KEY,
  memberRefFor,
  normalizeEmail,
  onAuthStateChanged,
  signInWithGoogle,
  signOutUser
} from "./auth.js";
import { db } from "./firebase-config.js";
import {
  addDoc,
  collection,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  addComment,
  addReply,
  canDeleteComment,
  canEditComment,
  commentCellKey,
  commentTargetLabel,
  deleteComment,
  ensureDisplayName,
  getAllCommentsWithReplies,
  getAllNotifications,
  getReadCommentIds,
  getReadNotificationIds,
  markAllNotificationsRead,
  markCommentRead,
  markNotificationRead,
  setCommentResolved,
  subscribeToComments,
  subscribeToNotifications,
  subscribeToReplies,
  updateComment
} from "./comments.js";
import { exportAllData, exportCurrentLot } from "./export.js";
import { getItemTotals, getRowStatus } from "./matrix.js";
import { formatDate, formatMoney, formatQuantity, renderLotTabs, renderMatrix } from "./ui.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const APP_VIEWS = new Set([
  "matrix", "overview", "comments", "notifications", "login-history",
  "users", "config", "password", "export", "audit", "restricted"
]);
const FREEZE_HEADER_STORAGE_KEY = "foodstuff-freeze-header";
const FREEZE_PANES_STORAGE_KEY = "foodstuff-freeze-panes";
const today = new Date();
const state = {
  year: Math.max(2026, today.getFullYear()),
  monthNumber: today.getFullYear() < 2026 ? 10 : today.getMonth() + 1,
  lotId: LOTS[0].id,
  monthData: null,
  units: [],
  configurationError: false,
  configurationLoaded: false,
  toastTimer: null,
  comments: [],
  notifications: [],
  unsubscribeComments: null,
  unsubscribeMonth: null,
  unsubscribeNotifications: null,
  unsubscribeReplies: null,
  matrixCardIndex: 0,
  activeCellRef: null,
  activeCommentId: null,
  replies: [],
  overviewHighlightItemId: ""
};

const navigationParams = new URLSearchParams(window.location.search);
const navigationYear = Number(navigationParams.get("year"));
const navigationMonth = Number(navigationParams.get("month"));
if (Number.isInteger(navigationYear) && navigationYear >= 2026) state.year = navigationYear;
if (Number.isInteger(navigationMonth) && navigationMonth >= 1 && navigationMonth <= 12) {
  state.monthNumber = navigationMonth;
}
if (LOTS.some(lot => lot.id === navigationParams.get("lot"))) {
  state.lotId = navigationParams.get("lot");
}
let pendingNavigation = navigationParams.has("itemId")
  ? {
    itemId: navigationParams.get("itemId"),
    columnKey: navigationParams.get("columnKey"),
    deliveryDateId: navigationParams.get("deliveryDateId"),
    catchUpId: navigationParams.get("catchUpId"),
    commentId: navigationParams.get("commentId")
  }
  : null;
let contextVersion = 0;
let persistenceQueue = Promise.resolve();
let latestSaveRequest = 0;
let authStateGeneration = 0;
let pendingAccessTimer = null;
let pendingPasswordHash = "";
let currentUser = null;
let messageAfterSignOut = "";

function activeView() {
  const requested = window.location.hash.slice(1);
  return requested || "matrix";
}

function setActiveView(view = activeView(), updateHash = false) {
  const allowedView = APP_VIEWS.has(view) ? view : "matrix";
  if (!APP_VIEWS.has(view) && window.location.hash) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#matrix`
    );
  }
  const adminOnlyView = ["login-history", "users", "password", "audit"].includes(allowedView);
  const nextView = adminOnlyView && !isAdminEmail(currentUser?.email) ? "restricted" : allowedView;
  if (updateHash && window.location.hash !== `#${nextView}`) {
    window.location.hash = nextView;
    return;
  }

  document.querySelectorAll("[data-app-view]").forEach(section => {
    section.hidden = section.dataset.appView !== nextView;
  });
  document.getElementById("appShell").classList.toggle("overview-print", nextView === "overview");
  if (nextView === "matrix") highlightOverviewItemInMatrix();
  document.querySelectorAll("[data-view-link]").forEach(link => {
    const selected = link.dataset.viewLink === nextView;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const embeddedFrame = document.querySelector(`[data-app-view="${nextView}"] iframe[data-src]`);
  if (embeddedFrame && !embeddedFrame.dataset.loaded) {
    embeddedFrame.dataset.loaded = "true";
    embeddedFrame.src = embeddedFrame.dataset.src;
  }
  document.getElementById("commentsPanelToggle").setAttribute(
    "aria-expanded",
    String(nextView === "notifications")
  );
  setSidebarOpen(false);
  if (nextView === "config") renderConfigurationView();
  if (nextView === "overview") renderSummaryTable();
  if (nextView === "password") setViewState("passwordViewState", "Set a password of at least 8 characters and confirm it.");
  if (nextView === "export") setViewState("exportViewState", "Choose an export action.");
  const viewTitles = {
    matrix: "Monthly Matrix",
    overview: "Monthly Overview / Summary",
    comments: "Comments Center",
    notifications: "Notifications",
    "login-history": "Login History",
    users: "Users & Access",
    config: "Configuration",
    password: "Change password",
    export: "Print / Export",
    audit: "Audit Log",
    restricted: "Access restricted"
  };
  document.title = `${viewTitles[nextView] || "Foodstuff Delivery Monitoring"} · DSWD Sanctuary Center`;
}

function setViewState(id, message, kind = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("state-error", kind === "error");
  element.classList.toggle("state-success", kind === "success");
  element.hidden = !message;
}

function getOverviewRecords() {
  return LOTS.flatMap(lot => {
    const lotData = state.monthData?.lots?.[lot.id] || { items: [], deliveryDates: [] };
    return lotData.items.map(item => {
      const totals = getItemTotals(item, lotData.deliveryDates);
      return {
        item,
        lot,
        totals,
        status: getRowStatus(item, lotData.deliveryDates),
        orderedAmount: totals.proposedAmount
      };
    });
  });
}

function getVisibleOverviewRecords(records) {
  const search = document.getElementById("overviewItemSearch").value.trim().toLocaleLowerCase();
  const selectedLot = document.getElementById("overviewLotFilter").value;
  const selectedStatus = document.querySelector("[data-overview-status].active")?.dataset.overviewStatus || "all";
  return records.filter(record => (
    (!search || String(record.item.name || "").toLocaleLowerCase().includes(search))
    && (!selectedLot || selectedLot === record.lot.id)
    && (selectedStatus === "all" || selectedStatus === record.status)
  ));
}

function overviewRecordStatusText(record) {
  const unit = record.item.unit || "";
  const status = record.status === "fully"
    ? "Fully delivered"
    : record.status === "partial"
      ? `Partially delivered · ${formatQuantity(record.totals.undelivered)}${unit ? ` ${unit}` : ""} remaining · Last delivery: ${formatDate(record.totals.lastDeliveryDate)}`
      : "Undelivered";
  return record.totals.overDelivered
    ? `${status} · Over-delivered by ${formatQuantity(record.totals.actual - record.totals.proposed)}${unit ? ` ${unit}` : ""}`
    : status;
}

function highlightOverviewItemInMatrix() {
  if (!state.overviewHighlightItemId) return;
  const row = [...document.querySelectorAll("#matrixBody tr[data-item-id]")]
    .find(candidate => candidate.dataset.itemId === state.overviewHighlightItemId);
  if (!row || row.closest("[hidden]")) return;
  state.overviewHighlightItemId = "";
  row.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  row.classList.add("summary-item-flash");
  window.setTimeout(() => row.classList.remove("summary-item-flash"), 1900);
}

function downloadOverviewCsv() {
  const records = getVisibleOverviewRecords(getOverviewRecords());
  const rows = [[
    "Lot", "Item", "Unit", "Unit price (PHP)", "Ordered quantity",
    "Delivered quantity", "Delivered amount (PHP)", "Undelivered quantity",
    "Undelivered amount (PHP)", "Status"
  ]];
  for (const record of records) {
    const unit = record.item.unit || "";
    rows.push([
      record.lot.description ? `${record.lot.name} ${record.lot.description}` : record.lot.name,
      record.item.name || "Unnamed item",
      unit,
      Number(record.item.unitPrice || 0),
      record.totals.proposed,
      record.totals.actual,
      record.totals.actualAmount,
      record.totals.undelivered,
      record.totals.undeliveredAmount,
      overviewRecordStatusText(record)
    ]);
  }
  const csv = rows.map(row => row.map(value =>
    `"${String(value ?? "").replaceAll('"', '""')}"`
  ).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `foodstuff-overview-${state.year}-${String(state.monthNumber).padStart(2, "0")}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderSummaryTable() {
  const body = document.getElementById("summaryRows");
  const table = document.getElementById("overviewTable");
  const emptyState = document.getElementById("overviewEmptyState");
  const cards = document.getElementById("lotSummary");
  const lotFilter = document.getElementById("overviewLotFilter");
  if (!body || !table || !emptyState || !cards || !lotFilter) return;
  if (!state.monthData) {
    setViewState("overviewViewState", "Loading monthly overview…");
    return;
  }

  if (lotFilter.options.length === 1) {
    for (const lot of LOTS) {
      const option = document.createElement("option");
      option.value = lot.id;
      option.textContent = lot.description ? `${lot.name} · ${lot.description}` : lot.name;
      lotFilter.append(option);
    }
  }

  const monthDate = new Date(Date.UTC(state.year, state.monthNumber - 1, 1, 12));
  document.getElementById("overviewPeriod").textContent =
    new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" }).format(monthDate);
  cards.replaceChildren();
  body.replaceChildren();
  if (state.configurationError) {
    table.hidden = true;
    emptyState.hidden = true;
    setViewState("overviewViewState", "Unable to load monthly overview data.", "error");
    return;
  }
  const selectedLot = lotFilter.value;
  const activeSearch = document.getElementById("overviewItemSearch").value.trim();
  const selectedStatus = document.querySelector("[data-overview-status].active")?.dataset.overviewStatus || "all";
  const allRecords = getOverviewRecords();
  const visibleRecords = getVisibleOverviewRecords(allRecords);
  const visibleRecordsByLot = new Map(LOTS.map(lot => [lot.id, []]));
  let orderedAmount = 0;
  let deliveredAmount = 0;
  let undeliveredAmount = 0;

  for (const lot of LOTS) {
    const records = allRecords.filter(record => record.lot.id === lot.id);
    const lotUndeliveredAmount = records.reduce((sum, record) => sum + record.totals.undeliveredAmount, 0);
    const notFullyDelivered = records.filter(record => record.status !== "fully").length;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `lot-summary-card${selectedLot === lot.id ? " selected" : ""}`;
    card.setAttribute("aria-label", `Show ${lot.description ? `${lot.name} ${lot.description}` : lot.name} items`);
    card.setAttribute("aria-pressed", String(selectedLot === lot.id));
    const lotName = document.createElement("strong");
    lotName.textContent = lot.description ? `${lot.name} · ${lot.description}` : lot.name;
    const cardAmount = document.createElement("span");
    cardAmount.className = "summary-amount";
    cardAmount.textContent = `${formatMoney(lotUndeliveredAmount)} undelivered`;
    const cardCount = document.createElement("span");
    cardCount.className = "summary-qty";
    cardCount.textContent = `${notFullyDelivered} item${notFullyDelivered === 1 ? "" : "s"} not fully delivered`;
    card.append(lotName, cardAmount, cardCount);
    card.addEventListener("click", () => {
      lotFilter.value = lot.id;
      renderSummaryTable();
      const target = table.hidden
        ? emptyState
        : document.getElementById(`overview-lot-${lot.id}`) || emptyState;
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    cards.append(card);

    visibleRecordsByLot.set(lot.id, visibleRecords.filter(record => record.lot.id === lot.id));
    for (const record of records) {
      orderedAmount += record.orderedAmount;
      deliveredAmount += record.totals.actualAmount;
      undeliveredAmount += record.totals.undeliveredAmount;
    }
  }

  table.hidden = visibleRecords.length === 0;
  emptyState.hidden = visibleRecords.length > 0;
  emptyState.textContent = allRecords.length
    ? "No items match these filters."
    : "No items entered for this month";

  for (const lot of LOTS) {
    const records = visibleRecordsByLot.get(lot.id);
    const showEmptyLot = !activeSearch
      && selectedStatus === "all"
      && (!selectedLot || selectedLot === lot.id);
    if (!records.length && !showEmptyLot) continue;
    const heading = document.createElement("tr");
    heading.className = "summary-lot-heading";
    heading.id = `overview-lot-${lot.id}`;
    const headingCell = document.createElement("th");
    headingCell.scope = "rowgroup";
    headingCell.colSpan = 9;
    headingCell.textContent = lot.description ? `${lot.name} ${lot.description}` : lot.name;
    heading.append(headingCell);
    body.append(heading);

    if (!records.length) {
      const emptyLotRow = document.createElement("tr");
      emptyLotRow.className = "summary-no-items";
      const emptyLotCell = document.createElement("td");
      emptyLotCell.colSpan = 9;
      emptyLotCell.textContent = "No items entered in this lot for the selected month.";
      emptyLotRow.append(emptyLotCell);
      body.append(emptyLotRow);
    }

    let lotDeliveredAmount = 0;
    let lotUndeliveredAmount = 0;
    for (const record of records) {
      const { item, totals, status } = record;
      const row = document.createElement("tr");
      row.className = "summary-item-row";
      const itemCell = document.createElement("td");
      const openItem = document.createElement("button");
      openItem.type = "button";
      openItem.className = "summary-item-link";
      openItem.textContent = item.name || "Unnamed item";
      openItem.addEventListener("click", () => {
        state.lotId = lot.id;
        state.overviewHighlightItemId = item.id;
        render();
        subscribeToCurrentContext();
        setActiveView("matrix", true);
      });
      itemCell.append(openItem);
      const unit = item.unit || "";
      const cells = [
        itemCell,
        unit,
        formatMoney(Number(item.unitPrice || 0)),
        `${formatQuantity(totals.proposed)}${unit ? ` ${unit}` : ""}`,
        `${formatQuantity(totals.actual)}${unit ? ` ${unit}` : ""}`,
        formatMoney(totals.actualAmount),
        `${formatQuantity(totals.undelivered)}${unit ? ` ${unit}` : ""}`,
        formatMoney(totals.undeliveredAmount)
      ];
      for (const [index, value] of cells.entries()) {
        const cell = index === 0 ? itemCell : document.createElement("td");
        if (index > 0) cell.textContent = value;
        if (index === 1) cell.classList.add("summary-unit-cell");
        if ([2, 3, 4, 5, 6, 7].includes(index)) cell.classList.add("summary-number");
        row.append(cell);
      }
      const statusCell = document.createElement("td");
      statusCell.className = "summary-status-cell";
      const statusBadge = document.createElement("span");
      statusBadge.className = `summary-status summary-status-${status}`;
      statusBadge.textContent = status === "fully"
        ? "Fully delivered"
        : status === "partial"
          ? `Partially delivered · ${formatQuantity(totals.undelivered)}${unit ? ` ${unit}` : ""} remaining · Last delivery: ${formatDate(totals.lastDeliveryDate)}`
          : "Undelivered";
      statusCell.append(statusBadge);
      if (totals.overDelivered) {
        const overDeliveryNote = document.createElement("small");
        overDeliveryNote.className = "summary-overdelivery";
        overDeliveryNote.textContent = `Over-delivered by ${formatQuantity(totals.actual - totals.proposed)}${unit ? ` ${unit}` : ""}`;
        statusCell.append(overDeliveryNote);
      }
      row.append(statusCell);
      body.append(row);
      lotDeliveredAmount += totals.actualAmount;
      lotUndeliveredAmount += totals.undeliveredAmount;
    }

    const subtotal = document.createElement("tr");
    subtotal.className = "summary-lot-subtotal";
    const subtotalLabel = document.createElement("th");
    subtotalLabel.scope = "row";
    subtotalLabel.colSpan = 5;
    subtotalLabel.textContent = `${lot.name} subtotal`;
    const deliveredSubtotal = document.createElement("td");
    deliveredSubtotal.className = "summary-number";
    deliveredSubtotal.textContent = formatMoney(lotDeliveredAmount);
    const emptySubtotal = document.createElement("td");
    const undeliveredSubtotal = document.createElement("td");
    undeliveredSubtotal.className = "summary-number";
    undeliveredSubtotal.textContent = formatMoney(lotUndeliveredAmount);
    const statusSubtotal = document.createElement("td");
    subtotal.append(subtotalLabel, deliveredSubtotal, emptySubtotal, undeliveredSubtotal, statusSubtotal);
    body.append(subtotal);
  }

  const foot = document.getElementById("summaryFoot");
  foot.replaceChildren();
  const totalRow = document.createElement("tr");
  totalRow.className = "summary-month-total";
  const totalLabel = document.createElement("th");
  totalLabel.scope = "row";
  totalLabel.colSpan = 3;
  totalLabel.textContent = "Month grand total";
  totalRow.append(totalLabel);
  for (const [label, amount, span] of [
    ["Ordered amount", orderedAmount, 2],
    ["Delivered amount", deliveredAmount, 1],
    ["", 0, 1],
    ["Undelivered amount", undeliveredAmount, 1],
    ["", 0, 1]
  ]) {
    const cell = document.createElement("td");
    cell.colSpan = span;
    cell.className = "summary-number";
    if (label) {
      const totalDescription = document.createElement("small");
      totalDescription.textContent = label;
      const totalValue = document.createElement("strong");
      totalValue.textContent = formatMoney(amount);
      cell.append(totalDescription, totalValue);
    }
    totalRow.append(cell);
  }
  foot.append(totalRow);

  setViewState("overviewViewState", "");
}

function renderConfigurationView() {
  const units = document.getElementById("configurationUnits");
  const lots = document.getElementById("configurationLots");
  if (!units || !lots) return;
  units.replaceChildren();
  lots.replaceChildren();
  if (state.configurationError) setViewState("configViewState", "Unable to load configuration data. Check your connection and try again.", "error");
  else if (!state.configurationLoaded) setViewState("configViewState", "Loading configuration…");
  else if (!state.units.length) setViewState("configViewState", "No records yet");
  else setViewState("configViewState", "");
  for (const unit of state.units) {
    const item = document.createElement("li");
    item.textContent = unit;
    units.append(item);
  }
  for (const lot of LOTS) {
    const item = document.createElement("li");
    item.textContent = lot.description ? `${lot.name} · ${lot.description}` : lot.name;
    lots.append(item);
  }
}

function setSidebarOpen(open) {
  const shell = document.getElementById("appShell");
  const toggle = document.getElementById("menuToggleButton");
  const sidebar = document.getElementById("sidebar");
  shell.classList.toggle("sidebar-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  sidebar.setAttribute("aria-hidden", String(
    !open && window.matchMedia("(max-width: 1100px)").matches
  ));
}

function setupFreezeSetting(toggleId, className, storageKey) {
  const toggle = document.getElementById(toggleId);
  const shell = document.getElementById("appShell");
  try {
    const savedValue = localStorage.getItem(storageKey);
    toggle.checked = savedValue === null || savedValue === "true";
  } catch (error) {
    handleError(error);
  }
  shell.classList.toggle(className, toggle.checked);
  toggle.addEventListener("change", () => {
    shell.classList.toggle(className, toggle.checked);
    try {
      localStorage.setItem(storageKey, String(toggle.checked));
    } catch (error) {
      handleError(error);
    }
  });
}

function syncPeriodTabs() {
  const yearSelect = document.getElementById("yearSelect");
  document.querySelectorAll(".year-tab").forEach(button => {
    const selected = Number(button.dataset.year) === Number(yearSelect.value);
    button.disabled = ![...yearSelect.options].some(option => Number(option.value) === Number(button.dataset.year));
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll(".month-tab").forEach(button => {
    const selected = Number(button.dataset.month) === Number(document.getElementById("monthSelect").value);
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.getElementById("selectedYearHeading").textContent = String(state.year);
}

function styleEmbeddedPage(frame) {
  try {
    const frameUrl = new URL(frame.contentWindow.location.href);
    if (frameUrl.pathname.endsWith("/index.html") && frameUrl.searchParams.has("itemId")) {
      window.location.href = `${frameUrl.pathname}${frameUrl.search}#matrix`;
      return;
    }
    const frameDocument = frame.contentDocument;
    if (!frameDocument || frameDocument.getElementById("host-shell-overrides")) return;
    const view = frame.closest("[data-app-view]")?.dataset.appView;
    const style = frameDocument.createElement("style");
    style.id = "host-shell-overrides";
    style.textContent = [
      ".sidebar,.audit-page-header,.comments-center-topbar,a[href='./index.html']{display:none!important}",
      ".app-shell{display:block!important;min-height:0!important;grid-template-columns:1fr!important}",
      ".main{max-width:none!important;margin:0!important;padding:0!important}",
      ".official-heading{margin-top:0!important}"
    ].join("");
    frameDocument.head.append(style);
    frameDocument.querySelectorAll('a[href="./login-history.html"], a[href="./users-access.html"]').forEach(link => {
      link.addEventListener("click", event => {
        event.preventDefault();
        window.location.hash = link.getAttribute("href").includes("login-history") ? "login-history" : "users";
      });
    });
    if (view === "login-history" && !frame.dataset.titleObserver) {
      const title = frameDocument.querySelector("title");
      if (title) {
        frame.dataset.titleObserver = "true";
        new MutationObserver(() => {
          if (activeView() === "login-history") document.title = title.textContent;
        }).observe(title, { childList: true, characterData: true, subtree: true });
      }
    }
    const stateIds = {
      comments: "commentsViewState",
      "login-history": "loginHistoryViewState",
      users: "usersViewState",
      audit: "auditViewState"
    };
    if (stateIds[view]) setViewState(stateIds[view], "");
  } catch (error) {
    console.error("embedded-view", error?.message ?? String(error));
  }
}

function cloneMonthData(monthData) {
  return JSON.parse(JSON.stringify(monthData));
}

function createEmptyMonthData() {
  return {
    lots: Object.fromEntries(LOTS.map(lot => [lot.id, { deliveryDates: [], items: [] }]))
  };
}

function monthKey() {
  return `${state.year}-${String(state.monthNumber).padStart(2, "0")}`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function todayInManila() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Manila"
  }).formatToParts(new Date());
  const part = type => parts.find(entry => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function handleError(error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  showToast(error instanceof Error ? error.message : "Something went wrong. Please try again.");
}

async function persist(beforeData) {
  const key = monthKey();
  let authorName;
  try {
    authorName = ensureDisplayName();
  } catch (error) {
    state.monthData = beforeData;
    render();
    handleError(error);
    return false;
  }

  const request = ++latestSaveRequest;
  const nextData = cloneMonthData(state.monthData);
  const saveRequest = persistenceQueue.then(() =>
    saveMonthData(key, beforeData, nextData, authorName)
  );
  persistenceQueue = saveRequest.catch(() => {});

  try {
    await saveRequest;
    return true;
  } catch (error) {
    if (request === latestSaveRequest && key === monthKey()) {
      try {
        state.monthData = await getMonthData(key);
      } catch (reloadError) {
        console.error(reloadError?.code ?? "unknown", reloadError?.message ?? String(reloadError));
        state.monthData = beforeData;
      }
      render();
    }
    handleError(error);
    return false;
  }
}

async function initializeApp() {
  setViewState("matrixViewState", "Loading matrix data…");
  setViewState("overviewViewState", "Loading monthly overview…");
  try {
    await ensureMonthData(monthKey(), ensureDisplayName());
    state.monthData = await getMonthData(monthKey());
    state.units = await getUnits();
    state.configurationError = false;
    state.configurationLoaded = true;
  } catch (error) {
    state.configurationError = true;
    state.configurationLoaded = true;
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    setViewState("matrixViewState", "Unable to load matrix data. Check your connection and retry by changing the month.", "error");
    setViewState("overviewViewState", "Unable to load monthly overview data.", "error");
    setViewState("configViewState", "Unable to load configuration data.", "error");
    showToast("Unable to load data. Please try again.");
    state.monthData = createEmptyMonthData();
    if (!state.units.length) {
      state.units = [];
    }
  }
  if (!state.configurationError) setViewState("matrixViewState", "");
  render();
  subscribeToCurrentContext();
  state.unsubscribeNotifications = subscribeToNotifications(notifications => {
    state.notifications = notifications;
    renderNotifications();
  }, error => {
    setViewState(
      "notificationsViewState",
      error instanceof Error ? error.message : "Unable to load notifications.",
      "error"
    );
    handleError(error);
  });
  maybeOpenPendingNavigation();
}

function render() {
  if (!state.monthData || !state.monthData.lots) {
    state.monthData = createEmptyMonthData();
  }

  for (const lot of LOTS) {
    if (!state.monthData.lots[lot.id]) {
      state.monthData.lots[lot.id] = { deliveryDates: [], items: [] };
    }
  }

  renderLotTabs(document.getElementById("lotTabs"), state.lotId, lotId => {
    state.lotId = lotId;
    render();
    subscribeToCurrentContext();
  });
  renderSummaryTable();
  renderMatrix({
    monthData: state.monthData,
    lotId: state.lotId,
    units: state.units,
    year: state.year,
    monthNumber: state.monthNumber
  });
  const cardRows = [...document.querySelectorAll("#matrixBody tr[data-item-id]")];
  state.matrixCardIndex = Math.min(state.matrixCardIndex, Math.max(0, cardRows.length - 1));
  updateMatrixCardView();
  renderCommentDecorations();
}

function selectLot(lotId) {
  if (!LOTS.some(lot => lot.id === lotId)) return;
  state.lotId = lotId;
  render();
  subscribeToCurrentContext();
  setActiveView("matrix", true);
}

function updateMatrixCardView() {
  const table = document.getElementById("matrixTable");
  const rows = [...document.querySelectorAll("#matrixBody tr[data-item-id]")];
  const cardMode = table?.classList.contains("card-mode");
  const navigation = document.getElementById("matrixCardNavigation");
  if (!navigation) return;
  navigation.hidden = !cardMode || rows.length === 0;
  rows.forEach((row, index) => row.classList.toggle("matrix-card-active", !cardMode || index === state.matrixCardIndex));
  document.getElementById("matrixCardPosition").textContent = rows.length
    ? `${state.matrixCardIndex + 1} of ${rows.length}`
    : "No records yet";
  document.getElementById("previousMatrixCard").disabled = state.matrixCardIndex <= 0;
  document.getElementById("nextMatrixCard").disabled = state.matrixCardIndex >= rows.length - 1;
}

function setMatrixMode(mode) {
  const table = document.getElementById("matrixTable");
  const cardMode = mode === "card";
  table.classList.toggle("card-mode", cardMode);
  document.getElementById("matrixScroll").classList.toggle("card-mode", cardMode);
  document.querySelectorAll(".matrix-mode").forEach(button => {
    const selected = button.dataset.matrixMode === (cardMode ? "card" : "table");
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  updateMatrixCardView();
}

async function loadMonth() {
  setViewState("matrixViewState", "Loading matrix…");
  setViewState("overviewViewState", "Loading monthly summary…");
  try {
    await ensureMonthData(monthKey(), ensureDisplayName());
    state.monthData = await getMonthData(monthKey());
    setViewState("matrixViewState", "");
    setViewState("overviewViewState", "");
  } catch (error) {
    setViewState("matrixViewState", "Unable to load matrix data.", "error");
    setViewState("overviewViewState", "Unable to load monthly summary.", "error");
    handleError(error);
    state.monthData = createEmptyMonthData();
  }
  render();
  subscribeToCurrentContext();
  maybeOpenPendingNavigation();
}

async function renderPeriodControls() {
  const yearSelect = document.getElementById("yearSelect");
  const monthSelect = document.getElementById("monthSelect");
  const years = await getAvailableYears();
  yearSelect.replaceChildren();
  for (const year of years) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    option.selected = year === state.year;
    yearSelect.append(option);
  }
  monthSelect.replaceChildren();
  MONTHS.forEach((month, index) => {
    const option = document.createElement("option");
    option.value = String(index + 1);
    option.textContent = month;
    option.selected = index + 1 === state.monthNumber;
    monthSelect.append(option);
  });
  syncPeriodTabs();
}

function currentCellRef(element) {
  return {
    itemId: element.dataset.commentItemId,
    columnKey: element.dataset.commentColumnKey,
    deliveryDateId: element.dataset.commentDeliveryDateId || "",
    catchUpId: element.dataset.commentCatchUpId || ""
  };
}

function subscribeToCurrentContext() {
  const version = ++contextVersion;
  state.unsubscribeComments?.();
  state.unsubscribeMonth?.();
  state.unsubscribeReplies?.();
  state.unsubscribeReplies = null;
  state.activeCommentId = null;
  state.replies = [];
  const commentDialog = document.getElementById("commentDialog");
  if (commentDialog.open) commentDialog.close();
  state.comments = [];
  renderCommentDecorations();
  renderCurrentComments();
  renderCommentThreads();
  state.unsubscribeComments = subscribeToComments(
    state.year,
    state.monthNumber,
    state.lotId,
    comments => {
      if (version !== contextVersion) return;
      state.comments = comments;
      renderCommentDecorations();
      renderCurrentComments();
      renderCommentThreads();
    },
    handleError
  );
  state.unsubscribeMonth = subscribeToMonthData(monthKey(), monthData => {
    if (version !== contextVersion) return;
    state.monthData = monthData;
    render();
    renderCurrentComments();
    maybeOpenPendingNavigation();
  }, handleError);
}

function renderCommentDecorations() {
  const byCell = new Map();
  for (const comment of state.comments) {
    const key = commentCellKey(comment.cellRef || {});
    const current = byCell.get(key);
    if (!current || (current.status !== "open" && comment.status === "open")) {
      byCell.set(key, comment);
    }
  }

  document.querySelectorAll("[data-comment-cell]").forEach(element => {
    const comment = byCell.get(commentCellKey(currentCellRef(element)));
    element.classList.toggle("comment-open", comment?.status === "open");
    element.classList.toggle("comment-resolved", Boolean(comment) && comment.status !== "open");
    const trigger = element.querySelector(".cell-comment-trigger");
    if (trigger) {
      const count = state.comments.filter(entry =>
        commentCellKey(entry.cellRef || {}) === commentCellKey(currentCellRef(element))
      ).length;
      trigger.textContent = count ? `＋${count}` : "＋";
      trigger.setAttribute("aria-label", count ? `Open ${count} comment threads for this cell` : "Add a comment to this cell");
    }
  });
}

function renderActivityCard(container, titleText, bodyText, unread, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `activity-card${unread ? " unread" : ""}`;
  const title = document.createElement("strong");
  title.textContent = titleText;
  const body = document.createElement("span");
  body.textContent = bodyText;
  button.append(title, body);
  button.addEventListener("click", onClick);
  container.append(button);
}

function renderCurrentComments() {
  const list = document.getElementById("currentCommentsList");
  if (!list) return;
  list.replaceChildren();
  const readIds = getReadCommentIds();
  const comments = [...state.comments].sort((a, b) => {
    const timeA = a.createdAt?.toMillis?.() || 0;
    const timeB = b.createdAt?.toMillis?.() || 0;
    return timeB - timeA;
  });
  if (!comments.length) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = "No comments in this lot yet.";
    list.append(empty);
    return;
  }
  for (const comment of comments) {
    renderActivityCard(
      list,
      `${comment.authorName || "Unknown author"} · ${comment.status || "open"}`,
      comment.text || "",
      !readIds.has(comment.id),
      () => openCommentThread(comment.cellRef, comment.id)
    );
  }
}

function renderNotifications() {
  const list = document.getElementById("notificationList");
  if (!list) return;
  const readIds = getReadNotificationIds();
  const unreadCount = state.notifications.filter(notification => !readIds.has(notification.id)).length;
  document.getElementById("notificationBadge").textContent = String(unreadCount);
  document.getElementById("notificationButtonBadge").textContent = String(unreadCount);
  document.getElementById("sidebarNotificationBadge").textContent = String(unreadCount);
  list.replaceChildren();
  if (!state.notifications.length) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = "No records yet";
    list.append(empty);
    setViewState("notificationsViewState", "No records yet");
    return;
  }
  setViewState("notificationsViewState", "");
  for (const notification of state.notifications) {
    const lot = LOTS.find(entry => entry.id === notification.lotId);
    const kind = notification.kind === "reply" ? "replied" :
      notification.kind === "resolved" ? "resolved a comment" :
        notification.kind === "reopened" ? "reopened a comment" : "commented";
    const unread = !readIds.has(notification.id);
    const entry = document.createElement("div");
    entry.className = "notification-entry";
    renderActivityCard(
      entry,
      `${notification.authorName || "Someone"} ${kind}`,
      `${lot?.name || notification.lotId || "Lot"} · ${notification.itemName || "Item"} · ${notification.text || ""}`,
      unread,
      () => {
        markNotificationRead(notification.id);
        renderNotifications();
        navigateToComment(notification);
      }
    );
    if (unread) {
      const markRead = document.createElement("button");
      markRead.className = "button button-light";
      markRead.type = "button";
      markRead.textContent = "Mark read";
      markRead.addEventListener("click", () => {
        try {
          markNotificationRead(notification.id);
          renderNotifications();
        } catch (error) {
          handleError(error);
        }
      });
      entry.append(markRead);
    }
    list.append(entry);
  }
  document.getElementById("notificationBadge").textContent = String(
    state.notifications.filter(notification => !getReadNotificationIds().has(notification.id)).length
  );
  document.getElementById("notificationButtonBadge").textContent =
    document.getElementById("notificationBadge").textContent;
  document.getElementById("sidebarNotificationBadge").textContent =
    document.getElementById("notificationBadge").textContent;
}

function navigateToComment(comment) {
  setActiveView("matrix");
  if (window.location.hash !== "#matrix") window.location.hash = "matrix";
  const target = {
    itemId: comment.cellRef?.itemId || "",
    columnKey: comment.cellRef?.columnKey || "",
    deliveryDateId: comment.cellRef?.deliveryDateId || "",
    catchUpId: comment.cellRef?.catchUpId || "",
    commentId: comment.commentId
  };
  if (comment.year !== state.year || comment.month !== state.monthNumber || comment.lotId !== state.lotId) {
    state.year = Number(comment.year);
    state.monthNumber = Number(comment.month);
    state.lotId = comment.lotId;
    pendingNavigation = target;
    renderPeriodControls().then(loadMonth).catch(handleError);
  } else {
    pendingNavigation = target;
    maybeOpenPendingNavigation();
  }
  document.getElementById("commentsPanel").hidden = true;
}

function openCommentThread(cellRef, commentId = "") {
  if (!cellRef?.itemId) return;
  state.activeCellRef = cellRef;
  state.activeCommentId = commentId;
  const item = activeLotData()?.items.find(entry => entry.id === cellRef.itemId);
  const lot = LOTS.find(entry => entry.id === state.lotId);
  document.getElementById("commentDialogTitle").textContent =
    `${lot?.name || "Lot"} · ${item?.name || "Item"} · ${commentTargetLabel(cellRef)}`;
  document.getElementById("newCommentText").value = "";
  const dialog = document.getElementById("commentDialog");
  if (!dialog.open) dialog.showModal();
  renderCommentThreads();
  state.unsubscribeReplies?.();
  state.unsubscribeReplies = null;
  if (commentId) {
    state.unsubscribeReplies = subscribeToReplies(
      monthKey(),
      state.lotId,
      commentId,
      replies => {
        state.replies = replies;
        renderCommentThreads();
      },
      handleError
    );
    markCommentRead(commentId);
    renderCurrentComments();
  }
}

function renderCommentThreads() {
  const container = document.getElementById("commentThreads");
  container.replaceChildren();
  const cellKey = commentCellKey(state.activeCellRef || {});
  const threads = state.comments.filter(comment =>
    commentCellKey(comment.cellRef || {}) === cellKey
  );
  for (const comment of threads) {
    const article = document.createElement("article");
    article.className = `comment-thread${comment.status === "open" ? "" : " resolved"}`;
    const heading = document.createElement("div");
    heading.className = "comment-thread-heading";
    const identity = document.createElement("strong");
    identity.textContent = comment.authorName || "Unknown author";
    const meta = document.createElement("span");
    meta.className = "comment-thread-meta";
    meta.textContent = comment.status === "open" ? "Open" : `Resolved by ${comment.resolvedBy || "unknown"}`;
    heading.append(identity, meta);
    const text = document.createElement("p");
    text.className = "comment-thread-text";
    text.textContent = comment.text || "";
    article.append(heading, text);

    if (comment.editedAt) {
      const edited = document.createElement("small");
      edited.className = "comment-thread-edited";
      edited.textContent = "Edited";
      article.append(edited);
    }

    const replies = document.createElement("div");
    replies.className = "comment-replies";
    if (comment.id === state.activeCommentId) {
      for (const reply of state.replies) {
        const replyElement = document.createElement("div");
        replyElement.className = "comment-reply";
        const author = document.createElement("strong");
        author.textContent = `${reply.authorName || "Unknown author"}: `;
        const replyText = document.createElement("p");
        replyText.textContent = reply.text || "";
        replyElement.append(author, replyText);
        replies.append(replyElement);
      }
    } else {
      const showReplies = document.createElement("button");
      showReplies.type = "button";
      showReplies.className = "text-button";
      showReplies.textContent = comment.id === state.activeCommentId ? "Viewing replies" : "View replies";
      showReplies.disabled = comment.id === state.activeCommentId;
      showReplies.addEventListener("click", () => openCommentThread(state.activeCellRef, comment.id));
      replies.append(showReplies);
    }
    if (comment.id === state.activeCommentId) {
      const replyForm = document.createElement("form");
      replyForm.className = "comment-reply-form";
      const input = document.createElement("textarea");
      input.className = "control";
      input.maxLength = 2000;
      input.required = true;
      input.setAttribute("aria-label", "Write a reply");
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "button button-light";
      submit.textContent = "Reply";
      replyForm.append(input, submit);
      replyForm.addEventListener("submit", async event => {
        event.preventDefault();
        try {
          await addReply({ year: state.year, month: state.monthNumber, lotId: state.lotId, comment, text: input.value });
          input.value = "";
        } catch (error) {
          handleError(error);
        }
      });
      replies.append(replyForm);
    }
    article.append(replies);

    const actions = document.createElement("div");
    actions.className = "comment-thread-actions";
    if (canEditComment(comment)) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        if (article.querySelector(".comment-edit-form")) return;
        const form = document.createElement("form");
        form.className = "comment-edit-form";
        const input = document.createElement("textarea");
        input.className = "control";
        input.rows = 3;
        input.maxLength = 2000;
        input.required = true;
        input.value = comment.text || "";
        input.setAttribute("aria-label", "Edit comment");
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "button button-primary";
        save.textContent = "Save edit";
        form.append(input, save);
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (!form.reportValidity()) return;
          save.disabled = true;
          try {
            await updateComment({
              year: state.year,
              month: state.monthNumber,
              lotId: state.lotId,
              comment,
              text: input.value
            });
          } catch (error) {
            handleError(error);
            save.disabled = false;
          }
        });
        article.append(form);
        input.focus();
      });
      actions.append(edit);
    }
    if (canDeleteComment(comment)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button comment-delete-button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        if (!window.confirm("Permanently delete this comment, all its replies, and linked notifications?")) return;
        try {
          await deleteComment({
            year: state.year,
            month: state.monthNumber,
            lotId: state.lotId,
            comment
          });
          state.comments = state.comments.filter(entry => entry.id !== comment.id);
          if (state.activeCommentId === comment.id) {
            state.unsubscribeReplies?.();
            state.unsubscribeReplies = null;
            state.activeCommentId = null;
            state.replies = [];
          }
          renderCommentDecorations();
          renderCurrentComments();
          renderCommentThreads();
        } catch (error) {
          handleError(error);
        }
      });
      actions.append(remove);
    }
    const resolve = document.createElement("button");
    resolve.type = "button";
    resolve.className = "text-button";
    resolve.textContent = comment.status === "open" ? "Resolve" : "Reopen";
    resolve.addEventListener("click", async () => {
      try {
        await setCommentResolved({
          year: state.year,
          month: state.monthNumber,
          lotId: state.lotId,
          comment,
          resolved: comment.status === "open"
        });
      } catch (error) {
        handleError(error);
      }
    });
    actions.append(resolve);
    article.append(actions);
    container.append(article);
  }
}

function maybeOpenPendingNavigation() {
  if (!pendingNavigation) return;
  const target = [...document.querySelectorAll("[data-comment-cell]")].find(element =>
    element.dataset.commentItemId === pendingNavigation.itemId
    && element.dataset.commentColumnKey === pendingNavigation.columnKey
    && (element.dataset.commentDeliveryDateId || "") === pendingNavigation.deliveryDateId
    && (element.dataset.commentCatchUpId || "") === pendingNavigation.catchUpId
  );
  if (!target) return;
  const commentId = pendingNavigation.commentId;
  pendingNavigation = null;
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  target.classList.add("comment-flash");
  window.setTimeout(() => target.classList.remove("comment-flash"), 1900);
  openCommentThread(currentCellRef(target), commentId);
  history.replaceState({}, "", window.location.pathname);
}

function activeLotData() {
  return state.monthData.lots[state.lotId];
}

function addItem() {
  const beforeData = cloneMonthData(state.monthData);
  activeLotData().items.push({
    id: makeId(),
    unit: state.units[0],
    name: "",
    unitPrice: 0,
    orderQty: 0,
    quantities: {},
    catchUps: []
  });
  render();
  persist(beforeData).then(saved => {
    if (saved) document.querySelector(".item-input")?.focus();
  });
}

function addDeliveryDate() {
  const input = document.getElementById("deliveryDateInput");
  const date = input.value;
  if (!date) {
    showToast("Select a delivery date first.");
    input.focus();
    return;
  }
  const lotData = activeLotData();
  if (lotData.deliveryDates.some(entry => entry.date === date)) {
    showToast("That delivery date is already in this lot.");
    return;
  }
  const beforeData = cloneMonthData(state.monthData);
  lotData.deliveryDates.push({ id: `date-${date}`, date });
  input.value = "";
  render();
  persist(beforeData);
}

function handleDateAction(button) {
  const lotData = activeLotData();
  const index = lotData.deliveryDates.findIndex(entry => entry.id === button.dataset.dateId);
  if (index < 0) return;

  const beforeData = cloneMonthData(state.monthData);
  if (button.dataset.action === "delete-date") {
    const date = lotData.deliveryDates[index];
    if (!window.confirm(`Delete the ${formatDate(date.date)} delivery date and its proposed/actual quantities for this lot?`)) return;
    lotData.deliveryDates.splice(index, 1);
    for (const item of lotData.items) delete item.quantities[date.id];
  } else if (button.dataset.action === "move-date") {
    const targetIndex = index + Number(button.dataset.direction);
    if (targetIndex < 0 || targetIndex >= lotData.deliveryDates.length) return;
    [lotData.deliveryDates[index], lotData.deliveryDates[targetIndex]] =
      [lotData.deliveryDates[targetIndex], lotData.deliveryDates[index]];
  }
  render();
  persist(beforeData);
}

function deleteItem(itemId) {
  const lotData = activeLotData();
  const item = lotData.items.find(entry => entry.id === itemId);
  if (!item || !window.confirm(`Delete "${item.name || "this item"}" from the matrix? Its complete item and delivery history will remain in the Audit Log.`)) return;
  const beforeData = cloneMonthData(state.monthData);
  lotData.items = lotData.items.filter(entry => entry.id !== itemId);
  render();
  persist(beforeData);
}

function updateCell(input) {
  const rowIndex = Number(input.dataset.rowIndex);
  const item = activeLotData().items[rowIndex];
  if (!item) return;
  const { field } = input.dataset;
  const beforeData = cloneMonthData(state.monthData);
  if (field === "name") {
    const name = input.value.trim();
    const duplicate = name && activeLotData().items.some(entry =>
      entry.id !== item.id && entry.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (duplicate) {
      showToast("An item with that name already exists in this lot.");
      render();
      return;
    }
    item.name = name;
  } else if (field === "unit") {
    item.unit = input.value;
  } else if (field === "unitPrice" || field === "orderQty") {
    const number = input.value === "" ? 0 : Number(input.value);
    if (!Number.isFinite(number) || number < 0) {
      showToast("Enter a valid number that is zero or greater.");
      render();
      return;
    }
    item[field] = number;
  } else {
    const [kind, dateId] = field.split(":");
    const number = input.value === "" ? 0 : Number(input.value);
    if (!Number.isFinite(number) || number < 0) {
      showToast("Enter a valid quantity that is zero or greater.");
      render();
      return;
    }
    if (!item.quantities[dateId]) item.quantities[dateId] = { proposed: 0, actual: 0 };
    item.quantities[dateId][kind] = number;
  }
  const previousItem = beforeData.lots[state.lotId].items[rowIndex];
  const currentTotals = getItemTotals(item, activeLotData().deliveryDates);
  if (currentTotals.overDelivered && !getItemTotals(previousItem, activeLotData().deliveryDates).overDelivered
    && !window.confirm(`${item.name || "This item"} will be over-delivered by ${formatQuantity(currentTotals.actual - currentTotals.proposed)} ${item.unit}. Record this change?`)) {
    state.monthData = beforeData;
    render();
    return;
  }
  render();
  persist(beforeData);
}

function moveSpreadsheetFocus(event) {
  if (!event.target.matches("[data-row-index][data-column-index]")) return;
  const direction = {
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    Enter: [1, 0]
  }[event.key];
  if (!direction) return;
  const rowIndex = Number(event.target.dataset.rowIndex) + direction[0];
  const columnIndex = Number(event.target.dataset.columnIndex) + direction[1];
  const selector = `[data-row-index="${rowIndex}"][data-column-index="${columnIndex}"]`;
  if (!document.querySelector(selector)) return;
  event.preventDefault();
  try {
    updateCell(event.target);
  } catch (error) {
    handleError(error);
    return;
  }
  const next = document.querySelector(selector);
  if (next) {
    next.focus();
    if (next instanceof HTMLInputElement && next.type === "text") next.select();
  }
}

function openCatchupDialog(itemId) {
  const item = activeLotData().items.find(entry => entry.id === itemId);
  if (!item) return;
  const totals = getItemTotals(item, activeLotData().deliveryDates);
  document.getElementById("catchupItemId").value = itemId;
  document.getElementById("catchupItemName").textContent = `${item.name || "Untitled item"} · ${item.unit}`;
  document.getElementById("catchupRemaining").textContent = `${formatQuantity(totals.undelivered)} ${item.unit}`;
  document.getElementById("catchupDate").value = todayInManila();
  document.getElementById("catchupQty").value = "";
  document.getElementById("catchupReceivedBy").value = "";
  document.getElementById("catchupRemarks").value = "";
  document.getElementById("catchupDialog").showModal();
}

async function saveCatchup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const itemId = document.getElementById("catchupItemId").value;
  const item = activeLotData().items.find(entry => entry.id === itemId);
  if (!item) {
    showToast("The item no longer exists. Reopen the delivery log and try again.");
    document.getElementById("catchupDialog").close();
    return;
  }
  const date = document.getElementById("catchupDate").value;
  const qty = Number(document.getElementById("catchupQty").value);
  const receivedBy = document.getElementById("catchupReceivedBy").value.trim();
  const remarks = document.getElementById("catchupRemarks").value.trim();
  if (!date || !Number.isFinite(qty) || qty <= 0 || !receivedBy) {
    showToast("Enter a valid date, positive quantity, and received-by name.");
    return;
  }
  const remaining = getItemTotals(item, activeLotData().deliveryDates).undelivered;
  if (qty > remaining && !window.confirm(`This quantity exceeds the remaining ${formatQuantity(remaining)} ${item.unit} by ${formatQuantity(qty - remaining)} ${item.unit}. Record it as an over-delivery?`)) return;
  const beforeData = cloneMonthData(state.monthData);
  item.catchUps.push({
    id: makeId(),
    date,
    qty,
    receivedBy,
    remarks,
    loggedAt: new Date().toISOString()
  });
  if (await persist(beforeData)) {
    document.getElementById("catchupDialog").close();
    render();
    showToast("Catch-up delivery recorded.");
  }
}

async function copyPreviousMonth() {
  const previousKey = getPreviousMonthKey(state.year, state.monthNumber);
  const previousLot = (await getMonthData(previousKey)).lots[state.lotId];
  if (!previousLot.items.length) {
    showToast(`No items found for this lot in ${previousKey}.`);
    return;
  }
  const currentLot = activeLotData();
  if (currentLot.items.length && !window.confirm("Replace this lot's current item list with the previous month's items? Current delivery and catch-up entries on these rows will be removed.")) return;
  const names = previousLot.items.map(item => item.name.trim().toLocaleLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) {
    showToast("The previous month contains duplicate item names. Resolve those duplicates before copying the items.");
    return;
  }
  const beforeData = cloneMonthData(state.monthData);
  currentLot.items = previousLot.items.map(item => ({
    id: makeId(),
    unit: item.unit,
    name: item.name,
    unitPrice: Number(item.unitPrice) || 0,
    orderQty: Number(item.orderQty) || 0,
    quantities: {},
    catchUps: []
  }));
  if (await persist(beforeData)) {
    render();
    showToast(`Copied ${currentLot.items.length} items from ${previousKey}.`);
  }
}

function renderUnits() {
  const list = document.getElementById("unitList");
  list.replaceChildren();
  for (const unit of state.units) {
    const item = document.createElement("li");
    item.textContent = unit;
    list.append(item);
  }
}

async function populateExportYears() {
  const select = document.getElementById("exportDataYear");
  const years = await getAvailableYears();
  select.replaceChildren();
  const allYears = document.createElement("option");
  allYears.value = "all";
  allYears.textContent = "All years";
  select.append(allYears);
  for (const year of years) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    option.selected = year === state.year;
    select.append(option);
  }
}

async function exportAllDataForSelection(format) {
  const selectedYear = document.getElementById("exportDataYear").value;
  const yearFilter = selectedYear === "all" ? null : Number(selectedYear);
  const [months, units, allComments, allNotifications, allAuditLogs] = await Promise.all([
    getAllMonthData(yearFilter),
    getUnits(),
    getAllCommentsWithReplies(),
    getAllNotifications(),
    getAuditLogs()
  ]);
  const comments = yearFilter === null
    ? allComments
    : allComments.filter(comment => Number(comment.year) === yearFilter);
  const notifications = yearFilter === null
    ? allNotifications
    : allNotifications.filter(notification => Number(notification.year) === yearFilter);
  const auditLogs = yearFilter === null
    ? allAuditLogs
    : allAuditLogs.filter(entry => Number(entry.year) === yearFilter);
  exportAllData({ yearFilter, months, units, comments, notifications, auditLogs, format });
  document.getElementById("exportDataDialog").close();
  showToast(`All data exported as ${format.toUpperCase()}.`);
}

async function addYearFromDialog(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const year = Number(document.getElementById("newYearInput").value);
  if (!Number.isInteger(year) || year < 2026 || year > 9999) {
    showToast("Enter a whole year from 2026 to 9999.");
    return;
  }
  try {
    await ensureYear(year);
    state.year = year;
    await renderPeriodControls();
    await loadMonth();
    document.getElementById("yearDialog").close();
    showToast(`${year} is ready.`);
  } catch (error) {
    handleError(error);
  }
}

function setAuthMessage(message) {
  document.getElementById("authMessage").textContent = message;
}

function showPasswordForm(message) {
  document.getElementById("googleSignInButton").hidden = true;
  document.getElementById("memberPasswordForm").hidden = false;
  document.getElementById("authSignOutButton").hidden = false;
  document.getElementById("memberPasswordInput").value = "";
  setAuthMessage(message);
}

function showGoogleSignIn(message = "") {
  document.getElementById("googleSignInButton").hidden = false;
  document.getElementById("memberPasswordForm").hidden = true;
  document.getElementById("authSignOutButton").hidden = true;
  setAuthMessage(message);
}

function clearPendingAccessPoll() {
  if (pendingAccessTimer !== null) {
    window.clearInterval(pendingAccessTimer);
    pendingAccessTimer = null;
  }
}

async function logEntryOnce(user, role) {
  if (localStorage.getItem(LOGIN_SESSION_KEY) === user.uid) return;
  await addDoc(collection(db, "loginLogs"), {
    email: normalizeEmail(user.email),
    displayName: user.displayName || normalizeEmail(user.email),
    role,
    event: "login",
    at: serverTimestamp(),
    device: navigator.userAgent
  });
  localStorage.setItem(LOGIN_SESSION_KEY, user.uid);
}

async function activateApp(user, role) {
  try {
    const email = normalizeEmail(user.email);
    const profileName = user.displayName || email;
    document.getElementById("signedInEmail").textContent = profileName;
    document.getElementById("profileName").textContent = profileName;
    document.getElementById("profileEmail").textContent = email;
    document.getElementById("profileLoginTime").textContent = user.metadata?.lastSignInTime
      ? `Signed in ${new Intl.DateTimeFormat("en-PH", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Manila"
      }).format(new Date(user.metadata.lastSignInTime))}`
      : "Signed in";
    const profilePhoto = document.getElementById("profilePhoto");
    profilePhoto.hidden = !user.photoURL;
    if (user.photoURL) profilePhoto.src = user.photoURL;
    else profilePhoto.removeAttribute("src");
    document.getElementById("changeAppPasswordButton").hidden = role !== "admin";
    document.getElementById("loginHistoryLink").hidden = role !== "admin";
    document.getElementById("usersAccessLink").hidden = role !== "admin";
    document.getElementById("sidebarChangePasswordButton").hidden = role !== "admin";
    document.getElementById("auditLogLink").hidden = role !== "admin";
    document.querySelector(".app-shell").hidden = false;
    document.getElementById("authScreen").hidden = true;
    if (!window.location.hash) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#matrix`
      );
    }
    setActiveView();
    await logEntryOnce(user, role);
    await renderPeriodControls();
    await initializeApp();
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    document.querySelector(".app-shell").hidden = true;
    document.getElementById("authScreen").hidden = false;
    setAuthMessage("Unable to start the workspace. Check your connection and try again.");
  }
}

function isPermissionDenied(error) {
  return error?.code === "permission-denied" || error?.code === "firestore/permission-denied";
}

async function completeMemberEntry(user, passwordHash, reloadAfterUpdate = false) {
  const email = normalizeEmail(user.email);
  try {
    await updateDoc(memberRefFor(email), { hash: passwordHash });
    localStorage.setItem(`dswd-foodstuff-member-hash:${email}`, passwordHash);
    pendingPasswordHash = "";
    clearPendingAccessPoll();
    if (reloadAfterUpdate) {
      window.location.reload();
      return;
    }
    await activateApp(user, "member");
  } catch (error) {
    if (isPermissionDenied(error)) {
      showPasswordForm("Wrong password");
      return;
    }
    handleError(error);
    showPasswordForm("Unable to verify access. Please try again.");
  }
}

async function refreshPendingAccess(user) {
  try {
    const member = await getMember(user.email);
    if (!member) {
      clearPendingAccessPoll();
      showPasswordForm("Your access request could not be found. Enter the shared password to try again.");
      return;
    }
    if (member.status === "approved") {
      clearPendingAccessPoll();
      if (pendingPasswordHash) {
        await completeMemberEntry(user, pendingPasswordHash, true);
      } else {
        showPasswordForm("Access approved. Enter the shared password to continue.");
      }
    } else if (member.status === "rejected" || member.status === "revoked") {
      clearPendingAccessPoll();
      messageAfterSignOut = "Access denied. Contact the administrator.";
      await signOutUser();
    } else {
      setAuthMessage("Waiting for administrator approval.");
    }
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    setAuthMessage(error instanceof Error ? error.message : "Unable to check access status.");
  }
}

function startPendingAccessPoll(user) {
  clearPendingAccessPoll();
  pendingAccessTimer = window.setInterval(() => {
    if (currentUser?.uid !== user.uid) {
      clearPendingAccessPoll();
      return;
    }
    refreshPendingAccess(user);
  }, 30_000);
}

async function logAccessRequest(user) {
  await addDoc(collection(db, "loginLogs"), {
    email: normalizeEmail(user.email),
    displayName: user.displayName || normalizeEmail(user.email),
    event: "request",
    at: serverTimestamp(),
    device: navigator.userAgent
  });
}

function waitingForApproval(user, passwordHash = "", message = "Waiting for administrator approval.") {
  pendingPasswordHash = passwordHash;
  document.getElementById("googleSignInButton").hidden = true;
  document.getElementById("memberPasswordForm").hidden = true;
  document.getElementById("authSignOutButton").hidden = false;
  setAuthMessage(message);
  startPendingAccessPoll(user);
}

async function submitMemberPassword(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity() || !currentUser) return;
  const user = currentUser;
  const email = normalizeEmail(user.email);
  const password = document.getElementById("memberPasswordInput").value;
  try {
    setAuthMessage("Checking shared password…");
    const passwordHash = await hashPassword(password);
    const member = await getMember(email);
    if (!member) {
      try {
        await setDoc(memberRefFor(email), {
          email,
          displayName: user.displayName || email,
          photoURL: user.photoURL || "",
          hash: passwordHash,
          status: "pending",
          requestedAt: serverTimestamp()
        });
      } catch (error) {
        if (isPermissionDenied(error)) {
          setAuthMessage("Wrong password or the administrator has not set a password yet.");
          return;
        }
        throw error;
      }
      await logAccessRequest(user);
      waitingForApproval(user, passwordHash, "Request sent. Waiting for administrator approval.");
      return;
    }

    if (member.status === "pending") {
      waitingForApproval(user, passwordHash);
      return;
    }
    if (member.status === "rejected" || member.status === "revoked") {
      messageAfterSignOut = "Access denied. Contact the administrator.";
      await signOutUser();
      return;
    }
    if (member.status !== "approved") {
      setAuthMessage("This account has an invalid access status. Contact the administrator.");
      return;
    }
    await completeMemberEntry(user, passwordHash, true);
  } catch (error) {
    handleError(error);
    setAuthMessage(error instanceof Error ? error.message : "Unable to check access.");
  }
}

async function handleAuthState(user) {
  const generation = ++authStateGeneration;
  clearPendingAccessPoll();
  pendingPasswordHash = "";
  if (!user) {
    currentUser = null;
    state.unsubscribeComments?.();
    state.unsubscribeMonth?.();
    state.unsubscribeNotifications?.();
    state.unsubscribeReplies?.();
    state.unsubscribeComments = null;
    state.unsubscribeMonth = null;
    state.unsubscribeNotifications = null;
    state.unsubscribeReplies = null;
    state.monthData = null;
    state.comments = [];
    state.notifications = [];
    contextVersion += 1;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    document.querySelector(".app-shell").hidden = true;
    document.getElementById("authScreen").hidden = false;
    document.getElementById("signedInEmail").textContent = "";
    document.getElementById("profileName").textContent = "Signed in";
    document.getElementById("profileEmail").textContent = "";
    document.getElementById("profileLoginTime").textContent = "";
    document.getElementById("profilePhoto").hidden = true;
    document.getElementById("profilePhoto").removeAttribute("src");
    document.getElementById("changeAppPasswordButton").hidden = true;
    document.getElementById("loginHistoryLink").hidden = true;
    document.getElementById("usersAccessLink").hidden = true;
    document.getElementById("sidebarChangePasswordButton").hidden = true;
    document.getElementById("auditLogLink").hidden = true;
    setSidebarOpen(false);
    localStorage.removeItem(LOGIN_SESSION_KEY);
    showGoogleSignIn(messageAfterSignOut);
    messageAfterSignOut = "";
    return;
  }

  currentUser = user;
  if (!user.email || user.emailVerified !== true) {
    messageAfterSignOut = "Sign in with a verified Google account.";
    await signOutUser();
    return;
  }

  const email = normalizeEmail(user.email);
  if (isAdminEmail(email)) {
    if (generation === authStateGeneration) await activateApp(user, "admin");
    return;
  }

  if (generation !== authStateGeneration) return;
  document.getElementById("googleSignInButton").hidden = true;
  document.getElementById("memberPasswordForm").hidden = true;
  setAuthMessage("Checking access…");
  try {
    const member = await getMember(email);
    if (generation !== authStateGeneration) return;
    if (!member) {
      showPasswordForm("Enter the shared workspace password to request access.");
      return;
    }
    if (member.status === "pending") {
      waitingForApproval(user);
      return;
    }
    if (member.status === "rejected" || member.status === "revoked") {
      messageAfterSignOut = "Access denied. Contact the administrator.";
      await signOutUser();
      return;
    }
    if (member.status !== "approved") {
      messageAfterSignOut = "This account has an invalid access status. Contact the administrator.";
      showGoogleSignIn("This account has an invalid access status. Contact the administrator.");
      await signOutUser();
      return;
    }

    const savedHash = localStorage.getItem(`dswd-foodstuff-member-hash:${email}`);
    if (savedHash) {
      await completeMemberEntry(user, savedHash);
    } else {
      showPasswordForm("Enter the shared workspace password to continue.");
    }
  } catch (error) {
    if (generation !== authStateGeneration) return;
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    showGoogleSignIn(error instanceof Error ? error.message : "Unable to check access.");
  }
}

function stopAppSubscriptions() {
  state.unsubscribeComments?.();
  state.unsubscribeMonth?.();
  state.unsubscribeNotifications?.();
  state.unsubscribeReplies?.();
  state.unsubscribeComments = null;
  state.unsubscribeMonth = null;
  state.unsubscribeNotifications = null;
  state.unsubscribeReplies = null;
  contextVersion += 1;
}

function setupEvents() {
  document.querySelectorAll("a[data-view-link]").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      setSidebarOpen(false);
      setActiveView(link.dataset.viewLink, true);
    });
  });
  document.querySelectorAll("[data-overview-status]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-overview-status]").forEach(filterButton => {
        const selected = filterButton === button;
        filterButton.classList.toggle("active", selected);
        filterButton.setAttribute("aria-pressed", String(selected));
      });
      renderSummaryTable();
    });
  });
  document.getElementById("overviewItemSearch").addEventListener("input", renderSummaryTable);
  document.getElementById("overviewLotFilter").addEventListener("change", renderSummaryTable);
  document.getElementById("overviewExportButton").addEventListener("click", () => {
    try {
      if (state.configurationError) throw new Error("The overview could not be loaded, so no CSV can be exported.");
      downloadOverviewCsv();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("overviewPrintButton").addEventListener("click", () => window.print());
  window.addEventListener("hashchange", () => setActiveView());
  document.getElementById("menuToggleButton").addEventListener("click", () => setSidebarOpen(true));
  document.getElementById("sidebarCloseButton").addEventListener("click", () => setSidebarOpen(false));
  document.getElementById("sidebarScrim").addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") setSidebarOpen(false);
  });
  window.addEventListener("resize", () => setSidebarOpen(false));
  setupFreezeSetting("freezeHeaderToggle", "header-frozen", FREEZE_HEADER_STORAGE_KEY);
  setupFreezeSetting("freezePanesToggle", "panes-frozen", FREEZE_PANES_STORAGE_KEY);
  document.getElementById("commentsPanelToggle").addEventListener("click", () => {
    setActiveView("notifications", true);
  });
  document.getElementById("closeCommentsPanelButton").addEventListener("click", () => {
    setActiveView("matrix", true);
  });
  document.querySelectorAll(".year-tab").forEach(button => {
    button.addEventListener("click", () => {
      document.getElementById("yearSelect").value = button.dataset.year;
      document.getElementById("yearSelect").dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  document.querySelectorAll(".month-tab").forEach(button => {
    button.addEventListener("click", () => {
      document.getElementById("monthSelect").value = button.dataset.month;
      document.getElementById("monthSelect").dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  document.querySelectorAll(".matrix-mode").forEach(button => {
    button.addEventListener("click", () => setMatrixMode(button.dataset.matrixMode));
  });
  document.getElementById("previousMatrixCard").addEventListener("click", () => {
    state.matrixCardIndex = Math.max(0, state.matrixCardIndex - 1);
    updateMatrixCardView();
  });
  document.getElementById("nextMatrixCard").addEventListener("click", () => {
    const count = document.querySelectorAll("#matrixBody tr[data-item-id]").length;
    state.matrixCardIndex = Math.min(count - 1, state.matrixCardIndex + 1);
    updateMatrixCardView();
  });
  document.querySelectorAll(".embedded-view iframe").forEach(frame => {
    frame.addEventListener("load", () => styleEmbeddedPage(frame));
    frame.addEventListener("error", () => {
      const view = frame.closest("[data-app-view]")?.dataset.appView;
      const stateIds = {
        comments: "commentsViewState",
        "login-history": "loginHistoryViewState",
        users: "usersViewState",
        audit: "auditViewState"
      };
      if (stateIds[view]) setViewState(stateIds[view], "Unable to load this view. Check your connection and try again.", "error");
    });
  });
  document.getElementById("googleSignInButton").addEventListener("click", async () => {
    setAuthMessage("");
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      setAuthMessage(error instanceof Error ? error.message : "Google sign-in failed.");
    }
  });
  document.getElementById("authSignOutButton").addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("memberPasswordForm").addEventListener("submit", submitMemberPassword);
  document.getElementById("signOutButton").addEventListener("click", async () => {
    const user = currentUser;
    let logError = null;
    if (user?.email && localStorage.getItem(LOGIN_SESSION_KEY) === user.uid) {
      try {
        await addDoc(collection(db, "loginLogs"), {
          email: normalizeEmail(user.email),
          displayName: user.displayName || normalizeEmail(user.email),
          role: isAdminEmail(user.email) ? "admin" : "member",
          event: "logout",
          at: serverTimestamp(),
          device: navigator.userAgent
        });
      } catch (error) {
        logError = error;
      }
    }
    try {
      await signOutUser();
      if (logError) handleError(logError);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("changePasswordForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = document.getElementById("newSharedPassword").value;
    const confirmation = document.getElementById("confirmSharedPassword").value;
    if (!form.reportValidity()) return;
    if (password.length < 8) {
      setViewState("passwordViewState", "Use a password with at least 8 characters.", "error");
      return;
    }
    if (password !== confirmation) {
      setViewState("passwordViewState", "The passwords do not match.", "error");
      return;
    }
    try {
      setViewState("passwordViewState", "Saving password…");
      await changeSharedPassword(currentUser.email, password);
      form.reset();
      setViewState("passwordViewState", "Password changed. All non-admin members must enter it again.", "success");
    } catch (error) {
      setViewState("passwordViewState", error instanceof Error ? error.message : "Unable to change the password.", "error");
      handleError(error);
    }
  });

  document.getElementById("yearSelect").addEventListener("change", async event => {
    state.year = Number(event.currentTarget.value);
    syncPeriodTabs();
    await loadMonth();
  });
  document.getElementById("monthSelect").addEventListener("change", async event => {
    state.monthNumber = Number(event.currentTarget.value);
    syncPeriodTabs();
    await loadMonth();
  });
  document.getElementById("addYearButton").addEventListener("click", () => {
    document.getElementById("newYearInput").value = String(Math.max(2026, state.year + 1));
    document.getElementById("yearDialog").showModal();
  });
  document.getElementById("addItemButton").addEventListener("click", addItem);
  document.getElementById("addDateButton").addEventListener("click", () => {
    try {
      addDeliveryDate();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("matrixHead").addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      handleDateAction(button);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("matrixBody").addEventListener("change", event => {
    if (!event.target.matches("[data-row-index][data-column-index]")) return;
    try {
      updateCell(event.target);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("matrixBody").addEventListener("keydown", moveSpreadsheetFocus);
  document.getElementById("matrixBody").addEventListener("click", event => {
    const commentButton = event.target.closest("button[data-action='open-comment']");
    if (commentButton) {
      openCommentThread(currentCellRef(commentButton.closest("[data-comment-cell]")));
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "delete-item") deleteItem(button.dataset.itemId);
      if (button.dataset.action === "log-catchup") openCatchupDialog(button.dataset.itemId);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("matrixBody").addEventListener("contextmenu", event => {
    const cell = event.target.closest("[data-comment-cell]");
    if (!cell) return;
    event.preventDefault();
    openCommentThread(currentCellRef(cell));
  });
  document.getElementById("commentDialog").addEventListener("close", () => {
    state.unsubscribeReplies?.();
    state.unsubscribeReplies = null;
    state.activeCommentId = null;
    state.replies = [];
  });
  document.getElementById("markAllNotificationsReadButton").addEventListener("click", () => {
    try {
      markAllNotificationsRead(state.notifications);
      renderNotifications();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("newCommentForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const item = activeLotData()?.items.find(entry => entry.id === state.activeCellRef?.itemId);
      const commentId = await addComment({
        year: state.year,
        month: state.monthNumber,
        lotId: state.lotId,
        cellRef: state.activeCellRef,
        itemName: item?.name || "",
        text: document.getElementById("newCommentText").value
      });
      document.getElementById("newCommentText").value = "";
      state.activeCommentId = null;
      openCommentThread(state.activeCellRef, commentId);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("closeCommentDialogButton").addEventListener("click", () => {
    document.getElementById("commentDialog").close();
    state.unsubscribeReplies?.();
    state.unsubscribeReplies = null;
    state.activeCommentId = null;
  });
  document.getElementById("copyPreviousButton").addEventListener("click", async () => {
    try {
      await copyPreviousMonth();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("exportButton").addEventListener("click", () => {
    try {
      exportCurrentLot({
        monthData: state.monthData,
        lotId: state.lotId,
        year: state.year,
        monthNumber: state.monthNumber
      });
      document.getElementById("exportCurrentLotButton").addEventListener("click", () => {
        try {
          exportCurrentLot({
            monthData: state.monthData,
            lotId: state.lotId,
            year: state.year,
            monthNumber: state.monthNumber
          });
          setViewState("exportViewState", "Current lot CSV exported.", "success");
        } catch (error) {
          setViewState("exportViewState", error instanceof Error ? error.message : "Unable to export the current lot.", "error");
          handleError(error);
        }
      });
      showToast("CSV export downloaded.");
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("exportAllDataButton").addEventListener("click", async () => {
    try {
      await populateExportYears();
      document.getElementById("exportDataDialog").showModal();
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("exportDataForm").addEventListener("submit", async event => {
    event.preventDefault();
    const format = event.submitter?.dataset.exportFormat;
    if (format !== "json" && format !== "csv") return;
    try {
      await exportAllDataForSelection(format);
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("closeExportDataButton").addEventListener("click", () =>
    document.getElementById("exportDataDialog").close()
  );
  document.getElementById("cancelExportDataButton").addEventListener("click", () =>
    document.getElementById("exportDataDialog").close()
  );
  document.getElementById("printButton").addEventListener("click", () => {
    setActiveView("matrix");
    if (window.location.hash !== "#matrix") window.location.hash = "matrix";
    window.print();
  });
  document.getElementById("configUnitForm").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("configNewUnit");
    try {
      setViewState("configViewState", "Saving unit…");
      state.units = await addUnit(input.value);
      state.configurationError = false;
      input.value = "";
      renderUnits();
      renderConfigurationView();
      render();
      setViewState("configViewState", "Unit added.", "success");
    } catch (error) {
      setViewState("configViewState", error instanceof Error ? error.message : "Unable to add unit.", "error");
      handleError(error);
    }
  });
  document.getElementById("unitForm").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("newUnitInput");
    try {
      state.units = await addUnit(input.value);
      input.value = "";
      renderUnits();
      render();
      showToast("Unit added.");
    } catch (error) {
      handleError(error);
    }
  });
  document.getElementById("catchupForm").addEventListener("submit", saveCatchup);
  document.getElementById("closeCatchupButton").addEventListener("click", () => document.getElementById("catchupDialog").close());
  document.getElementById("cancelCatchupButton").addEventListener("click", () => document.getElementById("catchupDialog").close());
  document.getElementById("closeUnitButton").addEventListener("click", () => document.getElementById("unitDialog").close());
  document.getElementById("doneUnitsButton").addEventListener("click", () => document.getElementById("unitDialog").close());
  document.getElementById("yearForm").addEventListener("submit", addYearFromDialog);
  document.getElementById("closeYearButton").addEventListener("click", () => document.getElementById("yearDialog").close());
  document.getElementById("cancelYearButton").addEventListener("click", () => document.getElementById("yearDialog").close());
}

try {
  setupEvents();
  authReady.then(() => {
    onAuthStateChanged(auth, user => {
      handleAuthState(user).catch(error => {
        console.error(error?.code ?? "unknown", error?.message ?? String(error));
        showGoogleSignIn(error instanceof Error ? error.message : "Unable to check account access.");
      });
    }, error => {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      showGoogleSignIn(error instanceof Error ? error.message : "Unable to initialize sign-in.");
    });
  }).catch(error => {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    showGoogleSignIn(error instanceof Error ? error.message : "Unable to initialize sign-in.");
  });
} catch (error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  setAuthMessage(error instanceof Error ? error.message : "Unable to initialize the workspace.");
}