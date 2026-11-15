import { api } from "../api.js";
import { esc, fmtQty, openModal, toast } from "../utils.js";

const CALENDAR_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MEAL_SLOTS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

export async function renderPlannerView(container, state, navigate) {
  let planItems = await api("/api/planner");
  let calendarData = await api("/api/planner/calendar");
  let recipes = await api("/api/recipes");
  const lists = await api("/api/lists");
  let templateItems = await api("/api/lists/template/items");
  let search = "";
  let showCalendar = state.showPlannerCalendar !== false;

  async function refreshPlannerState() {
    [planItems, calendarData] = await Promise.all([
      api("/api/planner"),
      api("/api/planner/calendar"),
    ]);
  }

  function render() {
    const filteredRecipes = recipes.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q));
    });

    const slots = calendarData?.slots || [];

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">What do we want to eat this week?</h1>
          <p class="page-subtitle">Pick your meals, scale servings, optionally map out your week, and generate your grocery list</p>
        </div>
        <button class="btn btn-primary" id="build-list-btn">
          Build Shopping List (${planItems.length} meals + Template)
        </button>
      </div>

      <div class="stack-lg">
        <!-- 1. This Week's Menu & Remaining Servings Pool -->
        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">This Week's Menu &amp; Servings Pool (${planItems.length})</h2>
              <p class="small muted" style="margin: 2px 0 0;">
                Shows how many servings are still available to place on the optional calendar below.
              </p>
            </div>
            ${planItems.length ? `<button class="btn btn-sm btn-danger" id="clear-plan-btn">Clear Menu</button>` : ""}
          </div>

          ${planItems.length === 0 ? `
            <div class="empty-state" style="padding: 20px;">
              <p style="margin: 0 0 6px;">No meals selected for this week yet.</p>
              <p class="small" style="margin: 0;">Pick recipes below or click <strong>Build Shopping List</strong> to start from your Weekly Template staples.</p>
            </div>
          ` : `
            <div class="stack-sm">
              ${planItems.map((p) => {
                const rem = Number(p.remaining_servings ?? p.effective_servings);
                const eff = Number(p.effective_servings);
                const allPlaced = rem <= 0;
                return `
                  <div class="card" style="padding: 12px; background: var(--bg);">
                    <div class="row-wrap" style="justify-content: space-between;">
                      <div class="row grow">
                        ${p.image_url ? `<img class="plan-thumb" src="${esc(p.image_url)}" alt="" loading="lazy" />` : ""}
                        <div class="grow">
                          <div class="row-wrap" style="gap: 8px;">
                            <span style="font-weight: 700;">${esc(p.title)}</span>
                            <span class="servings-pill ${allPlaced ? "done" : ""}">
                              ${allPlaced
                                ? `All ${fmtQty(eff)} servings placed ✓`
                                : `${fmtQty(rem)}x of ${fmtQty(eff)} servings left`}
                            </span>
                          </div>
                          <div class="small muted">
                            Total batch: ${fmtQty(eff)} servings ${p.added_by_name ? `· Added by ${esc(p.added_by_name)}` : ""}
                          </div>
                        </div>
                      </div>
                      <div class="row" style="gap: 6px;">
                        <button class="btn btn-sm plan-schedule-btn" data-plan-id="${p.id}" type="button" title="Place servings on a day/meal slot">
                          + Place on Day
                        </button>
                        <select class="select plan-scale-select" data-id="${p.id}" style="width: 82px; min-height: 34px; padding: 4px 8px;" title="Batch scale">
                          ${[0.5, 1, 1.5, 2, 3].map((s) => `<option value="${s}" ${Math.abs(s - p.scale) < 0.01 ? "selected" : ""}>${s}x</option>`).join("")}
                        </select>
                        <button class="btn btn-sm btn-danger plan-remove-btn" data-id="${p.id}" title="Remove from week">✕</button>
                      </div>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          `}
        </div>

        <!-- 2. Optional Weekly Meal & Snack Calendar (FB-11) -->
        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <div class="row" style="gap: 8px;">
                <h2 style="margin: 0; font-size: 1.08rem;">Weekly Meal &amp; Leftover Calendar</h2>
                <span class="badge">Optional</span>
              </div>
              <p class="small muted" style="margin: 2px 0 0;">
                Plan Breakfast, Lunch, Dinner &amp; Snacks by day. Assign different leftovers to different people or pull snacks from your grocery list.
              </p>
            </div>
            <div class="row" style="gap: 8px;">
              ${slots.length ? `<button class="btn btn-sm btn-danger" id="clear-calendar-btn" type="button">Clear Calendar</button>` : ""}
              <button class="btn btn-sm" id="toggle-calendar-btn" type="button">
                ${showCalendar ? "Hide Calendar" : `Show Calendar (${slots.length})`}
              </button>
            </div>
          </div>

          ${showCalendar ? `
            <div class="calendar-grid">
              ${CALENDAR_DAYS.map((day) => {
                const daySlots = slots.filter((s) => s.day_name === day);
                return `
                  <div class="day-card">
                    <div class="day-card-header">
                      <span>${esc(day)}</span>
                      <span class="small muted" style="font-weight: 600;">${daySlots.length ? `${daySlots.length} planned` : "Open"}</span>
                    </div>
                    ${MEAL_SLOTS.map((mealSlot) => {
                      const slotItems = daySlots.filter((s) => s.meal_slot === mealSlot);
                      return `
                        <div class="meal-slot-section">
                          <div class="meal-slot-header">
                            <span>${esc(mealSlot)}</span>
                            <button class="btn btn-sm add-cal-slot-btn" data-day="${esc(day)}" data-slot="${esc(mealSlot)}" type="button" style="min-height: 22px; padding: 1px 7px; font-size: 0.74rem;">
                              + Add
                            </button>
                          </div>
                          ${slotItems.map((entry) => `
                            <div class="slot-entry">
                              <div class="grow">
                                <div class="row-wrap" style="gap: 5px;">
                                  <span class="qty-badge" style="font-size: 0.72rem; padding: 1px 6px;">${fmtQty(entry.servings_used)} srv</span>
                                  <span style="font-weight: 600;">${esc(entry.title)}</span>
                                  ${entry.person_name ? `<span class="person-tag">${esc(entry.person_name)}</span>` : ""}
                                </div>
                                ${entry.notes ? `<div class="small muted" style="font-size: 0.74rem; margin-top: 2px;">${esc(entry.notes)}</div>` : ""}
                              </div>
                              <button class="btn btn-sm del-cal-slot-btn" data-id="${entry.id}" type="button" style="min-height: 22px; padding: 0 5px; font-size: 0.74rem; border: none; background: transparent; color: var(--text-muted);" title="Remove from slot">✕</button>
                            </div>
                          `).join("")}
                        </div>
                      `;
                    }).join("")}
                  </div>
                `;
              }).join("")}
            </div>
          ` : ""}
        </div>

        <!-- 3. Recipe Picker -->
        <div class="stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">Add Recipes to This Week</h2>
            <input class="input" id="planner-search" value="${esc(search)}" placeholder="Search recipes or tags..." style="max-width: 280px;" />
          </div>

          <div class="recipe-grid">
            ${filteredRecipes.map((r) => `
              <div class="recipe-card">
                ${r.image_url ? `<img class="recipe-cover" src="${esc(r.image_url)}" alt="${esc(r.title)}" loading="lazy" />` : ""}
                <div class="row" style="justify-content: space-between; align-items: flex-start;">
                  <h3>${esc(r.title)}</h3>
                  <span class="badge">${fmtQty(r.servings)} srv</span>
                </div>
                ${r.description ? `<p class="small muted" style="margin: 0;">${esc(r.description)}</p>` : ""}
                <div class="row-wrap">
                  ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
                </div>
                <div class="row" style="margin-top: auto; padding-top: 6px; justify-content: space-between;">
                  <span class="small muted">${r.ingredients.length} ingredients</span>
                  <button class="btn btn-primary btn-sm add-plan-btn" data-recipe-id="${r.id}">+ Add to Week</button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function openScheduleSlotModal({ defaultDay = "Mon", defaultSlot = "Dinner", defaultPlanItemId = null } = {}) {
    const members = calendarData?.household_members || [];
    const listSnacks = calendarData?.list_and_snack_items || [];
    let sourceMode = defaultPlanItemId
      ? "recipe"
      : (defaultSlot === "Snacks" && listSnacks.length ? "snack" : (planItems.length ? "recipe" : (listSnacks.length ? "snack" : "custom")));

    const renderSlotModal = () => `
      <form id="schedule-slot-form" class="stack-md">
        <div class="grid-2">
          <div>
            <label class="field-label">Day of Week</label>
            <select class="select" name="day_name">
              ${CALENDAR_DAYS.map((d) => `<option value="${d}" ${d === defaultDay ? "selected" : ""}>${d}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="field-label">Meal / Section</label>
            <select class="select" name="meal_slot">
              ${MEAL_SLOTS.map((m) => `<option value="${m}" ${m === defaultSlot ? "selected" : ""}>${m}</option>`).join("")}
            </select>
          </div>
        </div>

        <div>
          <label class="field-label">What are you having?</label>
          <div class="subtabs" style="margin-bottom: 10px;">
            <button type="button" class="subtab ${sourceMode === "recipe" ? "active" : ""}" data-src-mode="recipe">
              This Week's Recipes (${planItems.length})
            </button>
            <button type="button" class="subtab ${sourceMode === "snack" ? "active" : ""}" data-src-mode="snack">
              Snacks &amp; List Items (${listSnacks.length})
            </button>
            <button type="button" class="subtab ${sourceMode === "custom" ? "active" : ""}" data-src-mode="custom">
              Custom / Leftover
            </button>
          </div>

          ${sourceMode === "recipe" ? (
            planItems.length ? `
              <select class="select" name="plan_item_id" required>
                ${planItems.map((p) => `
                  <option value="${p.id}" ${p.id === defaultPlanItemId ? "selected" : ""}>
                    ${esc(p.title)} (${fmtQty(p.remaining_servings)}x of ${fmtQty(p.effective_servings)} servings remaining)
                  </option>
                `).join("")}
              </select>
            ` : `
              <p class="small muted" style="margin: 0;">No recipes in This Week's Menu yet. Switch to <strong>Snacks &amp; List Items</strong> or <strong>Custom</strong>.</p>
            `
          ) : ""}

          ${sourceMode === "snack" ? (
            listSnacks.length ? `
              <select class="select" name="snack_title" required>
                ${listSnacks.map((item) => `
                  <option value="${esc(item.name)}">
                    ${esc(item.name)} ${item.department ? `(${esc(item.department)})` : ""}
                  </option>
                `).join("")}
              </select>
            ` : `
              <p class="small muted" style="margin: 0;">No items on your shopping list or weekly template yet.</p>
            `
          ) : ""}

          ${sourceMode === "custom" ? `
            <input class="input" name="custom_title" placeholder="e.g. Leftover Soup, Turkey Sandwich, Eating Out..." required />
          ` : ""}
        </div>

        <div class="grid-2">
          <div>
            <label class="field-label">Servings Used</label>
            <input class="input" name="servings_used" type="number" step="0.5" min="0.5" max="20" value="1" required />
          </div>
          <div>
            <label class="field-label">Who is eating this? (Optional)</label>
            <input class="input" name="person_name" id="slot-person-input" placeholder="Blank = Everyone, or type name (e.g. Ryan, Wife)" />
            ${members.length ? `
              <div class="row-wrap" style="gap: 4px; margin-top: 5px;">
                <button type="button" class="badge person-preset-btn" data-person="" style="border: 1px solid var(--border);">Everyone</button>
                ${members.map((m) => `
                  <button type="button" class="badge badge-primary person-preset-btn" data-person="${esc(m)}" style="border: none;">${esc(m)}</button>
                `).join("")}
              </div>
            ` : ""}
          </div>
        </div>

        <div>
          <label class="field-label">Notes (Optional)</label>
          <input class="input" name="notes" placeholder="e.g. Pack for work lunch, leftover night..." />
        </div>

        <button class="btn btn-primary" type="submit">Add to Calendar</button>
      </form>
    `;

    openModal("Add to Weekly Meal Calendar", renderSlotModal(), (close) => {
      const bindSlotModal = () => {
        document.querySelectorAll("[data-src-mode]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const f = document.getElementById("schedule-slot-form");
            if (f) {
              defaultDay = f.day_name.value;
              defaultSlot = f.meal_slot.value;
            }
            sourceMode = btn.dataset.srcMode;
            document.getElementById("modal-body").innerHTML = renderSlotModal();
            bindSlotModal();
          });
        });

        document.querySelectorAll(".person-preset-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const inp = document.getElementById("slot-person-input");
            if (inp) inp.value = btn.dataset.person || "";
          });
        });

        document.getElementById("schedule-slot-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          let planItemId = null;
          let customTitle = "";

          if (sourceMode === "recipe") {
            if (!f.plan_item_id?.value) {
              toast("Select a recipe first", true);
              return;
            }
            planItemId = Number(f.plan_item_id.value);
          } else if (sourceMode === "snack") {
            customTitle = f.snack_title?.value?.trim() || "";
          } else {
            customTitle = f.custom_title?.value?.trim() || "";
          }

          await api("/api/planner/calendar", {
            method: "POST",
            body: {
              day_name: f.day_name.value,
              meal_slot: f.meal_slot.value,
              plan_item_id: planItemId,
              custom_title: customTitle,
              servings_used: Number(f.servings_used.value) || 1,
              person_name: f.person_name.value.trim(),
              notes: f.notes.value.trim(),
            },
          });

          await refreshPlannerState();
          close();
          render();
          toast(`Added to ${f.day_name.value} ${f.meal_slot.value}!`);
        });
      };

      bindSlotModal();
    });
  }

  function bindEvents() {
    document.getElementById("planner-search")?.addEventListener("input", (e) => {
      search = e.target.value;
      render();
      const el = document.getElementById("planner-search");
      el?.focus();
      el?.setSelectionRange(search.length, search.length);
    });

    document.querySelectorAll(".add-plan-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/planner", {
          method: "POST",
          body: { recipe_id: Number(btn.dataset.recipeId), scale: 1 },
        });
        await refreshPlannerState();
        render();
        toast("Added to This Week's Menu");
      });
    });

    document.querySelectorAll(".plan-schedule-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openScheduleSlotModal({
          defaultDay: "Mon",
          defaultSlot: "Dinner",
          defaultPlanItemId: Number(btn.dataset.planId),
        });
      });
    });

    document.querySelectorAll(".add-cal-slot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openScheduleSlotModal({
          defaultDay: btn.dataset.day,
          defaultSlot: btn.dataset.slot,
        });
      });
    });

    document.querySelectorAll(".del-cal-slot-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/planner/calendar/${btn.dataset.id}`, { method: "DELETE" });
        await refreshPlannerState();
        render();
      });
    });

    document.getElementById("toggle-calendar-btn")?.addEventListener("click", () => {
      showCalendar = !showCalendar;
      state.showPlannerCalendar = showCalendar;
      render();
    });

    document.getElementById("clear-calendar-btn")?.addEventListener("click", async () => {
      if (!confirm("Clear all scheduled slots on the Weekly Meal Calendar?")) return;
      await api("/api/planner/calendar", { method: "DELETE" });
      await refreshPlannerState();
      render();
      toast("Cleared calendar slots");
    });

    document.querySelectorAll(".plan-scale-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        await api(`/api/planner/${sel.dataset.id}`, {
          method: "PATCH",
          body: { scale: Number(sel.value) },
        });
        await refreshPlannerState();
        render();
      });
    });

    document.querySelectorAll(".plan-remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/planner/${btn.dataset.id}`, { method: "DELETE" });
        await refreshPlannerState();
        render();
      });
    });

    document.getElementById("clear-plan-btn")?.addEventListener("click", async () => {
      if (!confirm("Clear all meals from This Week's Menu?")) return;
      await api("/api/planner", { method: "DELETE" });
      await refreshPlannerState();
      render();
    });

    document.getElementById("build-list-btn")?.addEventListener("click", openPreviewModal);
  }

  async function openPreviewModal() {
    let preview = await api("/api/planner/preview-list", { method: "POST" });
    templateItems = await api("/api/lists/template/items");
    const activeTpl = templateItems.filter((t) => t.is_active);
    let editingStdIdx = null;

    if (!preview.length && !activeTpl.length) {
      toast("Select at least one recipe or configure Weekly Template staples first.", true);
      return;
    }

    const buildBodyHtml = () => {
      const regular = preview.filter((x) => !x.is_pantry_staple);
      const staples = preview.filter((x) => x.is_pantry_staple);

      const renderRow = (item, idx) => `
        <div style="padding: 8px 0; border-bottom: 1px solid var(--surface-alt);">
          <div class="row" style="align-items: flex-start;">
            <input type="checkbox" class="prev-check" data-idx="${idx}" ${item.include_by_default ? "checked" : ""} style="margin-top: 6px; width: 18px; height: 18px;" />
            <div class="grow">
              <div class="row-wrap" style="gap: 6px;">
                <span class="qty-badge ${Number(item.buy_qty) > 1 ? "multi" : ""}">${fmtQty(item.buy_qty)}×</span>
                <span style="font-weight: 700;">${esc(item.name)}</span>
                ${item.buy_unit ? `<span class="unit-pill">${esc(item.buy_unit)}</span>` : ""}
                <span class="badge">${esc(item.default_department)}</span>
              </div>
              <div class="small muted">
                ${esc(item.needed_summary || `Std: ${item.package_label}`)}
                <button type="button" class="btn-link-inline edit-std-btn" data-idx="${idx}" title="Change store's standard package size for ${esc(item.name)}">
                  ✎ Edit Std
                </button>
              </div>
              <div class="small muted">For: ${esc(item.source_recipes.join(", "))}</div>
            </div>
            <div class="row" style="gap: 4px; width: 155px; flex-shrink: 0;">
              <input class="input prev-qty" data-idx="${idx}" type="number" step="0.25" min="0.25" value="${esc(item.buy_qty)}" style="width: 66px; min-height: 34px; padding: 4px 6px;" />
              <input class="input prev-unit" data-idx="${idx}" value="${esc(item.buy_unit)}" style="min-height: 34px; padding: 4px 6px; font-size: 0.8rem;" />
            </div>
          </div>

          ${editingStdIdx === idx ? `
            <div class="card stack-sm" style="margin-top: 8px; padding: 10px; background: var(--accent-soft); border-color: #fcd34d;">
              <div class="small" style="font-weight: 700; color: #92400e;">
                Update Standard (Std) Store Package Size for "${esc(item.name)}"
              </div>
              <div class="row-wrap">
                <input class="input" id="std-size-input" type="number" step="0.01" min="0.01" value="${esc(item.package_size)}" style="width: 85px; min-height: 32px;" title="Numeric package size" />
                <select class="select" id="std-unit-input" style="width: 95px; min-height: 32px;">
                  ${["oz", "fl_oz", "lb", "count", "clove", "bunch", "head", "g", "ml", "cup", "tbsp"].map((u) => `
                    <option value="${u}" ${u === item.package_unit ? "selected" : ""}>${u}</option>
                  `).join("")}
                </select>
                <input class="input grow" id="std-label-input" value="${esc(item.package_label)}" placeholder="e.g. 28 oz can" style="min-height: 32px;" />
                <button type="button" class="btn btn-primary btn-sm" id="save-std-btn" data-idx="${idx}">Save &amp; Recalculate</button>
              </div>
            </div>
          ` : ""}
        </div>
      `;

      return `
        <div class="stack-md">
          <div>
            <label class="field-label">Destination Shopping List</label>
            <select class="select" id="target-list-select">
              ${lists.map((l) => `
                <option value="${l.id}" ${l.list_type === "weekly" ? "selected" : ""}>
                  ${esc(l.name)}${l.store_name ? ` (${esc(l.store_name)})` : ""}
                </option>
              `).join("")}
            </select>
          </div>

          ${activeTpl.length ? `
            <div class="card stack-sm" style="padding: 12px; background: var(--bg);">
              <label class="row" style="font-weight: 700; cursor: pointer;">
                <input type="checkbox" id="include-weekly-tpl-chk" checked style="width: 18px; height: 18px;" />
                <span>Include Weekly Template Staples (${activeTpl.length})</span>
              </label>
              <div class="small muted">
                ${activeTpl.map((t) => `${fmtQty(t.buy_qty)}× ${esc(t.name)}${t.buy_unit ? ` (${esc(t.buy_unit)})` : ""}`).join(" · ")}
              </div>
            </div>
          ` : ""}

          ${regular.length ? `
            <div>
              <h4 style="margin: 0 0 6px;">Recipe Ingredients to Buy (${regular.length})</h4>
              <div>${regular.map((item) => renderRow(item, preview.indexOf(item))).join("")}</div>
            </div>
          ` : ""}

          ${staples.length ? `
            <div>
              <h4 style="margin: 8px 0 4px; color: var(--text-muted);">In Pantry / Staples Check (${staples.length})</h4>
              <p class="small muted" style="margin: 0 0 6px;">Unchecked because they are marked In Stock in your Pantry — check any item if you need more.</p>
              <div>${staples.map((item) => renderRow(item, preview.indexOf(item))).join("")}</div>
            </div>
          ` : ""}

          <label class="row small">
            <input type="checkbox" id="clear-plan-after" />
            <span>Clear "This Week's Menu" after adding to shopping list</span>
          </label>

          <button class="btn btn-primary" id="confirm-apply-btn">Add Checked Items to List</button>
        </div>
      `;
    };

    openModal("Generate Shopping List (US Package Sizes)", buildBodyHtml(), (close) => {
      const bindModalEvents = () => {
        document.querySelectorAll(".edit-std-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = Number(btn.dataset.idx);
            editingStdIdx = editingStdIdx === idx ? null : idx;
            document.getElementById("modal-body").innerHTML = buildBodyHtml();
            bindModalEvents();
          });
        });

        document.getElementById("save-std-btn")?.addEventListener("click", async (e) => {
          const idx = Number(e.currentTarget.dataset.idx);
          const item = preview[idx];
          const pkgSize = Number(document.getElementById("std-size-input").value) || 1;
          const pkgUnit = document.getElementById("std-unit-input").value;
          const pkgLabel = document.getElementById("std-label-input").value.trim() || `${pkgSize} ${pkgUnit}`;

          await api("/api/catalog/upsert-std", {
            method: "POST",
            body: {
              item_key: item.item_key,
              display_name: item.name,
              default_department: item.default_department,
              package_size: pkgSize,
              package_unit: pkgUnit,
              package_label: pkgLabel,
            },
          });
          editingStdIdx = null;
          preview = await api("/api/planner/preview-list", { method: "POST" });
          document.getElementById("modal-body").innerHTML = buildBodyHtml();
          bindModalEvents();
          toast(`Updated standard size for ${item.name} to "${pkgLabel}"`);
        });

        document.getElementById("confirm-apply-btn")?.addEventListener("click", async () => {
          const listId = Number(document.getElementById("target-list-select").value);
          const clearAfter = document.getElementById("clear-plan-after").checked;
          const includeTpl = document.getElementById("include-weekly-tpl-chk")?.checked;
          const selected = [];

          preview.forEach((item, idx) => {
            const chk = document.querySelector(`.prev-check[data-idx="${idx}"]`);
            if (!chk?.checked) return;
            const qtyEl = document.querySelector(`.prev-qty[data-idx="${idx}"]`);
            const unitEl = document.querySelector(`.prev-unit[data-idx="${idx}"]`);
            selected.push({
              item_key: item.item_key,
              name: item.name,
              buy_qty: Number(qtyEl.value) || 1,
              buy_unit: unitEl.value.trim(),
              needed_summary: item.needed_summary,
              department: item.default_department,
              source_recipes: item.source_recipes,
            });
          });

          if (!selected.length && !includeTpl) {
            toast("Select at least one item to add.", true);
            return;
          }

          if (includeTpl && activeTpl.length) {
            await api(`/api/lists/${listId}/apply-template`, {
              method: "POST",
              body: { item_ids: activeTpl.map((t) => t.id) },
            });
          }

          if (selected.length) {
            await api("/api/planner/apply-to-list", {
              method: "POST",
              body: { list_id: listId, items: selected, clear_plan_after: clearAfter },
            });
          }

          state.activeListId = listId;
          close();
          toast("Shopping list updated!");
          navigate("lists");
        });
      };

      bindModalEvents();
    });
  }

  render();
}
