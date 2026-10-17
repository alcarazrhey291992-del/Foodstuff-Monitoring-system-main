import { auth, requireAppAccess } from "./auth.js";
import { db } from "./firebase-config.js";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const pendingList = document.getElementById("pendingRequests");
const pendingStatus = document.getElementById("pendingRequestsStatus");
const pendingCount = document.getElementById("pendingRequestsCount");
const pendingBadge = document.getElementById("pendingRequestBadge");
const historyStatus = document.getElementById("historyStatus");
const historyRows = document.getElementById("loginHistoryRows");
const emailFilter = document.getElementById("filterEmail");
const eventFilter = document.getElementById("filterEvent");
const fromFilter = document.getElementById("filterFromDate");
const toFilter = document.getElementById("filterToDate");
const formatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila"
});

let requests = [];
let logs = [];

function asDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatDate(value) {
  const date = asDate(value);
  return date ? formatter.format(date) : "—";
}

function dateKey(value) {
  const date = asDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Manila"
  }).formatToParts(date);
  const part = type => parts.find(entry => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function safePhotoUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function updatePendingBadge() {
  const count = requests.length;
  pendingCount.textContent = String(count);
  pendingBadge.textContent = String(count);
  document.title = count
    ? `Login History (${count} pending) · DSWD Sanctuary Center`
    : "Login History · DSWD Sanctuary Center";
}

function renderRequests() {
  updatePendingBadge();
  pendingList.replaceChildren();
  if (!requests.length) {
    pendingStatus.textContent = "There are no pending access requests.";
    return;
  }
  pendingStatus.textContent = `${requests.length} request${requests.length === 1 ? "" : "s"} awaiting review.`;

  for (const member of requests) {
    const card = document.createElement("article");
    card.className = "admin-record";
    const identity = document.createElement("div");
    identity.className = "admin-record-identity";
    const photoUrl = safePhotoUrl(member.photoURL);
    if (photoUrl) {
      const photo = document.createElement("img");
      photo.className = "admin-avatar";
      photo.src = photoUrl;
      photo.alt = "";
      photo.referrerPolicy = "no-referrer";
      identity.append(photo);
    }
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = member.displayName || member.email || member.id;
    const email = document.createElement("span");
    email.textContent = member.email || member.id;
    const requested = document.createElement("small");
    requested.textContent = `Requested ${formatDate(member.requestedAt)}`;
    details.append(name, email, requested);
    identity.append(details);

    const actions = document.createElement("div");
    actions.className = "admin-record-actions";
    const accept = document.createElement("button");
    accept.className = "button button-primary";
    accept.type = "button";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => updateRequest(member, "approved"));
    const reject = document.createElement("button");
    reject.className = "button button-light";
    reject.type = "button";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => updateRequest(member, "rejected"));
    actions.append(accept, reject);
    card.append(identity, actions);
    pendingList.append(card);
  }
}

async function updateRequest(member, status) {
  const action = status === "approved" ? "accept" : "reject";
  if (!window.confirm(`Are you sure you want to ${action} access for ${member.email || member.id}?`)) return;
  const email = auth.currentUser?.email?.trim().toLowerCase();
  if (!email) throw new Error("The administrator session is no longer available.");
  const changes = status === "approved"
    ? { status, approvedBy: email, approvedAt: serverTimestamp() }
    : { status, rejectedBy: email, rejectedAt: serverTimestamp() };
  try {
    await updateDoc(member.ref, changes);
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    pendingStatus.textContent = error instanceof Error ? error.message : "Unable to update this request.";
  }
}

function filteredLogs() {
  const email = emailFilter.value.trim().toLowerCase();
  const event = eventFilter.value;
  const from = fromFilter.value;
  const to = toFilter.value;
  return logs.filter(log => {
    const logEmail = String(log.email || "").toLowerCase();
    const day = dateKey(log.at);
    return (!email || logEmail.includes(email))
      && (!event || log.event === event)
      && (!from || (day && day >= from))
      && (!to || (day && day <= to));
  });
}

function renderLogs() {
  const visibleLogs = filteredLogs();
  historyRows.replaceChildren();
  for (const log of visibleLogs) {
    const row = document.createElement("tr");
    for (const value of [
      formatDate(log.at),
      log.email || "—",
      log.displayName || "—",
      log.role || (log.event === "request" ? "requester" : "—"),
      log.event || "—",
      log.device || "—"
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    historyRows.append(row);
  }
  historyStatus.textContent = visibleLogs.length
    ? `${visibleLogs.length} of ${logs.length} event${logs.length === 1 ? "" : "s"}`
    : "No matching login events.";
}

for (const filter of [emailFilter, eventFilter, fromFilter, toFilter]) {
  filter.addEventListener(filter === emailFilter ? "input" : "change", renderLogs);
}

try {
  if (await requireAppAccess(true)) {
    onSnapshot(query(collection(db, "members"), where("status", "==", "pending")), snapshot => {
      requests = snapshot.docs
        .map(member => ({ ...member.data(), id: member.id, ref: member.ref }))
        .sort((a, b) => (asDate(a.requestedAt)?.getTime() || 0) - (asDate(b.requestedAt)?.getTime() || 0));
      renderRequests();
    }, error => {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      pendingStatus.textContent = error instanceof Error ? error.message : "Unable to load access requests.";
    });
    onSnapshot(query(collection(db, "loginLogs"), orderBy("at", "desc")), snapshot => {
      logs = snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
      renderLogs();
    }, error => {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      historyStatus.textContent = error instanceof Error ? error.message : "Unable to load login history.";
    });
  }
} catch (error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  pendingStatus.textContent = error instanceof Error ? error.message : "Unable to load access requests.";
  historyStatus.textContent = error instanceof Error ? error.message : "Unable to load login history.";
}
