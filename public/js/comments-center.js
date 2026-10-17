import { LOTS } from "./db.js";
import { auth, isAdminEmail, requireAppAccess } from "./auth.js";
import {
  addReply,
  canDeleteComment,
  canEditComment,
  commentTargetLabel,
  deleteAllComments,
  deleteComment,
  getAllCommentsWithReplies,
  getReadCommentIds,
  markCommentRead,
  setCommentResolved,
  updateComment
} from "./comments.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

let comments = [];
const filters = {
  year: document.getElementById("filterYear"),
  month: document.getElementById("filterMonth"),
  lot: document.getElementById("filterLot"),
  item: document.getElementById("filterItem"),
  status: document.getElementById("filterStatus"),
  author: document.getElementById("filterAuthor"),
  unread: document.getElementById("filterUnread")
};

function populateFilter(select, values, labelForValue = value => value) {
  const firstOption = select.options[0];
  select.replaceChildren(firstOption);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = labelForValue(value);
    select.append(option);
  }
}

function populateFilters() {
  const selectFilters = Object.entries(filters).filter(([, element]) => element.tagName === "SELECT");
  const selectedValues = Object.fromEntries(
    selectFilters.map(([name, select]) => [name, select.value])
  );
  const years = [...new Set(comments.map(comment => comment.year).filter(Number.isFinite))].sort((a, b) => b - a);
  const months = [...new Set(comments.map(comment => comment.month).filter(Number.isFinite))].sort((a, b) => a - b);
  const lots = [...new Set(comments.map(comment => comment.lotId).filter(Boolean))];
  const items = [...new Map(comments
    .filter(comment => comment.cellRef?.itemId)
    .map(comment => [comment.cellRef.itemId, {
      id: comment.cellRef.itemId,
      name: comment.itemName || comment.cellRef.itemId
    }])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const authors = [...new Set(comments.map(comment => comment.authorName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  populateFilter(filters.year, years);
  populateFilter(filters.month, months, value => MONTH_NAMES[value - 1] || String(value));
  populateFilter(filters.lot, lots, value => LOTS.find(lot => lot.id === value)?.name || value);
  const itemOption = filters.item.options[0];
  filters.item.replaceChildren(itemOption);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    filters.item.append(option);
  }
  populateFilter(filters.author, authors);
  for (const [name, select] of selectFilters) {
    if ([...select.options].some(option => option.value === selectedValues[name])) {
      select.value = selectedValues[name];
    }
  }
}

function filteredComments() {
  const readIds = getReadCommentIds();
  return comments.filter(comment => (
    (!filters.year.value || String(comment.year) === filters.year.value)
    && (!filters.month.value || String(comment.month) === filters.month.value)
    && (!filters.lot.value || comment.lotId === filters.lot.value)
    && (!filters.item.value || comment.cellRef?.itemId === filters.item.value)
    && (!filters.status.value || comment.status === filters.status.value)
    && (!filters.author.value || comment.authorName === filters.author.value)
    && (!filters.unread.checked || !readIds.has(comment.id))
  ));
}

function groupName(comment) {
  const lotName = LOTS.find(lot => lot.id === comment.lotId)?.name || comment.lotId || "Unknown lot";
  return `${comment.year || "Unknown year"} · ${MONTH_NAMES[(comment.month || 0) - 1] || "Unknown month"} · ${lotName} · ${comment.itemName || comment.cellRef?.itemId || "Unknown item"}`;
}

function createdAtText(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila"
    }).format(date)
    : "Time unavailable";
}

async function refreshComments() {
  comments = await getAllCommentsWithReplies();
  populateFilters();
  render();
}

function addEditForm(card, comment) {
  if (card.querySelector(".comments-center-edit-form")) return;
  const form = document.createElement("form");
  form.className = "comments-center-edit-form";
  const input = document.createElement("textarea");
  input.className = "control";
  input.rows = 3;
  input.maxLength = 2000;
  input.required = true;
  input.setAttribute("aria-label", "Edit comment");
  input.value = comment.text || "";
  const actions = document.createElement("div");
  actions.className = "comments-center-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button button-primary";
  save.textContent = "Save edit";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button button-light";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => form.remove());
  actions.append(save, cancel);
  form.append(input, actions);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    try {
      await updateComment({
        year: comment.year,
        month: comment.month,
        lotId: comment.lotId,
        comment,
        text: input.value
      });
      await refreshComments();
      document.getElementById("commentsCenterStatus").textContent = "Comment updated.";
    } catch (error) {
      console.error(error?.code ?? "unknown", error?.message ?? String(error));
      document.getElementById("commentsCenterStatus").textContent =
        error instanceof Error ? error.message : "Unable to update the comment.";
      save.disabled = false;
    }
  });
  card.append(form);
  input.focus();
}

async function removeComment(comment) {
  if (!canDeleteComment(comment)) return;
  if (!window.confirm("Permanently delete this comment, all its replies, and linked notifications?")) return;
  const status = document.getElementById("commentsCenterStatus");
  try {
    await deleteComment({
      year: comment.year,
      month: comment.month,
      lotId: comment.lotId,
      comment
    });
    await refreshComments();
    status.textContent = "Comment, replies, and linked notifications deleted.";
  } catch (error) {
    console.error(error?.code ?? "unknown", error?.message ?? String(error));
    status.textContent = error instanceof Error ? error.message : "Unable to delete the comment.";
  }
}

function render() {
  const readIds = getReadCommentIds();
  const visible = filteredComments();
  const results = document.getElementById("commentsCenterResults");
  const status = document.getElementById("commentsCenterStatus");
  results.replaceChildren();
  status.textContent = visible.length
    ? `${visible.length} comment${visible.length === 1 ? "" : "s"}`
    : comments.length
      ? "No comments match these filters."
      : "No records yet";

  const groups = new Map();
  for (const comment of visible) {
    const name = groupName(comment);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(comment);
  }
  for (const [name, entries] of groups) {
    const section = document.createElement("section");
    section.className = "comments-center-group";
    const heading = document.createElement("h2");
    heading.textContent = name;
    section.append(heading);
    for (const comment of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `comments-center-card${readIds.has(comment.id) ? "" : " unread"}`;
      const title = document.createElement("strong");
      title.textContent = `${comment.authorName || "Unknown author"} · ${comment.status || "open"}`;
      const metadata = document.createElement("span");
      const editedText = comment.editedAt ? " · edited" : "";
      metadata.textContent = `${commentTargetLabel(comment.cellRef)} · ${createdAtText(comment.createdAt)}${editedText}`;
      const text = document.createElement("span");
      text.textContent = comment.text || "";
      button.append(title, metadata, text);
      button.addEventListener("click", () => openInMatrix(comment));
      const card = document.createElement("article");
      card.className = `comments-center-entry${readIds.has(comment.id) ? "" : " unread"}`;
      card.append(button);
      const replies = document.createElement("div");
      replies.className = "comments-center-replies";
      for (const reply of comment.replies || []) {
        const replyLine = document.createElement("p");
        const author = document.createElement("strong");
        author.textContent = `${reply.authorName || "Unknown author"}: `;
        const replyText = document.createElement("span");
        replyText.textContent = reply.text || "";
        replyLine.append(author, replyText);
        replies.append(replyLine);
      }
      const actions = document.createElement("div");
      actions.className = "comments-center-actions";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "button button-light";
      open.textContent = "Open in matrix";
      open.addEventListener("click", () => openInMatrix(comment));
      const resolution = document.createElement("button");
      resolution.type = "button";
      resolution.className = "button button-light";
      resolution.textContent = comment.status === "open" ? "Resolve" : "Reopen";
      resolution.addEventListener("click", () => updateResolution(comment));
      const replyButton = document.createElement("button");
      replyButton.type = "button";
      replyButton.className = "button button-light";
      replyButton.textContent = "Reply";
      replyButton.addEventListener("click", () => toggleReplyForm(card, comment));
      actions.append(open, resolution, replyButton);
      if (canEditComment(comment)) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button button-light";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => addEditForm(card, comment));
        actions.append(edit);
      }
      if (canDeleteComment(comment)) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-light comment-delete-button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => removeComment(comment));
        actions.append(remove);
      }
      card.append(replies, actions);
      section.append(card);
    }

    async function updateResolution(comment) {
      const status = document.getElementById("commentsCenterStatus");
      try {
        await setCommentResolved({
          year: comment.year,
          month: comment.month,
          lotId: comment.lotId,
          comment,
          resolved: comment.status === "open"
        });
        await refreshComments();
      } catch (error) {
        console.error(error?.code ?? "unknown", error?.message ?? String(error));
        status.textContent = error instanceof Error ? error.message : "Unable to update the comment.";
      }
    }

    function toggleReplyForm(card, comment) {
      if (card.querySelector(".comments-center-reply-form")) return;
      const form = document.createElement("form");
      form.className = "comments-center-reply-form";
      const input = document.createElement("textarea");
      input.className = "control";
      input.rows = 2;
      input.maxLength = 2000;
      input.required = true;
      input.setAttribute("aria-label", "Reply text");
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "button button-primary";
      submit.textContent = "Post reply";
      form.append(input, submit);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        submit.disabled = true;
        try {
          await addReply({
            year: comment.year,
            month: comment.month,
            lotId: comment.lotId,
            comment,
            text: input.value
          });
          await refreshComments();
        } catch (error) {
          console.error(error?.code ?? "unknown", error?.message ?? String(error));
          document.getElementById("commentsCenterStatus").textContent =
            error instanceof Error ? error.message : "Unable to post the reply.";
          submit.disabled = false;
        }
      });
      card.append(form);
      input.focus();
    }
    results.append(section);
  }
}

function openInMatrix(comment) {
  try {
    markCommentRead(comment.id);
    const params = new URLSearchParams({
      year: String(comment.year),
      month: String(comment.month),
      lot: comment.lotId,
      itemId: comment.cellRef?.itemId || "",
      columnKey: comment.cellRef?.columnKey || "",
      deliveryDateId: comment.cellRef?.deliveryDateId || "",
      catchUpId: comment.cellRef?.catchUpId || "",
      commentId: comment.id
    });
    window.location.href = `./index.html?${params.toString()}`;
  } catch (error) {
    const status = document.getElementById("commentsCenterStatus");
    status.textContent = error instanceof Error ? error.message : "Unable to open this comment.";
  }
}

for (const filter of Object.values(filters)) {
  filter.addEventListener("change", render);
}

try {
  if (await requireAppAccess()) {
    const deleteAllButton = document.getElementById("deleteAllCommentsButton");
    if (isAdminEmail(auth.currentUser?.email)) {
      deleteAllButton.hidden = false;
      deleteAllButton.addEventListener("click", async () => {
        if (!comments.length) return;
        if (!window.confirm("Permanently delete ALL comments, their replies, and linked notifications? This cannot be undone.")) return;
        deleteAllButton.disabled = true;
        try {
          const deletedCount = await deleteAllComments();
          await refreshComments();
          document.getElementById("commentsCenterStatus").textContent =
            `Deleted ${deletedCount} comment${deletedCount === 1 ? "" : "s"}, their replies, and linked notifications.`;
        } catch (error) {
          console.error(error?.code ?? "unknown", error?.message ?? String(error));
          document.getElementById("commentsCenterStatus").textContent =
            error instanceof Error ? error.message : "Unable to delete all comments.";
        } finally {
          deleteAllButton.disabled = false;
        }
      });
    }
    comments = await getAllCommentsWithReplies();
    populateFilters();
    render();
  }
} catch (error) {
  console.error(error?.code ?? "unknown", error?.message ?? String(error));
  document.getElementById("commentsCenterStatus").textContent =
    error instanceof Error ? error.message : "Unable to load comments.";
}
