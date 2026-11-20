import { api } from "../api.js";
import {
  isShortcutReady,
  launchShortcutLog,
  openLoseItQuickCardModal,
  openShortcutSetupModal,
  renderMacroStrip,
  setShortcutVerifiedFlag,
} from "../nutrition_ui.js";
import {
  bindOverflowMenus,
  esc,
  fmtQty,
  openModal,
  overflowMenu,
  renderQtyOrWeightBadge,
  toast,
} from "../utils.js";

const CALENDAR_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MEAL_SLOTS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
const SLOT_BADGES = { Breakfast: "B", Lunch: "L", Dinner: "D", Snacks: "S" };

function defaultTodayShort() {
  const map = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return map[new Date().getDay()] || "Mon";
}

export async function renderPlannerView(container, state, navigate) {
  if (state.shortcutJustVerified) {
    state.shortcutJustVerified = false;
    try {
      await setShortcutVerifiedFlag(state, true);
      toast("iOS Shortcut verified! 'Log Meals' buttons are now unlocked.");
    } catch {
      // Ignore transient failure
    }
  } else {
    try {
      const scStatus = await api("/api/nutrition/shortcut-status");
      if (state.user) state.user.shortcut_verified = Boolean(scStatus.shortcut_verified);
      if (scStatus.shortcut_verified) {
        localStorage.setItem("pantrycart_shortcut_verified", "1");
      }
    } catch {
      // Ignore transient check
    }
  }

  let [planItems, calendarData, recipes, lists, stapleLists, templateItems] = await Promise.all([
    api("/api/planner"),
    api("/api/planner/calendar"),
    api("/api/recipes"),
    api("/api/lists"),
    api("/api/lists/staple-lists").catch(() => []),
    api("/api/lists/template/items").catch(() => []),
  ]);

  let plannerTab = state.plannerTab || "plan"; // "plan" | "pick"
  let search = "";
  let showCalendar = state.showPlannerCalendar !== false;
  let personFilter = state.plannerPersonFilter || "ALL";
  let selectedDay = state.plannerCalDay || defaultTodayShort();
  let showFullWeekMobile = Boolean(state.plannerFullWeekMobile);

  async function refreshPlannerState() {
    [planItems, calendarData] = await Promise.all([
      api("/api/planner"),
      api("/api/planner/calendar"),
    ]);
  }

  function filterSlotsForPerson(daySlots) {
    if (personFilter === "ALL") return daySlots;
    return daySlots.filter((s) => !s.person_name || s.person_name === "Everyone" || s.person_name === personFilter);
  }

  function sumDayMacros(daySlots) {
    let cal = 0;
    let pro = 0;
    let carb = 0;
    let fat = 0;
    let fib = 0;
    let hasAny = false;
    for (const s of daySlots) {
      if (s.calories !== null && s.calories !== undefined) {
        hasAny = true;
        cal += Number(s.calories) || 0;
        pro += Number(s.protein_g) || 0;
        carb += Number(s.carbs_g) || 0;
        fat += Number(s.fat_g) || 0;
        fib += Number(s.fiber_g) || 0;
      }
    }
    return {
      hasAny,
      calories: Math.round(cal),
      protein_g: Math.round(pro),
      carbs_g: Math.round(carb),
      fat_g: Math.round(fat),
      fiber_g: Math.round(fib),
    };
  }

  function renderDayCard(day, slots, shortcutOk, householdSize) {
    const rawDaySlots = slots.filter((s) => s.day_name === day);
    const orderedDaySlots = [...rawDaySlots].sort(
      (a, b) => MEAL_SLOTS.indexOf(a.meal_slot) - MEAL_SLOTS.indexOf(b.meal_slot) || a.id - b.id
    );
    const activeDaySlots = filterSlotsForPerson(orderedDaySlots);
    const totals = sumDayMacros(activeDaySlots);
    const allDayLogged = activeDaySlots.length > 0 && activeDaySlots.every((s) => Boolean(s.logged_at));
    const logBtnClass = !shortcutOk
      ? "btn-locked"
      : (allDayLogged ? "btn-log-done" : "btn-log-ready");
    const logBtnLabel = !shortcutOk
      ? "🔒"
      : (allDayLogged ? "✓" : "📲");

    return `
      <div class="compact-day-card">
        <div class="compact-day-header">
          <div class="row" style="gap: 6px;">
            <span>${esc(day)}</span>
            ${totals.hasAny ? `<span class="macro-chip cal">${totals.calories} kcal</span>` : ""}
          </div>
          <div class="row" style="gap: 4px;">
            ${activeDaySlots.length > 0 ? `
              <button class="btn btn-sm log-day-btn ${logBtnClass}" data-day="${esc(day)}" type="button"
                style="min-height: 26px; padding: 2px 8px; font-size: 0.74rem;"
                title="${shortcutOk ? `Log ${day}'s macros (${totals.calories} kcal)` : "Setup iOS Shortcut to unlock"}">
                ${logBtnLabel}
              </button>
            ` : ""}
            <button class="btn btn-sm add-cal-slot-btn" data-day="${esc(day)}" data-slot="Dinner" type="button"
              style="min-height: 26px; padding: 2px 9px; font-size: 0.8rem;" title="Add meal to ${esc(day)}">+</button>
          </div>
        </div>

        <div class="compact-day-body">
          ${orderedDaySlots.length === 0 ? `
            <div class="small muted" style="padding: 4px 2px;">Open — tap + to add</div>
          ` : orderedDaySlots.map((entry) => {
            const badge = SLOT_BADGES[entry.meal_slot] || (entry.meal_slot || "M").slice(0, 1).toUpperCase();
            const whoLabel = entry.person_name || "Everyone";
            const perEaSuffix = entry.is_everyone && householdSize > 1 ? "/ea" : "";
            return `
              <div class="compact-slot-row">
                <span class="slot-badge" title="${esc(entry.meal_slot)}">${esc(badge)}</span>
                <div class="grow" style="min-width: 0;">
                  <div class="row-wrap" style="gap: 5px; align-items: baseline;">
                    <span style="font-weight: 700;">${esc(entry.title)}</span>
                    <span class="badge" style="font-size: 0.7rem;">${fmtQty(entry.servings_used)} srv</span>
                    <span class="person-tag">${esc(whoLabel)}</span>
                  </div>
                  ${(entry.calories || entry.notes) ? `
                    <div class="small muted" style="font-size: 0.72rem; margin-top: 2px;">
                      ${entry.calories ? `${Math.round(entry.calories)} kcal${perEaSuffix} · ${Math.round(Number(entry.protein_g || 0))}g P` : ""}
                      ${entry.logged_at ? ` · <strong style="color: var(--primary);">✓ Logged</strong>` : ""}
                      ${entry.notes ? ` · ${esc(entry.notes)}` : ""}
                    </div>
                  ` : ""}
                </div>
                <div class="row" style="gap: 2px; flex-shrink: 0;">
                  <button class="btn btn-sm log-slot-btn ${shortcutOk ? (entry.logged_at ? "btn-log-done" : "btn-log-ready") : "btn-locked"}"
                    data-slot-id="${entry.id}" type="button"
                    style="min-height: 24px; padding: 0 6px; font-size: 0.72rem;"
                    title="${shortcutOk ? "Log meal via iOS Shortcut" : "Setup Shortcut first"}">
                    ${shortcutOk ? (entry.logged_at ? "✓" : "📲") : "🔒"}
                  </button>
                  <button class="btn btn-sm del-cal-slot-btn" data-id="${entry.id}" type="button"
                    style="min-height: 24px; padding: 0 5px; font-size: 0.74rem; border: none; background: transparent; color: var(--text-muted);"
                    title="Remove">✕</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function render() {
    const slots = calendarData?.slots || [];
    const members = calendarData?.household_members || [];
    const householdSize = Number(calendarData?.household_size) || 2;
    const shortcutOk = isShortcutReady(state);
    const isMobile = window.innerWidth < 720;

    const filteredRecipes = recipes.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q));
    });

    const planCountByRecipeId = new Map();
    for (const p of planItems) {
      planCountByRecipeId.set(p.recipe_id, (planCountByRecipeId.get(p.recipe_id) || 0) + 1);
    }

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">This Week</h1>
          <p class="page-subtitle">Pick meals, scale servings, map your week &amp; build your grocery list</p>
        </div>
        <button class="btn btn-primary btn-sm" id="build-list-btn">
          Build List (${planItems.length})
        </button>
      </div>

      <div class="subtabs">
        <button type="button" class="subtab ${plannerTab === "plan" ? "active" : ""}" data-ptab="plan">
          Meal Plan (${planItems.length})
        </button>
        <button type="button" class="subtab ${plannerTab === "pick" ? "active" : ""}" data-ptab="pick">
          Pick Recipes (${recipes.length})
        </button>
      </div>

      ${plannerTab === "plan" ? `
        <div class="stack-md">
          <!-- 1. Compact Menu & Servings Pool -->
          <div class="card stack-sm">
            <div class="row-wrap" style="justify-content: space-between;">
              <h2 style="margin: 0; font-size: 1.04rem;">Menu (${planItems.length})</h2>
              <div class="row" style="gap: 6px;">
                <button type="button" class="btn btn-sm" id="go-pick-recipes-btn">+ Pick Recipes</button>
                ${planItems.length ? `<button class="btn btn-sm btn-danger" id="clear-plan-btn">Clear</button>` : ""}
              </div>
            </div>

            ${planItems.length === 0 ? `
              <div class="empty-state" style="padding: 16px;">
                <p style="margin: 0 0 8px;">No recipes picked for this week yet.</p>
                <p class="small" style="margin: 0;">Tap <strong>+ Pick Recipes</strong> or click <strong>Build List</strong> to add staples.</p>
              </div>
            ` : `
              <div class="stack-sm">
                ${planItems.map((p) => {
                  const rem = Number(p.remaining_servings ?? p.effective_servings);
                  const eff = Number(p.effective_servings);
                  const allPlaced = rem <= 0;
                  return `
                    <div class="menu-compact-row">
                      <div class="row grow" style="min-width: 0;">
                        ${p.image_url ? `<img class="plan-thumb" src="${esc(p.image_url)}" alt="" loading="lazy" />` : ""}
                        <div class="grow" style="min-width: 0;">
                          <div class="row-wrap" style="gap: 6px;">
                            <span style="font-weight: 700;">${esc(p.title)}</span>
                            <span class="servings-pill ${allPlaced ? "done" : ""}">
                              ${allPlaced ? `All ${fmtQty(eff)} placed ✓` : `${fmtQty(rem)} / ${fmtQty(eff)} left`}
                            </span>
                          </div>
                          <div class="row-wrap" style="gap: 6px; margin-top: 3px;">
                            ${renderMacroStrip(p, true)}
                          </div>
                        </div>
                      </div>
                      <div class="row" style="gap: 6px; flex-shrink: 0;">
                        <button class="btn btn-sm plan-schedule-btn" data-plan-id="${p.id}" type="button">+ Day</button>
                        <select class="select plan-scale-select" data-id="${p.id}" style="width: 72px; min-height: 32px; padding: 3px 6px;" title="Batch scale">
                          ${[0.5, 1, 1.5, 2, 3].map((s) => `<option value="${s}" ${Math.abs(s - p.scale) < 0.01 ? "selected" : ""}>${s}x</option>`).join("")}
                        </select>
                        ${overflowMenu([
                          { label: "📋 Lose It! / Macros", data: { "plan-action": "loseit", "recipe-id": p.recipe_id } },
                          { label: "Remove from Menu", danger: true, data: { "plan-action": "remove", "plan-id": p.id } },
                        ], { title: "Meal actions" })}
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            `}
          </div>

          <!-- 2. Compact Weekly Meal Calendar (Issue #8) -->
          <div class="card stack-sm">
            <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
              <div class="row" style="gap: 8px;">
                <h2 style="margin: 0; font-size: 1.04rem;">Meal Calendar</h2>
                <button class="btn btn-sm" id="toggle-calendar-btn" type="button" style="min-height: 28px; padding: 2px 9px;">
                  ${showCalendar ? "Hide" : `Show (${slots.length})`}
                </button>
              </div>
              ${showCalendar ? `
                <div class="row-wrap" style="gap: 6px;">
                  <div class="household-size-stepper" title="How many servings 'Everyone' deducts from a recipe batch">
                    <span class="muted">Everyone =</span>
                    <button type="button" id="hh-dec-btn" ${householdSize <= 1 ? "disabled" : ""}>−</button>
                    <span>${householdSize}</span>
                    <button type="button" id="hh-inc-btn" ${householdSize >= 20 ? "disabled" : ""}>+</button>
                  </div>
                  ${members.length ? `
                    <select class="select" id="person-macro-filter" style="width: auto; min-height: 30px; padding: 3px 8px; font-size: 0.82rem;" title="Filter daily calorie totals">
                      <option value="ALL" ${personFilter === "ALL" ? "selected" : ""}>Totals: All</option>
                      ${members.map((m) => `<option value="${esc(m)}" ${personFilter === m ? "selected" : ""}>${esc(m)}</option>`).join("")}
                    </select>
                  ` : ""}
                  <button class="btn btn-sm ${shortcutOk ? "" : "btn-accent"}" id="setup-shortcut-btn" type="button" style="min-height: 30px; padding: 2px 9px;">
                    ${shortcutOk ? "📲 Shortcut ✓" : "🔒 Shortcut"}
                  </button>
                  ${isMobile ? `
                    <button class="btn btn-sm" id="toggle-mobile-week-btn" type="button" style="min-height: 30px; padding: 2px 9px;">
                      ${showFullWeekMobile ? "1 Day" : "Full Week"}
                    </button>
                  ` : ""}
                  ${overflowMenu([
                    { id: "clear-calendar-btn", label: "Clear Calendar", danger: true, hidden: slots.length === 0 },
                  ], { title: "Calendar options" })}
                </div>
              ` : ""}
            </div>

            ${showCalendar ? `
              ${isMobile && !showFullWeekMobile ? `
                <div class="day-pill-bar">
                  ${CALENDAR_DAYS.map((day) => {
                    const cnt = slots.filter((s) => s.day_name === day).length;
                    return `
                      <button type="button" class="day-pill ${day === selectedDay ? "active" : ""}" data-cal-day="${esc(day)}">
                        <span>${esc(day)}</span>
                        <span class="day-dot">${cnt > 0 ? cnt : "·"}</span>
                      </button>
                    `;
                  }).join("")}
                </div>
                ${renderDayCard(selectedDay, slots, shortcutOk, householdSize)}
              ` : `
                <div class="compact-week-grid">
                  ${CALENDAR_DAYS.map((day) => renderDayCard(day, slots, shortcutOk, householdSize)).join("")}
                </div>
              `}
            ` : ""}
          </div>
        </div>
      ` : `
        <!-- Pick Recipes subtab -->
        <div class="stack-md">
          <input class="input" id="planner-search" value="${esc(search)}" placeholder="Search recipes or tags..." />
          <div class="recipe-grid">
            ${filteredRecipes.map((r) => {
              const inMenuCount = planCountByRecipeId.get(r.id) || 0;
              return `
                <div class="recipe-card">
                  ${r.image_url ? `<img class="recipe-cover" src="${esc(r.image_url)}" alt="${esc(r.title)}" loading="lazy" />` : ""}
                  <div class="row" style="justify-content: space-between; align-items: flex-start;">
                    <h3>${esc(r.title)}</h3>
                    <span class="badge">${fmtQty(r.custom_portions || r.servings)} srv</span>
                  </div>
                  <div class="row-wrap">
                    ${inMenuCount ? `<span class="badge badge-primary">In Menu${inMenuCount > 1 ? ` (${inMenuCount})` : ""} ✓</span>` : ""}
                    ${r.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
                    ${renderMacroStrip(r, true)}
                  </div>
                  <div class="row" style="margin-top: auto; padding-top: 6px; justify-content: space-between;">
                    <span class="small muted">${r.ingredients.length} ingredients</span>
                    <button class="btn btn-primary btn-sm add-plan-btn" data-recipe-id="${r.id}">+ Add to Week</button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `}
    `;

    bindOverflowMenus(container);
    bindEvents(householdSize);
  }

  function openScheduleSlotModal({ defaultDay = "Mon", defaultSlot = "Dinner", defaultPlanItemId = null } = {}) {
    const members = calendarData?.household_members || [];
    const listSnacks = calendarData?.list_and_snack_items || [];
    const householdSize = Number(calendarData?.household_size) || 2;
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
              Menu (${planItems.length})
            </button>
            <button type="button" class="subtab ${sourceMode === "snack" ? "active" : ""}" data-src-mode="snack">
              List &amp; Snacks (${listSnacks.length})
            </button>
            <button type="button" class="subtab ${sourceMode === "custom" ? "active" : ""}" data-src-mode="custom">
              Custom
            </button>
          </div>

          ${sourceMode === "recipe" ? (
            planItems.length ? `
              <select class="select" name="plan_item_id" required>
                ${planItems.map((p) => `
                  <option value="${p.id}" ${p.id === defaultPlanItemId ? "selected" : ""}>
                    ${esc(p.title)} (${fmtQty(p.remaining_servings)} of ${fmtQty(p.effective_servings)} left${p.calories_per_serving ? ` · ${Math.round(p.calories_per_serving)} kcal` : ""})
                  </option>
                `).join("")}
              </select>
            ` : `
              <p class="small muted" style="margin: 0;">No recipes in your Menu yet. Switch to <strong>List &amp; Snacks</strong> or <strong>Custom</strong>.</p>
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
              <p class="small muted" style="margin: 0;">No items on your shopping list or staples yet.</p>
            `
          ) : ""}

          ${sourceMode === "custom" ? `
            <input class="input" name="custom_title" placeholder="e.g. Leftover Soup, Turkey Sandwich, Eating Out..." required />
          ` : ""}
        </div>

        <div class="grid-2">
          <div>
            <label class="field-label">Servings Used</label>
            <input class="input" name="servings_used" id="slot-servings-input" type="number" step="0.5" min="0.5" max="20" value="${householdSize}" required />
            <div id="slot-servings-hint" class="small muted" style="margin-top: 4px;">
              Deducts ${householdSize}× from batch (${fmtQty(1)} srv per person)
            </div>
          </div>
          <div>
            <label class="field-label">Who is eating this?</label>
            <input class="input" name="person_name" id="slot-person-input" placeholder="Blank = Everyone (${householdSize} people)" />
            ${members.length ? `
              <div class="row-wrap" style="gap: 4px; margin-top: 5px;">
                <button type="button" class="badge person-preset-btn" data-person="" style="border: 1px solid var(--border);">Everyone (${householdSize})</button>
                ${members.map((m) => `
                  <button type="button" class="badge badge-primary person-preset-btn" data-person="${esc(m)}" style="border: none;">${esc(m)}</button>
                `).join("")}
              </div>
            ` : ""}
          </div>
        </div>

        <div>
          <label class="field-label">Notes (Optional)</label>
          <input class="input" name="notes" placeholder="e.g. Pack for work lunch..." />
        </div>

        <button class="btn btn-primary" type="submit">Add to Calendar</button>
      </form>
    `;

    openModal("Add to Meal Calendar", renderSlotModal(), (close) => {
      const updateServingsHint = () => {
        const personVal = (document.getElementById("slot-person-input")?.value || "").trim();
        const srvVal = Number(document.getElementById("slot-servings-input")?.value) || 1;
        const hintEl = document.getElementById("slot-servings-hint");
        if (!hintEl) return;
        const isEvery = !personVal || personVal.toLowerCase() === "everyone";
        if (isEvery) {
          hintEl.textContent = `Deducts ${fmtQty(srvVal)}× from batch (${fmtQty(srvVal / householdSize)} srv per person)`;
        } else {
          hintEl.textContent = `Deducts ${fmtQty(srvVal)}× from batch for ${personVal}`;
        }
      };

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
            const personVal = btn.dataset.person || "";
            const pInp = document.getElementById("slot-person-input");
            const sInp = document.getElementById("slot-servings-input");
            if (pInp) pInp.value = personVal;
            if (sInp) sInp.value = personVal ? "1" : String(householdSize);
            updateServingsHint();
          });
        });

        document.getElementById("slot-person-input")?.addEventListener("input", updateServingsHint);
        document.getElementById("slot-servings-input")?.addEventListener("input", updateServingsHint);

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

          selectedDay = f.day_name.value;
          state.plannerCalDay = selectedDay;
          await refreshPlannerState();
          close();
          render();
          toast(`Added to ${f.day_name.value} ${f.meal_slot.value}!`);
        });
      };

      bindSlotModal();
    });
  }

  function bindEvents(householdSize) {
    document.querySelectorAll("[data-ptab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        plannerTab = btn.dataset.ptab;
        state.plannerTab = plannerTab;
        render();
      });
    });

    document.getElementById("go-pick-recipes-btn")?.addEventListener("click", () => {
      plannerTab = "pick";
      state.plannerTab = "pick";
      render();
    });

    document.getElementById("planner-search")?.addEventListener("input", (e) => {
      search = e.target.value;
      render();
      const el = document.getElementById("planner-search");
      el?.focus();
      el?.setSelectionRange(search.length, search.length);
    });

    document.querySelectorAll("[data-cal-day]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedDay = btn.dataset.calDay;
        state.plannerCalDay = selectedDay;
        render();
      });
    });

    document.getElementById("toggle-mobile-week-btn")?.addEventListener("click", () => {
      showFullWeekMobile = !showFullWeekMobile;
      state.plannerFullWeekMobile = showFullWeekMobile;
      render();
    });

    const updateHouseholdSize = async (nextSize) => {
      const clamped = Math.max(1, Math.min(20, nextSize));
      await api("/api/planner/household-size", { method: "PUT", body: { size: clamped } });
      await refreshPlannerState();
      render();
      toast(`Set "Everyone" = ${clamped} servings`);
    };
    document.getElementById("hh-dec-btn")?.addEventListener("click", () => updateHouseholdSize(householdSize - 1));
    document.getElementById("hh-inc-btn")?.addEventListener("click", () => updateHouseholdSize(householdSize + 1));

    document.getElementById("person-macro-filter")?.addEventListener("change", (e) => {
      personFilter = e.target.value;
      state.plannerPersonFilter = personFilter;
      render();
    });

    document.getElementById("setup-shortcut-btn")?.addEventListener("click", () => {
      openShortcutSetupModal(state, () => render());
    });

    document.querySelectorAll('[data-plan-action="loseit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = recipes.find((x) => x.id === Number(btn.dataset.recipeId));
        if (!r) return;
        openLoseItQuickCardModal(r, state, {
          onSaved: async () => {
            recipes = await api("/api/recipes");
            await refreshPlannerState();
            render();
          },
        });
      });
    });

    document.querySelectorAll('[data-plan-action="remove"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/planner/${btn.dataset.planId}`, { method: "DELETE" });
        await refreshPlannerState();
        render();
      });
    });

    document.querySelectorAll(".log-day-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!isShortcutReady(state)) {
          toast("Setup iOS Shortcut first to unlock Log Meals!", true);
          openShortcutSetupModal(state, () => render());
          return;
        }
        const day = btn.dataset.day;
        const daySlots = filterSlotsForPerson((calendarData?.slots || []).filter((s) => s.day_name === day));
        const totals = sumDayMacros(daySlots);
        await api("/api/nutrition/mark-logged", {
          method: "POST",
          body: { slot_ids: daySlots.map((s) => s.id) },
        });
        await refreshPlannerState();
        render();
        toast(`Sending ${day}'s macros (${totals.calories} kcal) to iOS Shortcut...`);
        launchShortcutLog({
          mode: "log",
          day,
          person: personFilter === "ALL" ? "Everyone" : personFilter,
          meals: daySlots.map((s) => s.title).join(", "),
          calories: totals.calories,
          protein_g: totals.protein_g,
          carbs_g: totals.carbs_g,
          fat_g: totals.fat_g,
          fiber_g: totals.fiber_g,
        });
      });
    });

    document.querySelectorAll(".log-slot-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!isShortcutReady(state)) {
          toast("Setup iOS Shortcut first!", true);
          openShortcutSetupModal(state, () => render());
          return;
        }
        const slotId = Number(btn.dataset.slotId);
        const entry = (calendarData?.slots || []).find((s) => s.id === slotId);
        if (!entry) return;
        await api("/api/nutrition/mark-logged", {
          method: "POST",
          body: { slot_ids: [slotId] },
        });
        await refreshPlannerState();
        render();
        launchShortcutLog({
          mode: "log",
          day: entry.day_name,
          meals: entry.title,
          calories: Math.round(entry.calories || 0),
          protein_g: Math.round(Number(entry.protein_g || 0)),
          carbs_g: Math.round(Number(entry.carbs_g || 0)),
          fat_g: Math.round(Number(entry.fat_g || 0)),
          fiber_g: Math.round(Number(entry.fiber_g || 0)),
        });
      });
    });

    document.querySelectorAll(".add-plan-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/planner", {
          method: "POST",
          body: { recipe_id: Number(btn.dataset.recipeId), scale: 1 },
        });
        await refreshPlannerState();
        render();
        toast("Added to Menu");
      });
    });

    document.querySelectorAll(".plan-schedule-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openScheduleSlotModal({
          defaultDay: selectedDay || "Mon",
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
      if (!confirm("Clear all scheduled slots on the Meal Calendar?")) return;
      await api("/api/planner/calendar", { method: "DELETE" });
      await refreshPlannerState();
      render();
      toast("Cleared calendar");
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

    document.getElementById("clear-plan-btn")?.addEventListener("click", async () => {
      if (!confirm("Clear all meals from This Week's Menu?")) return;
      await api("/api/planner", { method: "DELETE" });
      await refreshPlannerState();
      render();
    });

    document.getElementById("build-list-btn")?.addEventListener("click", openPreviewModal);
  }

  async function openPreviewModal() {
    let [preview, freshStapleLists, freshTemplateItems] = await Promise.all([
      api("/api/planner/preview-list", { method: "POST" }),
      api("/api/lists/staple-lists").catch(() => stapleLists),
      api("/api/lists/template/items").catch(() => templateItems),
    ]);
    stapleLists = freshStapleLists || [];
    templateItems = freshTemplateItems || [];

    if (!preview.length && !templateItems.length) {
      toast("Select at least one recipe or configure a Staple List first.", true);
      return;
    }

    let selectedListId = (lists.find((l) => l.list_type === "weekly") || lists[0])?.id || "";

    const pickDefaultStapleList = (listId) => {
      const targetList = lists.find((l) => l.id === Number(listId));
      if (!targetList || !stapleLists.length) return "";
      const lname = (targetList.name || "").toLowerCase();
      const byName = stapleLists.find((sl) => lname.includes(sl.name.toLowerCase()) || sl.name.toLowerCase().includes(lname.split(" ")[0]));
      if (byName) return String(byName.id);
      if (targetList.list_type === "weekly") return String(stapleLists[0].id);
      return "";
    };

    let selectedStapleListVal = pickDefaultStapleList(selectedListId);
    let editingStdIdx = null;
    const stapleEdits = new Map(); // tplId -> { checked, buy_qty, buy_unit, notes }

    const captureStapleEdits = () => {
      document.querySelectorAll(".tpl-prev-check").forEach((chk) => {
        const id = Number(chk.dataset.tplId);
        const qtyEl = document.querySelector(`.tpl-prev-qty[data-tpl-id="${id}"]`);
        const unitEl = document.querySelector(`.tpl-prev-unit[data-tpl-id="${id}"]`);
        const notesEl = document.querySelector(`.tpl-prev-notes[data-tpl-id="${id}"]`);
        stapleEdits.set(id, {
          checked: chk.checked,
          buy_qty: Number(qtyEl?.value) || 1,
          buy_unit: unitEl?.value.trim() ?? "",
          notes: notesEl?.value.trim() ?? "",
        });
      });
    };

    const getVisibleStaples = () => {
      if (!selectedStapleListVal) return [];
      if (selectedStapleListVal === "ALL") return templateItems;
      const slId = Number(selectedStapleListVal);
      return templateItems.filter((t) => t.staple_list_id === slId);
    };

    const buildBodyHtml = () => {
      const regular = preview.filter((x) => !x.is_pantry_staple);
      const pantryStaples = preview.filter((x) => x.is_pantry_staple);
      const visibleStaples = getVisibleStaples();

      const renderRecipeIngRow = (item, idx) => {
        const { badgeHtml, unitPillHtml } = renderQtyOrWeightBadge(item.buy_qty, item.buy_unit);
        return `
          <div style="padding: 8px 0; border-bottom: 1px solid var(--surface-alt);">
            <div class="row" style="align-items: flex-start;">
              <input type="checkbox" class="prev-check" data-idx="${idx}" ${item.include_by_default ? "checked" : ""} style="margin-top: 6px; width: 18px; height: 18px;" />
              <div class="grow">
                <div class="row-wrap" style="gap: 6px;">
                  ${badgeHtml}
                  <span style="font-weight: 700;">${esc(item.name)}</span>
                  ${unitPillHtml}
                  <span class="badge">${esc(item.default_department)}</span>
                </div>
                <div class="small muted">
                  ${esc(item.needed_summary || `Std: ${item.package_label}`)}
                  <button type="button" class="btn-link-inline edit-std-btn" data-idx="${idx}" title="Change store's standard package size">
                    ✎ Edit Std
                  </button>
                </div>
                <div class="small muted">For: ${esc(item.source_recipes.join(", "))}</div>
              </div>
              <div class="row" style="gap: 4px; width: 150px; flex-shrink: 0;">
                <input class="input prev-qty" data-idx="${idx}" type="number" step="any" min="0.01" value="${esc(item.buy_qty)}" style="width: 64px; min-height: 34px; padding: 4px 6px;" />
                <input class="input prev-unit" data-idx="${idx}" value="${esc(item.buy_unit)}" style="min-height: 34px; padding: 4px 6px; font-size: 0.8rem;" />
              </div>
            </div>

            ${editingStdIdx === idx ? `
              <div class="card stack-sm" style="margin-top: 8px; padding: 10px; background: var(--accent-soft); border-color: #fcd34d;">
                <div class="small" style="font-weight: 700; color: #92400e;">
                  Update Standard (Std) Package Size for "${esc(item.name)}"
                </div>
                <div class="row-wrap">
                  <input class="input" id="std-size-input" type="number" step="0.01" min="0.01" value="${esc(item.package_size)}" style="width: 82px; min-height: 32px;" />
                  <select class="select" id="std-unit-input" style="width: 92px; min-height: 32px;">
                    ${["oz", "fl_oz", "lb", "count", "clove", "bunch", "head", "g", "ml", "cup", "tbsp"].map((u) => `
                      <option value="${u}" ${u === item.package_unit ? "selected" : ""}>${u}</option>
                    `).join("")}
                  </select>
                  <input class="input grow" id="std-label-input" value="${esc(item.package_label)}" placeholder="e.g. 28 oz can or lb" style="min-height: 32px;" />
                  <button type="button" class="btn btn-primary btn-sm" id="save-std-btn" data-idx="${idx}">Save &amp; Recalc</button>
                </div>
              </div>
            ` : ""}
          </div>
        `;
      };

      return `
        <div class="stack-md">
          <div class="grid-2">
            <div>
              <label class="field-label">Destination Shopping List</label>
              <select class="select" id="target-list-select">
                ${lists.map((l) => `
                  <option value="${l.id}" ${Number(selectedListId) === l.id ? "selected" : ""}>
                    ${esc(l.name)}${l.store_name ? ` (${esc(l.store_name)})` : ""}
                  </option>
                `).join("")}
              </select>
            </div>
            <div>
              <label class="field-label">Add Staples</label>
              <select class="select" id="preview-staple-list-select">
                <option value="" ${selectedStapleListVal === "" ? "selected" : ""}>None (recipes only)</option>
                ${stapleLists.map((sl) => `
                  <option value="${sl.id}" ${selectedStapleListVal === String(sl.id) ? "selected" : ""}>
                    ${esc(sl.name)} (${sl.item_count} items)
                  </option>
                `).join("")}
                ${stapleLists.length > 1 ? `
                  <option value="ALL" ${selectedStapleListVal === "ALL" ? "selected" : ""}>All Staple Lists</option>
                ` : ""}
              </select>
            </div>
          </div>

          ${visibleStaples.length ? `
            <div class="card stack-sm" style="padding: 12px; background: var(--bg);">
              <div class="row-wrap" style="justify-content: space-between;">
                <strong class="small">Editable Staples (${visibleStaples.length})</strong>
                <span class="small muted">Edit quantities/notes for this trip below</span>
              </div>
              <div class="stack-sm">
                ${visibleStaples.map((t) => {
                  const ed = stapleEdits.get(t.id);
                  const chk = ed ? ed.checked : t.is_active;
                  const qty = ed ? ed.buy_qty : t.buy_qty;
                  const unit = ed ? ed.buy_unit : (t.buy_unit || "");
                  const notes = ed ? ed.notes : (t.notes || "");
                  const { badgeHtml } = renderQtyOrWeightBadge(qty, unit);
                  return `
                    <div class="staple-preview-row">
                      <label class="row" style="cursor: pointer;">
                        <input type="checkbox" class="tpl-prev-check" data-tpl-id="${t.id}" ${chk ? "checked" : ""} style="width: 18px; height: 18px;" />
                        <span class="row-wrap grow" style="gap: 6px;">
                          ${badgeHtml}
                          <strong>${esc(t.name)}</strong>
                          <span class="badge">${esc(t.department)}</span>
                        </span>
                      </label>
                      <div class="staple-edit-controls">
                        <input class="input tpl-prev-qty" data-tpl-id="${t.id}" type="number" step="any" min="0.01" value="${esc(qty)}" style="width: 64px; min-height: 30px; padding: 3px 6px; font-size: 0.82rem;" title="Qty or weight" />
                        <input class="input tpl-prev-unit" data-tpl-id="${t.id}" value="${esc(unit)}" placeholder="Unit" style="width: 110px; min-height: 30px; padding: 3px 6px; font-size: 0.82rem;" />
                        <input class="input grow tpl-prev-notes" data-tpl-id="${t.id}" value="${esc(notes)}" placeholder="Optional note..." style="min-width: 130px; min-height: 30px; padding: 3px 6px; font-size: 0.82rem;" />
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          ` : ""}

          ${regular.length ? `
            <div>
              <h4 style="margin: 0 0 6px;">Recipe Ingredients (${regular.length})</h4>
              <div>${regular.map((item) => renderRecipeIngRow(item, preview.indexOf(item))).join("")}</div>
            </div>
          ` : ""}

          ${pantryStaples.length ? `
            <div>
              <h4 style="margin: 8px 0 4px; color: var(--text-muted);">In Pantry Check (${pantryStaples.length})</h4>
              <p class="small muted" style="margin: 0 0 6px;">Unchecked because they're In Stock in Pantry — check if needed.</p>
              <div>${pantryStaples.map((item) => renderRecipeIngRow(item, preview.indexOf(item))).join("")}</div>
            </div>
          ` : ""}

          <label class="row small">
            <input type="checkbox" id="clear-plan-after" />
            <span>Clear "This Week's Menu" after adding</span>
          </label>

          <button class="btn btn-primary" id="confirm-apply-btn">Add Checked Items to List</button>
        </div>
      `;
    };

    openModal("Build Shopping List", buildBodyHtml(), (close) => {
      const bindModalEvents = () => {
        document.getElementById("target-list-select")?.addEventListener("change", (e) => {
          captureStapleEdits();
          selectedListId = e.target.value;
          selectedStapleListVal = pickDefaultStapleList(selectedListId);
          document.getElementById("modal-body").innerHTML = buildBodyHtml();
          bindModalEvents();
        });

        document.getElementById("preview-staple-list-select")?.addEventListener("change", (e) => {
          captureStapleEdits();
          selectedStapleListVal = e.target.value;
          document.getElementById("modal-body").innerHTML = buildBodyHtml();
          bindModalEvents();
        });

        document.querySelectorAll(".edit-std-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            captureStapleEdits();
            const idx = Number(btn.dataset.idx);
            editingStdIdx = editingStdIdx === idx ? null : idx;
            document.getElementById("modal-body").innerHTML = buildBodyHtml();
            bindModalEvents();
          });
        });

        document.getElementById("save-std-btn")?.addEventListener("click", async (e) => {
          captureStapleEdits();
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
          toast(`Updated standard size for ${item.name}`);
        });

        document.getElementById("confirm-apply-btn")?.addEventListener("click", async () => {
          captureStapleEdits();
          const listId = Number(document.getElementById("target-list-select").value);
          const clearAfter = document.getElementById("clear-plan-after").checked;

          const selectedRecipes = [];
          preview.forEach((item, idx) => {
            const chk = document.querySelector(`.prev-check[data-idx="${idx}"]`);
            if (!chk?.checked) return;
            const qtyEl = document.querySelector(`.prev-qty[data-idx="${idx}"]`);
            const unitEl = document.querySelector(`.prev-unit[data-idx="${idx}"]`);
            selectedRecipes.push({
              item_key: item.item_key,
              name: item.name,
              buy_qty: Number(qtyEl.value) || 1,
              buy_unit: unitEl.value.trim(),
              needed_summary: item.needed_summary,
              department: item.default_department,
              source_recipes: item.source_recipes,
            });
          });

          const selectedStapleIds = [];
          const stapleOverrides = [];
          for (const t of getVisibleStaples()) {
            const ed = stapleEdits.get(t.id);
            const checked = ed ? ed.checked : t.is_active;
            if (!checked) continue;
            selectedStapleIds.push(t.id);
            if (ed) {
              stapleOverrides.push({
                id: t.id,
                buy_qty: ed.buy_qty,
                buy_unit: ed.buy_unit,
                notes: ed.notes,
              });
            }
          }

          if (!selectedRecipes.length && !selectedStapleIds.length) {
            toast("Select at least one staple or recipe item to add.", true);
            return;
          }

          if (selectedStapleIds.length) {
            await api(`/api/lists/${listId}/apply-template`, {
              method: "POST",
              body: { item_ids: selectedStapleIds, overrides: stapleOverrides },
            });
          }

          if (selectedRecipes.length) {
            await api("/api/planner/apply-to-list", {
              method: "POST",
              body: { list_id: listId, items: selectedRecipes, clear_plan_after: clearAfter },
            });
          } else if (clearAfter) {
            await api("/api/planner", { method: "DELETE" });
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
