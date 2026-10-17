import { ADMINS, auth, isAdminEmail, requireAppAccess } from "./auth.js";
import { db } from "./firebase-config.js";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const memberRows = document.getElementById("memberRows");
const usersStatus = document.getElementById("usersStatus");
const timeFormatter = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila"
});

let members = [];
let lastLoginByEmail = new Map();

function formatDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? timeFormatter.format(date) : "—";
}

function renderMembers() {
  memberRows.replaceChildren();
  if (!members.length) {
    usersStatus.textContent = "No member access requests have been recorded.";
    return;
  }

  usersStatus.textContent = `${members.length} member${members.length === 1 ? "" : "s"}`;
  for (const member of members) {
    const email = String(member.email || member.id).toLowerCase();
    const row = document.createElement("tr");
    const identityCell = document.createElement("td");
    const identity = document.createElement("div");
    identity.className = "member-identity";
    const photoUrl = safePhotoUrl(member.photoURL);
    if (photoUrl) {
      const photo = document.createElement("img");
      photo.className = "admin-avatar";
      photo.src = photoUrl;
      photo.alt = "";
      photo.referrerPolicy = "no-referrer";
      identity.append(photo);
    }
    const name = document.createElement("strong");
    name.textContent = member.displayName || email;
    identity.append(name);
    identityCell.append(identity);

    const emailCell = document.createElement("td");
    emailCell.textContent = email;
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `member-status status-${member.status || "unknown"}`;
    status.textContent = member.status
      ? `${member.status.charAt(0).toUpperCase()}${member.status.slice(1)}`
      : "Unknown";
    statusCell.append(status);
    const lastLoginCell = document.createElement("td");
    lastLoginCell.textContent = formatDate(lastLoginByEmail.get(email));

    const actionCell = document.createElement("td");
    const protectedAdmin = isAdminEmail(email);
    if (protectedAdmin) {
      actionCell.textContent = "Administrator";
    } else if (member.status === "approved") {
      const revoke = document.createElement("button");
      revoke.className = "button button-light";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => setMemberStatus(member, "revoked"));
      actionCell.append(revoke);
    } else if (member.status === "rejected" || member.status === "revoked") {
      const restore = document.createElement("button");
      restore.className = "button button-primary";
      restore.type = "button";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => setMemberStatus(member, "approved"));
      actionCell.append(restore);
    } else {
      actionCell.textContent = "—";
    }
    row.append(identityCell, emailCell, statusCell, lastLoginCell, actionCell);
    memberRows.append(row);
  }
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

async function setMemberStatus(member, status) {
  const email = member.email || member.id;
  const action = status === "revoked" ? "revoke access for" : "restore access for";
  if (!window.confirm(`Are you sure you want to ${action} ${email}?`)) return;
  const adminEmail = auth.currentUser?.email?.trim().toLowerCase();
  if (!adminEmail || isAdminEmail(email)) return;

  const changes = status === "approved"
    ? { status, approvedBy: adminEmail, approvedAt: serverTimestamp() }
    : { status, revokedBy: adminEmail, revokedAt: serverTimestamp() };
  try {
    await updateDoc(member.ref, changes);
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    usersStatus.textContent = error instanceof Error ? error.message : "Unable to change member access.";
  }
}

try {
  if (await requireAppAccess(true)) {
    onSnapshot(collection(db, "members"), snapshot => {
      const byEmail = new Map(snapshot.docs.map(member => {
        const data = member.data();
        return [String(data.email || member.id).toLowerCase(), {
          ...data,
          id: member.id,
          ref: member.ref
        }];
      }));
      for (const email of ADMINS) {
        const member = byEmail.get(email);
        byEmail.set(email, {
          ...member,
          id: member?.id || email,
          email,
          displayName: member?.displayName || email,
          status: "approved"
        });
      }
      members = [...byEmail.values()]
        .sort((a, b) => String(a.email || a.id).localeCompare(String(b.email || b.id)));
      renderMembers();
    }, error => {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      usersStatus.textContent = error instanceof Error ? error.message : "Unable to load members.";
    });

    onSnapshot(query(collection(db, "loginLogs"), orderBy("at", "desc")), snapshot => {
      lastLoginByEmail = new Map();
      for (const entry of snapshot.docs) {
        const data = entry.data();
        const email = String(data.email || "").toLowerCase();
        if (data.event === "login" && email && !lastLoginByEmail.has(email)) {
          lastLoginByEmail.set(email, data.at);
        }
      }
      renderMembers();
    }, error => {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      usersStatus.textContent = error instanceof Error ? error.message : "Unable to load last login times.";
    });
  }
} catch (error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  usersStatus.textContent = error instanceof Error ? error.message : "Unable to load members.";
}
