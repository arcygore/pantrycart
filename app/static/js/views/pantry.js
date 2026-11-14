import { api, apiUpload } from "../api.js";
import { esc, openModal, toast } from "../utils.js";

export async function renderPantryView(container, state) {
  let pantryData = await api("/api/pantry");
  let lists = await api("/api/lists");
  let activeCategory = state.pantryCategory || "ALL";
  let search = "";

  function render() {
    const categories = pantryData.categories || [];
    const items = (pantryData.items || []).filter((item) => {
      if (activeCategory !== "ALL" && item.category !== activeCategory) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q);
      }
      return true;
    });

    const grouped = new Map();
    for (const item of items) {
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category).push(item);
    }

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Pantry Staples</h1>
          <p class="page-subtitle">Categorized pantry inventory — items marked "In Stock" won't clutter your weekly list</p>
        </div>
        <div class="row">
          <button class="btn btn-sm" id="import-pantry-btn">Bulk Import</button>
          <button class="btn btn-primary btn-sm" id="add-pantry-btn">+ Add Pantry Item</button>
        </div>
      </div>

      <div class="list-tabs">
        <button class="list-tab ${activeCategory === "ALL" ? "active" : ""}" data-cat="ALL">
          <span>All Categories</span>
          <span class="count-pill">${pantryData.items.length}</span>
        </button>
        ${categories.map((cat) => {
          const count = pantryData.items.filter((i) => i.category === cat).length;
          return `
            <button class="list-tab ${activeCategory === cat ? "active" : ""}" data-cat="${esc(cat)}">
              <span>${esc(cat)}</span>
              <span class="count-pill">${count}</span>
            </button>
          `;
        }).join("")}
      </div>

      <div class="card stack-md" style="margin-bottom: 16px;">
        <input class="input" id="pantry-search" value="${esc(search)}" placeholder="Search spices, canned goods, oils, baking staples..." />
      </div>

      ${items.length === 0 ? `
        <div class="card empty-state">No pantry items in this category yet.</div>
      ` : `
        <div class="stack-md">
          ${Array.from(grouped.entries()).map(([cat, catItems]) => `
            <div class="dept-card">
              <div class="dept-header">
                <span>${esc(cat)}</span>
                <span>${catItems.length}</span>
              </div>
              ${catItems.map((item) => `
                <div class="item-row" data-pantry-id="${item.id}">
                  <div class="item-main">
                    <div class="item-title-line">
                      <span class="item-name">${esc(item.name)}</span>
                      <span class="badge ${item.in_stock ? "badge-primary" : "badge-accent"}">
                        ${item.in_stock ? "In Stock" : "Out / Low"}
                      </span>
                      ${item.quantity_note ? `<span class="small muted">(${esc(item.quantity_note)})</span>` : ""}
                    </div>
                  </div>
                  <div class="row" style="gap: 6px;">
                    <button class="btn btn-sm toggle-stock-btn" data-id="${item.id}">
                      ${item.in_stock ? "Mark Low" : "Mark In Stock"}
                    </button>
                    ${!item.in_stock ? `
                      <button class="btn btn-sm btn-primary send-to-list-btn" data-id="${item.id}">+ To List</button>
                    ` : ""}
                    <button class="btn btn-sm edit-pantry-btn" data-id="${item.id}">Edit</button>
                  </div>
                </div>
              `).join("")}
            </div>
          `).join("")}
        </div>
      `}
    `;

    bindEvents();
  }

  function bindEvents() {
    document.querySelectorAll("[data-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCategory = btn.dataset.cat;
        state.pantryCategory = activeCategory;
        render();
      });
    });

    document.getElementById("pantry-search")?.addEventListener("input", (e) => {
      search = e.target.value;
      render();
      const el = document.getElementById("pantry-search");
      el?.focus();
      el?.setSelectionRange(search.length, search.length);
    });

    document.querySelectorAll(".toggle-stock-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = pantryData.items.find((x) => x.id === Number(btn.dataset.id));
        if (!item) return;
        await api(`/api/pantry/${item.id}`, {
          method: "PATCH",
          body: {
            in_stock: !item.in_stock,
            quantity_note: !item.in_stock ? "In Stock" : "Running Low",
          },
        });
        pantryData = await api("/api/pantry");
        render();
      });
    });

    document.querySelectorAll(".send-to-list-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = pantryData.items.find((x) => x.id === Number(btn.dataset.id));
        if (!item) return;
        const weeklyList = lists.find((l) => l.list_type === "weekly") || lists[0];
        if (!weeklyList) {
          toast("Create a shopping list first", true);
          return;
        }
        await api(`/api/lists/${weeklyList.id}/items`, {
          method: "POST",
          body: { name: item.name, notes: "Restock pantry" },
        });
        toast(`Added ${item.name} to ${weeklyList.name}`);
      });
    });

    const openPantryModal = (existing) => {
      const cats = pantryData.categories || [];
      openModal(existing ? `Edit ${existing.name}` : "Add Pantry Item", `
        <form id="pantry-form" class="stack-md">
          <div>
            <label class="field-label">Item Name</label>
            <input class="input" name="name" value="${esc(existing?.name || "")}" placeholder="e.g. Smoked Paprika, Canned Chickpeas" required />
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">Pantry Category</label>
              <select class="select" name="category">
                ${cats.map((c) => `
                  <option value="${esc(c)}" ${c === (existing?.category || (activeCategory !== "ALL" ? activeCategory : "Spices & Seasonings")) ? "selected" : ""}>
                    ${esc(c)}
                  </option>
                `).join("")}
              </select>
            </div>
            <div>
              <label class="field-label">Quantity / Note</label>
              <input class="input" name="quantity_note" value="${esc(existing?.quantity_note || "In Stock")}" placeholder="e.g. 2 cans, Full jar" />
            </div>
          </div>
          <label class="row small">
            <input type="checkbox" name="in_stock" ${(existing ? existing.in_stock : true) ? "checked" : ""} />
            <span>Currently in stock at home</span>
          </label>
          <div class="row" style="justify-content: space-between;">
            ${existing ? `<button class="btn btn-danger" type="button" id="del-pantry-btn">Delete</button>` : `<span></span>`}
            <button class="btn btn-primary" type="submit">Save Pantry Item</button>
          </div>
        </form>
      `, (close) => {
        document.getElementById("del-pantry-btn")?.addEventListener("click", async () => {
          await api(`/api/pantry/${existing.id}`, { method: "DELETE" });
          pantryData = await api("/api/pantry");
          close();
          render();
          toast("Pantry item deleted");
        });

        document.getElementById("pantry-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const body = {
            name: f.name.value.trim(),
            category: f.category.value,
            quantity_note: f.quantity_note.value.trim(),
            in_stock: f.in_stock.checked,
          };
          if (existing) {
            await api(`/api/pantry/${existing.id}`, { method: "PATCH", body });
          } else {
            await api("/api/pantry", { method: "POST", body });
          }
          pantryData = await api("/api/pantry");
          close();
          render();
          toast("Saved to Pantry");
        });
      });
    };

    document.getElementById("add-pantry-btn")?.addEventListener("click", () => openPantryModal(null));
    document.querySelectorAll(".edit-pantry-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = pantryData.items.find((x) => x.id === Number(btn.dataset.id));
        if (item) openPantryModal(item);
      });
    });

    document.getElementById("import-pantry-btn")?.addEventListener("click", () => {
      openModal("Bulk Import Pantry Items (.csv / .xlsx)", `
        <form id="import-pantry-form" class="stack-md">
          <p class="small muted" style="margin: 0;">
            Upload a <code>.csv</code> or <code>.xlsx</code> file with columns: <code>name</code>, <code>category</code> (e.g. Spices &amp; Seasonings, Canned &amp; Jarred Goods), <code>quantity_note</code>, <code>in_stock</code>.
          </p>
          <input class="input" type="file" name="file" accept=".csv,.xlsx" required />
          <button class="btn btn-primary" type="submit">Upload &amp; Import</button>
        </form>
      `, (close) => {
        document.getElementById("import-pantry-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            const res = await apiUpload("/api/import/pantry", fd);
            pantryData = await api("/api/pantry");
            close();
            render();
            toast(`Imported ${res.imported} pantry items!`);
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
    });
  }

  render();
}
