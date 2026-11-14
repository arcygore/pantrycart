import { api } from "../api.js";
import { closeModal, esc, openModal, toast } from "../utils.js";

export async function renderStoresView(container, state) {
  let stores = await api("/api/stores");
  if (!state.activeStoreId || !stores.some((s) => s.id === state.activeStoreId)) {
    state.activeStoreId = stores[0]?.id || null;
  }
  let locations = state.activeStoreId ? await api(`/api/stores/${state.activeStoreId}/locations`) : [];
  let locSearch = "";

  function render() {
    const activeStore = stores.find((s) => s.id === state.activeStoreId);
    const filteredLocs = locations.filter((l) => {
      if (!locSearch.trim()) return true;
      const q = locSearch.trim().toLowerCase();
      return (
        l.item_display.toLowerCase().includes(q) ||
        l.department.toLowerCase().includes(q) ||
        l.aisle.toLowerCase().includes(q)
      );
    });

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Stores &amp; Aisle Maps</h1>
          <p class="page-subtitle">Configure department walking order &amp; exact aisle numbers per store</p>
        </div>
        <button class="btn btn-primary btn-sm" id="add-store-btn">+ Add Custom Store</button>
      </div>

      <div class="list-tabs">
        ${stores.map((s) => `
          <button class="list-tab ${s.id === activeStore?.id ? "active" : ""}" data-store-id="${s.id}">
            <span>${esc(s.name)}</span>
          </button>
        `).join("")}
      </div>

      ${activeStore ? `
        <div class="grid-2" style="align-items: start;">
          <div class="card stack-md">
            <div class="row" style="justify-content: space-between;">
              <div>
                <h2 style="margin: 0; font-size: 1.08rem;">${esc(activeStore.name)} Layout</h2>
                <span class="badge">${esc(activeStore.store_type)}</span>
              </div>
              <button class="btn btn-sm" id="edit-store-btn">Edit Departments</button>
            </div>
            <p class="small muted" style="margin: 0;">Walking order from top to bottom. Items in aisle-enabled departments sort by aisle number.</p>
            <div class="stack-sm">
              ${activeStore.departments.map((d, idx) => {
                const usesAisle = activeStore.aisle_departments.includes(d);
                return `
                  <div class="row" style="justify-content: space-between; padding: 7px 10px; background: var(--bg); border-radius: 8px;">
                    <span><strong>${idx + 1}.</strong> ${esc(d)}</span>
                    ${usesAisle ? `<span class="badge badge-accent">Sorted by Aisle</span>` : `<span class="badge">Section</span>`}
                  </div>
                `;
              }).join("")}
            </div>
          </div>

          <div class="card stack-md">
            <div class="row" style="justify-content: space-between;">
              <h2 style="margin: 0; font-size: 1.08rem;">Item Aisle Map (${locations.length})</h2>
              <button class="btn btn-primary btn-sm" id="add-loc-btn">+ Map Item</button>
            </div>
            <input class="input" id="loc-search" value="${esc(locSearch)}" placeholder="Filter mapped items or aisles..." />
            ${filteredLocs.length === 0 ? `
              <p class="small muted" style="margin: 8px 0;">
                No custom aisle mappings saved for ${esc(activeStore.name)} yet. Map items here or tap any item's <strong>+ Aisle</strong> button while shopping!
              </p>
            ` : `
              <div class="stack-sm">
                ${filteredLocs.map((loc) => `
                  <div class="row" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
                    <div class="grow">
                      <div style="font-weight: 700;">${esc(loc.item_display)}</div>
                      <div class="small muted">${esc(loc.department)}</div>
                    </div>
                    <div class="row" style="gap: 6px;">
                      <span class="aisle-pill ${loc.aisle ? "has-aisle" : ""}">${loc.aisle ? `Aisle ${esc(loc.aisle)}` : "No aisle"}</span>
                      <button class="btn btn-sm edit-loc-btn" data-id="${loc.id}">Edit</button>
                      <button class="btn btn-sm btn-danger del-loc-btn" data-id="${loc.id}">✕</button>
                    </div>
                  </div>
                `).join("")}
              </div>
            `}
          </div>
        </div>
      ` : ""}
    `;

    bindEvents(activeStore);
  }

  function bindEvents(activeStore) {
    document.querySelectorAll("[data-store-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.activeStoreId = Number(btn.dataset.storeId);
        locations = await api(`/api/stores/${state.activeStoreId}/locations`);
        render();
      });
    });

    document.getElementById("loc-search")?.addEventListener("input", (e) => {
      locSearch = e.target.value;
      render();
      const el = document.getElementById("loc-search");
      el?.focus();
      el?.setSelectionRange(locSearch.length, locSearch.length);
    });

    document.getElementById("add-store-btn")?.addEventListener("click", () => {
      openModal("Add Custom Store", `
        <form id="create-store-form" class="stack-md">
          <div>
            <label class="field-label">Store Name</label>
            <input class="input" name="name" placeholder="e.g. Kroger - Main St, Trader Joe's, Publix #412" required />
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">Store Type</label>
              <select class="select" name="store_type">
                <option value="grocery">Grocery Store</option>
                <option value="warehouse">Warehouse (Costco/Sam's)</option>
                <option value="hardware">Hardware (Home Depot/Lowe's)</option>
                <option value="home">Home Goods (IKEA/Target)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label class="field-label">Copy Aisle Map From (optional)</label>
              <select class="select" name="clone_id">
                <option value="">Start blank</option>
                ${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div>
            <label class="field-label">Departments (one per line, in walking order)</label>
            <textarea class="textarea" name="departments" style="min-height: 150px;">Produce
Bakery &amp; Deli
Meat &amp; Seafood
Dry Goods
Beverages
Frozen
Dairy &amp; Eggs
Household &amp; Personal
Other</textarea>
          </div>
          <div>
            <label class="field-label">Departments sorted by Aisle (comma-separated)</label>
            <input class="input" name="aisle_departments" value="Dry Goods, Beverages, Household & Personal" />
          </div>
          <button class="btn btn-primary" type="submit">Create Store</button>
        </form>
      `, (close) => {
        document.getElementById("create-store-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const depts = f.departments.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          const aisleDepts = f.aisle_departments.value.split(",").map((x) => x.trim()).filter(Boolean);
          const created = await api("/api/stores", {
            method: "POST",
            body: {
              name: f.name.value.trim(),
              store_type: f.store_type.value,
              departments: depts,
              aisle_departments: aisleDepts,
              clone_locations_from_store_id: f.clone_id.value ? Number(f.clone_id.value) : null,
            },
          });
          stores = await api("/api/stores");
          state.activeStoreId = created.id;
          locations = await api(`/api/stores/${created.id}/locations`);
          close();
          render();
          toast(`Added "${created.name}"`);
        });
      });
    });

    document.getElementById("edit-store-btn")?.addEventListener("click", () => {
      if (!activeStore) return;
      openModal(`Edit ${activeStore.name} Layout`, `
        <form id="edit-store-form" class="stack-md">
          <div>
            <label class="field-label">Store Name</label>
            <input class="input" name="name" value="${esc(activeStore.name)}" required />
          </div>
          <div>
            <label class="field-label">Departments (one per line, in walking order)</label>
            <textarea class="textarea" name="departments" style="min-height: 170px;">${esc(activeStore.departments.join("\n"))}</textarea>
          </div>
          <div>
            <label class="field-label">Departments sorted by Aisle (comma-separated)</label>
            <input class="input" name="aisle_departments" value="${esc(activeStore.aisle_departments.join(", "))}" />
          </div>
          <div class="row" style="justify-content: space-between;">
            <button class="btn btn-danger" type="button" id="delete-store-btn">Delete Store</button>
            <button class="btn btn-primary" type="submit">Save Store</button>
          </div>
        </form>
      `, (close) => {
        document.getElementById("delete-store-btn").addEventListener("click", async () => {
          if (!confirm(`Delete store "${activeStore.name}" and its aisle map?`)) return;
          await api(`/api/stores/${activeStore.id}`, { method: "DELETE" });
          stores = await api("/api/stores");
          state.activeStoreId = stores[0]?.id || null;
          locations = state.activeStoreId ? await api(`/api/stores/${state.activeStoreId}/locations`) : [];
          close();
          render();
          toast("Store deleted");
        });

        document.getElementById("edit-store-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const depts = f.departments.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          const aisleDepts = f.aisle_departments.value.split(",").map((x) => x.trim()).filter(Boolean);
          await api(`/api/stores/${activeStore.id}`, {
            method: "PUT",
            body: { name: f.name.value.trim(), departments: depts, aisle_departments: aisleDepts },
          });
          stores = await api("/api/stores");
          close();
          render();
          toast("Store layout updated");
        });
      });
    });

    const openLocModal = (existing) => {
      openModal(existing ? `Edit Location — ${existing.item_display}` : `Map Item for ${activeStore.name}`, `
        <form id="loc-form" class="stack-md">
          <div>
            <label class="field-label">Item Name</label>
            <input class="input" name="item_display" value="${esc(existing?.item_display || "")}" placeholder="e.g. Black Beans (Canned)" required />
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">Department</label>
              <select class="select" name="department">
                ${activeStore.departments.map((d) => `<option value="${esc(d)}" ${d === (existing?.department || "Dry Goods") ? "selected" : ""}>${esc(d)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="field-label">Aisle / Bay / Row</label>
              <input class="input" name="aisle" value="${esc(existing?.aisle || "")}" placeholder="e.g. 7, 7B, Bay 14" />
            </div>
          </div>
          <button class="btn btn-primary" type="submit">Save Mapping</button>
        </form>
      `, (close) => {
        document.getElementById("loc-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          await api(`/api/stores/${activeStore.id}/locations`, {
            method: "PUT",
            body: {
              item_key: existing?.item_key || "",
              item_display: f.item_display.value.trim(),
              department: f.department.value,
              aisle: f.aisle.value.trim(),
            },
          });
          locations = await api(`/api/stores/${activeStore.id}/locations`);
          close();
          render();
          toast("Aisle mapping saved");
        });
      });
    };

    document.getElementById("add-loc-btn")?.addEventListener("click", () => openLocModal(null));
    document.querySelectorAll(".edit-loc-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const loc = locations.find((l) => l.id === Number(btn.dataset.id));
        if (loc) openLocModal(loc);
      });
    });
    document.querySelectorAll(".del-loc-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/stores/${activeStore.id}/locations/${btn.dataset.id}`, { method: "DELETE" });
        locations = await api(`/api/stores/${activeStore.id}/locations`);
        render();
      });
    });
  }

  render();
}
