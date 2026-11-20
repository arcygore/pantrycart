export function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtQty(n) {
  if (n === null || n === undefined || n === "") return "";
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  if (Math.abs(num - Math.round(num)) < 0.02) return String(Math.round(num));
  return num.toFixed(2).replace(/\.?0+$/, "");
}

export function toast(message, isError = false) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3400);
}

/**
 * Toast with an inline action button (e.g. "Undo"). Stays a little longer than a normal toast.
 */
export function toastAction(message, actionLabel, onAction, isError = false) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast toast-with-action${isError ? " error" : ""}`;
  const span = document.createElement("span");
  span.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action-btn";
  btn.textContent = actionLabel;
  btn.addEventListener("click", async () => {
    el.remove();
    try {
      await onAction();
    } catch (err) {
      toast(err?.message || "Action failed", true);
    }
  });
  el.append(span, btn);
  root.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

/**
 * Units that mean "sold by weight" (issue #4). A buy_unit like "lb" or "oz" means the
 * quantity IS a weight, whereas "1 lb pack" / "15 oz can" means a package count.
 */
const WEIGHT_UNIT_RE = /^(lb|lbs|pound|pounds|oz|ounce|ounces|kg|kgs|kilogram|kilograms|g|gram|grams)\.?$/i;

export function isWeightUnit(unit) {
  return WEIGHT_UNIT_RE.test(String(unit || "").trim());
}

export function weightUnitLabel(unit) {
  const u = String(unit || "").trim().toLowerCase().replace(/\.$/, "");
  if (["lb", "lbs", "pound", "pounds"].includes(u)) return "lb";
  if (["oz", "ounce", "ounces"].includes(u)) return "oz";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["g", "gram", "grams"].includes(u)) return "g";
  return u;
}

/**
 * Render either a distinct sky-blue weight badge (e.g. "1.5 lb") for items sold by
 * weight, OR the standard count badge ("1×", "2×") + optional package pill (issue #4).
 */
export function renderQtyOrWeightBadge(qty, unit, { title = "" } = {}) {
  const num = Number(qty);
  const safeNum = Number.isNaN(num) || num <= 0 ? 1 : num;
  if (isWeightUnit(unit)) {
    const uLabel = weightUnitLabel(unit);
    const tAttr = title ? ` title="${esc(title)}"` : ` title="Sold by weight (${esc(uLabel)})"`;
    return {
      isWeight: true,
      badgeHtml: `<span class="weight-badge"${tAttr}>${fmtQty(safeNum)} ${esc(uLabel)}</span>`,
      unitPillHtml: "",
    };
  }
  const isMulti = safeNum > 1;
  const tAttr = title ? ` title="${esc(title)}"` : "";
  return {
    isWeight: false,
    badgeHtml: `<span class="qty-badge ${isMulti ? "multi" : ""}"${tAttr}>${fmtQty(safeNum)}×</span>`,
    unitPillHtml: unit ? `<span class="unit-pill">${esc(unit)}</span>` : "",
  };
}

/**
 * Overflow ("⋯ More") menu used to tuck secondary actions away (issues #1 / #2).
 * items: [{ id, label, danger?, hidden? }] — each item renders as a <button id="..."> so
 * existing `document.getElementById(id).addEventListener(...)` bindings keep working.
 * Call bindOverflowMenus(container) after injecting the HTML.
 */
export function overflowMenu(items, { label = "⋯", title = "More actions", align = "right" } = {}) {
  const visible = (items || []).filter((it) => it && !it.hidden);
  if (!visible.length) return "";
  return `
    <div class="overflow-wrap">
      <button type="button" class="btn btn-sm overflow-toggle" aria-haspopup="true" aria-expanded="false" title="${esc(title)}">${esc(label)}</button>
      <div class="overflow-menu ${align === "left" ? "align-left" : ""}" role="menu" hidden>
        ${visible.map((it) => `
          <button type="button" role="menuitem" class="overflow-item ${it.danger ? "danger" : ""}" ${it.id ? `id="${esc(it.id)}"` : ""} ${it.data ? Object.entries(it.data).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`).join(" ") : ""}>${esc(it.label)}</button>
        `).join("")}
      </div>
    </div>
  `;
}

let _overflowDocListenerBound = false;

function _closeAllOverflowMenus(except = null) {
  document.querySelectorAll(".overflow-menu").forEach((m) => {
    if (m !== except) {
      m.hidden = true;
      m.parentElement?.querySelector(".overflow-toggle")?.setAttribute("aria-expanded", "false");
    }
  });
}

export function bindOverflowMenus(root = document) {
  if (!_overflowDocListenerBound) {
    _overflowDocListenerBound = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".overflow-wrap")) _closeAllOverflowMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") _closeAllOverflowMenus();
    });
  }
  root.querySelectorAll(".overflow-wrap").forEach((wrap) => {
    if (wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    const toggle = wrap.querySelector(".overflow-toggle");
    const menu = wrap.querySelector(".overflow-menu");
    toggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      _closeAllOverflowMenus(menu);
      menu.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
    menu?.querySelectorAll(".overflow-item").forEach((item) => {
      // Close after the item's own click handler runs
      item.addEventListener("click", () => setTimeout(() => _closeAllOverflowMenus(), 0));
    });
  });
}

export function openModal(title, bodyHtml, onMount) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-panel" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>${esc(title)}</h3>
          <button class="btn btn-sm" id="modal-close-btn" type="button">Close</button>
        </div>
        <div id="modal-body">${bodyHtml}</div>
      </div>
    </div>
  `;
  const close = () => {
    root.innerHTML = "";
  };
  document.getElementById("modal-close-btn").addEventListener("click", close);
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") close();
  });
  if (onMount) onMount(close);
  return close;
}

export function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
}

export const ICONS = {
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  pantry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M9 6h.01M9 12h.01M9 18h.01"/></svg>`,
  store: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-6 9 6v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  check: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};
