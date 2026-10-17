import { auth, db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const STORAGE_KEY = "dswd-sanctuary-foodstuff-v1";


export const LOTS = [
  { id: "lot1", name: "Lot 1", description: "Vegetables and Fruits" },
  { id: "lot2", name: "Lot 2", description: "Fish and Seafoods" },
  { id: "lot3", name: "Lot 3", description: "Pork and Beef Meat" },
  { id: "lot4", name: "Lot 4", description: "Chicken Products and Eggs" },
  { id: "lot5", name: "Lot 5", description: "Grocery Items" },
  { id: "lot6", name: "Rice", description: "" }
];

const DEFAULT_UNITS = ["Kg", "Pc", "Pack", "Case", "Can", "Gallon", "Sack", "Grams"];

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeSampleItem(name, unit, unitPrice, orderQty, quantities, catchUps = []) {
  return { id: newId(), name, unit, unitPrice, orderQty, quantities, catchUps };
}

function makeEmptyLot() {
  return { deliveryDates: [], items: [] };
}

function makeEmptyMonth() {
  return { lots: Object.fromEntries(LOTS.map(lot => [lot.id, makeEmptyLot()])) };
}

function createSampleData() {
  const dates = [
    { id: newId(), date: "2026-10-03" },
    { id: newId(), date: "2026-10-10" },
    { id: newId(), date: "2026-10-17" }
  ];
  const [first, second, third] = dates;
  const sampleLotItems = [
    [
      makeSampleItem("Carrots", "Kg", 95, 50, { [first.id]: { proposed: 20, actual: 20 }, [second.id]: { proposed: 15, actual: 10 }, [third.id]: { proposed: 15, actual: 0 } }, [{ id: newId(), date: "2026-10-12", qty: 3, receivedBy: "Sample receiver", remarks: "Catch-up delivery", loggedAt: "2026-10-12T04:00:00.000Z" }]),
      makeSampleItem("Pechay", "Kg", 80, 30, { [first.id]: { proposed: 15, actual: 15 }, [second.id]: { proposed: 15, actual: 15 }, [third.id]: { proposed: 0, actual: 0 } })
    ],
    [
      makeSampleItem("Tilapia", "Kg", 180, 40, { [first.id]: { proposed: 20, actual: 20 }, [second.id]: { proposed: 20, actual: 12 }, [third.id]: { proposed: 0, actual: 0 } }),
      makeSampleItem("Galunggong", "Kg", 210, 25, { [first.id]: { proposed: 10, actual: 0 }, [second.id]: { proposed: 10, actual: 0 }, [third.id]: { proposed: 5, actual: 0 } })
    ],
    [
      makeSampleItem("Pork kasim", "Kg", 330, 35, { [first.id]: { proposed: 15, actual: 15 }, [second.id]: { proposed: 10, actual: 10 }, [third.id]: { proposed: 10, actual: 10 } }),
      makeSampleItem("Beef brisket", "Kg", 460, 20, { [first.id]: { proposed: 10, actual: 7 }, [second.id]: { proposed: 10, actual: 0 }, [third.id]: { proposed: 0, actual: 0 } })
    ],
    [
      makeSampleItem("Chicken leg quarter", "Kg", 195, 45, { [first.id]: { proposed: 15, actual: 15 }, [second.id]: { proposed: 15, actual: 15 }, [third.id]: { proposed: 15, actual: 13 } }),
      makeSampleItem("Chicken eggs", "Tray", 285, 20, { [first.id]: { proposed: 10, actual: 10 }, [second.id]: { proposed: 10, actual: 10 }, [third.id]: { proposed: 0, actual: 0 } })
    ],
    [
      makeSampleItem("Rice", "Sack", 2350, 25, { [first.id]: { proposed: 10, actual: 10 }, [second.id]: { proposed: 10, actual: 8 }, [third.id]: { proposed: 5, actual: 0 } }),
      makeSampleItem("Cooking oil", "Gallon", 420, 18, { [first.id]: { proposed: 6, actual: 6 }, [second.id]: { proposed: 6, actual: 6 }, [third.id]: { proposed: 6, actual: 6 } })
    ],
    []
  ];

  return {
    schemaVersion: 1,
    units: [...DEFAULT_UNITS, "Tray"],
    months: {
      "2026-10": {
        lots: Object.fromEntries(LOTS.map((lot, index) => [
          lot.id,
          { deliveryDates: dates.map(date => ({ ...date })), items: sampleLotItems[index] }
        ]))
      }
    }
  };
}

function readLocalData() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    throw new Error(`Unable to read browser storage: ${error.message}`);
  }

  if (raw === null) {
    const initialData = createSampleData();
    writeLocalData(initialData);
    return initialData;
  }

  try {
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== 1 || !data.months || !Array.isArray(data.units)) {
      throw new Error("stored data does not match this prototype's schema");
    }
    return data;
  } catch (error) {
    throw new Error(`Saved foodstuff data could not be loaded: ${error.message}`);
  }
}

function writeLocalData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    throw new Error(`Unable to save data in this browser: ${error.message}`);
  }
}

function getFirestoreMatrixId(monthKey, lotId) {
  const [year, month] = monthKey.split("-");
  return `${year}_${month}_${lotId}`;
}

async function readFirestoreMonthData(monthKey) {
  const lots = {};
  for (const lot of LOTS) {
    const matrixRef = doc(db, "matrices", getFirestoreMatrixId(monthKey, lot.id));
    const matrixSnap = await getDoc(matrixRef);
    const lotData = makeEmptyLot();
    if (matrixSnap.exists()) {
      const datesSnap = await getDocs(collection(matrixRef, "deliveryDates"));
      lotData.deliveryDates = datesSnap.docs
        .map(dateDoc => ({
          id: dateDoc.id,
          date: dateDoc.data().date,
          order: Number(dateDoc.data().order ?? 0)
        }))
        .sort((a, b) => a.order - b.order || a.date.localeCompare(b.date))
        .map(({ id, date }) => ({ id, date }));

      const itemsSnap = await getDocs(query(collection(matrixRef, "items"), orderBy("order", "asc")));
      for (const itemDoc of itemsSnap.docs) {
        const itemData = itemDoc.data();
        const item = {
          id: itemDoc.id,
          unit: itemData.unit ?? "",
          name: itemData.name ?? "",
          unitPrice: Number(itemData.unitPrice ?? 0),
          orderQty: Number(itemData.orderQty ?? 0),
          quantities: {},
          catchUps: []
        };
        const entriesSnap = await getDocs(query(
          collection(matrixRef, "entries"),
          where("itemId", "==", itemDoc.id)
        ));
        for (const entryDoc of entriesSnap.docs) {
          const entry = entryDoc.data();
          item.quantities[entry.deliveryDateId] = {
            proposed: Number(entry.proposedQty ?? 0),
            actual: Number(entry.actualQty ?? 0)
          };
        }
        const catchUpsSnap = await getDocs(query(
          collection(matrixRef, "catchUpDeliveries"),
          where("itemId", "==", itemDoc.id)
        ));
        item.catchUps = catchUpsSnap.docs
          .map(catchDoc => ({ id: catchDoc.id, ...catchDoc.data() }))
          .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        lotData.items.push(item);
      }
    }
    lots[lot.id] = lotData;
  }
  return { lots };
}

function stableValue(value) {
  return JSON.stringify(value ?? null);
}

function auditChange(changes, lot, action, what, oldValue, newValue, itemId = "", itemName = "", cellRef = null) {
  changes.push({
    year: lot.year,
    month: lot.month,
    lotId: lot.lotId,
    itemId,
    itemName,
    cellRef,
    action,
    what,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null
  });
}

function createAuditChanges(monthKey, beforeData, afterData) {
  const [year, month] = monthKey.split("-").map(Number);
  const changes = [];
  for (const lot of LOTS) {
    const oldLot = beforeData?.lots?.[lot.id] || makeEmptyLot();
    const newLot = afterData?.lots?.[lot.id] || makeEmptyLot();
    const meta = { year, month, lotId: lot.id };
    const oldDates = new Map(oldLot.deliveryDates.map((date, index) => [date.id, { ...date, order: index }]));
    const newDates = new Map(newLot.deliveryDates.map((date, index) => [date.id, { ...date, order: index }]));

    for (const [dateId, date] of oldDates) {
      const next = newDates.get(dateId);
      if (!next) {
        auditChange(changes, meta, "delete-delivery-date", `Deleted delivery date ${date.date}`, date, null, "", "", {
          columnKey: "deliveryDate",
          deliveryDateId: dateId
        });
      } else if (date.order !== next.order) {
        auditChange(changes, meta, "reorder-delivery-date", `Reordered delivery date ${date.date}`, date.order, next.order, "", "", {
          columnKey: "deliveryDate",
          deliveryDateId: dateId
        });
      }
    }
    for (const [dateId, date] of newDates) {
      if (!oldDates.has(dateId)) {
        auditChange(changes, meta, "add-delivery-date", `Added delivery date ${date.date}`, null, date, "", "", {
          columnKey: "deliveryDate",
          deliveryDateId: dateId
        });
      }
    }

    const oldItems = new Map(oldLot.items.map((item, index) => [item.id, { ...item, order: index }]));
    const newItems = new Map(newLot.items.map((item, index) => [item.id, { ...item, order: index }]));
    for (const [itemId, oldItem] of oldItems) {
      const next = newItems.get(itemId);
      if (!next) {
        auditChange(changes, meta, "delete-item", `Deleted item ${oldItem.name || "(unnamed item)"}`, oldItem, null, itemId, oldItem.name || "", {
          itemId,
          columnKey: "item"
        });
        for (const [dateId, values] of Object.entries(oldItem.quantities || {})) {
          const date = oldDates.get(dateId);
          for (const field of ["proposed", "actual"]) {
            const value = Number(values?.[field] ?? 0);
            if (value === 0) continue;
            auditChange(
              changes, meta, `delete-${field}`,
              `Removed ${field} quantity for ${oldItem.name || "item"}${date ? ` on ${date.date}` : ""}`,
              value, null, itemId, oldItem.name || "", {
                itemId,
                columnKey: field,
                deliveryDateId: dateId
              }
            );
          }
        }
        for (const entry of oldItem.catchUps || []) {
          auditChange(
            changes, meta, "delete-catch-up",
            `Removed catch-up delivery for ${oldItem.name || "item"}`,
            entry, null, itemId, oldItem.name || "", {
              itemId,
              columnKey: "catchUp",
              catchUpId: entry.id
            }
          );
        }
        continue;
      }
      if (oldItem.order !== next.order) {
        auditChange(
          changes, meta, "reorder-item",
          `Changed row order for ${next.name || oldItem.name || "item"}`,
          oldItem.order, next.order, itemId, next.name || oldItem.name || "", {
            itemId,
            columnKey: "itemOrder"
          }
        );
      }
      for (const field of ["name", "unit", "unitPrice", "orderQty"]) {
        if (!Object.is(oldItem[field] ?? "", next[field] ?? "")) {
          auditChange(
            changes, meta, "update-item",
            `Updated ${field} for ${next.name || oldItem.name || "item"}`,
            oldItem[field] ?? "", next[field] ?? "", itemId, next.name || oldItem.name || "", {
              itemId,
              columnKey: field
            }
          );
        }
      }

      for (const dateId of new Set([
        ...Object.keys(oldItem.quantities || {}),
        ...Object.keys(next.quantities || {})
      ])) {
        const date = newDates.get(dateId) || oldDates.get(dateId);
        for (const field of ["proposed", "actual"]) {
          const previous = Number(oldItem.quantities?.[dateId]?.[field] ?? 0);
          const current = Number(next.quantities?.[dateId]?.[field] ?? 0);
          if (previous !== current) {
            auditChange(
              changes, meta, `update-${field}`,
              `Updated ${field} quantity for ${next.name || oldItem.name || "item"}${date ? ` on ${date.date}` : ""}`,
              previous, current, itemId, next.name || oldItem.name || "", {
                itemId,
                columnKey: field,
                deliveryDateId: dateId
              }
            );
          }
        }
      }

      const oldCatchUps = new Map((oldItem.catchUps || []).map(entry => [entry.id, entry]));
      const newCatchUps = new Map((next.catchUps || []).map(entry => [entry.id, entry]));
      for (const [catchUpId, entry] of oldCatchUps) {
        const current = newCatchUps.get(catchUpId);
        if (!current) {
          auditChange(
            changes, meta, "delete-catch-up",
            `Deleted catch-up delivery for ${oldItem.name || "item"}`,
            entry, null, itemId, oldItem.name || "", {
              itemId,
              columnKey: "catchUp",
              catchUpId
            }
          );
        } else if (stableValue(entry) !== stableValue(current)) {
          auditChange(
            changes, meta, "update-catch-up",
            `Updated catch-up delivery for ${next.name || oldItem.name || "item"}`,
            entry, current, itemId, next.name || oldItem.name || "", {
              itemId,
              columnKey: "catchUp",
              catchUpId
            }
          );
        }
      }
      for (const [catchUpId, entry] of newCatchUps) {
        if (!oldCatchUps.has(catchUpId)) {
          auditChange(
            changes, meta, "add-catch-up",
            `Recorded catch-up delivery for ${next.name || "item"}`,
            null, entry, itemId, next.name || "", {
              itemId,
              columnKey: "catchUp",
              catchUpId
            }
          );
        }
      }
    }
    for (const [itemId, item] of newItems) {
      if (!oldItems.has(itemId)) {
        auditChange(changes, meta, "add-item", `Added item ${item.name || "(unnamed item)"}`, null, item, itemId, item.name || "", {
          itemId,
          columnKey: "item"
        });
      }
    }
  }
  return changes;
}

function recordsForLot(lotData, authorName) {
  const records = new Map();
  const dates = new Map();
  for (const [order, date] of (lotData.deliveryDates || []).entries()) {
    dates.set(date.id, { id: date.id, date: date.date, order });
  }
  const items = new Map();
  const entries = new Map();
  const catchUps = new Map();
  for (const [order, item] of (lotData.items || []).entries()) {
    items.set(item.id, {
      id: item.id,
      name: item.name ?? "",
      unit: item.unit ?? "",
      unitPrice: Number(item.unitPrice ?? 0),
      orderQty: Number(item.orderQty ?? 0),
      order
    });
    for (const [dateId, values] of Object.entries(item.quantities || {})) {
      if (!dates.has(dateId)) continue;
      const id = `${item.id}_${dateId}`;
      entries.set(id, {
        itemId: item.id,
        deliveryDateId: dateId,
        proposedQty: Number(values?.proposed ?? 0),
        actualQty: Number(values?.actual ?? 0)
      });
    }
    for (const entry of item.catchUps || []) {
      catchUps.set(entry.id, {
        id: entry.id,
        itemId: item.id,
        date: entry.date,
        qty: Number(entry.qty ?? 0),
        receivedBy: entry.receivedBy ?? "",
        remarks: entry.remarks ?? "",
        loggedBy: entry.loggedBy || authorName,
        loggedAt: entry.loggedAt || new Date().toISOString()
      });
    }
  }
  records.set("deliveryDates", dates);
  records.set("items", items);
  records.set("entries", entries);
  records.set("catchUpDeliveries", catchUps);
  return records;
}

function documentChanges(monthKey, beforeData, afterData, authorName) {
  const changes = [];
  const [year, month] = monthKey.split("-").map(Number);
  for (const lot of LOTS) {
    const oldLot = beforeData?.lots?.[lot.id] || makeEmptyLot();
    const newLot = afterData?.lots?.[lot.id] || makeEmptyLot();
    const oldRecords = recordsForLot(oldLot, authorName);
    const newRecords = recordsForLot(newLot, authorName);
    const matrixRef = doc(db, "matrices", getFirestoreMatrixId(monthKey, lot.id));
    let lotChanged = false;
    for (const collectionName of ["deliveryDates", "items", "entries", "catchUpDeliveries"]) {
      const oldRecordsById = oldRecords.get(collectionName);
      const newRecordsById = newRecords.get(collectionName);
      for (const id of new Set([...oldRecordsById.keys(), ...newRecordsById.keys()])) {
        const oldValue = oldRecordsById.get(id) || null;
        const newValue = newRecordsById.get(id) || null;
        if (stableValue(oldValue) === stableValue(newValue)) continue;
        lotChanged = true;
        changes.push({
          ref: doc(collection(matrixRef, collectionName), id),
          oldValue,
          newValue,
          collectionName
        });
      }
    }
    if (lotChanged) changes.push({
      ref: matrixRef,
      parent: true,
      year,
      month,
      lotId: lot.id
    });
  }
  return changes;
}

function itemNameClaims(monthKey, lotId, beforeLot, afterLot) {
  const oldOwners = new Map();
  const newOwners = new Map();
  for (const item of beforeLot.items || []) {
    const name = String(item.name ?? "").trim().toLocaleLowerCase();
    if (!name) continue;
    if (!oldOwners.has(name)) oldOwners.set(name, new Set());
    oldOwners.get(name).add(item.id);
  }
  for (const item of afterLot.items || []) {
    const name = String(item.name ?? "").trim().toLocaleLowerCase();
    if (!name) continue;
    if (newOwners.has(name)) {
      const error = new Error("An item with that name already exists in this lot.");
      error.code = "matrix/duplicate-item";
      throw error;
    }
    newOwners.set(name, item.id);
  }

  const matrixRef = doc(db, "matrices", getFirestoreMatrixId(monthKey, lotId));
  return [...new Set([...oldOwners.keys(), ...newOwners.keys()])].map(name => ({
    ref: doc(collection(matrixRef, "itemNames"), encodeURIComponent(name)),
    oldOwners: oldOwners.get(name) || new Set(),
    newOwner: newOwners.get(name) || ""
  }));
}

function matchesExpectedSnapshot(snapshot, expected) {
  if (expected === null) return !snapshot.exists();
  if (!snapshot.exists()) return false;
  const actual = snapshot.data();
  return Object.entries(expected).every(([key, value]) => stableValue(actual[key]) === stableValue(value));
}

async function writeFirestoreMonthData(monthKey, beforeData, monthData, authorName) {
  const records = documentChanges(monthKey, beforeData, monthData, authorName);
  const auditChanges = createAuditChanges(monthKey, beforeData, monthData);
  if (!records.length) return;

  const writes = records.filter(record => !record.parent);
  const parents = records.filter(record => record.parent);
  const claims = parents.flatMap(parent => itemNameClaims(
    monthKey,
    parent.lotId,
    beforeData?.lots?.[parent.lotId] || makeEmptyLot(),
    monthData?.lots?.[parent.lotId] || makeEmptyLot()
  ));
  const auditDocuments = auditChanges.map(change => ({
    ref: doc(collection(db, "auditLogs")),
    data: { ...change, who: authorName, createdAt: serverTimestamp() }
  }));
  if (writes.length + parents.length + claims.length + auditDocuments.length > 450) {
    throw new Error("This edit affects too many records to save safely at once. Split it into smaller changes and try again.");
  }

  await runTransaction(db, async transaction => {
    const snapshots = await Promise.all([...writes, ...claims].map(write => transaction.get(write.ref)));
    writes.forEach((write, index) => {
      if (!matchesExpectedSnapshot(snapshots[index], write.oldValue)) {
        const error = new Error("This matrix changed in another browser. The latest data has been reloaded; review it and try your edit again.");
        error.code = "matrix/conflict";
        throw error;
      }
    });

    const claimSnapshots = snapshots.slice(writes.length);
    claims.forEach((claim, index) => {
      const snapshot = claimSnapshots[index];
      if (!claim.newOwner) return;
      if (snapshot.exists() && snapshot.data().itemId !== claim.newOwner
        && !claim.oldOwners.has(snapshot.data().itemId)) {
        const error = new Error("Another item in this lot already uses that name. Refresh the matrix and choose a unique name.");
        error.code = "matrix/duplicate-item";
        throw error;
      }
    });

    const parentTimestamp = serverTimestamp();
    for (const parent of parents) {
      transaction.set(parent.ref, {
        year: parent.year,
        month: parent.month,
        lot: parent.lotId,
        updatedBy: authorName,
        updatedAt: parentTimestamp
      }, { merge: true });
    }
    for (const write of writes) {
      if (!write.newValue) {
        transaction.delete(write.ref);
        continue;
      }
      transaction.set(write.ref, {
        ...write.newValue,
        ...(write.collectionName === "catchUpDeliveries"
          ? {}
          : { updatedBy: authorName, updatedAt: serverTimestamp() })
      });
    }
    claims.forEach((claim, index) => {
      const snapshot = claimSnapshots[index];
      if (claim.newOwner) {
        if (!snapshot.exists() || snapshot.data().itemId !== claim.newOwner) {
          transaction.set(claim.ref, { itemId: claim.newOwner });
        }
      } else if (snapshot.exists() && claim.oldOwners.has(snapshot.data().itemId)) {
        transaction.delete(claim.ref);
      }
    });
    for (const audit of auditDocuments) transaction.set(audit.ref, audit.data);
  });
}

export async function getMonthData(monthKey) {
  return await readFirestoreMonthData(monthKey);
}

export async function ensureMonthData(monthKey, authorName) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new Error("Month must use the YYYY-MM format.");
  }
  const [, yearText, monthText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 2026) throw new Error("Year must be 2026 or later.");

  const matrixRefs = LOTS.map(lot =>
    doc(db, "matrices", getFirestoreMatrixId(monthKey, lot.id))
  );
  await runTransaction(db, async transaction => {
    const snapshots = await Promise.all(matrixRefs.map(matrixRef => transaction.get(matrixRef)));
    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists()) return;
      transaction.set(matrixRefs[index], {
        year,
        month,
        lot: LOTS[index].id,
        updatedBy: authorName,
        updatedAt: serverTimestamp()
      });
    });
  });
}

export async function saveMonthData(monthKey, beforeData, monthData, authorName) {
  await writeFirestoreMonthData(monthKey, beforeData, monthData, authorName);
}

export async function getAllMonthData(yearFilter = null) {
  const snapshot = await getDocs(collection(db, "matrices"));
  const monthKeys = [...new Set(snapshot.docs
    .map(matrixDoc => {
      const { year, month } = matrixDoc.data();
      if (!Number.isInteger(Number(year)) || Number(year) < 2026
        || !Number.isInteger(Number(month)) || Number(month) < 1 || Number(month) > 12) return "";
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    })
    .filter(Boolean))]
    .filter(key => yearFilter === null || Number(key.slice(0, 4)) === yearFilter)
    .sort();
  const months = [];
  for (let index = 0; index < monthKeys.length; index += 4) {
    const batch = await Promise.all(monthKeys.slice(index, index + 4).map(async key => ({
      year: Number(key.slice(0, 4)),
      month: Number(key.slice(5, 7)),
      monthKey: key,
      ...await readFirestoreMonthData(key)
    })));
    months.push(...batch);
  }
  return months;
}

export async function getAuditLogs() {
  const snapshot = await getDocs(query(collection(db, "auditLogs"), orderBy("createdAt", "desc")));
  return snapshot.docs.map(auditDoc => ({ id: auditDoc.id, ...auditDoc.data() }));
}

export async function getUnits() {
  const unitsSnap = await getDoc(doc(db, "config", "units"));
  const units = unitsSnap.data()?.list;
  return Array.isArray(units) && units.length ? units : [...DEFAULT_UNITS, "Tray"];
}

export async function addUnit(unit) {
  const normalized = unit.trim();
  const localData = readLocalData();

  if (!normalized) throw new Error("Enter a unit name.");
  if (localData.units.some(existing => existing.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    throw new Error("That unit is already in the list.");
  }

  localData.units.push(normalized);
  writeLocalData(localData);
  await setDoc(doc(db, "config", "units"), {
    list: localData.units,
    updatedBy: auth.currentUser?.email || "system",
    updatedAt: serverTimestamp()
  }, { merge: true });
  return [...localData.units];
}

export async function getAvailableYears() {
  const localYears = Object.keys(readLocalData().months).map(key => Number(key.slice(0, 4)));
  const snapshot = await getDocs(collection(db, "matrices"));
  const remoteYears = snapshot.docs.map(matrixDoc => Number(matrixDoc.data().year))
    .filter(year => Number.isInteger(year) && year >= 2026);
  return [...new Set([2026, ...localYears, ...remoteYears])].sort((a, b) => a - b);
}

export function ensureYear(year) {
  if (!Number.isInteger(year) || year < 2026) throw new Error("Year must be 2026 or later.");
  const data = readLocalData();
  const monthKey = `${year}-01`;
  if (!data.months[monthKey]) {
    data.months[monthKey] = makeEmptyMonth();
    writeLocalData(data);
  }
}

export function getPreviousMonthKey(year, monthNumber) {
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function makeId() {
  return newId();
}

export function subscribeToMonthData(monthKey, callback, onError) {
  const unsubscribers = LOTS.map(lot => {
    const matrixRef = doc(db, "matrices", getFirestoreMatrixId(monthKey, lot.id));
    return onSnapshot(matrixRef, async () => {
      try {
        callback(await readFirestoreMonthData(monthKey));
      } catch (error) {
        onError(error);
      }
    }, onError);
  });
  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}
