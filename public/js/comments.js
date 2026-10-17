import { db } from "./firebase-config.js";
import { auth, isAdminEmail, normalizeEmail } from "./auth.js";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const READ_COMMENTS_KEY = "dswd-foodstuff-read-comments";
const READ_NOTIFICATIONS_KEY = "dswd-foodstuff-read-notifications";

export function matrixDocumentId(monthKey, lotId) {
  return `${monthKey.replace("-", "_")}_${lotId}`;
}

export function getDisplayName() {
  return auth.currentUser?.email || "";
}

export function ensureDisplayName() {
  const email = getDisplayName().trim().toLowerCase();
  if (!email) throw new Error("Enter your Gmail address before editing the matrix or posting a comment.");
  return email;
}

export function isCommentAdmin() {
  return isAdminEmail(auth.currentUser?.email);
}

export function canEditComment(comment) {
  const currentEmail = normalizeEmail(auth.currentUser?.email);
  return Boolean(currentEmail && normalizeEmail(comment?.authorName) === currentEmail);
}

export function canDeleteComment(comment) {
  return isCommentAdmin() || canEditComment(comment);
}

export function commentTargetLabel(cellRef) {
  const labels = {
    unit: "Unit",
    item: "Item name",
    unitPrice: "Unit price",
    totalAmount: "Total amount",
    orderQty: "Ordered quantity",
    proposed: "Proposed quantity",
    actual: "Delivered quantity",
    totalProposed: "Total proposed amount",
    totalActual: "Total delivered amount",
    undelivered: "Undelivered quantity",
    undeliveredAmount: "Undelivered amount",
    catchUp: "Catch-up delivery"
  };
  return labels[cellRef?.columnKey] || "Matrix cell";
}

export function commentCellKey(cellRef) {
  return [
    cellRef.itemId || "",
    cellRef.columnKey || "",
    cellRef.deliveryDateId || "",
    cellRef.catchUpId || ""
  ].join("|");
}

export function subscribeToComments(year, month, lotId, callback, onError) {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const commentsRef = collection(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments"
  );
  return onSnapshot(query(commentsRef, orderBy("createdAt", "asc")), snapshot => {
    callback(snapshot.docs.map(commentDoc => ({
      id: commentDoc.id,
      ...commentDoc.data()
    })));
  }, onError);
}

export function subscribeToReplies(monthKey, lotId, commentId, callback, onError) {
  const repliesRef = collection(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments",
    commentId,
    "replies"
  );
  return onSnapshot(query(repliesRef, orderBy("createdAt", "asc")), snapshot => {
    callback(snapshot.docs.map(replyDoc => ({
      id: replyDoc.id,
      ...replyDoc.data()
    })));
  }, onError);
}

async function createNotification(kind, comment, extra = {}) {
  await addDoc(collection(db, "notifications"), {
    kind,
    commentId: comment.id,
    monthKey: comment.monthKey,
    year: comment.year,
    month: comment.month,
    lotId: comment.lotId,
    itemId: comment.cellRef.itemId,
    itemName: comment.itemName || "",
    cellRef: comment.cellRef,
    authorName: extra.authorName || comment.authorName,
    text: extra.text || comment.text || "",
    createdAt: serverTimestamp()
  });
}

export async function addComment({ year, month, lotId, cellRef, itemName, text }) {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Enter a comment first.");
  const authorName = ensureDisplayName();
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const commentRef = await addDoc(collection(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments"
  ), {
    cellRef,
    text: cleanText,
    authorName,
    createdAt: serverTimestamp(),
    status: "open",
    resolvedBy: "",
    resolvedAt: null,
    monthKey,
    year,
    month,
    lotId,
    itemName: itemName || ""
  });
  await createNotification("comment", {
    id: commentRef.id,
    monthKey,
    year,
    month,
    lotId,
    cellRef,
    authorName,
    text: cleanText,
    itemName
  });
  markCommentRead(commentRef.id);
  return commentRef.id;
}

export async function addReply({ year, month, lotId, comment, text }) {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Enter a reply first.");
  const authorName = ensureDisplayName();
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  await addDoc(collection(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments",
    comment.id,
    "replies"
  ), {
    text: cleanText,
    authorName,
    createdAt: serverTimestamp()
  });
  await createNotification("reply", comment, { text: cleanText, authorName });
  markCommentRead(comment.id);
}

export async function updateComment({ year, month, lotId, comment, text }) {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Enter a comment first.");
  if (cleanText.length > 2000) throw new Error("Comments cannot exceed 2,000 characters.");
  if (!canEditComment(comment)) throw new Error("You can edit only your own comments.");
  const commentRef = doc(
    db,
    "matrices",
    matrixDocumentId(`${year}-${String(month).padStart(2, "0")}`, lotId),
    "comments",
    comment.id
  );
  await updateDoc(commentRef, {
    text: cleanText,
    editedBy: ensureDisplayName(),
    editedAt: serverTimestamp()
  });
}

function commentRefFor(comment) {
  return doc(
    db,
    "matrices",
    comment.matrixId || matrixDocumentId(comment.monthKey, comment.lotId),
    "comments",
    comment.id
  );
}

function notificationMatchesComment(notification, comment) {
  const data = notification.data();
  return data.commentId === comment.id
    && data.monthKey === comment.monthKey
    && data.lotId === comment.lotId;
}

async function commitDeletes(references, maxBatchSize = 450) {
  const uniqueReferences = [...new Map(references.map(reference => [reference.path, reference])).values()];
  for (let index = 0; index < uniqueReferences.length; index += maxBatchSize) {
    const batch = writeBatch(db);
    for (const reference of uniqueReferences.slice(index, index + maxBatchSize)) batch.delete(reference);
    await batch.commit();
  }
}

export async function deleteComment({ year, month, lotId, comment }) {
  if (!canDeleteComment(comment)) throw new Error("You can delete only your own comments.");
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const commentRef = doc(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments",
    comment.id
  );
  const repliesRef = collection(commentRef, "replies");
  const [repliesSnapshot, notificationsSnapshot] = await Promise.all([
    getDocs(repliesRef),
    getDocs(query(collection(db, "notifications"), where("commentId", "==", comment.id)))
  ]);
  await commitDeletes([
    ...repliesSnapshot.docs.map(reply => reply.ref),
    ...notificationsSnapshot.docs
      .filter(notification => notificationMatchesComment(notification, { ...comment, monthKey }))
      .map(notification => notification.ref),
    commentRef
  ], 15);
}

export async function deleteAllComments() {
  if (!isCommentAdmin()) throw new Error("Only official administrators can delete all comments.");
  const comments = await getAllComments();
  const replyReferences = [];
  for (let index = 0; index < comments.length; index += 8) {
    const batch = await Promise.all(comments.slice(index, index + 8).map(async comment => {
      const replies = await getDocs(collection(commentRefFor(comment), "replies"));
      return replies.docs.map(reply => reply.ref);
    }));
    replyReferences.push(...batch.flat());
  }
  const commentsByIdentity = new Map(comments.map(comment => [
    `${comment.monthKey}|${comment.lotId}|${comment.id}`,
    comment
  ]));
  const notificationsSnapshot = await getDocs(collection(db, "notifications"));
  const notificationReferences = notificationsSnapshot.docs
    .filter(notification => commentsByIdentity.has(
      `${notification.data().monthKey}|${notification.data().lotId}|${notification.data().commentId}`
    ))
    .map(notification => notification.ref);
  await commitDeletes([
    ...replyReferences,
    ...notificationReferences,
    ...comments.map(commentRefFor)
  ]);
  return comments.length;
}

export async function setCommentResolved({ year, month, lotId, comment, resolved }) {
  const authorName = ensureDisplayName();
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const commentRef = doc(
    db,
    "matrices",
    matrixDocumentId(monthKey, lotId),
    "comments",
    comment.id
  );
  await updateDoc(commentRef, {
    status: resolved ? "resolved" : "open",
    resolvedBy: resolved ? authorName : "",
    resolvedAt: resolved ? serverTimestamp() : null
  });
  await createNotification(resolved ? "resolved" : "reopened", comment, {
    text: resolved ? "Comment resolved" : "Comment reopened",
    authorName
  });
}

function getStoredIds(storageKey) {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return new Set();
  const ids = JSON.parse(raw);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
    throw new Error("Saved read state is invalid. Clear this app's read-state browser storage and try again.");
  }
  return new Set(ids);
}

function markRead(storageKey, id) {
  const ids = getStoredIds(storageKey);
  ids.add(id);
  localStorage.setItem(storageKey, JSON.stringify([...ids]));
}

export function getReadCommentIds() {
  return getStoredIds(READ_COMMENTS_KEY);
}

export function markCommentRead(id) {
  markRead(READ_COMMENTS_KEY, id);
}

export function getReadNotificationIds() {
  return getStoredIds(READ_NOTIFICATIONS_KEY);
}

export function markNotificationRead(id) {
  markRead(READ_NOTIFICATIONS_KEY, id);
}

export function markAllNotificationsRead(notifications) {
  const ids = getReadNotificationIds();
  notifications.forEach(notification => ids.add(notification.id));
  localStorage.setItem(READ_NOTIFICATIONS_KEY, JSON.stringify([...ids]));
}

export async function getAllComments() {
  const matricesSnapshot = await getDocs(collection(db, "matrices"));
  const matrices = matricesSnapshot.docs
    .map(matrixDoc => ({
      id: matrixDoc.id,
      match: matrixDoc.id.match(/^(\d{4})_(\d{2})_(lot\d+)$/)
    }))
    .filter(matrix => matrix.match);
  const comments = [];
  for (let index = 0; index < matrices.length; index += 8) {
    const batch = await Promise.all(matrices.slice(index, index + 8).map(async matrix => {
      const [, yearText, monthText, lotId] = matrix.match;
      const snapshot = await getDocs(query(
        collection(db, "matrices", matrix.id, "comments"),
        orderBy("createdAt", "desc")
      ));
      return snapshot.docs.map(commentDoc => {
        const data = commentDoc.data();
        return {
          id: commentDoc.id,
          ...data,
          matrixId: matrix.id,
          year: data.year ?? Number(yearText),
          month: data.month ?? Number(monthText),
          lotId: data.lotId ?? lotId,
          monthKey: data.monthKey ?? `${yearText}-${monthText}`
        };
      });
    }));
    comments.push(...batch.flat());
  }
  comments.sort((first, second) =>
    (second.createdAt?.toMillis?.() || 0) - (first.createdAt?.toMillis?.() || 0)
  );
  return comments;
}

export async function getAllCommentsWithReplies() {
  const comments = await getAllComments();
  const enriched = [];
  for (let index = 0; index < comments.length; index += 8) {
    const batch = await Promise.all(comments.slice(index, index + 8).map(async comment => {
      const repliesRef = collection(
        db,
        "matrices",
        matrixDocumentId(comment.monthKey, comment.lotId),
        "comments",
        comment.id,
        "replies"
      );
      const repliesSnapshot = await getDocs(query(repliesRef, orderBy("createdAt", "asc")));
      return {
        ...comment,
        replies: repliesSnapshot.docs.map(replyDoc => ({
          id: replyDoc.id,
          ...replyDoc.data()
        }))
      };
    }));
    enriched.push(...batch);
  }
  return enriched;
}

export async function getAllNotifications() {
  const snapshot = await getDocs(query(collection(db, "notifications"), orderBy("createdAt", "desc")));
  return snapshot.docs.map(notificationDoc => ({
    id: notificationDoc.id,
    ...notificationDoc.data()
  }));
}

export function subscribeToNotifications(callback, onError) {
  return onSnapshot(query(
    collection(db, "notifications"),
    orderBy("createdAt", "desc")
  ), snapshot => {
    callback(snapshot.docs.map(notificationDoc => ({
      id: notificationDoc.id,
      ...notificationDoc.data()
    })));
  }, onError);
}
