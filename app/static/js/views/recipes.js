import { api, apiUpload } from "../api.js";
import { openLoseItQuickCardModal, renderMacroStrip } from "../nutrition_ui.js";
import { esc, fmtQty, openModal, toast } from "../utils.js";

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
          <p class="page-subtitle">Import from any recipe website, bulk upload files, or save your family favorites</p>
        </div>
        <div class="row">
          <button class="btn btn-sm" id="bulk-import-recipes-btn">Bulk Import</button>
          <button class="btn btn-primary btn-sm" id="new-recipe-btn">+ New Recipe</button>
        </div>
      </div>

      <div class="card stack-md" style="margin-bottom: 16px;">
        <form id="scrape-form" class="row-wrap">
          <input class="input grow" id="scrape-url-input" type="url" placeholder="Paste a recipe URL to auto-import photo, ingredients & steps (https://...)" required />
          <button class="btn btn-accent" type="submit" id="scrape-btn">Import from URL</button>
          <button class="btn" type="button" id="paste-recipe-btn" title="Paste copied recipe text or HTML if a website blocks automatic scraping">Paste Text / HTML</button>
        </form>
        <input class="input" id="recipe-search" value="${esc(search)}" placeholder="Search recipes by title, tag, or ingredient..." />
      </div>

      ${filtered.length === 0 ? `
        <div class="card empty-state">No recipes found. Import one from a URL, click <strong>Bulk Import</strong>, or click <strong>+ New Recipe</strong>!</div>
      ` : `
        <div class="recipe-grid">
          ${filtered.map((r) => `
            <div class="recipe-card">
              ${r.image_url ? `<img class="recipe-cover" src="${esc(r.image_url)}" alt="${esc(r.title)}" loading="lazy" />` : ""}
              <div class="row" style="justify-content: space-between; align-items: flex-start;">
                <h3>${esc(r.title)}</h3>
                <span class="badge">${fmtQty(r.servings)} srv</span>
              </div>
              ${r.description ? `<p class="small muted" style="margin: 0;">${esc(r.description)}</p>` : ""}
              <div class="row-wrap">
                ${r.tags.map((t) => `<span class="badge badge-primary">${esc(t)}</span>`).join("")}
                ${(r.prep_minutes || r.cook_minutes) ? `<span class="badge">${(r.prep_minutes || 0) + (r.cook_minutes || 0)} min</span>` : ""}
              </div>
              ${renderMacroStrip(r, true)}
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

    document.getElementById("new-recipe-btn")?.addEventListener("click", () => openRecipeEditor(null, false));
    document.getElementById("bulk-import-recipes-btn")?.addEventListener("click", openBulkImportModal);
    document.getElementById("paste-recipe-btn")?.addEventListener("click", () => {
      const urlVal = document.getElementById("scrape-url-input")?.value.trim() || "";
      openQuickPasteModal(urlVal, "");
    });

    document.getElementById("scrape-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById("scrape-url-input");
      const targetUrl = urlInput.value.trim();
      const btn = document.getElementById("scrape-btn");
      btn.disabled = true;
      btn.textContent = "Importing...";
      try {
        const scraped = await api("/api/recipes/scrape", {
          method: "POST",
          body: { url: targetUrl },
        });
        urlInput.value = "";
        toast("Recipe imported! Review & save below.");
        openRecipeEditor(scraped, true);
      } catch (err) {
        toast(err.message, true);
        openQuickPasteModal(targetUrl, err.message);
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

  function openQuickPasteModal(prefillUrl = "", errorReason = "") {
    openModal("Quick Paste Recipe Import", `
      <form id="quick-paste-form" class="stack-md">
        ${errorReason ? `
          <div class="card" style="padding: 10px 12px; background: var(--accent-soft); border-color: #fcd34d; color: #92400e; font-size: 0.85rem;">
            <strong>Direct URL fetch was blocked by the website's firewall:</strong> ${esc(errorReason)}<br/>
            You can still import it in seconds: open the recipe page in your browser, copy either the recipe text or the page HTML source (<code>Ctrl+U</code> &rarr; <code>Ctrl+A</code> &rarr; <code>Ctrl+C</code>), and paste it below!
          </div>
        ` : `
          <p class="small muted" style="margin: 0;">
            Paste copied recipe text (with Ingredients &amp; Instructions) or full page HTML source (<code>Ctrl+U</code>) to automatically extract the title, photo, ingredients, and steps.
          </p>
        `}
        <div>
          <label class="field-label">Source URL (optional)</label>
          <input class="input" name="source_url" value="${esc(prefillUrl)}" placeholder="https://..." />
        </div>
        <div>
          <label class="field-label">Pasted Recipe Text or Page HTML Source</label>
          <textarea class="textarea" name="raw_content" style="min-height: 200px;" placeholder="Paste copied recipe text or HTML source here..." required></textarea>
        </div>
        <button class="btn btn-primary" type="submit" id="parse-paste-btn">Parse &amp; Open Recipe Editor</button>
      </form>
    `, (close) => {
      document.getElementById("quick-paste-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const btn = document.getElementById("parse-paste-btn");
        btn.disabled = true;
        btn.textContent = "Parsing...";
        try {
          const parsed = await api("/api/recipes/parse-content", {
            method: "POST",
            body: {
              raw_content: f.raw_content.value,
              source_url: f.source_url.value.trim(),
            },
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
        <button class="btn btn-sm" id="back-recipes-btn">← All Recipes</button>
        <div class="row-wrap">
          <button class="btn btn-sm" id="detail-loseit-btn">📋 Lose It! / Macro Card</button>
          <button class="btn btn-sm" id="edit-recipe-btn">Edit</button>
          <button class="btn btn-primary btn-sm" id="detail-add-week-btn">+ Add to This Week</button>
        </div>
      </div>

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
          <div class="row-wrap" style="justify-content: space-between;">
            <span class="field-label" style="margin: 0;">Nutrition per Recipe Serving (Optional — auto-scraped when available)</span>
            <button type="button" class="btn btn-sm" id="estimate-editor-macros-btn">✨ Estimate from Ingredients</button>
          </div>
          <div class="row-wrap" style="gap: 8px;">
            <div style="width: 95px;">
              <label class="small muted">Calories</label>
              <input class="input" name="calories_per_serving" type="number" step="1" min="0" value="${esc(recipe?.calories_per_serving ?? "")}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Protein (g)</label>
              <input class="input" name="protein_g" type="number" step="0.1" min="0" value="${esc(recipe?.protein_g ?? "")}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Carbs (g)</label>
              <input class="input" name="carbs_g" type="number" step="0.1" min="0" value="${esc(recipe?.carbs_g ?? "")}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Fat (g)</label>
              <input class="input" name="fat_g" type="number" step="0.1" min="0" value="${esc(recipe?.fat_g ?? "")}" />
            </div>
            <div style="width: 85px;">
              <label class="small muted">Fiber (g)</label>
              <input class="input" name="fiber_g" type="number" step="0.1" min="0" value="${esc(recipe?.fiber_g ?? "")}" />
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

      document.getElementById("estimate-editor-macros-btn")?.addEventListener("click", async () => {
        const f = document.getElementById("recipe-editor-form");
        const est = await api("/api/nutrition/estimate-text", {
          method: "POST",
          body: {
            ingredients_text: f.ingredients_text.value,
            servings: Number(f.servings.value) || 4,
          },
        });
        f.calories_per_serving.value = est.calories_per_serving ?? "";
        f.protein_g.value = est.protein_g ?? "";
        f.carbs_g.value = est.carbs_g ?? "";
        f.fat_g.value = est.fat_g ?? "";
        f.fiber_g.value = est.fiber_g ?? "";
        toast("Estimated per-serving macros from ingredients!");
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
        if (selectedRecipe) selectedRecipe = saved;
        close();
        render();
        toast("Recipe saved!");
      });
    });
  }

  render();
}
