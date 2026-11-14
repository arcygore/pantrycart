import { api } from "../api.js";
import { closeModal, esc, fmtQty, openModal, toast } from "../utils.js";

export async function renderRecipesView(container, state) {
  let recipes = await api("/api/recipes");
  let search = "";
  let selectedRecipe = null;
  let cookScale = 1;
  let doneSteps = new Set();

  function render() {
    if (selectedRecipe) {
      renderDetail(selectedRecipe);
      return;
    }

    const filtered = recipes.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        r.title.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)) ||
        r.ingredients.some((i) => i.name.toLowerCase().includes(q))
      );
    });

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Recipes</h1>
          <p class="page-subtitle">Import from any recipe website or save your family favorites</p>
        </div>
        <button class="btn btn-primary btn-sm" id="new-recipe-btn">+ New Recipe</button>
      </div>

      <div class="card stack-md" style="margin-bottom: 16px;">
        <form id="scrape-form" class="row-wrap">
          <input class="input grow" id="scrape-url-input" type="url" placeholder="Paste a recipe URL to auto-import ingredients & steps (https://...)" required />
          <button class="btn btn-accent" type="submit" id="scrape-btn">Import from URL</button>
        </form>
        <input class="input" id="recipe-search" value="${esc(search)}" placeholder="Search recipes by title, tag, or ingredient..." />
      </div>

      ${filtered.length === 0 ? `
        <div class="card empty-state">No recipes found. Import one from a URL or click <strong>+ New Recipe</strong>!</div>
      ` : `
        <div class="recipe-grid">
          ${filtered.map((r) => `
            <div class="recipe-card">
              <div class="row" style="justify-content: space-between; align-items: flex-start;">
                <h3>${esc(r.title)}</h3>
                <span class="badge">${fmtQty(r.servings)} srv</span>
              </div>
              ${r.description ? `<p class="small muted" style="margin: 0;">${esc(r.description)}</p>` : ""}
              <div class="row-wrap">
                ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
                ${(r.prep_minutes || r.cook_minutes) ? `<span class="badge">${(r.prep_minutes || 0) + (r.cook_minutes || 0)} min</span>` : ""}
              </div>
              <div class="row" style="margin-top: auto; padding-top: 8px; justify-content: space-between;">
                <button class="btn btn-sm open-recipe-btn" data-id="${r.id}">View &amp; Cook</button>
                <button class="btn btn-primary btn-sm add-week-btn" data-id="${r.id}">+ This Week</button>
              </div>
            </div>
          `).join("")}
        </div>
      `}
    `;

    document.getElementById("recipe-search")?.addEventListener("input", (e) => {
      search = e.target.value;
      render();
      const el = document.getElementById("recipe-search");
      el?.focus();
      el?.setSelectionRange(search.length, search.length);
    });

    document.getElementById("new-recipe-btn")?.addEventListener("click", () => openRecipeEditor(null));

    document.getElementById("scrape-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById("scrape-url-input");
      const btn = document.getElementById("scrape-btn");
      btn.disabled = true;
      btn.textContent = "Importing...";
      try {
        const scraped = await api("/api/recipes/scrape", {
          method: "POST",
          body: { url: urlInput.value.trim() },
        });
        urlInput.value = "";
        toast("Recipe imported! Review & save below.");
        openRecipeEditor(scraped, true);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Import from URL";
      }
    });

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

  function renderDetail(r) {
    container.innerHTML = `
      <div class="page-header">
        <button class="btn btn-sm" id="back-recipes-btn">← All Recipes</button>
        <div class="row">
          <button class="btn btn-sm" id="edit-recipe-btn">Edit</button>
          <button class="btn btn-primary btn-sm" id="detail-add-week-btn">+ Add to This Week</button>
        </div>
      </div>

      <div class="card stack-md" style="margin-bottom: 16px;">
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
          <span class="badge">${fmtQty(r.servings * cookScale)} servings</span>
          ${r.prep_minutes ? `<span class="badge">Prep: ${r.prep_minutes}m</span>` : ""}
          ${r.cook_minutes ? `<span class="badge">Cook: ${r.cook_minutes}m</span>` : ""}
          ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
          ${r.source_url ? `<a class="badge" href="${esc(r.source_url)}" target="_blank" rel="noopener">Original Source ↗</a>` : ""}
        </div>
      </div>

      <div class="grid-2" style="align-items: start;">
        <div class="card stack-sm">
          <h2 style="margin: 0 0 6px; font-size: 1.08rem;">Ingredients</h2>
          ${r.ingredients.map((ing) => {
            const qty = ing.quantity !== null && ing.quantity !== undefined ? fmtQty(ing.quantity * cookScale) : "";
            return `
              <div style="padding: 6px 0; border-bottom: 1px solid var(--surface-alt);">
                <strong>${esc([qty, ing.unit].filter(Boolean).join(" "))}</strong>
                <span>${esc(ing.name)}</span>
                ${ing.prep_notes ? `<span class="muted small">, ${esc(ing.prep_notes)}</span>` : ""}
              </div>
            `;
          }).join("")}
        </div>

        <div class="card stack-sm">
          <div class="row" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">Steps (Cook Mode)</h2>
            <span class="small muted">Tap step when done</span>
          </div>
          ${r.steps.length === 0 ? `<p class="muted small">No steps saved.</p>` : r.steps.map((step, idx) => `
            <div class="step-row ${doneSteps.has(idx) ? "done" : ""}" data-step="${idx}">
              <div class="step-num">${idx + 1}</div>
              <div class="grow">${esc(step)}</div>
            </div>
          `).join("")}
          ${r.notes ? `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
              <span class="field-label">Family Notes</span>
              <p class="small" style="margin: 0;">${esc(r.notes)}</p>
            </div>
          ` : ""}
        </div>
      </div>
    `;

    document.getElementById("back-recipes-btn").addEventListener("click", () => {
      selectedRecipe = null;
      render();
    });

    document.getElementById("edit-recipe-btn").addEventListener("click", () => openRecipeEditor(r, false));

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
        <div>
          <label class="field-label">Source URL (optional)</label>
          <input class="input" name="source_url" value="${esc(recipe?.source_url || "")}" />
        </div>
        <div>
          <label class="field-label">Ingredients (one per line, e.g. "2 tbsp olive oil")</label>
          <textarea class="textarea" name="ingredients_text" style="min-height: 140px;" placeholder="1.5 lbs chicken breast&#10;3 cloves garlic, minced&#10;15 oz black beans">${esc(ingText)}</textarea>
        </div>
        <div>
          <label class="field-label">Cooking Steps (one step per line)</label>
          <textarea class="textarea" name="steps_text" style="min-height: 140px;" placeholder="Season chicken with salt and pepper.&#10;Sear in skillet 5 minutes per side.">${esc(stepsText)}</textarea>
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

        const body = {
          title: f.title.value.trim(),
          description: f.description.value.trim(),
          servings: Number(f.servings.value) || 4,
          prep_minutes: f.prep_minutes.value ? Number(f.prep_minutes.value) : null,
          cook_minutes: f.cook_minutes.value ? Number(f.cook_minutes.value) : null,
          source_url: f.source_url.value.trim(),
          tags,
          steps,
          notes: f.notes.value.trim(),
          ingredients,
        };

        let saved;
        if (isEdit) {
          saved = await api(`/api/recipes/${recipe.id}`, { method: "PUT", body });
        } else {
          saved = await api("/api/recipes", { method: "POST", body });
        }
        recipes = await api("/api/recipes");
        if (selectedRecipe) selectedRecipe = saved;
        close();
        render();
        toast("Recipe saved!");
      });
    });
  }

  render();
}
