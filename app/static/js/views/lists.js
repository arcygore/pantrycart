import { api } from "../api.js";
import {
  ICONS,
  bindOverflowMenus,
  esc,
  fmtQty,
  isWeightUnit,
  openModal,
  overflowMenu,
  renderQtyOrWeightBadge,
  toast,
  toastAction,
} from "../utils.js";

const UNIT_CHIPS = [
  { label: "× (count)", value: "", weight: false },
  { label: "lb", value: "lb", weight: true },
  { label: "oz", value: "oz", weight: true },
  { label: "pack", value: "pack", weight: false },
  { label: "bag", value: "bag", weight: false },
  { label: "can", value: "can", weight: false },
  { label: "bunch", value: "bunch", weight: false },
];

/** Lightweight client preview of leading qty/unit (mirrors backend parse_leading_quantity). */
function previewParseInput(raw) {
  const txt = String(raw || "").trim();
  if (!txt) return null;
  if (/^\d+(?:\.\d+)?\s*%/.test(txt)) return null;
  const ratio = txt.match(/^(\d+)\/(\d+)\b/);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (a >= 50 && b <= 50 && a + b === 100) return null;
  }
  const leadMult = txt.match(/^(\d+(?:\.\d+)?)\s*[x×]\s+(.+)$/i);
  if (leadMult) {
    return { qty: Number(leadMult[1]), unit: "", name: leadMult[2].trim() };
  }
  const numLead = txt.match(/^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s+(.+)$/);
  if (numLead) {
    let qVal = 0;
    for (const part of numLead[1].trim().split(/\s+/)) {
      if (part.includes("/")) {
        const [n, d] = part.split("/").map(Number);
        if (d) qVal += n / d;
      } else {
        qVal += Number(part);
      }
    }
    if (qVal > 0) {
      let rest = numLead[2].trim();
      let unit = "";
      const unitMatch = rest.match(/^(lbs?|pounds?|oz|ounces?|g|grams?|kgs?|packs?|pkgs?|bags?|cans?|boxes?|bottles?|jars?|bunch(?:es)?|heads?|cloves?)\b\.?\s+(?:of\s+)?(.+)$/i);
      if (unitMatch) {
        unit = unitMatch[1].toLowerCase().replace(/^pounds?$/, "lb").replace(/^lbs$/, "lb").replace(/^ounces?$/, "oz").replace(/^grams?$/, "g").replace(/^kgs?$/, "kg").replace(/^pkgs?$/, "pack");
        rest = unitMatch[2].trim();
      }
      return { qty: Math.round(qVal * 100) / 100, unit, name: rest };
    }
  }
  const trailMult = txt.match(/^(.+?)\s+[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (trailMult) {
    return { qty: Number(trailMult[2]), unit: "", name: trailMult[1].trim() };
  }
  return null;
}

export async function renderListsView(container, state, navigate) {
  let [lists, stores, stapleLists, templateItems, krogerStatus] = await Promise.all([
    api("/api/lists"),
    api("/api/stores"),
    api("/api/lists/staple-lists").catch(() => []),
    api("/api/lists/template/items").catch(() => []),
    api("/api/kroger/status").catch(() => null),
  ]);

  if (state.krogerJustConnected) {
    state.krogerJustConnected = false;
    toast("Kroger account connected! You can now send lists to your Kroger cart.");
  }

  if (!state.activeListId || !lists.some((l) => l.id === state.activeListId)) {
    state.activeListId = lists[0]?.id || null;
  }

  let activeList = state.activeListId ? await api(`/api/lists/${state.activeListId}`) : null;
  let showChecked = Boolean(state.showChecked);
  const isGuest = Boolean(state.user?.is_guest);

  let quickAddDetailsOpen = false;
  let quickAddDraft = { text: "", qty: "", unit: "", dept: "", notes: "" };
  let justAddedItemId = null;
  let isSyncingStore = false;
  let isAddingItem = false;

  async function refreshAllListsAndActive() {
    [lists, activeList] = await Promise.all([
      api("/api/lists"),
      state.activeListId ? api(`/api/lists/${state.activeListId}`) : Promise.resolve(null),
    ]);
  }

  function render() {
    const uncheckedItems = (activeList?.items || []).filter((i) => !i.checked);
    const checkedItems = (activeList?.items || []).filter((i) => i.checked);
    const storeDepts = activeList?.store?.departments || [];
    const aisleDepts = new Set(activeList?.store?.aisle_departments || ["Dry Goods"]);
    const hasLinkedKroger = Boolean(activeList?.store?.kroger_location_id);

    const isAisleDept = (deptName) => {
      const low = (deptName || "").trim().toLowerCase();
      for (const ad of aisleDepts) {
        if (ad.toLowerCase() === low) return true;
      }
      return false;
    };

    const deptGroups = new Map();
    for (const d of storeDepts) {
      deptGroups.set(d, []);
    }
    for (const item of uncheckedItems) {
      const rawDept = (item.department || "Other").trim();
      let targetDept = rawDept;
      for (const sd of storeDepts) {
        if (sd.toLowerCase() === rawDept.toLowerCase()) {
          targetDept = sd;
          break;
        }
      }
      if (!deptGroups.has(targetDept)) deptGroups.set(targetDept, []);
      deptGroups.get(targetDept).push(item);
    }
    const nonEmptyDeptGroups = Array.from(deptGroups.entries()).filter(([, items]) => items.length > 0);

    const allDepts = Array.from(new Set([
      ...storeDepts,
      "Produce", "Bakery & Deli", "Meat & Seafood", "Dry Goods",
      "Beverages", "Frozen", "Dairy & Eggs", "Household & Personal", "Other",
    ]));

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Shopping Lists</h1>
          <p class="page-subtitle">Grouped by store walking path &amp; aisle</p>
        </div>
        <div class="row" style="gap: 6px;">
          ${isGuest ? `<span class="badge badge-accent">Guest</span>` : `
            <button class="btn btn-primary btn-sm" id="new-list-btn">+ New List</button>
            ${overflowMenu([
              { id: "template-list-btn", label: "🧺 Manage Staple Lists" },
              { id: "reorder-lists-btn", label: "↕ Reorder List Tabs" },
            ], { title: "List options" })}
          `}
        </div>
      </div>

      <div class="list-tabs" id="list-tabs">
        ${lists.map((l) => `
          <button class="list-tab ${l.id === activeList?.id ? "active" : ""}" data-list-id="${l.id}">
            <span>${esc(l.name)}</span>
            <span class="count-pill">${l.unchecked_count}</span>
          </button>
        `).join("")}
      </div>

      ${activeList ? `
        <div class="card stack-sm" style="margin-bottom: 14px;">
          <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
            <div class="row" style="gap: 6px; flex-wrap: wrap;">
              <span class="small muted" style="font-weight: 700;">At:</span>
              <select class="select" id="list-store-select" style="width: auto; min-width: 150px; min-height: 34px; padding: 4px 10px;" ${isSyncingStore ? "disabled" : ""}>
                <option value="">No specific store</option>
                ${stores.map((s) => `
                  <option value="${s.id}" ${s.id === activeList.store_id ? "selected" : ""}>${esc(s.name)}</option>
                `).join("")}
              </select>
              ${isSyncingStore ? `<span class="badge badge-info">Syncing aisles...</span>` : ""}
              ${(!isSyncingStore && hasLinkedKroger)
                ? `<span class="badge badge-info" title="Linked Kroger Store">🏪 ${esc(activeList.store.kroger_location_name || "Kroger")}</span>`
                : ""}
              ${activeList.store?.has_custom_path ? `<span class="badge" title="Using your personal walking path">Your Path</span>` : ""}
            </div>

            ${isGuest ? "" : `
              <div class="row" style="gap: 6px; flex-wrap: wrap;">
                <button class="btn btn-sm" id="open-add-staples-btn" type="button" title="Pick from your staple lists to add">+ Staples</button>
                ${hasLinkedKroger ? `
                  <button class="btn btn-sm btn-primary" id="kroger-cart-btn" type="button" title="Match items &amp; send to Kroger Cart">🛒 Kroger Cart</button>
                ` : ""}
                ${overflowMenu([
                  { id: "kroger-aisles-btn", label: "🧭 Re-sync Kroger Aisles", hidden: !hasLinkedKroger },
                  { id: "quick-load-template-btn", label: "⚡ Quick Add Active Staples" },
                  { id: "clear-checked-menu-btn", label: `Clear Checked (${checkedItems.length})`, hidden: checkedItems.length === 0 },
                  { id: "clear-all-list-btn", label: "🗑 Clear Entire List", danger: true, hidden: (activeList.items || []).length === 0 },
                  { id: "delete-list-btn", label: "Delete List", danger: true, hidden: activeList.list_type !== "one_off" },
                ], { title: "Trip actions" })}
              </div>
            `}
          </div>

          <form id="quick-add-form" class="quick-add-wrap">
            <div class="row" style="gap: 6px;">
              <input class="input grow" id="quick-add-input" autocomplete="off"
                value="${esc(quickAddDraft.text)}"
                placeholder="Add item (e.g. bananas, 1.5 lb chicken, 2% milk)..." />
              <button class="btn btn-sm ${quickAddDetailsOpen ? "btn-primary" : ""}" id="quick-add-details-btn"
                type="button" title="Quantity, weight/unit, department &amp; notes">⚙</button>
              <button class="btn btn-primary btn-sm" id="quick-add-submit-btn" type="submit" style="min-height: 40px; padding: 0 14px;">Add</button>
            </div>
            <div id="parsed-preview-bar" class="parsed-preview-bar" style="display: none;"></div>

            ${quickAddDetailsOpen ? `
              <div id="quick-add-details" class="quick-add-details">
                <div class="grid-2" style="gap: 8px;">
                  <div>
                    <label class="field-label">Quantity / Weight</label>
                    <input class="input" id="detail-qty-input" type="number" step="any" min="0.01"
                      value="${esc(quickAddDraft.qty)}" placeholder="1" style="min-height: 36px;" />
                  </div>
                  <div>
                    <label class="field-label">Unit / Package</label>
                    <input class="input" id="detail-unit-input" value="${esc(quickAddDraft.unit)}"
                      placeholder="e.g. lb, oz, pack, can" style="min-height: 36px;" />
                  </div>
                </div>
                <div class="unit-chip-row">
                  <span class="small muted" style="font-weight: 700;">Quick unit:</span>
                  ${UNIT_CHIPS.map((c) => `
                    <button type="button" class="unit-chip ${c.weight ? "weight" : ""} ${quickAddDraft.unit.toLowerCase() === c.value ? "active" : ""}"
                      data-quick-unit="${esc(c.value)}">${esc(c.label)}</button>
                  `).join("")}
                </div>
                <div class="grid-2" style="gap: 8px;">
                  <div>
                    <label class="field-label">Department</label>
                    <select class="select" id="detail-dept-select" style="min-height: 36px;">
                      <option value="">Auto-detect</option>
                      ${allDepts.map((d) => `<option value="${esc(d)}" ${quickAddDraft.dept === d ? "selected" : ""}>${esc(d)}</option>`).join("")}
                    </select>
                  </div>
                  <div>
                    <label class="field-label">Notes / Substitutions</label>
                    <input class="input" id="detail-notes-input" value="${esc(quickAddDraft.notes)}"
                      placeholder="Optional note..." style="min-height: 36px;" />
                  </div>
                </div>
              </div>
            ` : ""}

            <div id="suggestions-box" class="suggestions-menu" style="display:none;"></div>
          </form>
        </div>

        ${uncheckedItems.length === 0 ? `
          <div class="card empty-state">
            <p style="font-weight:700; color: var(--text); margin: 0 0 6px;">Nothing left to buy on ${esc(activeList.name)}!</p>
            <p class="small" style="margin: 0;">Add items above, tap <strong>+ Staples</strong>, or build from <strong>This Week</strong>.</p>
          </div>
        ` : `
          <div class="stack-md">
            ${nonEmptyDeptGroups.map(([dept, items], walkIdx) => {
              const usesAisles = isAisleDept(dept);
              let lastAisleKey = null;
              return `
                <div class="dept-card">
                  <div class="dept-header">
                    <span>${activeList.store ? `<span class="muted" style="font-weight:600;margin-right:5px;">#${walkIdx + 1}</span>` : ""}${esc(dept)}</span>
                    <span>${items.length}</span>
                  </div>
                  ${items.map((item) => {
                    let aisleDivider = "";
                    if (usesAisles) {
                      const aLabel = item.aisle ? `Aisle ${item.aisle}` : "Unassigned Aisle";
                      if (aLabel !== lastAisleKey) {
                        lastAisleKey = aLabel;
                        aisleDivider = `<div class="aisle-divider">${esc(aLabel)}</div>`;
                      }
                    }
                    return `${aisleDivider}${renderItemRow(item, activeList.store, usesAisles)}`;
                  }).join("")}
                </div>
              `;
            }).join("")}
          </div>
        `}

        <div class="card stack-sm" id="checked-drawer-card" style="margin-top: 14px; ${checkedItems.length === 0 ? "display:none;" : ""}">
          <div class="row" style="justify-content: space-between;">
            <button class="btn btn-sm" id="toggle-checked-btn" type="button">
              ${showChecked ? "Hide" : "Show"} Checked / In Cart (${checkedItems.length})
            </button>
            ${isGuest ? "" : `
              <button class="btn btn-sm btn-danger" id="clear-checked-btn" type="button">Clear Checked</button>
            `}
          </div>
          ${showChecked ? `
            <div style="margin-top: 6px;">
              ${checkedItems.map((item) => renderItemRow(item, activeList.store, isAisleDept(item.department))).join("")}
            </div>
          ` : ""}
        </div>
      ` : `
        <div class="card empty-state">No shopping lists yet. Create one to get started!</div>
      `}
    `;

    bindOverflowMenus(container);
    bindEvents(allDepts);
    updateParsedPreview();
  }

  function renderItemRow(item, store, usesAisles = false) {
    const canModify = !isGuest || item.added_by === state.user?.id;
    const { badgeHtml, unitPillHtml } = renderQtyOrWeightBadge(item.buy_qty, item.buy_unit, {
      title: canModify ? "Click item to edit quantity or weight" : "",
    });
    const recipeText = item.source_recipes?.length ? `For: ${item.source_recipes.join(", ")}` : "";
    const showAislePill = Boolean(store && usesAisles);
    const aisleText = item.aisle ? `Aisle ${item.aisle}` : "+ Aisle";
    const priceBadge = item.price != null ? `<span class="price-chip">$${Number(item.price).toFixed(2)}</span>` : "";
    const brandHint = item.preferred_brand ? `★ ${item.preferred_brand}` : "";
    const flashCls = item.id === justAddedItemId ? " just-added" : "";

    return `
      <div class="item-row ${item.checked ? "checked" : ""}${flashCls}" data-item-id="${item.id}">
        <button class="check-circle ${item.checked ? "checked" : ""}" data-action="toggle" aria-label="Toggle item">
          ${item.checked ? ICONS.check : ""}
        </button>
        <div class="item-main ${canModify ? "editable" : ""}" ${canModify ? `data-action="edit-item" title="Tap to edit"` : ""}>
          <div class="item-title-line">
            ${badgeHtml}
            <span class="item-name">${esc(item.name)}</span>
            ${unitPillHtml}
          </div>
          ${(item.needed_summary || recipeText || priceBadge || brandHint) ? `
            <div class="item-meta row-wrap" style="gap: 6px;">
              ${priceBadge}
              ${[item.needed_summary, recipeText, brandHint].filter(Boolean).map(esc).join(" · ")}
            </div>
          ` : ""}
          ${item.notes ? `
            <div class="item-note-callout" title="Notes / acceptable substitutions">📝 ${esc(item.notes)}</div>
          ` : ""}
        </div>
        <div class="item-action-btns">
          ${showAislePill ? (canModify ? `
            <button class="aisle-pill ${item.aisle ? "has-aisle" : ""}" data-action="edit-item" title="Set department &amp; aisle for ${esc(store.name)}">
              ${esc(aisleText)}
            </button>
          ` : (item.aisle ? `<span class="badge badge-accent">${esc(aisleText)}</span>` : "")) : ""}
          ${canModify ? `
            <button class="item-icon-btn danger" data-action="delete-item" type="button" title="Remove item">✕</button>
          ` : ""}
        </div>
      </div>
    `;
  }

  function updateParsedPreview() {
    const bar = document.getElementById("parsed-preview-bar");
    const inp = document.getElementById("quick-add-input");
    if (!bar || !inp) return;
    if (quickAddDetailsOpen) {
      bar.style.display = "none";
      return;
    }
    const p = previewParseInput(inp.value);
    if (!p || !p.name) {
      bar.style.display = "none";
      return;
    }
    const { badgeHtml } = renderQtyOrWeightBadge(p.qty, p.unit);
    bar.innerHTML = `<span>Will add: ${badgeHtml} <strong>${esc(p.name)}</strong></span><span class="small muted">Press Enter</span>`;
    bar.style.display = "flex";
  }

  function openStaplesModal() {
    let activeStapleListId = stapleLists[0]?.id || null;
    // Smart default: match active list name if a staple list name is similar (e.g. "Costco")
    if (activeList && stapleLists.length > 1) {
      const listLow = (activeList.name || "").toLowerCase();
      const matched = stapleLists.find((sl) => listLow.includes(sl.name.toLowerCase()) || sl.name.toLowerCase().includes(listLow.split(" ")[0]));
      if (matched) activeStapleListId = matched.id;
    }
    let editingTplId = null;
    const overrides = new Map(); // tplId -> { checked, buy_qty, buy_unit }

    const allDepts = Array.from(new Set([
      ...(activeList?.store?.departments || []),
      "Produce", "Bakery & Deli", "Meat & Seafood", "Dry Goods",
      "Beverages", "Frozen", "Dairy & Eggs", "Household & Personal", "Other",
    ]));

    const syncOverridesFromDom = () => {
      document.querySelectorAll(".tpl-trip-qty").forEach((el) => {
        const id = Number(el.dataset.id);
        const unitEl = document.querySelector(`.tpl-trip-unit[data-id="${id}"]`);
        const chkEl = document.querySelector(`.tpl-toggle[data-id="${id}"]`);
        overrides.set(id, {
          checked: chkEl ? chkEl.checked : true,
          buy_qty: Number(el.value) || 1,
          buy_unit: unitEl ? unitEl.value.trim() : "",
        });
      });
    };

    const renderModalBody = () => {
      const currentListItems = templateItems.filter((t) =>
        activeStapleListId ? t.staple_list_id === activeStapleListId : true
      );
      const activeStapleList = stapleLists.find((sl) => sl.id === activeStapleListId);
      const selectedCount = currentListItems.filter((t) => {
        const ov = overrides.get(t.id);
        return ov ? ov.checked : t.is_active;
      }).length;

      return `
        <div class="stack-md">
          <div class="row-wrap" style="justify-content: space-between; gap: 6px;">
            <div class="list-tabs" style="margin-bottom: 0; flex: 1;">
              ${stapleLists.map((sl) => `
                <button type="button" class="list-tab staple-list-tab ${sl.id === activeStapleListId ? "active" : ""}" data-sl-id="${sl.id}">
                  <span>${esc(sl.name)}</span>
                  <span class="count-pill">${templateItems.filter((t) => t.staple_list_id === sl.id).length}</span>
                </button>
              `).join("")}
            </div>
            <div class="row" style="gap: 4px; flex-shrink: 0;">
              <button type="button" class="btn btn-sm" id="new-staple-list-btn">+ New Group</button>
              ${activeStapleList ? `<button type="button" class="btn btn-sm" id="rename-staple-list-btn" title="Rename staple list">✎</button>` : ""}
              ${activeStapleList && stapleLists.length > 1 ? `<button type="button" class="btn btn-sm btn-danger" id="del-staple-list-btn" title="Delete staple list">🗑</button>` : ""}
            </div>
          </div>

          <form id="add-tpl-form" class="row-wrap" style="gap: 6px;">
            <input class="input grow" name="name" placeholder="Add staple to ${esc(activeStapleList?.name || "list")}..." required style="min-width: 150px;" />
            <input class="input" name="buy_qty" type="number" step="any" min="0.01" value="1" style="width: 68px;" title="Quantity or weight" />
            <input class="input" name="buy_unit" placeholder="Unit (lb, pack...)" style="width: 115px;" />
            <input class="input" name="notes" placeholder="Notes (optional)..." style="flex: 1 1 140px;" />
            <button class="btn btn-primary btn-sm" type="submit">+ Add</button>
          </form>

          <div class="stack-sm" style="max-height: 330px; overflow-y: auto;">
            ${currentListItems.length === 0 ? `
              <p class="small muted" style="margin: 8px 0;">No staples in "${esc(activeStapleList?.name || "this group")}" yet. Add one above!</p>
            ` : currentListItems.map((t) => {
              if (editingTplId === t.id) {
                const itemDepts = allDepts.includes(t.department) ? allDepts : [t.department, ...allDepts];
                return `
                  <form class="tpl-edit-form stack-sm" data-id="${t.id}" style="padding: 10px; border: 2px solid var(--primary); border-radius: 9px; background: var(--surface-alt);">
                    <div class="row-wrap">
                      <input class="input grow" name="name" value="${esc(t.name)}" placeholder="Item name" required style="min-width: 140px;" />
                      <input class="input" name="buy_qty" type="number" step="any" min="0.01" value="${esc(t.buy_qty)}" style="width: 72px;" required />
                      <input class="input" name="buy_unit" value="${esc(t.buy_unit)}" placeholder="Unit (lb, bunch, pack)" style="width: 135px;" />
                    </div>
                    <input class="input" name="notes" value="${esc(t.notes || "")}" placeholder="Notes / acceptable substitutions" />
                    <div class="row-wrap" style="justify-content: space-between;">
                      <select class="select" name="department" style="width: auto; min-width: 160px; min-height: 34px;">
                        ${itemDepts.map((d) => `<option value="${esc(d)}" ${d === t.department ? "selected" : ""}>${esc(d)}</option>`).join("")}
                      </select>
                      <div class="row" style="gap: 6px;">
                        <button class="btn btn-sm tpl-cancel-edit" type="button">Cancel</button>
                        <button class="btn btn-sm btn-primary" type="submit">Save</button>
                      </div>
                    </div>
                  </form>
                `;
              }
              const ov = overrides.get(t.id);
              const effChecked = ov ? ov.checked : t.is_active;
              const effQty = ov ? ov.buy_qty : t.buy_qty;
              const effUnit = ov ? ov.buy_unit : t.buy_unit;
              const { badgeHtml } = renderQtyOrWeightBadge(effQty, effUnit);
              return `
                <div class="stack-sm" style="padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
                  <div class="row" style="justify-content: space-between; gap: 8px;">
                    <label class="row grow" style="cursor: pointer;">
                      <input type="checkbox" class="tpl-toggle" data-id="${t.id}" ${effChecked ? "checked" : ""} />
                      <div class="grow">
                        <div class="row-wrap" style="gap: 6px;">
                          ${badgeHtml}
                          <span style="font-weight: 700;">${esc(t.name)}</span>
                        </div>
                        <div class="small muted">${esc(t.department)}</div>
                        ${t.notes ? `<div class="item-note-callout">📝 ${esc(t.notes)}</div>` : ""}
                      </div>
                    </label>
                    <div class="row" style="gap: 4px;">
                      <button class="btn btn-sm tpl-edit-btn" data-id="${t.id}" type="button" title="Edit saved staple">Edit</button>
                      <button class="btn btn-sm btn-danger tpl-del-btn" data-id="${t.id}" type="button" title="Delete staple">✕</button>
                    </div>
                  </div>
                  <div class="row" style="gap: 6px; padding-left: 26px;">
                    <span class="small muted">For trip:</span>
                    <input class="input tpl-trip-qty" data-id="${t.id}" type="number" step="any" min="0.01" value="${esc(effQty)}" style="width: 68px; min-height: 30px; padding: 3px 6px; font-size: 0.82rem;" />
                    <input class="input tpl-trip-unit" data-id="${t.id}" value="${esc(effUnit)}" placeholder="unit" style="width: 120px; min-height: 30px; padding: 3px 6px; font-size: 0.82rem;" />
                  </div>
                </div>
              `;
            }).join("")}
          </div>

          ${activeList ? `
            <button class="btn btn-primary" id="apply-tpl-now-btn" type="button" ${selectedCount === 0 ? "disabled" : ""}>
              Add ${selectedCount} Staple${selectedCount === 1 ? "" : "s"} to "${esc(activeList.name)}"
            </button>
          ` : ""}
        </div>
      `;
    };

    openModal("Add Staples", renderModalBody(), (close) => {
      const refreshModal = async () => {
        [stapleLists, templateItems] = await Promise.all([
          api("/api/lists/staple-lists"),
          api("/api/lists/template/items"),
        ]);
        if (!stapleLists.some((s) => s.id === activeStapleListId)) {
          activeStapleListId = stapleLists[0]?.id || null;
        }
        document.getElementById("modal-body").innerHTML = renderModalBody();
        bindTplModal();
      };

      const bindTplModal = () => {
        document.querySelectorAll(".staple-list-tab").forEach((btn) => {
          btn.addEventListener("click", () => {
            syncOverridesFromDom();
            activeStapleListId = Number(btn.dataset.slId);
            editingTplId = null;
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
          });
        });

        document.getElementById("new-staple-list-btn")?.addEventListener("click", async () => {
          const name = prompt("Name for new staple list (e.g. Costco Bulk, Trader Joe's, Camping):");
          if (!name || !name.trim()) return;
          const created = await api("/api/lists/staple-lists", {
            method: "POST",
            body: { name: name.trim() },
          });
          activeStapleListId = created.id;
          await refreshModal();
          toast(`Created staple list "${created.name}"`);
        });

        document.getElementById("rename-staple-list-btn")?.addEventListener("click", async () => {
          const cur = stapleLists.find((s) => s.id === activeStapleListId);
          if (!cur) return;
          const nextName = prompt("Rename staple list:", cur.name);
          if (!nextName || !nextName.trim() || nextName.trim() === cur.name) return;
          await api(`/api/lists/staple-lists/${cur.id}`, {
            method: "PATCH",
            body: { name: nextName.trim() },
          });
          await refreshModal();
          toast("Renamed staple list");
        });

        document.getElementById("del-staple-list-btn")?.addEventListener("click", async () => {
          const cur = stapleLists.find((s) => s.id === activeStapleListId);
          if (!cur || !confirm(`Delete staple list "${cur.name}" and all its items?`)) return;
          await api(`/api/lists/staple-lists/${cur.id}`, { method: "DELETE" });
          await refreshModal();
          toast("Deleted staple list");
        });

        document.getElementById("add-tpl-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          syncOverridesFromDom();
          const f = e.target;
          await api("/api/lists/template/items", {
            method: "POST",
            body: {
              name: f.name.value.trim(),
              buy_qty: Number(f.buy_qty.value) || 1,
              buy_unit: f.buy_unit.value.trim(),
              notes: f.notes?.value.trim() || "",
              staple_list_id: activeStapleListId,
            },
          });
          await refreshModal();
          render();
        });

        document.querySelectorAll(".tpl-toggle").forEach((chk) => {
          chk.addEventListener("change", async () => {
            syncOverridesFromDom();
            await api(`/api/lists/template/items/${chk.dataset.id}`, {
              method: "PATCH",
              body: { is_active: chk.checked },
            });
            templateItems = await api("/api/lists/template/items");
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
          });
        });

        document.querySelectorAll(".tpl-edit-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            syncOverridesFromDom();
            editingTplId = Number(btn.dataset.id);
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
          });
        });

        document.querySelectorAll(".tpl-cancel-edit").forEach((btn) => {
          btn.addEventListener("click", () => {
            editingTplId = null;
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
          });
        });

        document.querySelectorAll(".tpl-edit-form").forEach((form) => {
          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const id = Number(form.dataset.id);
            await api(`/api/lists/template/items/${id}`, {
              method: "PATCH",
              body: {
                name: form.name.value.trim(),
                buy_qty: Number(form.buy_qty.value) || 1,
                buy_unit: form.buy_unit.value.trim(),
                department: form.department.value,
                notes: form.notes?.value.trim() || "",
              },
            });
            overrides.delete(id);
            editingTplId = null;
            await refreshModal();
            render();
            toast("Staple updated!");
          });
        });

        document.querySelectorAll(".tpl-del-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            syncOverridesFromDom();
            const id = Number(btn.dataset.id);
            overrides.delete(id);
            await api(`/api/lists/template/items/${id}`, { method: "DELETE" });
            await refreshModal();
            render();
          });
        });

        document.getElementById("apply-tpl-now-btn")?.addEventListener("click", async () => {
          syncOverridesFromDom();
          const currentListItems = templateItems.filter((t) =>
            activeStapleListId ? t.staple_list_id === activeStapleListId : true
          );
          const itemIds = [];
          const overrideList = [];
          for (const t of currentListItems) {
            const ov = overrides.get(t.id);
            const checked = ov ? ov.checked : t.is_active;
            if (!checked) continue;
            itemIds.push(t.id);
            if (ov) {
              overrideList.push({
                id: t.id,
                buy_qty: ov.buy_qty,
                buy_unit: ov.buy_unit,
              });
            }
          }
          if (!itemIds.length) {
            toast("Select at least one staple item first", true);
            return;
          }
          activeList = await api(`/api/lists/${activeList.id}/apply-template`, {
            method: "POST",
            body: { item_ids: itemIds, overrides: overrideList },
          });
          lists = await api("/api/lists");
          close();
          render();
          toast(`Added ${itemIds.length} staples to ${activeList.name}!`);
        });
      };

      bindTplModal();
    });
  }

  function openKrogerSetupPromptModal(actionLabel) {
    openModal("Link Kroger Store First", `
      <div class="stack-md">
        <p class="muted">
          To ${esc(actionLabel)}, configure your Kroger API credentials in Settings and link a Kroger location to this store in <strong>Stores → Store Settings</strong>.
        </p>
        <div class="row" style="justify-content: flex-end; gap: 8px;">
          <button class="btn" id="kroger-setup-cancel-btn" type="button">Cancel</button>
          <button class="btn btn-primary" id="kroger-go-settings-btn" type="button">Go to Settings → Kroger</button>
        </div>
      </div>
    `, (close) => {
      document.getElementById("kroger-setup-cancel-btn")?.addEventListener("click", close);
      document.getElementById("kroger-go-settings-btn")?.addEventListener("click", () => {
        close();
        state.settingsTab = "kroger";
        if (typeof navigate === "function") navigate("settings");
        else window.location.hash = "#settings?tab=kroger";
      });
    });
  }

  function openKrogerProductPickerModal(item) {
    if (!activeList) return;
    let candidates = [];
    let searching = true;
    let searchTerm = item.name;
    let errMsg = "";

    const renderPickerBody = () => `
      <div class="stack-md">
        <p class="small muted" style="margin: 0;">
          Pick the exact Kroger product &amp; brand for <strong>${esc(item.name)}</strong>. Your choice is remembered per-person for future trips and aisle lookups!
        </p>
        <form id="kroger-picker-search-form" class="row" style="gap: 6px;">
          <input class="input grow" id="kroger-picker-term" value="${esc(searchTerm)}" placeholder="Search Kroger products..." required />
          <button class="btn btn-primary btn-sm" type="submit" ${searching ? "disabled" : ""}>${searching ? "..." : "🔍 Search"}</button>
        </form>
        ${errMsg ? `<div class="small" style="color: var(--danger);">${esc(errMsg)}</div>` : ""}
        ${searching ? `<div class="small muted">Searching ${esc(activeList.store?.kroger_location_name || "Kroger")}...</div>` : `
          ${candidates.length === 0 ? `<p class="small muted">No matching Kroger products found. Try broader keywords.</p>` : `
            <div class="kroger-prod-list">
              ${candidates.map((c, idx) => {
                const isSelected = item.preferred_upc && c.upc === item.preferred_upc;
                return `
                  <div class="kroger-prod-card ${isSelected ? "selected" : ""}">
                    ${c.image_url
                      ? `<img class="kroger-prod-thumb" src="${esc(c.image_url)}" alt="" loading="lazy" />`
                      : `<div class="kroger-prod-thumb-placeholder">🛒</div>`}
                    <div class="grow">
                      <div style="font-weight: 700; font-size: 0.88rem;">
                        ${c.brand ? `<span class="muted">${esc(c.brand)} · </span>` : ""}${esc(c.description)}
                      </div>
                      <div class="row-wrap small muted" style="gap: 6px; margin-top: 2px;">
                        ${c.size ? `<span>${esc(c.size)}</span>` : ""}
                        ${c.price != null ? `<span class="price-chip">$${Number(c.price).toFixed(2)}</span>` : ""}
                        ${c.aisle ? `<span class="aisle-pill has-aisle" style="padding: 1px 6px; font-size: 0.72rem;">Aisle ${esc(c.aisle)}${c.aisle_detail ? ` (${esc(c.aisle_detail)})` : ""}</span>` : ""}
                        ${isSelected ? `<span class="badge badge-primary">★ Saved</span>` : ""}
                      </div>
                    </div>
                    <button type="button" class="btn btn-sm btn-primary pick-kroger-cand-btn" data-idx="${idx}">Select</button>
                  </div>
                `;
              }).join("")}
            </div>
          `}
        `}
      </div>
    `;

    openModal(`Pick Kroger Product — ${item.name}`, renderPickerBody(), async (close) => {
      const runSearch = async () => {
        searching = true;
        errMsg = "";
        const bodyEl = document.getElementById("modal-body");
        if (bodyEl) bodyEl.innerHTML = renderPickerBody();
        bindPickerEvents();
        try {
          const res = await api("/api/kroger/search-product", {
            method: "POST",
            body: {
              term: searchTerm,
              list_id: activeList.id,
              department: item.department || "",
              limit: 10,
            },
          });
          candidates = res?.candidates || [];
        } catch (err) {
          errMsg = err.message || "Search failed";
          candidates = [];
        } finally {
          searching = false;
          const b = document.getElementById("modal-body");
          if (b) {
            b.innerHTML = renderPickerBody();
            bindPickerEvents();
          }
        }
      };

      const bindPickerEvents = () => {
        document.getElementById("kroger-picker-search-form")?.addEventListener("submit", (e) => {
          e.preventDefault();
          searchTerm = document.getElementById("kroger-picker-term")?.value.trim() || item.name;
          runSearch();
        });

        document.querySelectorAll(".pick-kroger-cand-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const c = candidates[Number(btn.dataset.idx)];
            if (!c) return;
            await api("/api/kroger/prefs", {
              method: "PUT",
              body: {
                item_key: item.item_key,
                upc: c.upc,
                description: c.description,
                brand: c.brand,
                size: c.size,
                image_url: c.image_url,
                list_id: activeList.id,
                item_id: item.id,
                aisle: c.aisle || "",
                price: c.price ?? null,
              },
            });
            await refreshAllListsAndActive();
            close();
            render();
            const pickedLabel = [c.brand, c.description].filter(Boolean).join(" ");
            toast(`Saved "${pickedLabel}"${c.aisle ? ` (Aisle ${c.aisle})` : ""}!`);
          });
        });
      };

      await runSearch();
    });
  }

  function openKrogerCartModal() {
    if (!activeList) return;
    if (!krogerStatus?.configured || !activeList.store?.kroger_location_id) {
      openKrogerSetupPromptModal("match products and send them to your Kroger cart");
      return;
    }

    openModal(`Send "${activeList.name}" to Kroger Cart`, `
      <div id="kroger-cart-modal-body" class="stack-md">
        <p class="muted">Searching live Kroger catalog at <strong>${esc(activeList.store.kroger_location_name || "your store")}</strong>...</p>
      </div>
    `, async (close) => {
      const bodyEl = document.getElementById("kroger-cart-modal-body");
      try {
        krogerStatus = await api("/api/kroger/status").catch(() => krogerStatus);
        const preview = await api(`/api/kroger/preview-cart/${activeList.id}`, {
          method: "POST",
          body: {},
        });
        const items = preview.items || [];
        const matchedCount = items.filter((it) => (it.candidates || []).length > 0).length;

        bodyEl.innerHTML = `
          <div class="stack-md">
            <div class="row-wrap" style="justify-content: space-between; align-items: center; gap: 8px;">
              <span class="badge badge-info">🏪 ${esc(preview.location_name || activeList.store.kroger_location_name || "Kroger")}</span>
              <div class="row" style="gap: 8px; align-items: center;">
                <label class="small muted" for="kroger-modality-select" style="font-weight: 700;">Fulfillment:</label>
                <select class="select" id="kroger-modality-select" style="width: auto; min-height: 34px;">
                  <option value="PICKUP">Curbside Pickup</option>
                  <option value="DELIVERY">Delivery</option>
                </select>
              </div>
            </div>

            ${!krogerStatus?.user_connected ? `
              <div class="card" style="background: #fffbeb; border-color: #f59e0b;">
                <div class="row-wrap" style="justify-content: space-between; align-items: center; gap: 10px;">
                  <div class="small">
                    <strong>Step Required:</strong> Sign in with your Kroger shopper account before adding items to your cart.
                  </div>
                  <button class="btn btn-sm btn-primary" id="kroger-oauth-connect-btn" type="button">Connect Kroger Account</button>
                </div>
              </div>
            ` : `
              <div class="small muted">Matched <strong>${matchedCount}</strong> of ${items.length} items. Picks are remembered for next time!</div>
            `}

            <div id="kroger-modal-error" class="small" style="display: none; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; padding: 8px 10px; border-radius: 8px;"></div>

            ${items.length === 0 ? `
              <p class="muted">No unchecked items on this shopping list to send.</p>
            ` : `
              <div class="stack-sm" style="max-height: 360px; overflow-y: auto; padding-right: 4px;">
                ${items.map((it) => {
                  const hasMatches = (it.candidates || []).length > 0;
                  const selCand = (it.candidates || []).find((c) => c.upc === it.selected_upc) || it.candidates?.[0] || null;
                  return `
                    <div class="card" style="padding: 10px 12px;">
                      <div class="row" style="gap: 10px; align-items: flex-start;">
                        <input type="checkbox" class="kroger-item-check" data-item-id="${it.list_item_id}"
                          ${hasMatches ? "checked" : "disabled"} style="margin-top: 4px;" />
                        <div class="kroger-thumb-slot" data-item-id="${it.list_item_id}">
                          ${selCand?.image_url
                            ? `<img class="kroger-prod-thumb" src="${esc(selCand.image_url)}" alt="" />`
                            : `<div class="kroger-prod-thumb-placeholder">🛒</div>`}
                        </div>
                        <div class="grow stack-sm" style="gap: 6px;">
                          <div class="row-wrap" style="justify-content: space-between; gap: 6px;">
                            <div class="row" style="gap: 6px;">
                              <strong>${esc(it.list_item_name)}</strong>
                              ${selCand?.is_preferred ? `<span class="badge badge-primary">★ Saved</span>` : ""}
                            </div>
                            <span class="small muted">Need: ${fmtQty(it.quantity)} ${esc(it.buy_unit || "ea")}</span>
                          </div>
                          <div class="row" style="gap: 6px; flex-wrap: wrap;">
                            <input class="input grow kroger-search-input" data-item-id="${it.list_item_id}"
                              value="${esc(it.search_term || it.list_item_name)}"
                              placeholder="Refine Kroger search..."
                              style="min-height: 32px; font-size: 0.84rem; min-width: 140px;" />
                            <button class="btn btn-sm kroger-retry-search-btn" type="button" data-item-id="${it.list_item_id}">🔍 Search</button>
                          </div>
                          <div class="row" style="gap: 8px; flex-wrap: wrap;">
                            <select class="select grow kroger-item-select" data-item-id="${it.list_item_id}" ${hasMatches ? "" : "disabled"}>
                              ${hasMatches ? it.candidates.map((c) => {
                                const priceTxt = c.price != null ? ` — $${Number(c.price).toFixed(2)}` : "";
                                const aisleTxt = c.aisle ? ` [Aisle ${c.aisle}]` : "";
                                const star = c.is_preferred ? "★ " : "";
                                const label = `${star}${c.brand ? c.brand + " - " : ""}${c.description}${c.size ? " (" + c.size + ")" : ""}${priceTxt}${aisleTxt}`;
                                return `<option value="${esc(c.upc)}" ${c.upc === it.selected_upc ? "selected" : ""}>${esc(label)}</option>`;
                              }).join("") : `<option value="">No Kroger match — edit search above</option>`}
                            </select>
                            <input type="number" min="1" step="1" class="input kroger-item-qty"
                              data-item-id="${it.list_item_id}" value="${Math.max(1, Number(it.quantity) || 1)}"
                              style="width: 68px;" ${hasMatches ? "" : "disabled"} title="Cart quantity" />
                          </div>
                        </div>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            `}

            <div class="row" style="justify-content: flex-end; gap: 8px;">
              <button class="btn" id="kroger-cart-cancel-btn" type="button">Close</button>
              <button class="btn btn-primary" id="kroger-push-submit-btn" type="button"
                ${!krogerStatus?.user_connected || matchedCount === 0 ? "disabled" : ""}>
                🛒 Add Selected to Cart
              </button>
            </div>
          </div>
        `;

        const candidatesByItemId = new Map(items.map((it) => [String(it.list_item_id), it]));

        const formatKrogerCandidateOption = (c) => {
          const priceTxt = c.price != null ? ` — $${Number(c.price).toFixed(2)}` : "";
          const aisleTxt = c.aisle ? ` [Aisle ${c.aisle}]` : "";
          const label = `${c.brand ? c.brand + " - " : ""}${c.description}${c.size ? " (" + c.size + ")" : ""}${priceTxt}${aisleTxt}`;
          return `<option value="${esc(c.upc)}">${esc(label)}</option>`;
        };

        const updateRowThumb = (itemId, upc) => {
          const entry = candidatesByItemId.get(String(itemId));
          const c = entry?.candidates?.find((x) => x.upc === upc);
          const slot = document.querySelector(`.kroger-thumb-slot[data-item-id="${itemId}"]`);
          if (slot) {
            slot.innerHTML = c?.image_url
              ? `<img class="kroger-prod-thumb" src="${esc(c.image_url)}" alt="" />`
              : `<div class="kroger-prod-thumb-placeholder">🛒</div>`;
          }
        };

        const saveCandidatePref = async (itemId, upc) => {
          const entry = candidatesByItemId.get(String(itemId));
          const c = entry?.candidates?.find((x) => x.upc === upc);
          if (!entry || !c) return;
          try {
            await api("/api/kroger/prefs", {
              method: "PUT",
              body: {
                item_key: entry.item_key,
                upc: c.upc,
                description: c.description,
                brand: c.brand,
                size: c.size,
                image_url: c.image_url,
                list_id: activeList.id,
                item_id: entry.list_item_id,
                aisle: c.aisle || null,
                price: c.price ?? null,
              },
            });
          } catch {
            // Non-blocking preference save
          }
        };

        const refreshKrogerPushBtn = () => {
          const pushBtnEl = document.getElementById("kroger-push-submit-btn");
          if (!pushBtnEl) return;
          const anySelected = Array.from(document.querySelectorAll(".kroger-item-check")).some((c) => c.checked && !c.disabled);
          pushBtnEl.disabled = !krogerStatus?.user_connected || !anySelected;
        };

        const runItemSearch = async (itemId) => {
          const inp = document.querySelector(`.kroger-search-input[data-item-id="${itemId}"]`);
          const btn = document.querySelector(`.kroger-retry-search-btn[data-item-id="${itemId}"]`);
          const sel = document.querySelector(`.kroger-item-select[data-item-id="${itemId}"]`);
          const chk = document.querySelector(`.kroger-item-check[data-item-id="${itemId}"]`);
          const qtyEl = document.querySelector(`.kroger-item-qty[data-item-id="${itemId}"]`);
          const entry = candidatesByItemId.get(String(itemId));
          const term = inp?.value.trim() || "";
          if (!term) {
            toast("Enter keywords to search Kroger", true);
            return;
          }
          if (btn) {
            btn.disabled = true;
            btn.textContent = "...";
          }
          try {
            const res = await api("/api/kroger/search-product", {
              method: "POST",
              body: {
                term,
                list_id: activeList.id,
                location_id: preview.location_id || "",
                department: entry?.department || "",
                limit: 8,
              },
            });
            const cands = res?.candidates || [];
            if (entry) entry.candidates = cands;
            if (sel) {
              sel.innerHTML = cands.length
                ? cands.map(formatKrogerCandidateOption).join("")
                : `<option value="">No matches for "${esc(term)}"</option>`;
              sel.disabled = cands.length === 0;
            }
            if (qtyEl) qtyEl.disabled = cands.length === 0;
            if (chk) {
              chk.disabled = cands.length === 0;
              chk.checked = cands.length > 0;
            }
            updateRowThumb(itemId, cands[0]?.upc || "");
            if (cands[0]?.upc) {
              saveCandidatePref(itemId, cands[0].upc);
            }
            if (!cands.length) toast(`No Kroger matches for "${term}"`, true);
            else toast(`Found ${cands.length} Kroger option(s) for "${term}"`);
            refreshKrogerPushBtn();
          } catch (err) {
            toast(err.message || "Kroger search failed", true);
          } finally {
            if (btn) {
              btn.disabled = false;
              btn.textContent = "🔍 Search";
            }
          }
        };

        document.querySelectorAll(".kroger-item-select").forEach((sel) => {
          sel.addEventListener("change", () => {
            updateRowThumb(sel.dataset.itemId, sel.value);
            saveCandidatePref(sel.dataset.itemId, sel.value);
          });
        });

        document.querySelectorAll(".kroger-retry-search-btn").forEach((btn) => {
          btn.addEventListener("click", () => runItemSearch(btn.dataset.itemId));
        });
        document.querySelectorAll(".kroger-search-input").forEach((inp) => {
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runItemSearch(inp.dataset.itemId);
            }
          });
        });
        document.querySelectorAll(".kroger-item-check").forEach((chk) => {
          chk.addEventListener("change", refreshKrogerPushBtn);
        });

        document.getElementById("kroger-cart-cancel-btn")?.addEventListener("click", close);

        document.getElementById("kroger-oauth-connect-btn")?.addEventListener("click", async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = "Redirecting...";
          try {
            const oauth = await api("/api/kroger/oauth/start");
            if (oauth?.authorize_url) window.location.href = oauth.authorize_url;
          } catch (err) {
            btn.disabled = false;
            btn.textContent = "Connect Kroger Account";
            const errEl = document.getElementById("kroger-modal-error");
            if (errEl) {
              errEl.textContent = err.message || "Could not start Kroger OAuth login.";
              errEl.style.display = "block";
            }
          }
        });

        document.getElementById("kroger-push-submit-btn")?.addEventListener("click", async (ev) => {
          const pushBtn = ev.currentTarget;
          const errEl = document.getElementById("kroger-modal-error");
          if (errEl) errEl.style.display = "none";

          const selected = [];
          document.querySelectorAll(".kroger-item-check").forEach((chk) => {
            if (!chk.checked) return;
            const id = chk.dataset.itemId;
            const sel = document.querySelector(`.kroger-item-select[data-item-id="${id}"]`);
            const qtyEl = document.querySelector(`.kroger-item-qty[data-item-id="${id}"]`);
            const upc = sel?.value?.trim() || "";
            const qty = Math.max(1, parseInt(qtyEl?.value || "1", 10) || 1);
            if (upc) selected.push({ upc, quantity: qty });
          });

          if (!selected.length) {
            toast("Select at least one matched Kroger item to add.");
            return;
          }

          const modality = document.getElementById("kroger-modality-select")?.value || "PICKUP";
          pushBtn.disabled = true;
          pushBtn.textContent = "Sending to Kroger Cart...";
          try {
            const res = await api("/api/kroger/push-cart", {
              method: "POST",
              body: { modality, items: selected },
            });
            await refreshAllListsAndActive();
            close();
            render();
            toast(`Added ${res.added_count} item${res.added_count === 1 ? "" : "s"} to your Kroger ${modality.toLowerCase()} cart!`);
          } catch (err) {
            pushBtn.disabled = false;
            pushBtn.textContent = "🛒 Add Selected to Cart";
            if (errEl) {
              errEl.textContent = err.message || "Could not push items to Kroger cart.";
              errEl.style.display = "block";
            }
          }
        });
      } catch (err) {
        bodyEl.innerHTML = `
          <div class="stack-md">
            <p style="color: #b91c1c;">${esc(err.message || "Failed to load Kroger product preview.")}</p>
            <div class="row" style="justify-content: flex-end; gap: 8px;">
              <button class="btn" id="kroger-err-close-btn" type="button">Close</button>
              <button class="btn btn-primary" id="kroger-err-settings-btn" type="button">Check Kroger Settings</button>
            </div>
          </div>
        `;
        document.getElementById("kroger-err-close-btn")?.addEventListener("click", close);
        document.getElementById("kroger-err-settings-btn")?.addEventListener("click", () => {
          close();
          state.settingsTab = "kroger";
          if (typeof navigate === "function") navigate("settings");
        });
      }
    });
  }

  async function submitNewItem(itemPayload, prevQtyMap) {
    if (isAddingItem) return;
    isAddingItem = true;
    const submitBtn = document.getElementById("quick-add-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Adding...";
    }

    try {
      const res = await api(`/api/lists/${activeList.id}/items`, {
        method: "POST",
        body: itemPayload,
      });
      const added = res.last_added;
      activeList = res;
      lists = await api("/api/lists");
      justAddedItemId = added?.id || null;
      quickAddDraft = { text: "", qty: "", unit: "", dept: "", notes: "" };
      render();
      setTimeout(() => { justAddedItemId = null; }, 2200);

      if (added) {
        const qtyStr = isWeightUnit(added.buy_unit)
          ? `${fmtQty(added.buy_qty)} ${added.buy_unit}`
          : `${fmtQty(added.buy_qty)}×`;
        const aisleSuffix = added.aisle ? ` · Aisle ${added.aisle}` : "";
        const prevQty = prevQtyMap.get(added.id);
        toastAction(
          `${added.merged ? "Updated" : "Added"} ${qtyStr} ${added.name} → ${added.department}${aisleSuffix}`,
          "Undo",
          async () => {
            if (added.merged && prevQty !== undefined) {
              activeList = await api(`/api/lists/${activeList.id}/items/${added.id}`, {
                method: "PATCH",
                body: { buy_qty: prevQty },
              });
            } else {
              activeList = await api(`/api/lists/${activeList.id}/items/${added.id}`, { method: "DELETE" });
            }
            lists = await api("/api/lists");
            render();
            toast(`Undid "${added.name}"`);
          }
        );
      }

      if (window.innerWidth >= 720) {
        document.getElementById("quick-add-input")?.focus();
      }
    } catch (err) {
      toast(err.message || "Could not add item", true);
    } finally {
      isAddingItem = false;
      const btn = document.getElementById("quick-add-submit-btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add";
      }
    }
  }

  function bindEvents(allDepts) {
    document.querySelectorAll(".list-tab").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.activeListId = Number(btn.dataset.listId);
        activeList = await api(`/api/lists/${state.activeListId}`);
        render();
      });
    });

    document.getElementById("template-list-btn")?.addEventListener("click", openStaplesModal);
    document.getElementById("open-add-staples-btn")?.addEventListener("click", openStaplesModal);

    document.getElementById("kroger-aisles-btn")?.addEventListener("click", async () => {
      if (!activeList) return;
      if (!krogerStatus?.configured || !activeList.store?.kroger_location_id) {
        openKrogerSetupPromptModal("auto-map store aisles");
        return;
      }
      isSyncingStore = true;
      render();
      try {
        const res = await api(`/api/kroger/auto-aisles/${activeList.id}`, { method: "POST", body: {} });
        await refreshAllListsAndActive();
        isSyncingStore = false;
        render();
        toast(`Mapped aisles for ${res.updated_count} of ${res.total_unchecked} items at ${res.location_name || "Kroger"}!`);
      } catch (err) {
        isSyncingStore = false;
        render();
        toast(err.message || "Could not map Kroger aisles.", true);
      }
    });

    document.getElementById("kroger-cart-btn")?.addEventListener("click", openKrogerCartModal);

    document.getElementById("quick-load-template-btn")?.addEventListener("click", async () => {
      activeList = await api(`/api/lists/${activeList.id}/apply-template`, {
        method: "POST",
        body: {},
      });
      lists = await api("/api/lists");
      render();
      toast(`Loaded active staples into ${activeList.name}!`);
    });

    document.getElementById("reorder-lists-btn")?.addEventListener("click", () => {
      let ordered = [...lists];
      const renderOrderBody = () => `
        <div class="stack-md">
          <p class="small muted" style="margin: 0;">Move shopping list tabs up or down to change their order on the top bar.</p>
          <div class="stack-sm">
            ${ordered.map((l, idx) => `
              <div class="row" style="justify-content: space-between; padding: 8px 10px; background: var(--bg); border-radius: 9px;">
                <span><strong>${idx + 1}.</strong> ${esc(l.name)}</span>
                <div class="row" style="gap: 4px;">
                  <button class="btn btn-sm move-list-up" data-idx="${idx}" ${idx === 0 ? "disabled" : ""}>↑</button>
                  <button class="btn btn-sm move-list-down" data-idx="${idx}" ${idx === ordered.length - 1 ? "disabled" : ""}>↓</button>
                </div>
              </div>
            `).join("")}
          </div>
          <button class="btn btn-primary" id="save-list-order-btn">Save Tab Order</button>
        </div>
      `;
      openModal("Reorder Shopping List Tabs", renderOrderBody(), (close) => {
        const bindOrder = () => {
          document.querySelectorAll(".move-list-up").forEach((b) => {
            b.addEventListener("click", () => {
              const i = Number(b.dataset.idx);
              [ordered[i - 1], ordered[i]] = [ordered[i], ordered[i - 1]];
              document.getElementById("modal-body").innerHTML = renderOrderBody();
              bindOrder();
            });
          });
          document.querySelectorAll(".move-list-down").forEach((b) => {
            b.addEventListener("click", () => {
              const i = Number(b.dataset.idx);
              [ordered[i + 1], ordered[i]] = [ordered[i], ordered[i + 1]];
              document.getElementById("modal-body").innerHTML = renderOrderBody();
              bindOrder();
            });
          });
          document.getElementById("save-list-order-btn")?.addEventListener("click", async () => {
            lists = await api("/api/lists/reorder", {
              method: "POST",
              body: { list_ids: ordered.map((x) => x.id) },
            });
            close();
            render();
            toast("List tab order saved!");
          });
        };
        bindOrder();
      });
    });

    document.getElementById("new-list-btn")?.addEventListener("click", () => {
      openModal("Create Shopping List", `
        <form id="create-list-form" class="stack-md">
          <div>
            <label class="field-label">List Name</label>
            <input class="input" name="name" placeholder="e.g. Quick Stop - Bananas & Milk" required />
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">List Type</label>
              <select class="select" name="list_type">
                <option value="one_off">One-Off Trip</option>
                <option value="weekly">Weekly Grocery Trip</option>
                <option value="store">Dedicated Store List</option>
              </select>
            </div>
            <div>
              <label class="field-label">Default Store</label>
              <select class="select" name="store_id">
                <option value="">No specific store</option>
                ${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div>
            <label class="field-label">Position on Top Bar (1 = First, blank = End)</label>
            <input class="input" name="position" type="number" min="1" max="${lists.length + 1}" placeholder="${lists.length + 1}" />
          </div>
          <button class="btn btn-primary" type="submit">Create List</button>
        </form>
      `, (close) => {
        document.getElementById("create-list-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const created = await api("/api/lists", {
            method: "POST",
            body: {
              name: f.name.value,
              list_type: f.list_type.value,
              store_id: f.store_id.value ? Number(f.store_id.value) : null,
              position: f.position.value ? Number(f.position.value) : null,
            },
          });
          lists = await api("/api/lists");
          state.activeListId = created.id;
          activeList = created;
          close();
          render();
          toast(`Created "${created.name}"`);
        });
      });
    });

    // Issue #7: Automatically sync Kroger aisles or clear aisles on store switch
    document.getElementById("list-store-select")?.addEventListener("change", async (e) => {
      const storeId = e.target.value ? Number(e.target.value) : null;
      isSyncingStore = true;
      render();
      try {
        activeList = await api(`/api/lists/${activeList.id}`, {
          method: "PATCH",
          body: { store_id: storeId },
        });
        lists = await api("/api/lists");
        isSyncingStore = false;
        render();
        const syncInfo = activeList.store_sync || {};
        if (syncInfo.synced) {
          toast(`Switched to ${activeList.store?.name || "store"} · synced ${syncInfo.updated_count} aisles`);
        } else if (activeList.store?.name) {
          toast(`Switched to ${activeList.store.name}`);
        } else {
          toast("Cleared store selection & aisles");
        }
      } catch (err) {
        isSyncingStore = false;
        render();
        toast(err.message || "Could not switch store", true);
      }
    });

    document.getElementById("delete-list-btn")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${activeList.name}"?`)) return;
      await api(`/api/lists/${activeList.id}`, { method: "DELETE" });
      lists = await api("/api/lists");
      state.activeListId = lists[0]?.id || null;
      activeList = state.activeListId ? await api(`/api/lists/${state.activeListId}`) : null;
      render();
      toast("List deleted");
    });

    document.getElementById("clear-all-list-btn")?.addEventListener("click", async () => {
      const count = (activeList.items || []).length;
      if (!confirm(`Clear all ${count} item${count === 1 ? "" : "s"} from "${activeList.name}"? You will have to re-input them once deleted.`)) {
        return;
      }
      activeList = await api(`/api/lists/${activeList.id}/clear-all`, { method: "POST" });
      lists = await api("/api/lists");
      render();
      toast(`Cleared "${activeList.name}"`);
    });

    const handleClearChecked = async () => {
      activeList = await api(`/api/lists/${activeList.id}/clear-checked`, { method: "POST" });
      lists = await api("/api/lists");
      render();
      toast("Cleared checked items");
    };
    document.getElementById("clear-checked-btn")?.addEventListener("click", handleClearChecked);
    document.getElementById("clear-checked-menu-btn")?.addEventListener("click", handleClearChecked);

    // Quick add & Details drawer (Issues #4 & #6)
    const input = document.getElementById("quick-add-input");
    const sugBox = document.getElementById("suggestions-box");
    let sugTimer = null;

    const captureDraft = () => {
      if (input) quickAddDraft.text = input.value;
      const dq = document.getElementById("detail-qty-input");
      const du = document.getElementById("detail-unit-input");
      const dd = document.getElementById("detail-dept-select");
      const dn = document.getElementById("detail-notes-input");
      if (dq) quickAddDraft.qty = dq.value;
      if (du) quickAddDraft.unit = du.value;
      if (dd) quickAddDraft.dept = dd.value;
      if (dn) quickAddDraft.notes = dn.value;
    };

    document.getElementById("quick-add-details-btn")?.addEventListener("click", () => {
      captureDraft();
      quickAddDetailsOpen = !quickAddDetailsOpen;
      render();
      if (quickAddDetailsOpen) {
        document.getElementById("detail-qty-input")?.focus();
      } else {
        document.getElementById("quick-add-input")?.focus();
      }
    });

    document.querySelectorAll("[data-quick-unit]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const val = chip.dataset.quickUnit ?? "";
        const unitInp = document.getElementById("detail-unit-input");
        if (unitInp) unitInp.value = val;
        quickAddDraft.unit = val;
        document.querySelectorAll("[data-quick-unit]").forEach((c) => {
          c.classList.toggle("active", (c.dataset.quickUnit ?? "") === val);
        });
      });
    });

    input?.addEventListener("input", () => {
      quickAddDraft.text = input.value;
      updateParsedPreview();
      clearTimeout(sugTimer);
      const q = input.value.trim();
      if (q.length < 2) {
        sugBox.style.display = "none";
        return;
      }
      sugTimer = setTimeout(async () => {
        try {
          const storeParam = activeList.store_id ? `&store_id=${activeList.store_id}` : "";
          const sugs = await api(`/api/lists/suggestions?q=${encodeURIComponent(q)}${storeParam}`);
          if (!sugs.length) {
            sugBox.style.display = "none";
            return;
          }
          sugBox.innerHTML = sugs.map((s, idx) => `
            <button type="button" class="suggestion-row" data-idx="${idx}">
              <span>
                <strong>${esc(s.name)}</strong>
                ${s.buy_unit ? `<span class="muted small">${esc(s.buy_unit)}</span>` : ""}
              </span>
              <span class="badge">${esc(s.aisle ? `Aisle ${s.aisle}` : s.department)}</span>
            </button>
          `).join("");
          sugBox.style.display = "block";
          sugBox.querySelectorAll(".suggestion-row").forEach((row) => {
            row.addEventListener("click", async () => {
              captureDraft();
              const s = sugs[Number(row.dataset.idx)];
              const parsed = previewParseInput(input.value);
              const detailQty = quickAddDetailsOpen && quickAddDraft.qty ? Number(quickAddDraft.qty) : null;
              const detailUnit = quickAddDetailsOpen ? quickAddDraft.unit.trim() : "";
              const finalQty = detailQty || parsed?.qty || 1;
              const finalUnit = detailUnit || parsed?.unit || s.buy_unit || "";
              const finalDept = (quickAddDetailsOpen && quickAddDraft.dept) ? quickAddDraft.dept : s.department;
              const finalNotes = quickAddDetailsOpen ? quickAddDraft.notes.trim() : "";
              const prevQtyMap = new Map((activeList?.items || []).filter((i) => !i.checked).map((i) => [i.id, i.buy_qty]));
              sugBox.style.display = "none";
              await submitNewItem({
                name: s.name,
                buy_qty: finalQty,
                buy_unit: finalUnit,
                department: finalDept,
                aisle: s.aisle,
                notes: finalNotes,
              }, prevQtyMap);
            });
          });
        } catch {
          sugBox.style.display = "none";
        }
      }, 170);
    });

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sugBox) {
        sugBox.style.display = "none";
      }
    });

    document.getElementById("quick-add-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      captureDraft();
      const val = quickAddDraft.text.trim();
      if (!val) return;
      if (sugBox) sugBox.style.display = "none";

      const prevQtyMap = new Map((activeList?.items || []).filter((i) => !i.checked).map((i) => [i.id, i.buy_qty]));
      const payload = { name: val };
      if (quickAddDetailsOpen) {
        if (quickAddDraft.qty && Number(quickAddDraft.qty) > 0) payload.buy_qty = Number(quickAddDraft.qty);
        if (quickAddDraft.unit.trim()) payload.buy_unit = quickAddDraft.unit.trim();
        if (quickAddDraft.dept) payload.department = quickAddDraft.dept;
        if (quickAddDraft.notes.trim()) payload.notes = quickAddDraft.notes.trim();
      }
      await submitNewItem(payload, prevQtyMap);
    });

    document.getElementById("toggle-checked-btn")?.addEventListener("click", () => {
      showChecked = !showChecked;
      state.showChecked = showChecked;
      render();
    });

    // Item row actions
    container.querySelectorAll(".item-row").forEach((rowEl) => {
      const itemId = Number(rowEl.dataset.itemId);
      const item = activeList.items.find((i) => i.id === itemId);
      if (!item) return;

      rowEl.querySelector('[data-action="toggle"]')?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (!item.checked) {
          btn.classList.add("animating");
          btn.innerHTML = ICONS.check;
          rowEl.classList.add("checking-stage-1");

          const patchPromise = api(`/api/lists/${activeList.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: true },
          });

          await new Promise((r) => setTimeout(r, 340));
          rowEl.classList.add("flying-to-bottom");
          await new Promise((r) => setTimeout(r, 440));

          activeList = await patchPromise;
          lists = await api("/api/lists");
          render();
        } else {
          activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: false },
          });
          lists = await api("/api/lists");
          render();
        }
      });

      rowEl.querySelector('[data-action="delete-item"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, { method: "DELETE" });
        lists = await api("/api/lists");
        render();
        toast(`Removed ${item.name}`);
      });

      rowEl.querySelectorAll('[data-action="edit-item"]').forEach((editTrigger) => editTrigger.addEventListener("click", () => {
        const depts = activeList.store?.departments || allDepts;
        const storeName = activeList.store?.name || "Default";
        const isKrogerStore = Boolean(activeList.store?.kroger_location_id);

        openModal(`Edit Item — ${item.name}`, `
          <form id="edit-item-form" class="stack-md">
            <div>
              <label class="field-label">Item Name</label>
              <input class="input" name="name" value="${esc(item.name)}" required />
            </div>
            <div class="grid-2">
              <div>
                <label class="field-label" id="edit-qty-label">${isWeightUnit(item.buy_unit) ? "Weight" : "Buy Quantity"}</label>
                <input class="input" name="buy_qty" type="number" step="any" min="0.01" value="${esc(item.buy_qty)}" required />
              </div>
              <div>
                <label class="field-label">Unit / Package</label>
                <input class="input" name="buy_unit" id="edit-item-unit" value="${esc(item.buy_unit)}" placeholder="e.g. lb, oz, 15 oz can" />
              </div>
            </div>
            <div class="unit-chip-row">
              <span class="small muted" style="font-weight: 700;">Unit:</span>
              ${UNIT_CHIPS.map((c) => `
                <button type="button" class="unit-chip ${c.weight ? "weight" : ""} ${(item.buy_unit || "").toLowerCase() === c.value ? "active" : ""}"
                  data-edit-unit="${esc(c.value)}">${esc(c.label)}</button>
              `).join("")}
            </div>
            <div class="grid-2">
              <div>
                <label class="field-label">Department (${esc(storeName)})</label>
                <select class="select" name="department">
                  ${depts.map((d) => `<option value="${esc(d)}" ${d === item.department ? "selected" : ""}>${esc(d)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Aisle / Bay (${esc(storeName)})</label>
                <input class="input" name="aisle" value="${esc(item.aisle)}" placeholder="e.g. 7 or Bay 12" />
              </div>
            </div>
            <div>
              <label class="field-label">Notes / Acceptable Substitutions</label>
              <input class="input" name="notes" value="${esc(item.notes)}" placeholder="e.g. Organic preferred, 2% OK if out of whole..." />
            </div>

            ${isKrogerStore ? `
              <div class="card stack-sm" style="padding: 10px 12px; background: var(--bg);">
                <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
                  <div class="small">
                    <strong>Kroger Product Match:</strong>
                    ${item.preferred_upc
                      ? `<span>${esc(item.preferred_brand ? item.preferred_brand + " · " : "")}${esc(item.preferred_description)}</span>`
                      : `<span class="muted">Auto-matched (none pinned yet)</span>`}
                  </div>
                  <button class="btn btn-sm" type="button" id="pick-kroger-match-btn">🔍 Pick Exact Product &amp; Brand</button>
                </div>
              </div>
            ` : ""}

            ${activeList.store && !isGuest ? `
              <label class="row small">
                <input type="checkbox" name="save_to_store" checked />
                <span>Remember Department &amp; Aisle for <strong>${esc(storeName)}</strong></span>
              </label>
            ` : ""}
            ${isGuest ? "" : `
              <label class="row small">
                <input type="checkbox" name="save_as_std" />
                <span>Save this Unit/Package as the default <strong>Standard (Std) Size</strong></span>
              </label>
            `}
            <div class="row" style="justify-content: space-between;">
              <button class="btn btn-danger" type="button" id="delete-item-btn">Remove Item</button>
              <button class="btn btn-primary" type="submit">Save Changes</button>
            </div>
          </form>
        `, (close) => {
          document.querySelectorAll("[data-edit-unit]").forEach((chip) => {
            chip.addEventListener("click", () => {
              const val = chip.dataset.editUnit ?? "";
              const inp = document.getElementById("edit-item-unit");
              const lbl = document.getElementById("edit-qty-label");
              if (inp) inp.value = val;
              if (lbl) lbl.textContent = isWeightUnit(val) ? "Weight" : "Buy Quantity";
              document.querySelectorAll("[data-edit-unit]").forEach((c) => {
                c.classList.toggle("active", (c.dataset.editUnit ?? "") === val);
              });
            });
          });

          document.getElementById("pick-kroger-match-btn")?.addEventListener("click", () => {
            close();
            openKrogerProductPickerModal(item);
          });

          document.getElementById("delete-item-btn").addEventListener("click", async () => {
            activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, { method: "DELETE" });
            lists = await api("/api/lists");
            close();
            render();
            toast("Item removed");
          });

          document.getElementById("edit-item-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const f = e.target;
            if (f.save_as_std && f.save_as_std.checked && f.buy_unit.value.trim()) {
              const numMatch = f.buy_unit.value.match(/(\d+(?:\.\d+)?)\s*(fl_oz|oz|lb|g|ml|count|clove|bunch|head)/i);
              const unitOnly = isWeightUnit(f.buy_unit.value.trim()) ? f.buy_unit.value.trim().toLowerCase() : null;
              await api("/api/catalog/upsert-std", {
                method: "POST",
                body: {
                  item_key: item.item_key,
                  display_name: f.name.value.trim(),
                  default_department: f.department.value,
                  package_size: numMatch ? Number(numMatch[1]) : 1,
                  package_unit: numMatch ? numMatch[2].toLowerCase() : (unitOnly || "count"),
                  package_label: f.buy_unit.value.trim(),
                },
              });
            }
            activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, {
              method: "PATCH",
              body: {
                name: f.name.value.trim(),
                buy_qty: Number(f.buy_qty.value),
                buy_unit: f.buy_unit.value.trim(),
                department: f.department.value,
                aisle: f.aisle.value.trim(),
                notes: f.notes.value.trim(),
                save_to_store: f.save_to_store ? f.save_to_store.checked : false,
              },
            });
            lists = await api("/api/lists");
            close();
            render();
            toast("Item updated");
          });
        });
      }));
    });
  }

  render();

  return setInterval(async () => {
    if (document.hidden || document.getElementById("modal-root")?.innerHTML) return;
    if (document.querySelector(".flying-to-bottom, .checking-stage-1")) return;
    if (quickAddDetailsOpen) return;
    const sugBoxEl = document.getElementById("suggestions-box");
    if (sugBoxEl && sugBoxEl.style.display !== "none") return;
    if (Array.from(document.querySelectorAll(".overflow-menu")).some((m) => !m.hidden)) return;
    const focused = document.activeElement;
    if (focused && container.contains(focused) && ["INPUT", "SELECT", "TEXTAREA"].includes(focused.tagName)) return;
    try {
      if (state.activeListId) {
        const fresh = await api(`/api/lists/${state.activeListId}`);
        if (fresh.updated_at !== activeList?.updated_at) {
          activeList = fresh;
          lists = await api("/api/lists");
          render();
        }
      }
    } catch {
      // Ignore transient poll errors
    }
  }, 5000);
}
