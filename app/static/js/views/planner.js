import { api } from "../api.js";
import { closeModal, esc, fmtQty, openModal, toast } from "../utils.js";

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Weekend"];

export async function renderPlannerView(container, state, navigate) {
  let planItems = await api("/api/planner");
  let recipes = await api("/api/recipes");
  const lists = await api("/api/lists");
  let search = "";

  function render() {
    const filteredRecipes = recipes.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q));
    });

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">What do we want to eat this week?</h1>
          <p class="page-subtitle">Pick your meals, scale servings, and generate a store-sized grocery list</p>
        </div>
        ${planItems.length ? `
          <button class="btn btn-primary" id="build-list-btn">Build Shopping List (${planItems.length} meals)</button>
        ` : ""}
      </div>

      <div class="stack-lg">
        <div class="card stack-md">
          <div class="row" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">This Week's Menu (${planItems.length})</h2>
            ${planItems.length ? `<button class="btn btn-sm btn-danger" id="clear-plan-btn">Clear Menu</button>` : ""}
          </div>

          ${planItems.length === 0 ? `
            <div class="empty-state" style="padding: 20px;">
              <p style="margin: 0 0 6px;">No meals selected for this week yet.</p>
              <p class="small" style="margin: 0;">Pick recipes below to build your weekly grocery trip automatically.</p>
            </div>
          ` : `
            <div class="stack-sm">
              ${planItems.map((p) => `
                <div class="card" style="padding: 12px; background: var(--bg);">
                  <div class="row-wrap" style="justify-content: space-between;">
                    <div class="grow">
                      <div style="font-weight: 700;">${esc(p.title)}</div>
                      <div class="small muted">Makes ${fmtQty(p.effective_servings)} servings ${p.added_by_name ? `· Added by ${esc(p.added_by_name)}` : ""}</div>
                    </div>
                    <div class="row" style="gap: 6px;">
                      <select class="select plan-day-select" data-id="${p.id}" style="width: 96px; min-height: 34px; padding: 4px 8px;">
                        ${DAYS.map((d) => `<option value="${esc(d)}" ${d === p.day_label ? "selected" : ""}>${esc(d || "Any day")}</option>`).join("")}
                      </select>
                      <select class="select plan-scale-select" data-id="${p.id}" style="width: 82px; min-height: 34px; padding: 4px 8px;">
                        ${[0.5, 1, 1.5, 2, 3].map((s) => `<option value="${s}" ${Math.abs(s - p.scale) < 0.01 ? "selected" : ""}>${s}x</option>`).join("")}
                      </select>
                      <button class="btn btn-sm btn-danger plan-remove-btn" data-id="${p.id}" title="Remove">✕</button>
                    </div>
                  </div>
                </div>
              `).join("")}
            </div>
          `}
        </div>

        <div class="stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">Add Recipes to This Week</h2>
            <input class="input" id="planner-search" value="${esc(search)}" placeholder="Search recipes or tags..." style="max-width: 280px;" />
          </div>

          <div class="recipe-grid">
            ${filteredRecipes.map((r) => `
              <div class="recipe-card">
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
        planItems = await api("/api/planner");
        render();
        toast("Added to This Week's Menu");
      });
    });

    document.querySelectorAll(".plan-day-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        await api(`/api/planner/${sel.dataset.id}`, {
          method: "PATCH",
          body: { day_label: sel.value },
        });
        planItems = await api("/api/planner");
      });
    });

    document.querySelectorAll(".plan-scale-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        await api(`/api/planner/${sel.dataset.id}`, {
          method: "PATCH",
          body: { scale: Number(sel.value) },
        });
        planItems = await api("/api/planner");
        render();
      });
    });

    document.querySelectorAll(".plan-remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/planner/${btn.dataset.id}`, { method: "DELETE" });
        planItems = await api("/api/planner");
        render();
      });
    });

    document.getElementById("clear-plan-btn")?.addEventListener("click", async () => {
      if (!confirm("Clear all meals from This Week's Menu?")) return;
      await api("/api/planner", { method: "DELETE" });
      planItems = [];
      render();
    });

    document.getElementById("build-list-btn")?.addEventListener("click", openPreviewModal);
  }

  async function openPreviewModal() {
    const preview = await api("/api/planner/preview-list", { method: "POST" });
    if (!preview.length) {
      toast("Selected recipes have no ingredients yet.", true);
      return;
    }

    const regular = preview.filter((x) => !x.is_pantry_staple);
    const staples = preview.filter((x) => x.is_pantry_staple);

    const renderRow = (item, idx) => `
      <div class="row" style="padding: 8px 0; border-bottom: 1px solid var(--surface-alt); align-items: flex-start;">
        <input type="checkbox" class="prev-check" data-idx="${idx}" ${item.include_by_default ? "checked" : ""} style="margin-top: 6px; width: 18px; height: 18px;" />
        <div class="grow">
          <div style="font-weight: 700;">${esc(item.name)} <span class="badge">${esc(item.default_department)}</span></div>
          <div class="small muted">${esc(item.needed_summary)}</div>
          <div class="small muted">For: ${esc(item.source_recipes.join(", "))}</div>
        </div>
        <div class="row" style="gap: 4px; width: 155px; flex-shrink: 0;">
          <input class="input prev-qty" data-idx="${idx}" type="number" step="0.25" min="0.25" value="${esc(item.buy_qty)}" style="width: 66px; min-height: 34px; padding: 4px 6px;" />
          <input class="input prev-unit" data-idx="${idx}" value="${esc(item.buy_unit)}" style="min-height: 34px; padding: 4px 6px; font-size: 0.8rem;" />
        </div>
      </div>
    `;

    openModal("Generate Shopping List (US Package Sizes)", `
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

        <div>
          <h4 style="margin: 0 0 6px;">Ingredients to Buy (${regular.length})</h4>
          <div>${regular.map((item) => renderRow(item, preview.indexOf(item))).join("")}</div>
        </div>

        ${staples.length ? `
          <div>
            <h4 style="margin: 8px 0 4px; color: var(--text-muted);">Pantry Staples Check (${staples.length})</h4>
            <p class="small muted" style="margin: 0 0 6px;">Unchecked by default — check any item if you're running low.</p>
            <div>${staples.map((item) => renderRow(item, preview.indexOf(item))).join("")}</div>
          </div>
        ` : ""}

        <label class="row small">
          <input type="checkbox" id="clear-plan-after" />
          <span>Clear "This Week's Menu" after adding to shopping list</span>
        </label>

        <button class="btn btn-primary" id="confirm-apply-btn">Add Checked Items to List</button>
      </div>
    `, (close) => {
      document.getElementById("confirm-apply-btn").addEventListener("click", async () => {
        const listId = Number(document.getElementById("target-list-select").value);
        const clearAfter = document.getElementById("clear-plan-after").checked;
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

        if (!selected.length) {
          toast("Select at least one item to add.", true);
          return;
        }

        const res = await api("/api/planner/apply-to-list", {
          method: "POST",
          body: { list_id: listId, items: selected, clear_plan_after: clearAfter },
        });
        state.activeListId = listId;
        close();
        toast(`Added ${res.added} new, merged ${res.merged} existing items!`);
        navigate("lists");
      });
    });
  }

  render();
}
