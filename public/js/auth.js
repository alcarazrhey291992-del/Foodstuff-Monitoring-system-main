import { auth, db } from "./firebase-config.js";
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const ADMINS = ["asanctuary171@gmail.com", "sc.foncr@dswd.gov.ph"];
export const ADMIN_EMAIL = ADMINS[0];
export const LOGIN_SESSION_KEY = "dswd-foodstuff-login-session";
export const authReady = setPersistence(auth, browserLocalPersistence);

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isAdminEmail(email) {
  return ADMINS.includes(normalizeEmail(email));
}

export async function signInWithGoogle() {
  await authReady;
  return signInWithPopup(auth, provider);
}

export async function signOutUser() {
  await authReady;
  await signOut(auth);
}

export function waitForAuthUser() {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    }, reject);
  });
}

export async function hashPassword(password) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function memberRefFor(email) {
  return doc(db, "members", normalizeEmail(email));
}

export async function getMember(email) {
  const snapshot = await getDoc(memberRefFor(email));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function changeSharedPassword(email, password) {
  if (!isAdminEmail(email)) throw new Error("Only administrators can change the password.");
  if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
  await setDoc(doc(db, "config", "gate"), {
    hash: await hashPassword(password),
    updatedBy: normalizeEmail(email),
    updatedAt: serverTimestamp()
  });
}

export async function requireAppAccess(adminOnly = false) {
  try {
    await authReady;
    const user = await waitForAuthUser();
    if (!user?.email || user.emailVerified !== true) {
      window.location.replace("./index.html");
      return false;
    }

    const email = normalizeEmail(user.email);
    if (isAdminEmail(email)) return true;
    if (adminOnly) {
      window.location.replace("./index.html");
      return false;
    }

    const member = await getMember(email);
    const storedHash = localStorage.getItem(`dswd-foodstuff-member-hash:${email}`);
    if (!member || member.status !== "approved" || !storedHash || storedHash !== member.hash) {
      window.location.replace("./index.html");
      return false;
    }

    await getDoc(doc(db, "config", "units"));
    return true;
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    window.location.replace("./index.html");
    return false;
  }
}

export { auth, onAuthStateChanged };
