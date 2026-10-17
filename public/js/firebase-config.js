// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB7SeQTrYb4_DVOb35e0RyJKDUlUSgPKpw",
  authDomain: "sc-foodstuff-monitoring-system.firebaseapp.com",
  projectId: "sc-foodstuff-monitoring-system",
  storageBucket: "sc-foodstuff-monitoring-system.firebasestorage.app",
  messagingSenderId: "1052126501607",
  appId: "1:1052126501607:web:ba4cdd06c0afbc115da042"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);