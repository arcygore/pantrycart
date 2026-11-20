import { api, apiUpload } from "../api.js";
import { openLoseItQuickCardModal, renderMacroStrip } from "../nutrition_ui.js";
import {
  bindOverflowMenus,
  esc,
  fmtQty,
  openModal,
  overflowMenu,
  toast,
} from "../utils.js";

const VIEW_PREFS_KEY = "pantrycart_recipe_view_prefs";
const DEFAULT_VIEW_PREFS = {
  sort_mode: "custom",
  card_density: "cards",
  show_photos: true,
  show_macros: true,
  show_description: true,
};

function loadCachedViewPrefs() {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) return { ...DEFAULT_VIEW_PREFS, ...JSON.parse(raw) };
  } catch {
    // Ignore storage errors
  }
  return { ...DEFAULT_VIEW_PREFS };
}

function saveCachedViewPrefs(prefs) {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

export async function renderRecipesView(container, state) {
  let [recipes, qData, remotePrefs] = await Promise.all([
    api("/api/recipes"),
    api("/api/recipes/quick-queries").catch(() => ({ queries: [] })),
    api("/api/recipes/view-prefs").catch(() => null),
  ]);

  let viewPrefs = remotePrefs ? { ...DEFAULT_VIEW_PREFS, ...remotePrefs } : loadCachedViewPrefs();
  saveCachedViewPrefs(viewPrefs);

  let quickQueries = Array.isArray(qData?.queries) && qData.queries.length
    ? qData.queries
    : ["Dinner", "Lunch", "Breakfast", "Dessert", "Quick", "High Protein", "Chicken", "Beef", "Vegetarian"];
  let search = "";
  let selectedRecipe = null;
  let cookScale = 1;
  let doneSteps = new Set();
  let showDiff = true;
  let arrangeMode = false;
  const isGuest = Boolean(state.user?.is_guest);

  // FB-21 / FB-22: Automatically backfill missing images & nutrition for URL-imported recipes
  if (!isGuest && !state._recipeSyncAttempted && recipes.some((r) => r.source_url && (!r.image_url || r.calories_per_serving == null))) {
    state._recipeSyncAttempted = true;
    api("/api/recipes/sync-missing-from-url", { method: "POST" }).then(async (res) => {
      if (res?.updated > 0) {
        recipes = await api("/api/recipes");
        if (selectedRecipe) {
          selectedRecipe = recipes.find((x) => x.id === selectedRecipe.id) || selectedRecipe;
        }
        render();
        toast(`Synced missing photo/nutrition for ${res.updated} recipe(s)!`);
      }
    }).catch(() => {});
  }

  function getOrderedRecipes(list) {
    const mode = viewPrefs.sort_mode || "custom";
    const copy = [...list];
    copy.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      if (mode === "alpha") {
        return (a.title || "").localeCompare(b.title || "");
      }
      if (mode === "recent") {
        return String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || b.id - a.id;
      }
      if (mode === "fastest") {
        const ta = (a.prep_minutes || 0) + (a.cook_minutes || 0);
        const tb = (b.prep_minutes || 0) + (b.cook_minutes || 0);
        return (ta > 0 ? ta : 9999) - (tb > 0 ? tb : 9999);
      }
      if (mode === "protein") {
        return (Number(b.protein_g) || 0) - (Number(a.protein_g) || 0);
      }
      // "custom": honor server's pinned + sort_order + updated_at order
      return 0;
    });
    return copy;
  }

  async function togglePinRecipe(recipeId) {
    const r = recipes.find((x) => x.id === recipeId);
    if (!r) return;
    const nextPinned = !r.pinned;
    await api(`/api/recipes/${recipeId}/pin`, {
      method: "POST",
      body: { pinned: nextPinned },
    });
    recipes = await api("/api/recipes");
    if (selectedRecipe?.id === recipeId) {
      selectedRecipe = recipes.find((x) => x.id === recipeId) || selectedRecipe;
    }
    render();
    toast(nextPinned ? `Pinned "${r.title}" to top` : `Unpinned "${r.title}"`);
  }

  async function persistRecipeOrder(orderedIds) {
    await api("/api/recipes/reorder", {
      method: "POST",
      body: { recipe_ids: orderedIds },
    });
    if (viewPrefs.sort_mode !== "custom") {
      viewPrefs = { ...viewPrefs, sort_mode: "custom" };
      saveCachedViewPrefs(viewPrefs);
      await api("/api/recipes/view-prefs", { method: "PUT", body: viewPrefs }).catch(() => {});
    }
    recipes = await api("/api/recipes");
    render();
  }

  function render() {
    if (selectedRecipe) {
      renderDetail(selectedRecipe);
      return;
    }

    const ordered = getOrderedRecipes(recipes);
    const filtered = ordered.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      if (q === "quick") {
        const mins = (r.prep_minutes || 0) + (r.cook_minutes || 0);
        if (mins > 0 && mins <= 35) return true;
      }
      if (q === "high protein" && Number(r.protein_g || 0) >= 25) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)) ||
        r.ingredients.some((i) => i.name.toLowerCase().includes(q)) ||
        (r.description || "").toLowerCase().includes(q)
      );
    });

    const activeQ = search.trim().toLowerCase();
    const isCompact = viewPrefs.card_density === "compact";

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Recipes</h1>
          <p class="page-subtitle">Pin favorites, reorder your page, import URLs &amp; track macros</p>
        </div>
        <div class="row" style="gap: 6px;">
          <button type="button" class="btn btn-sm ${arrangeMode ? "btn-primary" : ""}" id="toggle-arrange-btn" title="Pin &amp; reorder recipes">
            ${arrangeMode ? "✓ Done" : "↕ Arrange"}
          </button>
          ${overflowMenu([
            { id: "customize-recipes-btn", label: "⚙ Customize View" },
            { id: "edit-quick-queries-btn", label: "✎ Edit Filter Chips", hidden: isGuest },
            { id: "bulk-import-recipes-btn", label: "📥 Bulk Import", hidden: isGuest },
          ], { title: "Recipe options" })}
          ${isGuest ? "" : `<button class="btn btn-primary btn-sm" id="add-recipe-hub-btn">+ Add</button>`}
        </div>
      </div>

      <div class="card stack-sm" style="margin-bottom: 14px;">
        <input class="input" id="recipe-search" value="${esc(search)}" placeholder="Search recipes, tags, or ingredients..." />
        <div class="quick-query-bar">
          ${quickQueries.map((qq) => `
            <button type="button" class="quick-query-chip ${activeQ === qq.toLowerCase() ? "active" : ""}" data-query="${esc(qq)}">${esc(qq)}</button>
          `).join("")}
          ${activeQ ? `<button type="button" class="btn btn-sm" id="clear-recipe-filter-btn">Clear</button>` : ""}
        </div>
      </div>

      ${arrangeMode ? `
        <div class="recipe-arrange-bar">
          <span class="small" style="font-weight: 600;">
            Drag cards or use <strong>⬆ Top / ↑ / ↓</strong> to arrange your Recipes page. Pin favorites with 📌.
          </span>
          <button type="button" class="btn btn-sm btn-primary" id="done-arrange-btn">Done Arranging</button>
        </div>
      ` : ""}

      ${filtered.length === 0 ? `
        <div class="card empty-state">
          No recipes match${search.trim() ? ` "${esc(search.trim())}"` : ""}. ${isGuest ? "" : `Tap <strong>+ Add</strong> to import or create one!`}
        </div>
      ` : isCompact ? `
        <div class="recipe-list-compact" id="recipe-arrange-container">
          ${filtered.map((r, idx) => `
            <div class="recipe-compact-row ${r.pinned ? "pinned" : ""}"
              data-recipe-id="${r.id}" ${arrangeMode ? `draggable="true"` : ""}>
              <div class="row grow" style="min-width: 0;">
                ${(viewPrefs.show_photos && r.image_url) ? `<img class="recipe-compact-thumb" src="${esc(r.image_url)}" alt="" loading="lazy" />` : ""}
                <div class="grow" style="min-width: 0;">
                  <div class="row-wrap" style="gap: 6px; align-items: center;">
                    <strong style="font-size: 0.96rem;">${esc(r.title)}</strong>
                    <span class="badge">${fmtQty(r.servings)} srv</span>
                    ${(r.prep_minutes || r.cook_minutes) ? `<span class="badge">${(r.prep_minutes || 0) + (r.cook_minutes || 0)}m</span>` : ""}
                    ${r.is_customized ? `<span class="badge badge-accent">✨</span>` : ""}
                  </div>
                  ${viewPrefs.show_macros ? `<div style="margin-top: 3px;">${renderMacroStrip(r, true)}</div>` : ""}
                </div>
              </div>
              <div class="row" style="gap: 5px; flex-shrink: 0;">
                ${arrangeMode ? `
                  <div class="recipe-move-controls">
                    <button type="button" class="btn btn-sm move-rec-top" data-id="${r.id}" ${idx === 0 ? "disabled" : ""} title="Move to top">⬆</button>
                    <button type="button" class="btn btn-sm move-rec-up" data-id="${r.id}" ${idx === 0 ? "disabled" : ""} title="Move up">↑</button>
                    <button type="button" class="btn btn-sm move-rec-down" data-id="${r.id}" ${idx === filtered.length - 1 ? "disabled" : ""} title="Move down">↓</button>
                  </div>
                ` : `
                  <button type="button" class="pin-btn ${r.pinned ? "active" : ""}" data-pin-id="${r.id}" title="${r.pinned ? "Unpin from top" : "Pin to top"}">📌</button>
                  <button class="btn btn-sm open-recipe-btn" data-id="${r.id}">Open</button>
                  <button class="btn btn-primary btn-sm add-week-btn" data-id="${r.id}">+ Week</button>
                `}
              </div>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="recipe-grid" id="recipe-arrange-container">
          ${filtered.map((r, idx) => `
            <div class="recipe-card ${r.pinned ? "pinned" : ""}"
              data-recipe-id="${r.id}" ${arrangeMode ? `draggable="true"` : ""}>
              ${(viewPrefs.show_photos && r.image_url) ? `<img class="recipe-cover" src="${esc(r.image_url)}" alt="${esc(r.title)}" loading="lazy" />` : ""}
              <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 8px;">
                <h3 class="grow">${esc(r.title)}</h3>
                <button type="button" class="pin-btn ${r.pinned ? "active" : ""}" data-pin-id="${r.id}" title="${r.pinned ? "Unpin from top" : "Pin to top"}">
                  📌${r.pinned ? " Pinned" : ""}
                </button>
              </div>
              ${(viewPrefs.show_description && r.description) ? `<p class="small muted" style="margin: 0;">${esc(r.description)}</p>` : ""}
              <div class="row-wrap">
                <span class="badge">${fmtQty(r.servings)} srv</span>
                ${(r.prep_minutes || r.cook_minutes) ? `<span class="badge">${(r.prep_minutes || 0) + (r.cook_minutes || 0)} min</span>` : ""}
                ${r.is_customized ? `<span class="badge badge-accent">✨ Customized</span>` : ""}
                ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
              </div>
              ${viewPrefs.show_macros ? renderMacroStrip(r, true) : ""}
              ${arrangeMode ? `
                <div class="row" style="margin-top: auto; padding-top: 8px; justify-content: space-between;">
                  <span class="small muted">Drag or move</span>
                  <div class="recipe-move-controls">
                    <button type="button" class="btn btn-sm move-rec-top" data-id="${r.id}" ${idx === 0 ? "disabled" : ""} title="Move to top">⬆ Top</button>
                    <button type="button" class="btn btn-sm move-rec-up" data-id="${r.id}" ${idx === 0 ? "disabled" : ""} title="Move earlier">↑</button>
                    <button type="button" class="btn btn-sm move-rec-down" data-id="${r.id}" ${idx === filtered.length - 1 ? "disabled" : ""} title="Move later">↓</button>
                  </div>
                </div>
              ` : `
                <div class="row" style="margin-top: auto; padding-top: 8px; justify-content: space-between;">
                  <button class="btn btn-sm open-recipe-btn" data-id="${r.id}">View &amp; Cook</button>
                  <button class="btn btn-primary btn-sm add-week-btn" data-id="${r.id}">+ This Week</button>
                </div>
              `}
            </div>
          `).join("")}
        </div>
      `}
    `;

    bindOverflowMenus(container);
    bindListEvents(filtered);
  }

  function bindListEvents(filtered) {
    document.getElementById("recipe-search")?.addEventListener("input", (e) => {
      search = e.target.value;
      render();
      const el = document.getElementById("recipe-search");
      el?.focus();
      el?.setSelectionRange(search.length, search.length);
    });

    document.querySelectorAll(".quick-query-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const q = chip.dataset.query || "";
        search = search.trim().toLowerCase() === q.toLowerCase() ? "" : q;
        render();
      });
    });

    document.getElementById("clear-recipe-filter-btn")?.addEventListener("click", () => {
      search = "";
      render();
    });

    const toggleArrange = () => {
      arrangeMode = !arrangeMode;
      render();
    };
    document.getElementById("toggle-arrange-btn")?.addEventListener("click", toggleArrange);
    document.getElementById("done-arrange-btn")?.addEventListener("click", toggleArrange);

    document.getElementById("customize-recipes-btn")?.addEventListener("click", openCustomizeViewModal);
    document.getElementById("add-recipe-hub-btn")?.addEventListener("click", () => openAddRecipeModal("url"));
    document.getElementById("bulk-import-recipes-btn")?.addEventListener("click", openBulkImportModal);

    document.getElementById("edit-quick-queries-btn")?.addEventListener("click", () => {
      openModal("Edit Recipe Filter Chips", `
        <form id="quick-queries-form" class="stack-md">
          <p class="small muted" style="margin: 0;">
            Enter comma-separated or one-per-line quick filter buttons shown under the Recipes search bar (matches tags, title, ingredients, "Quick" ≤ 35 min, or "High Protein" ≥ 25g).
          </p>
          <textarea class="input" name="queries_text" rows="5" required>${esc(quickQueries.join("\n"))}</textarea>
          <div class="row" style="justify-content: flex-end; gap: 8px;">
            <button class="btn" type="button" id="reset-default-qq-btn">Reset Defaults</button>
            <button class="btn btn-primary" type="submit">Save Filters</button>
          </div>
        </form>
      `, (close) => {
        const defaults = ["Dinner", "Lunch", "Breakfast", "Dessert", "Quick", "High Protein", "Chicken", "Beef", "Vegetarian"];
        document.getElementById("reset-default-qq-btn")?.addEventListener("click", () => {
          document.querySelector("#quick-queries-form textarea[name='queries_text']").value = defaults.join("\n");
        });
        document.getElementById("quick-queries-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const raw = e.target.queries_text.value || "";
          const list = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
          const res = await api("/api/recipes/quick-queries", {
            method: "PUT",
            body: { queries: list },
          });
          quickQueries = res.queries || list;
          close();
          render();
          toast("Recipe filter chips updated!");
        });
      });
    });

    document.querySelectorAll("[data-pin-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePinRecipe(Number(btn.dataset.pinId));
      });
    });

    // Arrange move buttons (works on mobile & desktop)
    const moveVisibleRecipe = async (recipeId, direction) => {
      const visibleIds = filtered.map((r) => r.id);
      const curIdx = visibleIds.indexOf(recipeId);
      if (curIdx < 0) return;
      const nextVisible = [...visibleIds];
      const [moved] = nextVisible.splice(curIdx, 1);
      if (direction === "top") nextVisible.unshift(moved);
      else if (direction === "up" && curIdx > 0) nextVisible.splice(curIdx - 1, 0, moved);
      else if (direction === "down" && curIdx < visibleIds.length - 1) nextVisible.splice(curIdx + 1, 0, moved);
      else return;

      // Merge any hidden (filtered-out) recipes at the end
      const restIds = recipes.map((r) => r.id).filter((id) => !nextVisible.includes(id));
      await persistRecipeOrder([...nextVisible, ...restIds]);
    };

    document.querySelectorAll(".move-rec-top").forEach((b) => {
      b.addEventListener("click", () => moveVisibleRecipe(Number(b.dataset.id), "top"));
    });
    document.querySelectorAll(".move-rec-up").forEach((b) => {
      b.addEventListener("click", () => moveVisibleRecipe(Number(b.dataset.id), "up"));
    });
    document.querySelectorAll(".move-rec-down").forEach((b) => {
      b.addEventListener("click", () => moveVisibleRecipe(Number(b.dataset.id), "down"));
    });

    // Drag & Drop arrangement (desktop)
    if (arrangeMode) {
      let draggedId = null;
      document.querySelectorAll("#recipe-arrange-container [data-recipe-id]").forEach((el) => {
        el.addEventListener("dragstart", (e) => {
          draggedId = Number(el.dataset.recipeId);
          el.classList.add("dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(draggedId));
          }
        });
        el.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (Number(el.dataset.recipeId) !== draggedId) {
            el.classList.add("drag-over");
          }
        });
        el.addEventListener("dragleave", () => {
          el.classList.remove("drag-over");
        });
        el.addEventListener("drop", async (e) => {
          e.preventDefault();
          el.classList.remove("drag-over");
          const targetId = Number(el.dataset.recipeId);
          if (!draggedId || draggedId === targetId) return;
          const visibleIds = filtered.map((r) => r.id);
          const fromIdx = visibleIds.indexOf(draggedId);
          const toIdx = visibleIds.indexOf(targetId);
          if (fromIdx < 0 || toIdx < 0) return;
          const [moved] = visibleIds.splice(fromIdx, 1);
          visibleIds.splice(toIdx, 0, moved);
          const restIds = recipes.map((r) => r.id).filter((id) => !visibleIds.includes(id));
          await persistRecipeOrder([...visibleIds, ...restIds]);
        });
        el.addEventListener("dragend", () => {
          draggedId = null;
          document.querySelectorAll(".dragging, .drag-over").forEach((n) => n.classList.remove("dragging", "drag-over"));
        });
      });
    }

    document.querySelectorAll(".open-recipe-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedRecipe = recipes.find((r) => r.id === Number(btn.dataset.id));
        cookScale = 1;
        doneSteps = new Set();
        render();
      });
    });

    document.querySelectorAll(".add-week-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/planner", {
          method: "POST",
          body: { recipe_id: Number(btn.dataset.id), scale: 1 },
        });
        toast("Added to This Week's Menu!");
      });
    });
  }

  function openCustomizeViewModal() {
    openModal("Customize Recipes Page", `
      <form id="customize-recipes-form" class="stack-md">
        <div>
          <label class="field-label">Sort Order (Pinned recipes always stay first)</label>
          <select class="select" name="sort_mode">
            <option value="custom" ${viewPrefs.sort_mode === "custom" ? "selected" : ""}>Custom Order (Pinned + Arranged)</option>
            <option value="recent" ${viewPrefs.sort_mode === "recent" ? "selected" : ""}>Recently Updated</option>
            <option value="alpha" ${viewPrefs.sort_mode === "alpha" ? "selected" : ""}>Alphabetical (A → Z)</option>
            <option value="fastest" ${viewPrefs.sort_mode === "fastest" ? "selected" : ""}>Fastest Total Time</option>
            <option value="protein" ${viewPrefs.sort_mode === "protein" ? "selected" : ""}>Highest Protein</option>
          </select>
        </div>
        <div>
          <label class="field-label">Layout Style</label>
          <select class="select" name="card_density">
            <option value="cards" ${viewPrefs.card_density === "cards" ? "selected" : ""}>Cards Grid</option>
            <option value="compact" ${viewPrefs.card_density === "compact" ? "selected" : ""}>Compact List</option>
          </select>
        </div>
        <div class="stack-sm">
          <label class="row small" style="cursor: pointer;">
            <input type="checkbox" name="show_photos" ${viewPrefs.show_photos ? "checked" : ""} />
            <span>Show recipe photos</span>
          </label>
          <label class="row small" style="cursor: pointer;">
            <input type="checkbox" name="show_macros" ${viewPrefs.show_macros ? "checked" : ""} />
            <span>Show nutrition &amp; calorie badges</span>
          </label>
          <label class="row small" style="cursor: pointer;">
            <input type="checkbox" name="show_description" ${viewPrefs.show_description ? "checked" : ""} />
            <span>Show short descriptions on cards</span>
          </label>
        </div>
        <button class="btn btn-primary" type="submit">Save Layout Preferences</button>
      </form>
    `, (close) => {
      document.getElementById("customize-recipes-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const nextPrefs = {
          sort_mode: f.sort_mode.value,
          card_density: f.card_density.value,
          show_photos: f.show_photos.checked,
          show_macros: f.show_macros.checked,
          show_description: f.show_description.checked,
        };
        viewPrefs = await api("/api/recipes/view-prefs", {
          method: "PUT",
          body: nextPrefs,
        });
        saveCachedViewPrefs(viewPrefs);
        close();
        render();
        toast("Saved Recipes page preferences!");
      });
    });
  }

  function openAddRecipeModal(initialTab = "url") {
    let tab = initialTab;
    const renderHub = () => `
      <div class="stack-md">
        <div class="subtabs" style="margin-bottom: 4px;">
          <button type="button" class="subtab ${tab === "url" ? "active" : ""}" data-add-tab="url">From URL</button>
          <button type="button" class="subtab ${tab === "paste" ? "active" : ""}" data-add-tab="paste">Paste Text / HTML</button>
          <button type="button" class="subtab" data-add-tab="manual">Manual</button>
          <button type="button" class="subtab ${tab === "bulk" ? "active" : ""}" data-add-tab="bulk">Bulk Import</button>
        </div>

        ${tab === "url" ? `
          <form id="hub-scrape-form" class="stack-md">
            <div>
              <label class="field-label">Recipe Web Page URL</label>
              <input class="input" id="hub-scrape-url" type="url" placeholder="https://www.budgetbytes.com/..." required />
            </div>
            <p class="small muted" style="margin: 0;">Automatically imports title, photo, servings, ingredients, steps, and nutrition.</p>
            <button class="btn btn-primary" type="submit" id="hub-scrape-btn">Import from URL</button>
          </form>
        ` : ""}

        ${tab === "paste" ? `
          <div id="hub-paste-placeholder"></div>
        ` : ""}

        ${tab === "bulk" ? `
          <div id="hub-bulk-placeholder"></div>
        ` : ""}
      </div>
    `;

    openModal("Add Recipe", renderHub(), (close) => {
      const bindHub = () => {
        document.querySelectorAll("[data-add-tab]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const nextTab = btn.dataset.addTab;
            if (nextTab === "manual") {
              close();
              openRecipeEditor(null, false);
              return;
            }
            if (nextTab === "paste") {
              close();
              openQuickPasteModal("", "");
              return;
            }
            if (nextTab === "bulk") {
              close();
              openBulkImportModal();
              return;
            }
            tab = nextTab;
            document.getElementById("modal-body").innerHTML = renderHub();
            bindHub();
          });
        });

        document.getElementById("hub-scrape-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const urlInput = document.getElementById("hub-scrape-url");
          const targetUrl = urlInput.value.trim();
          const btn = document.getElementById("hub-scrape-btn");
          btn.disabled = true;
          btn.textContent = "Importing...";
          try {
            const scraped = await api("/api/recipes/scrape", {
              method: "POST",
              body: { url: targetUrl },
            });
            close();
            toast("Recipe imported! Review & save below.");
            openRecipeEditor(scraped, true);
          } catch (err) {
            toast(err.message, true);
            close();
            openQuickPasteModal(targetUrl, err.message);
          }
        });

        if (tab === "url") {
          document.getElementById("hub-scrape-url")?.focus();
        }
      };

      bindHub();
    });
  }

  function openQuickPasteModal(prefillUrl = "", errorReason = "") {
    let pasteMode = "smart";
    openModal("Quick Paste Recipe Import", `
      <form id="quick-paste-form" class="stack-md">
        ${errorReason ? `
          <div class="card" style="padding: 10px 12px; background: var(--accent-soft); border-color: #fcd34d; color: #92400e; font-size: 0.85rem;">
            <strong>Direct URL fetch was blocked by the website's firewall:</strong> ${esc(errorReason)}<br/>
            Open the recipe in your browser, copy either the recipe text or the page HTML source (<code>Ctrl+U</code> &rarr; <code>Ctrl+A</code> &rarr; <code>Ctrl+C</code>), and paste it below!
          </div>
        ` : `
          <p class="small muted" style="margin: 0;">
            Paste copied recipe text or full page HTML source (<code>Ctrl+U</code>), or switch to Separate Boxes to paste ingredients and instructions individually.
          </p>
        `}
        <div class="row" style="gap: 6px;">
          <button type="button" class="btn btn-sm btn-primary" id="paste-mode-smart">Smart Auto-Detect</button>
          <button type="button" class="btn btn-sm" id="paste-mode-split">Separate Ingredients &amp; Steps</button>
        </div>
        <div>
          <label class="field-label">Source URL (optional)</label>
          <input class="input" name="source_url" value="${esc(prefillUrl)}" placeholder="https://..." />
        </div>
        <div id="paste-smart-wrap">
          <label class="field-label">Pasted Recipe Text or Page HTML Source</label>
          <textarea class="textarea" name="raw_content" style="min-height: 200px;" placeholder="Paste copied recipe text or HTML source here..."></textarea>
        </div>
        <div id="paste-split-wrap" class="stack-md" style="display: none;">
          <div>
            <label class="field-label">Recipe Title (optional)</label>
            <input class="input" name="title" placeholder="e.g. Garlic Butter Chicken" />
          </div>
          <div>
            <label class="field-label">Ingredients (one per line)</label>
            <textarea class="textarea" name="ingredients_text" style="min-height: 120px;" placeholder="1.5 lbs chicken thighs&#10;3 cloves garlic&#10;2 tbsp butter"></textarea>
          </div>
          <div>
            <label class="field-label">Cooking Steps (one step per line)</label>
            <textarea class="textarea" name="steps_text" style="min-height: 120px;" placeholder="Season chicken with salt and pepper.&#10;Sear in skillet 5 minutes per side."></textarea>
          </div>
        </div>
        <button class="btn btn-primary" type="submit" id="parse-paste-btn">Parse &amp; Open Recipe Editor</button>
      </form>
    `, (close) => {
      const smartBtn = document.getElementById("paste-mode-smart");
      const splitBtn = document.getElementById("paste-mode-split");
      const smartWrap = document.getElementById("paste-smart-wrap");
      const splitWrap = document.getElementById("paste-split-wrap");

      smartBtn?.addEventListener("click", () => {
        pasteMode = "smart";
        smartBtn.classList.add("btn-primary");
        splitBtn.classList.remove("btn-primary");
        smartWrap.style.display = "block";
        splitWrap.style.display = "none";
      });
      splitBtn?.addEventListener("click", () => {
        pasteMode = "split";
        splitBtn.classList.add("btn-primary");
        smartBtn.classList.remove("btn-primary");
        splitWrap.style.display = "flex";
        smartWrap.style.display = "none";
      });

      document.getElementById("quick-paste-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        if (pasteMode === "smart" && !f.raw_content.value.trim()) {
          toast("Please paste recipe text or HTML content.", true);
          return;
        }
        if (pasteMode === "split" && !f.ingredients_text.value.trim() && !f.steps_text.value.trim()) {
          toast("Please paste ingredients or steps.", true);
          return;
        }
        const btn = document.getElementById("parse-paste-btn");
        btn.disabled = true;
        btn.textContent = "Parsing...";
        try {
          const payload = pasteMode === "split"
            ? {
                title: f.title.value.trim(),
                ingredients_text: f.ingredients_text.value,
                steps_text: f.steps_text.value,
                source_url: f.source_url.value.trim(),
              }
            : {
                raw_content: f.raw_content.value,
                source_url: f.source_url.value.trim(),
              };
          const parsed = await api("/api/recipes/parse-content", {
            method: "POST",
            body: payload,
          });
          close();
          toast("Parsed recipe! Review & save below.");
          openRecipeEditor(parsed, true);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
          btn.textContent = "Parse & Open Recipe Editor";
        }
      });
    });
  }

  function openBulkImportModal() {
    openModal("Bulk Import Recipes", `
      <div class="stack-lg">
        <form id="bulk-file-form" class="card stack-sm" style="background: var(--bg);">
          <h4 style="margin: 0;">Option 1: Upload File (.csv, .xlsx, .docx, .json, .txt, .md)</h4>
          <p class="small muted" style="margin: 0;">
            For spreadsheets (<code>.csv</code> / <code>.xlsx</code>), use columns like <code>title</code>, <code>ingredients</code>, <code>steps</code>, <code>servings</code>, <code>tags</code>, <code>image_url</code>.
            For Word/Text (<code>.docx</code> / <code>.txt</code>), separate recipes with <code>---</code> and use <code>Ingredients:</code> and <code>Steps:</code> headings.
          </p>
          <input class="input" type="file" name="file" accept=".csv,.xlsx,.docx,.json,.txt,.md" required />
          <button class="btn btn-primary" type="submit" id="upload-recipes-btn">Upload &amp; Import File</button>
        </form>

        <form id="bulk-urls-form" class="card stack-sm" style="background: var(--bg);">
          <h4 style="margin: 0;">Option 2: Batch Import Recipe URLs</h4>
          <p class="small muted" style="margin: 0;">Paste up to 25 recipe web page URLs (one per line) to scrape and save automatically.</p>
          <textarea class="textarea" name="urls" placeholder="https://example.com/recipe-1&#10;https://example.com/recipe-2" required></textarea>
          <button class="btn btn-accent" type="submit" id="batch-urls-btn">Batch Scrape URLs</button>
        </form>
      </div>
    `, (close) => {
      document.getElementById("bulk-file-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = document.getElementById("upload-recipes-btn");
        btn.disabled = true;
        btn.textContent = "Importing...";
        try {
          const fd = new FormData(e.target);
          const res = await apiUpload("/api/import/recipes", fd);
          recipes = await api("/api/recipes");
          close();
          render();
          toast(`Successfully imported ${res.imported} recipes!`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
          btn.textContent = "Upload & Import File";
        }
      });

      document.getElementById("bulk-urls-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = document.getElementById("batch-urls-btn");
        btn.disabled = true;
        btn.textContent = "Scraping URLs...";
        try {
          const urls = e.target.urls.value.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
          const res = await api("/api/import/recipes-urls", {
            method: "POST",
            body: { urls },
          });
          recipes = await api("/api/recipes");
          close();
          render();
          toast(`Imported ${res.imported} recipes!${res.errors?.length ? ` (${res.errors.length} failed)` : ""}`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
          btn.textContent = "Batch Scrape URLs";
        }
      });
    });
  }

  function renderDetail(r) {
    const portionCount = Number(r.custom_portions) || Number(r.servings) || 1;
    const hasMacros = r.calories_per_serving !== null && r.calories_per_serving !== undefined;
    const ratio = (Number(r.servings) || 1) / portionCount;
    const perPortionMacros = hasMacros ? {
      calories_per_serving: r.calories_per_serving * ratio,
      protein_g: (r.protein_g || 0) * ratio,
      carbs_g: (r.carbs_g || 0) * ratio,
      fat_g: (r.fat_g || 0) * ratio,
      fiber_g: (r.fiber_g || 0) * ratio,
    } : null;

    container.innerHTML = `
      <div class="page-header">
        <button class="btn btn-sm" id="back-recipes-btn">← Recipes</button>
        <div class="row" style="gap: 6px;">
          <button class="btn btn-primary btn-sm" id="detail-add-week-btn">+ This Week</button>
          ${overflowMenu([
            { id: "edit-recipe-btn", label: "✎ Edit Recipe", hidden: isGuest },
            { id: "detail-loseit-btn", label: "📋 Lose It! / Macro Card" },
            { id: "detail-pin-btn", label: r.pinned ? "📌 Unpin from Top" : "📌 Pin to Top" },
            { id: "sync-url-btn", label: "🔄 Sync URL Info", hidden: !(r.source_url && !isGuest) },
          ], { title: "Recipe actions" })}
        </div>
      </div>

      ${r.is_customized ? `
        <div class="diff-banner" style="margin-bottom: 14px;">
          <div class="row-wrap" style="gap: 8px; align-items: center;">
            <span class="badge badge-accent">✨ Customized Recipe</span>
            <span class="small">Changes from original recipe are highlighted below.</span>
          </div>
          <div class="row-wrap" style="gap: 6px;">
            <button class="btn btn-sm" id="toggle-diff-btn" type="button">${showDiff ? "Hide Diff" : "Show Diff"}</button>
            ${isGuest ? "" : `
              <button class="btn btn-sm" id="reset-original-btn" type="button">↩ Revert</button>
              <button class="btn btn-sm" id="save-baseline-btn" type="button" title="Save current version as the new original baseline">✓ Set Baseline</button>
            `}
          </div>
        </div>
      ` : ""}

      <div class="card stack-md" style="margin-bottom: 16px;">
        ${r.image_url ? `<img class="recipe-detail-banner" src="${esc(r.image_url)}" alt="${esc(r.title)}" />` : ""}
        <div class="row-wrap" style="justify-content: space-between;">
          <div>
            <h1 class="page-title">${esc(r.title)}</h1>
            ${r.description ? `<p class="page-subtitle">${esc(r.description)}</p>` : ""}
          </div>
          <div class="row" style="gap: 6px;">
            <span class="small muted" style="font-weight:700;">Scale:</span>
            ${[0.5, 1, 1.5, 2].map((s) => `
              <button class="btn btn-sm ${Math.abs(cookScale - s) < 0.01 ? "btn-primary" : ""} scale-btn" data-scale="${s}">${s}x</button>
            `).join("")}
          </div>
        </div>
        <div class="row-wrap">
          <span class="badge">${fmtQty(r.servings * cookScale)} servings${r.custom_portions ? ` (divided into ${fmtQty(r.custom_portions)} portions)` : ""}</span>
          ${r.prep_minutes ? `<span class="badge">Prep: ${r.prep_minutes}m</span>` : ""}
          ${r.cook_minutes ? `<span class="badge">Cook: ${r.cook_minutes}m</span>` : ""}
          ${r.pinned ? `<span class="badge badge-accent">📌 Pinned</span>` : ""}
          ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
          ${r.source_url ? `<a class="badge" href="${esc(r.source_url)}" target="_blank" rel="noopener">Original Source ↗</a>` : ""}
        </div>
        <div class="row-wrap" style="justify-content: space-between; align-items: center;">
          ${hasMacros
            ? `<div class="row-wrap" style="gap: 8px;"><span class="small muted" style="font-weight: 700;">Per Portion:</span>${renderMacroStrip(perPortionMacros)}</div>`
            : `<button class="btn btn-sm" id="calc-detail-macros-btn" type="button">✨ Auto-Calculate Macros from Ingredients</button>`}
        </div>
      </div>

      <div class="grid-2" style="align-items: start;">
        <div class="card stack-sm">
          <h2 style="margin: 0 0 6px; font-size: 1.08rem;">Ingredients</h2>
          ${r.ingredients.map((ing) => {
            const qty = ing.quantity !== null && ing.quantity !== undefined ? fmtQty(ing.quantity * cookScale) : "";
            const dStatus = showDiff ? ing.diff_status : "unchanged";
            return `
              <div style="padding: 6px 0; border-bottom: 1px solid var(--surface-alt);">
                <div class="row-wrap" style="justify-content: space-between; align-items: baseline; gap: 6px;">
                  <div>
                    <strong>${esc([qty, ing.unit].filter(Boolean).join(" "))}</strong>
                    <span>${esc(ing.name)}</span>
                    ${ing.prep_notes ? `<span class="muted small">, ${esc(ing.prep_notes)}</span>` : ""}
                  </div>
                  ${dStatus === "added" ? `<span class="diff-badge-added">+ User Added</span>` : ""}
                  ${dStatus === "modified" ? `<span class="diff-badge-mod">✎ Modified</span>` : ""}
                </div>
                ${(dStatus === "modified" && ing.original_raw) ? `<div class="diff-was-note">Original: ${esc(ing.original_raw)}</div>` : ""}
              </div>
            `;
          }).join("")}
          ${(showDiff && r.removed_ingredients?.length) ? `
            <div class="removed-block">
              <div class="row" style="gap: 6px; margin-bottom: 4px;">
                <span class="diff-badge-removed">Removed from Original</span>
              </div>
              ${r.removed_ingredients.map((orig) => `<div class="small muted" style="text-decoration: line-through;">${esc(orig)}</div>`).join("")}
            </div>
          ` : ""}
        </div>

        <div class="card stack-sm">
          <div class="row" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">Steps (Cook Mode)</h2>
            <span class="small muted">Tap step when done</span>
          </div>
          ${r.steps.length === 0 ? `<p class="muted small">No steps saved.</p>` : r.steps.map((step, idx) => {
            const sDiff = (showDiff && r.step_diffs?.[idx]) ? r.step_diffs[idx] : null;
            const sStatus = sDiff?.diff_status || "unchanged";
            return `
              <div class="step-row ${doneSteps.has(idx) ? "done" : ""}" data-step="${idx}">
                <div class="step-num">${idx + 1}</div>
                <div class="grow">
                  <div class="row-wrap" style="justify-content: space-between; align-items: flex-start; gap: 6px;">
                    <span>${esc(step)}</span>
                    ${sStatus === "added" ? `<span class="diff-badge-added">+ User Added</span>` : ""}
                    ${sStatus === "modified" ? `<span class="diff-badge-mod">✎ Modified</span>` : ""}
                  </div>
                  ${(sStatus === "modified" && sDiff.original_text) ? `<div class="diff-was-note">Original: ${esc(sDiff.original_text)}</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
          ${(showDiff && r.removed_steps?.length) ? `
            <div class="removed-block">
              <div class="row" style="gap: 6px; margin-bottom: 4px;">
                <span class="diff-badge-removed">Removed Steps from Original</span>
              </div>
              ${r.removed_steps.map((orig) => `<div class="small muted" style="text-decoration: line-through; margin-bottom: 3px;">${esc(orig)}</div>`).join("")}
            </div>
          ` : ""}
          ${r.notes ? `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
              <span class="field-label">Family Notes</span>
              <p class="small" style="margin: 0;">${esc(r.notes)}</p>
            </div>
          ` : ""}
        </div>
      </div>
    `;

    bindOverflowMenus(container);

    document.getElementById("back-recipes-btn").addEventListener("click", () => {
      selectedRecipe = null;
      render();
    });

    document.getElementById("detail-pin-btn")?.addEventListener("click", () => togglePinRecipe(r.id));

    document.getElementById("toggle-diff-btn")?.addEventListener("click", () => {
      showDiff = !showDiff;
      render();
    });

    document.getElementById("sync-url-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Syncing...";
      try {
        const synced = await api(`/api/recipes/${r.id}/sync-from-url`, { method: "POST" });
        recipes = await api("/api/recipes");
        selectedRecipe = recipes.find((x) => x.id === r.id) || synced;
        render();
        toast("Synced recipe image & nutrition from URL!");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "🔄 Sync URL Info";
        toast(err.message || "Could not sync from URL", true);
      }
    });

    document.getElementById("reset-original-btn")?.addEventListener("click", async () => {
      if (!confirm(`Revert "${r.title}" back to its original ingredients and steps?`)) return;
      const reverted = await api(`/api/recipes/${r.id}/reset-to-original`, { method: "POST" });
      recipes = await api("/api/recipes");
      selectedRecipe = recipes.find((x) => x.id === r.id) || reverted;
      render();
      toast("Reverted recipe to original!");
    });

    document.getElementById("save-baseline-btn")?.addEventListener("click", async () => {
      if (!confirm("Set your current edited version as the new Original baseline (clears diff badges)?")) return;
      const updated = await api(`/api/recipes/${r.id}/save-as-original`, { method: "POST" });
      recipes = await api("/api/recipes");
      selectedRecipe = recipes.find((x) => x.id === r.id) || updated;
      render();
      toast("Saved current version as baseline!");
    });

    document.getElementById("detail-loseit-btn")?.addEventListener("click", () => {
      openLoseItQuickCardModal(r, state, {
        onSaved: async (updated) => {
          recipes = await api("/api/recipes");
          selectedRecipe = recipes.find((x) => x.id === r.id) || updated;
          render();
        },
      });
    });

    document.getElementById("calc-detail-macros-btn")?.addEventListener("click", async () => {
      await api(`/api/nutrition/estimate-recipe/${r.id}`, { method: "POST" });
      recipes = await api("/api/recipes");
      selectedRecipe = recipes.find((x) => x.id === r.id) || selectedRecipe;
      render();
      toast("Calculated estimated macros!");
    });

    document.getElementById("edit-recipe-btn")?.addEventListener("click", () => openRecipeEditor(r, false));

    document.getElementById("detail-add-week-btn").addEventListener("click", async () => {
      await api("/api/planner", {
        method: "POST",
        body: { recipe_id: r.id, scale: cookScale },
      });
      toast("Added to This Week's Menu!");
    });

    document.querySelectorAll(".scale-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        cookScale = Number(btn.dataset.scale);
        render();
      });
    });

    document.querySelectorAll(".step-row").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = Number(row.dataset.step);
        if (doneSteps.has(idx)) doneSteps.delete(idx);
        else doneSteps.add(idx);
        render();
      });
    });
  }

  function openRecipeEditor(recipe, isScrapedNew) {
    const isEdit = Boolean(recipe && recipe.id && !isScrapedNew);
    const ingText = (recipe?.ingredients || []).map((i) => i.raw_text || `${i.quantity || ""} ${i.unit || ""} ${i.name}`).join("\n");
    const stepsText = (recipe?.steps || []).join("\n");
    const tagsText = (recipe?.tags || []).join(", ");

    openModal(isEdit ? "Edit Recipe" : "Save Recipe", `
      <form id="recipe-editor-form" class="stack-md">
        ${recipe?.image_url ? `
          <img class="recipe-detail-banner" id="editor-img-preview" src="${esc(recipe.image_url)}" alt="Preview" style="max-height: 170px;" />
        ` : ""}
        <div>
          <label class="field-label">Recipe Title</label>
          <input class="input" name="title" value="${esc(recipe?.title || "")}" required />
        </div>
        <div>
          <label class="field-label">Short Description</label>
          <input class="input" name="description" value="${esc(recipe?.description || "")}" />
        </div>
        <div class="grid-2">
          <div>
            <label class="field-label">Servings</label>
            <input class="input" name="servings" type="number" step="0.5" min="0.5" value="${esc(recipe?.servings || 4)}" required />
          </div>
          <div>
            <label class="field-label">Tags (comma-separated)</label>
            <input class="input" name="tags" value="${esc(tagsText)}" placeholder="Dinner, Quick, Mexican" />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label class="field-label">Prep Minutes</label>
            <input class="input" name="prep_minutes" type="number" min="0" value="${esc(recipe?.prep_minutes ?? "")}" />
          </div>
          <div>
            <label class="field-label">Cook Minutes</label>
            <input class="input" name="cook_minutes" type="number" min="0" value="${esc(recipe?.cook_minutes ?? "")}" />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label class="field-label">Source URL (optional)</label>
            <input class="input" name="source_url" value="${esc(recipe?.source_url || "")}" />
          </div>
          <div>
            <label class="field-label">Recipe Photo URL (auto-filled when scraped)</label>
            <input class="input" name="image_url" value="${esc(recipe?.image_url || "")}" placeholder="https://..." />
          </div>
        </div>
        <div>
          <label class="field-label">Ingredients (one per line, e.g. "2 tbsp olive oil")</label>
          <textarea class="textarea" name="ingredients_text" style="min-height: 140px;" placeholder="1.5 lbs chicken breast&#10;3 cloves garlic, minced&#10;15 oz black beans">${esc(ingText)}</textarea>
        </div>
        <div>
          <label class="field-label">Cooking Steps (one step per line)</label>
          <textarea class="textarea" name="steps_text" style="min-height: 140px;" placeholder="Season chicken with salt and pepper.&#10;Sear in skillet 5 minutes per side.">${esc(stepsText)}</textarea>
        </div>
        <div class="card stack-sm" style="background: var(--bg); padding: 12px;">
          <div class="row-wrap" style="justify-content: space-between; align-items: center;">
            <span class="field-label" style="margin: 0;">Nutrition per Recipe Serving <span id="macro-auto-status" class="small muted" style="font-weight: 400;">(auto-updates when ingredients change)</span></span>
            <button type="button" class="btn btn-sm" id="estimate-editor-macros-btn">✨ Recalculate Now</button>
          </div>
          <div class="row-wrap" style="gap: 8px;">
            <div style="width: 95px;">
              <label class="small muted">Calories</label>
              <input class="input" name="calories_per_serving" type="number" step="1" min="0" value="${recipe?.calories_per_serving != null ? Math.round(recipe.calories_per_serving) : ""}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Protein (g)</label>
              <input class="input" name="protein_g" type="number" step="1" min="0" value="${recipe?.protein_g != null ? Math.round(recipe.protein_g) : ""}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Carbs (g)</label>
              <input class="input" name="carbs_g" type="number" step="1" min="0" value="${recipe?.carbs_g != null ? Math.round(recipe.carbs_g) : ""}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Fat (g)</label>
              <input class="input" name="fat_g" type="number" step="1" min="0" value="${recipe?.fat_g != null ? Math.round(recipe.fat_g) : ""}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Fiber (g)</label>
              <input class="input" name="fiber_g" type="number" step="1" min="0" value="${recipe?.fiber_g != null ? Math.round(recipe.fiber_g) : ""}" />
            </div>
            <div style="width: 115px;">
              <label class="small muted">Custom Portions</label>
              <input class="input" name="custom_portions" type="number" step="0.5" min="0.5" value="${esc(recipe?.custom_portions ?? "")}" placeholder="e.g. 5" />
            </div>
          </div>
        </div>
        <div>
          <label class="field-label">Notes</label>
          <input class="input" name="notes" value="${esc(recipe?.notes || "")}" placeholder="Kids loved this, double sauce next time..." />
        </div>
        <div class="row" style="justify-content: space-between;">
          ${isEdit ? `<button class="btn btn-danger" type="button" id="delete-recipe-btn">Delete Recipe</button>` : `<span></span>`}
          <button class="btn btn-primary" type="submit">Save Recipe</button>
        </div>
      </form>
    `, (close) => {
      document.getElementById("delete-recipe-btn")?.addEventListener("click", async () => {
        if (!confirm(`Delete "${recipe.title}"?`)) return;
        await api(`/api/recipes/${recipe.id}`, { method: "DELETE" });
        recipes = await api("/api/recipes");
        selectedRecipe = null;
        close();
        render();
        toast("Recipe deleted");
      });

      const recalcMacros = async (showToastMsg = false) => {
        const f = document.getElementById("recipe-editor-form");
        if (!f || !f.ingredients_text.value.trim()) return;
        try {
          const est = await api("/api/nutrition/estimate-text", {
            method: "POST",
            body: {
              ingredients_text: f.ingredients_text.value,
              servings: Number(f.servings.value) || 4,
            },
          });
          f.calories_per_serving.value = est.calories_per_serving != null ? Math.round(est.calories_per_serving) : "";
          f.protein_g.value = est.protein_g != null ? Math.round(est.protein_g) : "";
          f.carbs_g.value = est.carbs_g != null ? Math.round(est.carbs_g) : "";
          f.fat_g.value = est.fat_g != null ? Math.round(est.fat_g) : "";
          f.fiber_g.value = est.fiber_g != null ? Math.round(est.fiber_g) : "";
          const statusEl = document.getElementById("macro-auto-status");
          if (statusEl) statusEl.textContent = "✓ Updated from ingredients";
          if (showToastMsg) toast("Estimated per-serving macros from ingredients!");
        } catch {
          // Ignore transient estimation errors
        }
      };

      let macroTimer = null;
      const scheduleMacroRecalc = () => {
        clearTimeout(macroTimer);
        const statusEl = document.getElementById("macro-auto-status");
        if (statusEl) statusEl.textContent = "Recalculating...";
        macroTimer = setTimeout(() => recalcMacros(false), 380);
      };

      const editorForm = document.getElementById("recipe-editor-form");
      editorForm?.ingredients_text?.addEventListener("input", scheduleMacroRecalc);
      editorForm?.servings?.addEventListener("input", scheduleMacroRecalc);

      document.getElementById("estimate-editor-macros-btn")?.addEventListener("click", () => recalcMacros(true));

      document.getElementById("recipe-editor-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const ingredients = f.ingredients_text.value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((raw_text) => ({ raw_text }));
        const steps = f.steps_text.value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const tags = f.tags.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);

        const optFloat = (inp) => (inp && inp.value !== "" ? Number(inp.value) : null);
        const body = {
          title: f.title.value.trim(),
          description: f.description.value.trim(),
          servings: Number(f.servings.value) || 4,
          prep_minutes: f.prep_minutes.value ? Number(f.prep_minutes.value) : null,
          cook_minutes: f.cook_minutes.value ? Number(f.cook_minutes.value) : null,
          source_url: f.source_url.value.trim(),
          image_url: f.image_url.value.trim(),
          tags,
          steps,
          notes: f.notes.value.trim(),
          calories_per_serving: optFloat(f.calories_per_serving),
          protein_g: optFloat(f.protein_g),
          carbs_g: optFloat(f.carbs_g),
          fat_g: optFloat(f.fat_g),
          fiber_g: optFloat(f.fiber_g),
          custom_portions: optFloat(f.custom_portions),
          ingredients,
        };

        let saved;
        if (isEdit) {
          saved = await api(`/api/recipes/${recipe.id}`, { method: "PUT", body });
        } else {
          saved = await api("/api/recipes", { method: "POST", body });
        }
        recipes = await api("/api/recipes");
        if (selectedRecipe) {
          selectedRecipe = recipes.find((x) => x.id === saved.id) || saved;
        }
        close();
        render();
        toast("Recipe saved!");
      });
    });
  }

  render();
}
