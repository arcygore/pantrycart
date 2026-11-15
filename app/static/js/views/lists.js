import { api } from "../api.js";
import { ICONS, esc, fmtQty, openModal, toast } from "../utils.js";

export async function renderListsView(container, state, navigate) {
  let lists = await api("/api/lists");
  const stores = await api("/api/stores");
  let templateItems = await api("/api/lists/template/items");
  let krogerStatus = await api("/api/kroger/status").catch(() => null);

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

  function render() {
    const uncheckedItems = (activeList?.items || []).filter((i) => !i.checked);
    const checkedItems = (activeList?.items || []).filter((i) => i.checked);
    const activeTplCount = templateItems.filter((t) => t.is_active).length;
    const storeDepts = activeList?.store?.departments || [];
    const aisleDepts = new Set(activeList?.store?.aisle_departments || ["Dry Goods"]);
    const isAisleDept = (deptName) => {
      const low = (deptName || "").trim().toLowerCase();
      for (const ad of aisleDepts) {
        if (ad.toLowerCase() === low) return true;
      }
      return false;
    };

    // Seed deptGroups strictly in the store's walking-path order first (FB-10)
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

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Shopping Lists</h1>
          <p class="page-subtitle">Automatically grouped by store department &amp; aisle</p>
        </div>
        <div class="row-wrap">
          ${isGuest ? `<span class="badge badge-accent">Guest View</span>` : `
            <button class="btn btn-accent btn-sm" id="template-list-btn">Weekly Template (${activeTplCount})</button>
            <button class="btn btn-sm" id="reorder-lists-btn">Reorder Tabs</button>
            <button class="btn btn-primary btn-sm" id="new-list-btn">+ New List</button>
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
        <div class="card stack-md" style="margin-bottom: 16px;">
          <div class="row-wrap" style="justify-content: space-between;">
            <div class="row" style="gap: 8px; flex-wrap: wrap;">
              <span class="small muted" style="font-weight: 700;">Shopping at:</span>
              <select class="select" id="list-store-select" style="width: auto; min-width: 170px; min-height: 36px;">
                <option value="">No specific store</option>
                ${stores.map((s) => `
                  <option value="${s.id}" ${s.id === activeList.store_id ? "selected" : ""}>${esc(s.name)}</option>
                `).join("")}
              </select>
              <span class="badge">${esc(activeList.list_type === "weekly" ? "Weekly Trip" : activeList.list_type === "store" ? "Dedicated Store" : "One-off")}</span>
              ${activeList.store?.has_custom_path ? `<span class="badge badge-info" title="Using your custom walking path">Your Path</span>` : ""}
              ${krogerStatus?.location_name ? `<span class="badge badge-info" title="Linked Kroger Store">🏪 ${esc(krogerStatus.location_name)}</span>` : ""}
            </div>
            ${isGuest ? "" : `
              <div class="row" style="gap: 6px; flex-wrap: wrap;">
                <button class="btn btn-sm" id="kroger-aisles-btn" title="Auto-fill Kroger store aisles & prices for unchecked items">🧭 Auto-Map Aisles</button>
                <button class="btn btn-sm btn-primary" id="kroger-cart-btn" title="Match items and send directly to your Kroger / Pick 'n Save / Fred Meyer cart">🛒 Send to Kroger Cart</button>
                <button class="btn btn-sm" id="quick-load-template-btn" title="Add active weekly staples to this list">+ Load Weekly Staples</button>
                ${activeList.list_type === "one_off" ? `<button class="btn btn-sm btn-danger" id="delete-list-btn">Delete List</button>` : ""}
              </div>
            `}
          </div>

          <form id="quick-add-form" class="quick-add-wrap">
            <div class="row">
              <input class="input grow" id="quick-add-input" autocomplete="off"
                placeholder="Quick add (e.g. 'bananas', '2 cans black beans', 'M6 bolts')..." />
              <button class="btn btn-primary" type="submit">Add</button>
            </div>
            <div id="suggestions-box" class="suggestions-menu" style="display:none;"></div>
          </form>
        </div>

        ${uncheckedItems.length === 0 ? `
          <div class="card empty-state">
            <p style="font-weight:700; color: var(--text); margin: 0 0 6px;">Nothing left to buy on ${esc(activeList.name)}!</p>
            <p class="small" style="margin: 0 0 12px;">Add items above, click <strong>+ Load Weekly Staples</strong>, or generate from <strong>This Week's Meals</strong>.</p>
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

        <div class="card stack-sm" id="checked-drawer-card" style="margin-top: 16px; ${checkedItems.length === 0 ? "display:none;" : ""}">
          <div class="row" style="justify-content: space-between;">
            <button class="btn btn-sm" id="toggle-checked-btn" type="button">
              ${showChecked ? "Hide" : "Show"} Checked / In Cart (${checkedItems.length})
            </button>
            ${isGuest ? "" : `
              <button class="btn btn-sm btn-danger" id="clear-checked-btn" type="button">
                Clear Checked
              </button>
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

    bindEvents();
  }

  function renderItemRow(item, store, usesAisles = false) {
    const qtyNum = Number(item.buy_qty) || 1;
    const isMulti = qtyNum > 1;
    const recipeText = item.source_recipes?.length ? `For: ${item.source_recipes.join(", ")}` : "";
    const showAislePill = Boolean(store && usesAisles);
    const aisleText = item.aisle ? `Aisle ${item.aisle}` : "+ Aisle";
    const canModify = !isGuest || item.added_by === state.user?.id;
    return `
      <div class="item-row ${item.checked ? "checked" : ""}" data-item-id="${item.id}">
        <button class="check-circle ${item.checked ? "checked" : ""}" data-action="toggle" aria-label="Toggle item">
          ${item.checked ? ICONS.check : ""}
        </button>
        <div class="item-main ${canModify ? "editable" : ""}" ${canModify ? `data-action="edit-item" title="Click to edit item"` : ""}>
          <div class="item-title-line">
            ${canModify ? `
              <span class="qty-stepper" title="Adjust quantity">
                <button class="qty-step-btn" data-action="qty-dec" type="button" aria-label="Decrease quantity">−</button>
                <span class="qty-badge ${isMulti ? "multi" : ""}">${fmtQty(qtyNum)}×</span>
                <button class="qty-step-btn" data-action="qty-inc" type="button" aria-label="Increase quantity">+</button>
              </span>
            ` : `<span class="qty-badge ${isMulti ? "multi" : ""}" title="Quantity">${fmtQty(qtyNum)}×</span>`}
            <span class="item-name">${esc(item.name)}</span>
            ${item.buy_unit ? `<span class="unit-pill">${esc(item.buy_unit)}</span>` : ""}
          </div>
          ${(item.needed_summary || recipeText || item.notes) ? `
            <div class="item-meta">
              ${[item.needed_summary, recipeText, item.notes].filter(Boolean).map(esc).join(" · ")}
            </div>
          ` : ""}
        </div>
        <div class="item-action-btns">
          ${showAislePill ? (canModify ? `
            <button class="aisle-pill ${item.aisle ? "has-aisle" : ""}" data-action="edit-item" title="Set department & aisle for ${esc(store.name)}">
              ${esc(aisleText)}
            </button>
          ` : (item.aisle ? `<span class="badge badge-accent">${esc(aisleText)}</span>` : "")) : ""}
          ${canModify ? `
            <button class="item-icon-btn" data-action="edit-item" type="button" title="Edit item">✎</button>
            <button class="item-icon-btn danger" data-action="delete-item" type="button" title="Remove item">✕</button>
          ` : ""}
        </div>
      </div>
    `;
  }

  function openTemplateManagerModal() {
    let editingTplId = null;
    const allDepts = Array.from(new Set([
      ...(activeList?.store?.departments || []),
      "Produce", "Bakery & Deli", "Meat & Seafood", "Dry Goods",
      "Snacks & Chips", "Beverages", "Frozen", "Dairy & Eggs", "Household & Personal", "Other",
    ]));

    const renderModalBody = () => `
      <div class="stack-md">
        <p class="small muted" style="margin: 0;">
          Configure your recurring weekly essentials (like bananas, chicken tenderloins, salad mixes). Load checked items onto any list in one tap!
        </p>

        <form id="add-tpl-form" class="row-wrap">
          <input class="input grow" name="name" placeholder="Add weekly staple (e.g. Greek Yogurt, Berries)..." required />
          <input class="input" name="buy_qty" type="number" step="0.25" min="0.25" value="1" style="width: 70px;" />
          <input class="input" name="buy_unit" placeholder="Unit/Pack" style="width: 120px;" />
          <button class="btn btn-primary btn-sm" type="submit">+ Add</button>
        </form>

        <div class="stack-sm" style="max-height: 360px; overflow-y: auto;">
          ${templateItems.map((t) => {
            if (editingTplId === t.id) {
              const itemDepts = allDepts.includes(t.department) ? allDepts : [t.department, ...allDepts];
              return `
                <form class="tpl-edit-form stack-sm" data-id="${t.id}" style="padding: 10px; border: 2px solid var(--primary); border-radius: 9px; background: var(--surface-alt);">
                  <div class="row-wrap">
                    <input class="input grow" name="name" value="${esc(t.name)}" placeholder="Item name" required style="min-width: 150px;" />
                    <input class="input" name="buy_qty" type="number" step="0.25" min="0.25" value="${esc(t.buy_qty)}" style="width: 78px;" required />
                    <input class="input" name="buy_unit" value="${esc(t.buy_unit)}" placeholder="Unit (e.g. bunch, 1 lb pack)" style="width: 145px;" />
                  </div>
                  <div class="row-wrap" style="justify-content: space-between;">
                    <select class="select" name="department" style="width: auto; min-width: 170px; min-height: 34px;">
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
            const qNum = Number(t.buy_qty) || 1;
            return `
              <div class="row" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
                <label class="row grow" style="cursor: pointer;">
                  <input type="checkbox" class="tpl-toggle" data-id="${t.id}" ${t.is_active ? "checked" : ""} />
                  <div>
                    <div class="row-wrap" style="gap: 6px;">
                      <span class="qty-badge ${qNum > 1 ? "multi" : ""}">${fmtQty(qNum)}×</span>
                      <span style="font-weight: 700;">${esc(t.name)}</span>
                      ${t.buy_unit ? `<span class="unit-pill">${esc(t.buy_unit)}</span>` : ""}
                    </div>
                    <div class="small muted">${esc(t.department)}</div>
                  </div>
                </label>
                <div class="row" style="gap: 5px;">
                  <button class="btn btn-sm tpl-edit-btn" data-id="${t.id}" type="button" title="Edit template item">Edit</button>
                  <button class="btn btn-sm btn-danger tpl-del-btn" data-id="${t.id}" type="button" title="Delete template item">✕</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        ${activeList ? `
          <button class="btn btn-primary" id="apply-tpl-now-btn" type="button">
            Add Checked Staples to "${esc(activeList.name)}"
          </button>
        ` : ""}
      </div>
    `;

    openModal("Weekly Template List (Recurring Staples)", renderModalBody(), (close) => {
      const bindTplModal = () => {
        document.getElementById("add-tpl-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          await api("/api/lists/template/items", {
            method: "POST",
            body: {
              name: f.name.value.trim(),
              buy_qty: Number(f.buy_qty.value) || 1,
              buy_unit: f.buy_unit.value.trim(),
            },
          });
          templateItems = await api("/api/lists/template/items");
          document.getElementById("modal-body").innerHTML = renderModalBody();
          bindTplModal();
          render();
        });

        document.querySelectorAll(".tpl-toggle").forEach((chk) => {
          chk.addEventListener("change", async () => {
            await api(`/api/lists/template/items/${chk.dataset.id}`, {
              method: "PATCH",
              body: { is_active: chk.checked },
            });
            templateItems = await api("/api/lists/template/items");
            render();
          });
        });

        document.querySelectorAll(".tpl-edit-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
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
              },
            });
            editingTplId = null;
            templateItems = await api("/api/lists/template/items");
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
            render();
            toast("Template item updated!");
          });
        });

        document.querySelectorAll(".tpl-del-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await api(`/api/lists/template/items/${btn.dataset.id}`, { method: "DELETE" });
            templateItems = await api("/api/lists/template/items");
            document.getElementById("modal-body").innerHTML = renderModalBody();
            bindTplModal();
            render();
          });
        });

        document.getElementById("apply-tpl-now-btn")?.addEventListener("click", async () => {
          const activeIds = templateItems.filter((t) => t.is_active).map((t) => t.id);
          if (!activeIds.length) {
            toast("Check at least one template item first", true);
            return;
          }
          activeList = await api(`/api/lists/${activeList.id}/apply-template`, {
            method: "POST",
            body: { item_ids: activeIds },
          });
          lists = await api("/api/lists");
          close();
          render();
          toast(`Added ${activeIds.length} weekly staples to ${activeList.name}!`);
        });
      };
      bindTplModal();
    });
  }

  function openKrogerSetupPromptModal(actionLabel) {
    openModal("Connect Kroger Store First", `
      <div class="stack-md">
        <p class="muted">
          To ${esc(actionLabel)}, configure your Kroger Developer API Client ID & Secret and choose your local Kroger-family store (Kroger, Mariano's, Pick 'n Save, Fred Meyer, Ralphs, King Soopers, Harris Teeter, etc.) in Settings.
        </p>
        <div class="row" style="justify-content: flex-end; gap: 8px;">
          <button class="btn" id="kroger-setup-cancel-btn" type="button">Cancel</button>
          <button class="btn btn-primary" id="kroger-go-settings-btn" type="button">Go to Settings → Kroger API</button>
        </div>
      </div>
    `, (close) => {
      document.getElementById("kroger-setup-cancel-btn")?.addEventListener("click", close);
      document.getElementById("kroger-go-settings-btn")?.addEventListener("click", () => {
        close();
        state.settingsTab = "kroger";
        if (typeof navigate === "function") {
          navigate("settings");
        } else {
          window.location.hash = "#settings?tab=kroger";
        }
      });
    });
  }

  function openKrogerCartModal() {
    if (!activeList) return;
    if (!krogerStatus?.configured || !krogerStatus?.location_id) {
      openKrogerSetupPromptModal("match products and send them to your Kroger cart");
      return;
    }

    openModal(`Send "${activeList.name}" to Kroger Cart`, `
      <div id="kroger-cart-modal-body" class="stack-md">
        <p class="muted">Searching live Kroger catalog at <strong>${esc(krogerStatus.location_name || "your store")}</strong> for unchecked items...</p>
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
              <span class="badge badge-info">🏪 ${esc(preview.location_name || krogerStatus.location_name || "Kroger")}</span>
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
              <div class="small muted">Matched <strong>${matchedCount}</strong> of ${items.length} unchecked list items. Adjust product matches or quantities below before pushing to your cart.</div>
            `}

            <div id="kroger-modal-error" class="small" style="display: none; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; padding: 8px 10px; border-radius: 8px;"></div>

            ${items.length === 0 ? `
              <p class="muted">No unchecked items on this shopping list to send.</p>
            ` : `
              <div class="stack-sm" style="max-height: 360px; overflow-y: auto; padding-right: 4px;">
                ${items.map((it) => {
                  const hasMatches = (it.candidates || []).length > 0;
                  return `
                    <div class="card" style="padding: 10px 12px;">
                      <div class="row" style="gap: 10px; align-items: flex-start;">
                        <input type="checkbox" class="kroger-item-check" data-item-id="${it.list_item_id}"
                          ${hasMatches ? "checked" : "disabled"} style="margin-top: 4px;" />
                        <div class="grow stack-xs">
                          <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
                            <strong>${esc(it.list_item_name)}</strong>
                            <span class="small muted">List need: ${fmtQty(it.quantity)} ${esc(it.buy_unit || "ea")}</span>
                          </div>
                          <div class="row" style="gap: 8px; flex-wrap: wrap;">
                            <select class="select grow kroger-item-select" data-item-id="${it.list_item_id}" ${hasMatches ? "" : "disabled"}>
                              ${hasMatches ? it.candidates.map((c) => {
                                const priceTxt = c.price != null ? ` — $${Number(c.price).toFixed(2)}` : "";
                                const aisleTxt = c.aisle ? ` [${c.aisle}]` : "";
                                const label = `${c.brand ? c.brand + " - " : ""}${c.description}${c.size ? " (" + c.size + ")" : ""}${priceTxt}${aisleTxt}`;
                                return `<option value="${esc(c.upc)}" ${c.upc === it.selected_upc ? "selected" : ""}>${esc(label)}</option>`;
                              }).join("") : `<option value="">No Kroger catalog match found</option>`}
                            </select>
                            <input type="number" min="1" step="1" class="input kroger-item-qty"
                              data-item-id="${it.list_item_id}" value="${Math.max(1, Number(it.quantity) || 1)}"
                              style="width: 72px;" ${hasMatches ? "" : "disabled"} title="Cart quantity" />
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
                🛒 Add Selected to Kroger Cart
              </button>
            </div>
          </div>
        `;

        document.getElementById("kroger-cart-cancel-btn")?.addEventListener("click", close);

        document.getElementById("kroger-oauth-connect-btn")?.addEventListener("click", async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = "Redirecting...";
          try {
            const oauth = await api("/api/kroger/oauth/start");
            if (oauth?.authorize_url) {
              window.location.href = oauth.authorize_url;
            }
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
            close();
            toast(`Added ${res.added_count} item${res.added_count === 1 ? "" : "s"} to your Kroger ${modality.toLowerCase()} cart!`);
          } catch (err) {
            pushBtn.disabled = false;
            pushBtn.textContent = "🛒 Add Selected to Kroger Cart";
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

  function bindEvents() {
    document.querySelectorAll(".list-tab").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.activeListId = Number(btn.dataset.listId);
        activeList = await api(`/api/lists/${state.activeListId}`);
        render();
      });
    });

    document.getElementById("template-list-btn")?.addEventListener("click", openTemplateManagerModal);

    document.getElementById("kroger-aisles-btn")?.addEventListener("click", async (ev) => {
      if (!activeList) return;
      if (!krogerStatus?.configured || !krogerStatus?.location_id) {
        openKrogerSetupPromptModal("auto-map store aisles");
        return;
      }
      const btn = ev.currentTarget;
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Mapping...";
      try {
        const res = await api(`/api/kroger/auto-aisles/${activeList.id}`, {
          method: "POST",
          body: {},
        });
        activeList = await api(`/api/lists/${activeList.id}`);
        lists = await api("/api/lists");
        render();
        toast(`Mapped aisles for ${res.updated_count} of ${res.total_unchecked} items at ${res.location_name || "Kroger"}!`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = orig;
        toast(err.message || "Could not map Kroger aisles.");
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
      toast(`Loaded weekly template items into ${activeList.name}!`);
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

    document.getElementById("list-store-select")?.addEventListener("change", async (e) => {
      const storeId = e.target.value ? Number(e.target.value) : null;
      activeList = await api(`/api/lists/${activeList.id}`, {
        method: "PATCH",
        body: { store_id: storeId },
      });
      lists = await api("/api/lists");
      render();
      toast(`Sorted for ${activeList.store?.name || "default order"}`);
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

    // Quick add & autocomplete
    const input = document.getElementById("quick-add-input");
    const sugBox = document.getElementById("suggestions-box");
    let sugTimer = null;

    input?.addEventListener("input", () => {
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
              <span><strong>${esc(s.name)}</strong> <span class="muted small">${esc(s.buy_unit)}</span></span>
              <span class="badge">${esc(s.aisle ? `Aisle ${s.aisle}` : s.department)}</span>
            </button>
          `).join("");
          sugBox.style.display = "block";
          sugBox.querySelectorAll(".suggestion-row").forEach((row) => {
            row.addEventListener("click", async () => {
              const s = sugs[Number(row.dataset.idx)];
              sugBox.style.display = "none";
              input.value = "";
              activeList = await api(`/api/lists/${activeList.id}/items`, {
                method: "POST",
                body: {
                  name: s.name,
                  buy_qty: 1,
                  buy_unit: s.buy_unit,
                  department: s.department,
                  aisle: s.aisle,
                },
              });
              lists = await api("/api/lists");
              render();
            });
          });
        } catch {
          sugBox.style.display = "none";
        }
      }, 180);
    });

    document.getElementById("quick-add-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      sugBox.style.display = "none";
      activeList = await api(`/api/lists/${activeList.id}/items`, {
        method: "POST",
        body: { name: val },
      });
      lists = await api("/api/lists");
      render();
    });

    document.getElementById("toggle-checked-btn")?.addEventListener("click", () => {
      showChecked = !showChecked;
      state.showChecked = showChecked;
      render();
    });

    document.getElementById("clear-checked-btn")?.addEventListener("click", async () => {
      activeList = await api(`/api/lists/${activeList.id}/clear-checked`, { method: "POST" });
      lists = await api("/api/lists");
      render();
      toast("Cleared checked items");
    });

    // Item row actions
    container.querySelectorAll(".item-row").forEach((rowEl) => {
      const itemId = Number(rowEl.dataset.itemId);
      const item = activeList.items.find((i) => i.id === itemId);
      if (!item) return;

      rowEl.querySelector('[data-action="toggle"]')?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (!item.checked) {
          // FB-03: Satisfying checkmark draw + fly-to-bottom animation!
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

      rowEl.querySelector('[data-action="qty-dec"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        const curQty = Number(item.buy_qty) || 1;
        if (curQty <= 1) {
          if (!confirm(`Remove "${item.name}" from the list?`)) return;
          activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, { method: "DELETE" });
          lists = await api("/api/lists");
          render();
          toast(`Removed ${item.name}`);
          return;
        }
        const nextQty = Math.max(1, Math.round((curQty - 1) * 100) / 100);
        activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, {
          method: "PATCH",
          body: { buy_qty: nextQty },
        });
        lists = await api("/api/lists");
        render();
      });

      rowEl.querySelector('[data-action="qty-inc"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        const curQty = Number(item.buy_qty) || 1;
        const nextQty = Math.round((curQty + 1) * 100) / 100;
        activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, {
          method: "PATCH",
          body: { buy_qty: nextQty },
        });
        lists = await api("/api/lists");
        render();
      });

      rowEl.querySelector('[data-action="delete-item"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        activeList = await api(`/api/lists/${activeList.id}/items/${itemId}`, { method: "DELETE" });
        lists = await api("/api/lists");
        render();
        toast(`Removed ${item.name}`);
      });

      rowEl.querySelectorAll('[data-action="edit-item"]').forEach((editTrigger) => editTrigger.addEventListener("click", () => {
        const depts = activeList.store?.departments || [
          "Produce", "Bakery & Deli", "Meat & Seafood", "Dry Goods",
          "Beverages", "Frozen", "Dairy & Eggs", "Household & Personal", "Other",
        ];
        const storeName = activeList.store?.name || "Default";
        openModal(`Edit Item — ${item.name}`, `
          <form id="edit-item-form" class="stack-md">
            <div>
              <label class="field-label">Item Name</label>
              <input class="input" name="name" value="${esc(item.name)}" required />
            </div>
            <div class="grid-2">
              <div>
                <label class="field-label">Buy Quantity</label>
                <input class="input" name="buy_qty" type="number" step="0.01" min="0.01" value="${esc(item.buy_qty)}" required />
              </div>
              <div>
                <label class="field-label">Unit / Package</label>
                <input class="input" name="buy_unit" value="${esc(item.buy_unit)}" placeholder="e.g. 15 oz can" />
              </div>
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
                <input class="input" name="aisle" value="${esc(item.aisle)}" placeholder="e.g. 7 or 7A or Bay 12" />
              </div>
            </div>
            <div>
              <label class="field-label">Notes</label>
              <input class="input" name="notes" value="${esc(item.notes)}" placeholder="Brand preference, etc." />
            </div>
            ${activeList.store && !isGuest ? `
              <label class="row small">
                <input type="checkbox" name="save_to_store" checked />
                <span>Remember this Department &amp; Aisle for <strong>${esc(storeName)}</strong></span>
              </label>
            ` : ""}
            ${isGuest ? "" : `
              <label class="row small">
                <input type="checkbox" name="save_as_std" />
                <span>Save this Unit/Package label as the default <strong>Standard (Std) Size</strong> for future recipes</span>
              </label>
            `}
            <div class="row" style="justify-content: space-between;">
              <button class="btn btn-danger" type="button" id="delete-item-btn">Remove Item</button>
              <button class="btn btn-primary" type="submit">Save Changes</button>
            </div>
          </form>
        `, (close) => {
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
              await api("/api/catalog/upsert-std", {
                method: "POST",
                body: {
                  item_key: item.item_key,
                  display_name: f.name.value.trim(),
                  default_department: f.department.value,
                  package_size: numMatch ? Number(numMatch[1]) : 1,
                  package_unit: numMatch ? numMatch[2].toLowerCase() : "count",
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
    const focused = document.activeElement;
    if (focused && (focused.id === "quick-add-input" || focused.tagName === "SELECT")) return;
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
