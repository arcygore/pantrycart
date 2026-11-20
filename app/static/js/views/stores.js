import { api, apiUpload } from "../api.js";
import { bindOverflowMenus, esc, openModal, overflowMenu, toast } from "../utils.js";

export async function renderStoresView(container, state) {
  let stores = await api("/api/stores");
  if (!state.activeStoreId || !stores.some((s) => s.id === state.activeStoreId)) {
    state.activeStoreId = stores[0]?.id || null;
  }
  let locations = state.activeStoreId ? await api(`/api/stores/${state.activeStoreId}/locations`) : [];
  let storeTab = state.storeSubTab || "path"; // "path" | "aisles" | "settings"
  let locSearch = "";
  let isSyncingKroger = false;
  const isGuest = Boolean(state.user?.is_guest);

  async function syncStoreFromKroger(storeId, quietIfEmpty = false) {
    isSyncingKroger = true;
    render();
    try {
      const res = await api(`/api/kroger/sync-store/${storeId}`, { method: "POST" });
      [stores, locations] = await Promise.all([
        api("/api/stores"),
        api(`/api/stores/${storeId}/locations`),
      ]);
      isSyncingKroger = false;
      render();
      if (!quietIfEmpty || res.synced_count > 0) {
        toast(`Synced ${res.synced_count} aisle${res.synced_count === 1 ? "" : "s"} from ${res.location_name || "Kroger"}!`);
      }
      return res;
    } catch (err) {
      isSyncingKroger = false;
      render();
      if (!quietIfEmpty) toast(err.message || "Could not sync Kroger aisles", true);
      return null;
    }
  }

  function render() {
    const activeStore = stores.find((s) => s.id === state.activeStoreId);
    const activeIndex = stores.findIndex((s) => s.id === state.activeStoreId);
    if (isGuest && storeTab === "settings") {
      storeTab = "path";
      state.storeSubTab = "path";
    }

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
          <h1 class="page-title">Stores</h1>
          <p class="page-subtitle">Personal walking order, aisle maps &amp; Kroger store links</p>
        </div>
        <div class="row" style="gap: 6px;">
          ${isGuest ? `<span class="badge badge-accent">Guest (Personal Path)</span>` : `
            <button class="btn btn-primary btn-sm" id="add-store-btn">+ Store</button>
            ${overflowMenu([
              { id: "reorder-stores-btn", label: "↕ Reorder Top Bar" },
            ], { title: "Store bar options" })}
          `}
        </div>
      </div>

      <div class="list-tabs">
        ${stores.map((s) => `
          <button class="list-tab ${s.id === activeStore?.id ? "active" : ""}" data-store-id="${s.id}">
            <span>${esc(s.name)}</span>
          </button>
        `).join("")}
      </div>

      ${activeStore ? `
        <div class="row-wrap" style="justify-content: space-between; margin-bottom: 10px; gap: 6px;">
          <div class="row-wrap" style="gap: 6px;">
            <span class="badge">${esc(activeStore.store_type)}</span>
            <span class="badge badge-primary">Pos #${activeIndex + 1}</span>
            ${activeStore.has_custom_path
              ? `<span class="badge badge-info">Your Custom Path</span>`
              : `<span class="badge">Shared Default</span>`}
            ${activeStore.kroger_location_id
              ? `<span class="badge badge-info" title="${esc(activeStore.kroger_location_address || "")}">🏪 ${esc(activeStore.kroger_location_name || ("Kroger #" + activeStore.kroger_location_id))}</span>`
              : ""}
          </div>
        </div>

        <div class="subtabs">
          <button type="button" class="subtab ${storeTab === "path" ? "active" : ""}" data-stab="path">Walking Path</button>
          <button type="button" class="subtab ${storeTab === "aisles" ? "active" : ""}" data-stab="aisles">Aisle Map (${locations.length})</button>
          ${isGuest ? "" : `
            <button type="button" class="subtab ${storeTab === "settings" ? "active" : ""}" data-stab="settings">Store Settings</button>
          `}
        </div>

        ${storeTab === "path" ? `
          <div class="card stack-md">
            <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
              <p class="small muted" style="margin: 0; flex: 1; min-width: 180px;">
                Your personal walking order (top to bottom). Other household members keep their own path.
              </p>
              <div class="row" style="gap: 6px; flex-wrap: wrap;">
                <button class="btn btn-sm" id="reverse-path-btn" type="button" title="Reverse walking direction">⇄ Reverse</button>
                ${activeStore.has_custom_path ? `
                  <button class="btn btn-sm" id="reset-path-btn" type="button">Reset Default</button>
                ` : ""}
              </div>
            </div>
            <div class="stack-sm">
              ${activeStore.departments.map((d, idx) => {
                const usesAisle = activeStore.aisle_departments.includes(d);
                return `
                  <div class="row" style="justify-content: space-between; padding: 7px 10px; background: var(--bg); border-radius: 8px;">
                    <span><strong>${idx + 1}.</strong> ${esc(d)}</span>
                    <div class="row" style="gap: 6px;">
                      ${usesAisle ? `<span class="badge badge-accent">Aisles</span>` : `<span class="badge">Section</span>`}
                      <button class="btn btn-sm move-dept-up" data-idx="${idx}" ${idx === 0 ? "disabled" : ""} title="Move earlier">↑</button>
                      <button class="btn btn-sm move-dept-down" data-idx="${idx}" ${idx === activeStore.departments.length - 1 ? "disabled" : ""} title="Move later">↓</button>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        ` : ""}

        ${storeTab === "aisles" ? `
          <div class="card stack-md">
            <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
              <input class="input grow" id="loc-search" value="${esc(locSearch)}" placeholder="Filter mapped items or aisles..." style="min-width: 170px;" />
              <div class="row" style="gap: 6px; flex-wrap: wrap;">
                ${(activeStore.kroger_location_id && !isGuest) ? `
                  <button class="btn btn-sm" id="sync-kroger-store-btn" type="button" ${isSyncingKroger ? "disabled" : ""}>
                    ${isSyncingKroger ? "Syncing..." : "🔄 Sync Kroger Aisles"}
                  </button>
                ` : ""}
                ${isGuest ? "" : `
                  <button class="btn btn-primary btn-sm" id="add-loc-btn">+ Map Item</button>
                  ${overflowMenu([
                    { id: "bulk-import-locs-btn", label: "📥 Bulk Import (.csv / .xlsx)" },
                  ], { title: "Aisle map options" })}
                `}
              </div>
            </div>

            ${filteredLocs.length === 0 ? `
              <p class="small muted" style="margin: 8px 0;">
                No aisle mappings saved for ${esc(activeStore.name)} yet. ${activeStore.kroger_location_id ? `Tap <strong>🔄 Sync Kroger Aisles</strong>, map` : "Map"} items manually, or tap <strong>+ Aisle</strong> while shopping!
              </p>
            ` : `
              <div class="stack-sm">
                ${filteredLocs.map((loc) => `
                  <div class="row" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
                    <div class="grow">
                      <div style="font-weight: 700;">${esc(loc.item_display)}</div>
                      <div class="small muted">${esc(loc.department)}${loc.source === "kroger" ? " · Kroger API" : ""}</div>
                    </div>
                    <div class="row" style="gap: 6px;">
                      <span class="aisle-pill ${loc.aisle ? "has-aisle" : ""}">${loc.aisle ? `Aisle ${esc(loc.aisle)}` : "No aisle"}</span>
                      ${isGuest ? "" : `
                        <button class="btn btn-sm edit-loc-btn" data-id="${loc.id}">Edit</button>
                        <button class="btn btn-sm btn-danger del-loc-btn" data-id="${loc.id}">✕</button>
                      `}
                    </div>
                  </div>
                `).join("")}
              </div>
            `}
          </div>
        ` : ""}

        ${(storeTab === "settings" && !isGuest) ? `
          <div class="stack-md">
            ${(activeStore.store_type === "grocery" || activeStore.kroger_location_id) ? `
              <div class="card stack-sm">
                <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
                  <div>
                    <h3 style="margin: 0; font-size: 1rem;">Kroger Store Link</h3>
                    <p class="small muted" style="margin: 2px 0 0;">
                      ${activeStore.kroger_location_id
                        ? `Linked to <strong>${esc(activeStore.kroger_location_name || activeStore.kroger_location_id)}</strong>${activeStore.kroger_location_address ? ` (${esc(activeStore.kroger_location_address)})` : ""}`
                        : "Link a Kroger-family store (Kroger, Mariano's, Pick 'n Save, Fred Meyer, Ralphs, Harris Teeter) for automatic aisle sync and Cart Push."}
                    </p>
                  </div>
                  <div class="row-wrap" style="gap: 6px;">
                    <button class="btn btn-sm btn-primary" id="link-kroger-store-btn" type="button">
                      🏪 ${activeStore.kroger_location_id ? "Change Kroger Store" : "Link Kroger Store"}
                    </button>
                    ${activeStore.kroger_location_id ? `
                      <button class="btn btn-sm" id="sync-kroger-settings-btn" type="button" ${isSyncingKroger ? "disabled" : ""}>
                        ${isSyncingKroger ? "Syncing..." : "🔄 Sync Aisle Map"}
                      </button>
                      <button class="btn btn-sm btn-danger" id="unlink-inline-kroger-btn" type="button">Unlink</button>
                    ` : ""}
                  </div>
                </div>
              </div>
            ` : ""}

            <div class="card stack-md">
              <h3 style="margin: 0; font-size: 1rem;">Edit ${esc(activeStore.name)} Layout &amp; Position</h3>
              <form id="inline-edit-store-form" class="stack-md">
                <div class="grid-2">
                  <div>
                    <label class="field-label">Store Name</label>
                    <input class="input" name="name" value="${esc(activeStore.name)}" required />
                  </div>
                  <div>
                    <label class="field-label">Position on Top Bar (1 = First, ${stores.length} = Last)</label>
                    <input class="input" name="position" type="number" min="1" max="${stores.length}" value="${activeIndex + 1}" required />
                  </div>
                </div>
                <div>
                  <label class="field-label">Departments (one per line, in default walking order)</label>
                  <textarea class="textarea" name="departments" style="min-height: 150px;">${esc((activeStore.shared_departments || activeStore.departments).join("\n"))}</textarea>
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
            </div>
          </div>
        ` : ""}
      ` : ""}
    `;

    bindOverflowMenus(container);
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

    document.querySelectorAll("[data-stab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        storeTab = btn.dataset.stab;
        state.storeSubTab = storeTab;
        render();
      });
    });

    document.querySelectorAll(".move-dept-up").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!activeStore) return;
        const i = Number(btn.dataset.idx);
        const depts = [...activeStore.departments];
        [depts[i - 1], depts[i]] = [depts[i], depts[i - 1]];
        await api(`/api/stores/${activeStore.id}/walking-path`, {
          method: "PUT",
          body: { departments: depts },
        });
        stores = await api("/api/stores");
        render();
        toast("Personal walking path updated!");
      });
    });

    document.querySelectorAll(".move-dept-down").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!activeStore) return;
        const i = Number(btn.dataset.idx);
        const depts = [...activeStore.departments];
        [depts[i + 1], depts[i]] = [depts[i], depts[i + 1]];
        await api(`/api/stores/${activeStore.id}/walking-path`, {
          method: "PUT",
          body: { departments: depts },
        });
        stores = await api("/api/stores");
        render();
        toast("Personal walking path updated!");
      });
    });

    document.getElementById("reverse-path-btn")?.addEventListener("click", async () => {
      if (!activeStore) return;
      await api(`/api/stores/${activeStore.id}/walking-path`, {
        method: "PUT",
        body: { reverse: true },
      });
      stores = await api("/api/stores");
      render();
      toast("Reversed your walking path!");
    });

    document.getElementById("reset-path-btn")?.addEventListener("click", async () => {
      if (!activeStore) return;
      await api(`/api/stores/${activeStore.id}/walking-path`, { method: "DELETE" });
      stores = await api("/api/stores");
      render();
      toast("Reset to shared default walking order");
    });

    document.getElementById("loc-search")?.addEventListener("input", (e) => {
      locSearch = e.target.value;
      render();
      const el = document.getElementById("loc-search");
      el?.focus();
      el?.setSelectionRange(locSearch.length, locSearch.length);
    });

    document.getElementById("sync-kroger-store-btn")?.addEventListener("click", () => {
      if (activeStore) syncStoreFromKroger(activeStore.id, false);
    });
    document.getElementById("sync-kroger-settings-btn")?.addEventListener("click", () => {
      if (activeStore) syncStoreFromKroger(activeStore.id, false);
    });

    document.getElementById("unlink-inline-kroger-btn")?.addEventListener("click", async () => {
      if (!activeStore) return;
      await api(`/api/stores/${activeStore.id}`, {
        method: "PUT",
        body: { kroger_location_id: "", kroger_location_name: "", kroger_location_address: "" },
      });
      [stores, locations] = await Promise.all([
        api("/api/stores"),
        api(`/api/stores/${activeStore.id}/locations`),
      ]);
      render();
      toast("Unlinked Kroger store & cleared Kroger-synced aisles");
    });

    document.getElementById("delete-store-btn")?.addEventListener("click", async () => {
      if (!activeStore || !confirm(`Delete store "${activeStore.name}" and its aisle map?`)) return;
      await api(`/api/stores/${activeStore.id}`, { method: "DELETE" });
      stores = await api("/api/stores");
      state.activeStoreId = stores[0]?.id || null;
      locations = state.activeStoreId ? await api(`/api/stores/${state.activeStoreId}/locations`) : [];
      render();
      toast("Store deleted");
    });

    document.getElementById("inline-edit-store-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!activeStore) return;
      const f = e.target;
      const depts = f.departments.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const aisleDepts = f.aisle_departments.value.split(",").map((x) => x.trim()).filter(Boolean);
      await api(`/api/stores/${activeStore.id}`, {
        method: "PUT",
        body: {
          name: f.name.value.trim(),
          departments: depts,
          aisle_departments: aisleDepts,
          position: f.position.value ? Number(f.position.value) : null,
        },
      });
      stores = await api("/api/stores");
      render();
      toast("Store layout & position updated");
    });

    document.getElementById("reorder-stores-btn")?.addEventListener("click", () => {
      let ordered = [...stores];
      const renderOrderBody = () => `
        <div class="stack-md">
          <p class="small muted" style="margin: 0;">Place stores in any order you like on the top bar and dropdowns.</p>
          <div class="stack-sm">
            ${ordered.map((s, idx) => `
              <div class="row" style="justify-content: space-between; padding: 8px 10px; background: var(--bg); border-radius: 9px;">
                <span><strong>${idx + 1}.</strong> ${esc(s.name)} <span class="badge">${esc(s.store_type)}</span></span>
                <div class="row" style="gap: 4px;">
                  <button class="btn btn-sm move-store-up" data-idx="${idx}" ${idx === 0 ? "disabled" : ""}>↑</button>
                  <button class="btn btn-sm move-store-down" data-idx="${idx}" ${idx === ordered.length - 1 ? "disabled" : ""}>↓</button>
                </div>
              </div>
            `).join("")}
          </div>
          <button class="btn btn-primary" id="save-store-order-btn">Save Top Bar Order</button>
        </div>
      `;

      openModal("Reorder Stores on Top Bar", renderOrderBody(), (close) => {
        const bindOrder = () => {
          document.querySelectorAll(".move-store-up").forEach((b) => {
            b.addEventListener("click", () => {
              const i = Number(b.dataset.idx);
              [ordered[i - 1], ordered[i]] = [ordered[i], ordered[i - 1]];
              document.getElementById("modal-body").innerHTML = renderOrderBody();
              bindOrder();
            });
          });
          document.querySelectorAll(".move-store-down").forEach((b) => {
            b.addEventListener("click", () => {
              const i = Number(b.dataset.idx);
              [ordered[i + 1], ordered[i]] = [ordered[i], ordered[i + 1]];
              document.getElementById("modal-body").innerHTML = renderOrderBody();
              bindOrder();
            });
          });
          document.getElementById("save-store-order-btn")?.addEventListener("click", async () => {
            stores = await api("/api/stores/reorder", {
              method: "POST",
              body: { store_ids: ordered.map((x) => x.id) },
            });
            close();
            render();
            toast("Store top bar order saved!");
          });
        };
        bindOrder();
      });
    });

    document.getElementById("add-store-btn")?.addEventListener("click", () => {
      openModal("Add Custom Store", `
        <form id="create-store-form" class="stack-md">
          <div class="grid-2">
            <div>
              <label class="field-label">Store Name</label>
              <input class="input" name="name" placeholder="e.g. Kroger - Main St, Trader Joe's" required />
            </div>
            <div>
              <label class="field-label">Position on Top Bar (1 = First)</label>
              <input class="input" name="position" type="number" min="1" max="${stores.length + 1}" value="${stores.length + 1}" />
            </div>
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
Bakery & Deli
Meat & Seafood
Dry Goods
Beverages
Frozen
Dairy & Eggs
Household & Personal
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
              position: f.position.value ? Number(f.position.value) : null,
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

    document.getElementById("bulk-import-locs-btn")?.addEventListener("click", () => {
      if (!activeStore) return;
      openModal(`Bulk Import Aisle Map for ${activeStore.name}`, `
        <form id="import-locs-form" class="stack-md">
          <p class="small muted" style="margin: 0;">
            Upload a <code>.csv</code> or <code>.xlsx</code> file with columns: <code>item</code>, <code>department</code>, <code>aisle</code>.
          </p>
          <input class="input" type="file" name="file" accept=".csv,.xlsx" required />
          <button class="btn btn-primary" type="submit">Upload &amp; Map Items</button>
        </form>
      `, (close) => {
        document.getElementById("import-locs-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            const res = await apiUpload(`/api/import/store-locations/${activeStore.id}`, fd);
            locations = await api(`/api/stores/${activeStore.id}/locations`);
            close();
            render();
            toast(`Mapped ${res.imported} items for ${activeStore.name}!`);
          } catch (err) {
            toast(err.message, true);
          }
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

    const openLinkKrogerModal = () => {
      openModal(`Link Kroger Store — ${activeStore.name}`, `
        <div class="stack-md">
          <p class="small muted" style="margin: 0;">
            Link <strong>${esc(activeStore.name)}</strong> to a Kroger-family store. Linking automatically syncs your Aisle Map and active shopping lists to that store!
          </p>
          ${activeStore.kroger_location_id ? `
            <div class="row-wrap" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);">
              <div class="small">
                <strong>Currently linked:</strong> ${esc(activeStore.kroger_location_name || activeStore.kroger_location_id)}
                ${activeStore.kroger_location_address ? `<div class="muted">${esc(activeStore.kroger_location_address)}</div>` : ""}
              </div>
              <button class="btn btn-sm btn-danger" type="button" id="unlink-store-kroger-btn">Unlink</button>
            </div>
          ` : ""}
          <form id="store-kroger-zip-form" class="row-wrap">
            <input class="input grow" id="store-kroger-zip-input" placeholder="Enter 5-digit ZIP code (e.g. 30068)" required />
            <button class="btn btn-primary" type="submit">Find Stores</button>
          </form>
          <div id="store-kroger-loc-results" class="stack-sm"></div>
          <p class="small muted" style="margin: 0;">Requires Kroger Client ID &amp; Secret configured in Settings → Kroger.</p>
        </div>
      `, (close) => {
        document.getElementById("unlink-store-kroger-btn")?.addEventListener("click", async () => {
          await api(`/api/stores/${activeStore.id}`, {
            method: "PUT",
            body: {
              kroger_location_id: "",
              kroger_location_name: "",
              kroger_location_address: "",
            },
          });
          [stores, locations] = await Promise.all([
            api("/api/stores"),
            api(`/api/stores/${activeStore.id}/locations`),
          ]);
          close();
          render();
          toast("Unlinked Kroger store");
        });

        document.getElementById("store-kroger-zip-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const zip = document.getElementById("store-kroger-zip-input").value.trim();
          const resBox = document.getElementById("store-kroger-loc-results");
          resBox.innerHTML = `<div class="small muted">Searching Kroger locations near ${esc(zip)}...</div>`;
          try {
            const locs = await api(`/api/kroger/locations?zip_code=${encodeURIComponent(zip)}`);
            if (!locs.length) {
              resBox.innerHTML = `<div class="small muted">No Kroger-family stores found near ${esc(zip)}.</div>`;
              return;
            }
            resBox.innerHTML = locs.map((l) => `
              <div class="row-wrap" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);">
                <div>
                  <div style="font-weight: 700;">${esc(l.name)} <span class="badge">${esc(l.chain || "Kroger")}</span></div>
                  <div class="small muted">${esc(l.address)} · ID ${esc(l.location_id)}</div>
                </div>
                <button class="btn btn-primary btn-sm pick-store-kroger-btn" type="button"
                  data-id="${esc(l.location_id)}"
                  data-name="${esc(l.name)}"
                  data-addr="${esc(l.address)}">Select &amp; Sync</button>
              </div>
            `).join("");
            resBox.querySelectorAll(".pick-store-kroger-btn").forEach((btn) => {
              btn.addEventListener("click", async () => {
                btn.disabled = true;
                btn.textContent = "Linking & Syncing...";
                await api(`/api/stores/${activeStore.id}`, {
                  method: "PUT",
                  body: {
                    kroger_location_id: btn.dataset.id,
                    kroger_location_name: btn.dataset.name,
                    kroger_location_address: btn.dataset.addr,
                  },
                });
                close();
                toast(`Linked ${activeStore.name} to ${btn.dataset.name}!`);
                await syncStoreFromKroger(activeStore.id, true);
              });
            });
          } catch (err) {
            resBox.innerHTML = `<div class="small" style="color: var(--danger);">${esc(err.message)}</div>`;
          }
        });
      });
    };

    document.getElementById("link-kroger-store-btn")?.addEventListener("click", openLinkKrogerModal);
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
