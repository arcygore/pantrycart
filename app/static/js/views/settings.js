import { api } from "../api.js";
import { isShortcutReady, openShortcutSetupModal } from "../nutrition_ui.js";
import { closeModal, esc, openModal, toast } from "../utils.js";

export async function renderSettingsView(container, state, onLogout) {
  const isGuest = Boolean(state.user?.is_guest);
  let tab = state.settingsTab || "household";
  let users = isGuest ? [] : await api("/api/auth/users");
  let catalog = isGuest ? [] : await api("/api/catalog");
  let apiKeys = isGuest ? [] : await api("/api/auth/api-keys");
  let stores = isGuest ? [] : await api("/api/stores");
  let krogerStatus = isGuest ? null : await api("/api/kroger/status").catch(() => ({
    configured: false,
    client_id: "",
    has_client_secret: false,
    redirect_uri: `${window.location.origin}/api/kroger/oauth/callback`,
    location_id: "",
    location_name: "",
    location_address: "",
    linked_store_id: null,
    user_connected: false,
  }));
  let krogerSearchResults = [];
  let catSearch = "";
  let newlyCreatedKey = null;

  function render() {
    const origin = window.location.origin;

    if (isGuest) {
      container.innerHTML = `
        <div class="page-header">
          <div>
            <h1 class="page-title">Account</h1>
            <p class="page-subtitle">Signed in with a Guest account</p>
          </div>
          <button class="btn btn-sm" id="logout-btn">Sign Out (${esc(state.user.display_name)})</button>
        </div>
        <div class="card stack-md" style="max-width: 580px;">
          <div class="row" style="gap: 8px; align-items: center;">
            <strong style="font-size: 1.05rem;">${esc(state.user.display_name)}</strong>
            <span class="badge">@${esc(state.user.username)}</span>
            <span class="badge badge-accent">Guest Account</span>
          </div>
          <p class="small muted" style="margin: 0;">
            Guest accounts can add items to shopping lists, check off items, customize items you added yourself, request low pantry items onto a list, and set your own personal store walking path. Household settings, integrations, and deleting shared household data are restricted.
          </p>
        </div>
      `;
      bindEvents();
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Household accounts, US store package sizes, Kroger API &amp; Home Assistant</p>
        </div>
        <button class="btn btn-sm" id="logout-btn">Sign Out (${esc(state.user.display_name)})</button>
      </div>

      <div class="subtabs">
        <button class="subtab ${tab === "household" ? "active" : ""}" data-tab="household">Household</button>
        <button class="subtab ${tab === "catalog" ? "active" : ""}" data-tab="catalog">Packages</button>
        <button class="subtab ${tab === "kroger" ? "active" : ""}" data-tab="kroger">Kroger</button>
        <button class="subtab ${tab === "ha" ? "active" : ""}" data-tab="ha">Home Asst</button>
      </div>

      ${tab === "household" ? renderHouseholdTab()
        : tab === "catalog" ? renderCatalogTab()
        : tab === "kroger" ? renderKrogerTab(origin)
        : renderHaTab(origin)}
    `;

    bindEvents();
  }

  function renderHouseholdTab() {
    return `
      <div class="grid-2" style="align-items: start;">
        <div class="card stack-md">
          <div class="row" style="justify-content: space-between;">
            <h2 style="margin: 0; font-size: 1.08rem;">Family Members (${users.length})</h2>
            ${state.user.is_admin ? `<button class="btn btn-primary btn-sm" id="add-member-btn">+ Add Member</button>` : ""}
          </div>
          <div class="stack-sm">
            ${users.map((u) => `
              <div class="row" style="justify-content: space-between; padding: 9px 10px; background: var(--bg); border-radius: 9px;">
                <div>
                  <div style="font-weight: 700;">
                    ${esc(u.display_name)}
                    ${u.is_admin ? `<span class="badge badge-primary">Admin</span>` : ""}
                    ${u.is_guest ? `<span class="badge badge-accent">Guest</span>` : ""}
                  </div>
                  <div class="small muted">@${esc(u.username)}</div>
                </div>
                ${(state.user.is_admin && u.id !== state.user.id) ? `
                  <button class="btn btn-sm btn-danger del-user-btn" data-id="${u.id}">Remove</button>
                ` : ""}
              </div>
            `).join("")}
          </div>
        </div>

        <div class="card stack-md">
          <h2 style="margin: 0; font-size: 1.08rem;">Change Your Password</h2>
          <form id="change-pw-form" class="stack-sm">
            <div>
              <label class="field-label">Current Password</label>
              <input class="input" name="current_password" type="password" required />
            </div>
            <div>
              <label class="field-label">New Password</label>
              <input class="input" name="new_password" type="password" minlength="4" required />
            </div>
            <button class="btn btn-primary" type="submit">Update Password</button>
          </form>
        </div>

        <div class="card stack-md">
          <h2 style="margin: 0; font-size: 1.08rem;">Appearance (Theme)</h2>
          <p class="small muted" style="margin: 0;">Choose light or dark mode for this browser.</p>
          <div class="row-wrap" style="gap: 8px;">
            <button type="button" class="btn ${document.documentElement.dataset.theme !== "dark" ? "btn-primary" : ""}" id="settings-theme-light">☀️ Light Mode</button>
            <button type="button" class="btn ${document.documentElement.dataset.theme === "dark" ? "btn-primary" : ""}" id="settings-theme-dark">🌙 Dark Mode</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderCatalogTab() {
    const filtered = catalog.filter((c) => {
      if (!catSearch.trim()) return true;
      const q = catSearch.trim().toLowerCase();
      return (
        c.display_name.toLowerCase().includes(q) ||
        c.canonical_name.toLowerCase().includes(q) ||
        c.default_department.toLowerCase().includes(q)
      );
    });

    return `
      <div class="card stack-md">
        <div class="row-wrap" style="justify-content: space-between;">
          <div>
            <h2 style="margin: 0; font-size: 1.08rem;">Standard US Grocery Package Sizes (${catalog.length})</h2>
            <p class="small muted" style="margin: 2px 0 0;">Used to convert recipe amounts (e.g. "24 oz broth") into store packages ("1 × 32 oz carton").</p>
          </div>
          <button class="btn btn-primary btn-sm" id="add-cat-btn">+ Add Product</button>
        </div>

        <input class="input" id="cat-search" value="${esc(catSearch)}" placeholder="Search products (e.g. garlic, black beans, butter)..." />

        <div class="stack-sm">
          ${filtered.slice(0, 60).map((c) => `
            <div class="row" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
              <div class="grow">
                <div style="font-weight: 700;">
                  ${esc(c.display_name)}
                </div>
                <div class="small muted">${esc(c.default_department)} · Std Size: ${esc(c.package_size)} ${esc(c.package_unit)} (${esc(c.package_label)})</div>
              </div>
              <button class="btn btn-sm edit-cat-btn" data-id="${c.id}">Edit Std Size</button>
            </div>
          `).join("")}
          ${filtered.length > 60 ? `<p class="small muted">Showing first 60 matches — refine search to see more.</p>` : ""}
        </div>
      </div>
    `;
  }

  function renderKrogerTab(origin) {
    const redirectUri = krogerStatus.redirect_uri || `${origin}/api/kroger/oauth/callback`;
    const shortcutOk = isShortcutReady(state);
    return `
      <div class="stack-md">
        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">Step 1: Kroger Developer API Credentials</h2>
              <p class="small muted" style="margin: 2px 0 0;">
                Create a free app on <a href="https://developer.kroger.com/" target="_blank" rel="noopener">developer.kroger.com</a> (Production or Certification environment) and enable <strong>Products</strong>, <strong>Locations</strong>, and <strong>Cart</strong> scopes.
              </p>
            </div>
            <span class="badge ${krogerStatus.configured ? "badge-primary" : "badge-accent"}">
              ${krogerStatus.configured ? "Credentials Verified ✓" : "Not Configured"}
            </span>
          </div>

          <div class="card" style="background: var(--bg); padding: 10px 12px;">
            <div class="small muted">Add this <strong>Redirect URI</strong> inside your Kroger Developer app settings:</div>
            <code style="word-break: break-all; font-weight: 700;">${esc(redirectUri)}</code>
          </div>

          <form id="kroger-config-form" class="stack-sm">
            <div class="grid-2">
              <div>
                <label class="field-label">Kroger Client ID</label>
                <input class="input" name="client_id" value="${esc(krogerStatus.client_id || "")}" placeholder="your-client-id" required />
              </div>
              <div>
                <label class="field-label">Kroger Client Secret</label>
                <input class="input" name="client_secret" type="password" placeholder="${krogerStatus.has_client_secret ? "******** (saved — leave blank to keep)" : "your-client-secret"}" ${krogerStatus.has_client_secret ? "" : "required"} />
              </div>
            </div>
            <div class="grid-2">
              <div>
                <label class="field-label">Linked PantryCart Store</label>
                <select class="select" name="linked_store_id">
                  <option value="">None / Auto</option>
                  ${stores.map((s) => `<option value="${s.id}" ${s.id === krogerStatus.linked_store_id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Custom Redirect URI Override (optional)</label>
                <input class="input" name="redirect_uri" value="${esc(krogerStatus.redirect_uri || "")}" placeholder="${esc(redirectUri)}" />
              </div>
            </div>
            <div>
              <button class="btn btn-primary" type="submit" id="save-kroger-btn">Save &amp; Verify Credentials</button>
            </div>
          </form>
        </div>

        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">Step 2: Map Kroger Stores (for Aisle &amp; Price Lookup)</h2>
              <p class="small muted" style="margin: 2px 0 0;">
                ${krogerStatus.location_id
                  ? `Default Global Store: <strong>${esc(krogerStatus.location_name)}</strong> — ${esc(krogerStatus.location_address)} (<code>${esc(krogerStatus.location_id)}</code>)`
                  : "Search by ZIP code after saving your credentials above."}
              </p>
            </div>
            ${krogerStatus.location_id ? `<span class="badge badge-primary">Store Selected ✓</span>` : ""}
          </div>

          <div class="stack-xs" style="padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg);">
            <div class="small" style="font-weight: 700;">Per-Store Kroger Mappings:</div>
            ${stores.filter((s) => s.store_type === "grocery" || s.kroger_location_id).map((s) => `
              <div class="row-wrap small" style="justify-content: space-between; gap: 6px;">
                <span><strong>${esc(s.name)}</strong></span>
                <span class="${s.kroger_location_id ? "badge badge-info" : "muted"}">
                  ${s.kroger_location_id
                    ? `🏪 ${esc(s.kroger_location_name || s.kroger_location_id)}`
                    : "Using global default"}
                </span>
              </div>
            `).join("")}
          </div>

          <form id="kroger-zip-form" class="row-wrap" style="align-items: center;">
            <select class="select" id="kroger-target-store-select" style="width: auto; min-width: 190px; min-height: 36px;">
              <option value="">Global Default Kroger Location</option>
              ${stores.filter((s) => s.store_type === "grocery" || s.kroger_location_id).map((s) => `
                <option value="${s.id}" ${krogerStatus.linked_store_id === s.id ? "selected" : ""}>Assign to: ${esc(s.name)}</option>
              `).join("")}
            </select>
            <input class="input" name="zip_code" placeholder="Enter 5-digit ZIP code (e.g. 30309)..." style="max-width: 240px;" required />
            <button class="btn btn-sm" type="submit" ${krogerStatus.configured ? "" : "disabled"}>Search Nearby Kroger Stores</button>
          </form>

          ${krogerSearchResults.length ? `
            <div class="stack-sm">
              ${krogerSearchResults.map((loc) => `
                <div class="row" style="justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px;">
                  <div>
                    <div style="font-weight: 700;">${esc(loc.name)} <span class="badge">${esc(loc.chain)}</span></div>
                    <div class="small muted">${esc(loc.address)} · ID: ${esc(loc.location_id)}</div>
                  </div>
                  <button class="btn btn-primary btn-sm select-kroger-loc-btn"
                    data-loc-id="${esc(loc.location_id)}"
                    data-loc-name="${esc(loc.name)}"
                    data-loc-addr="${esc(loc.address)}"
                    data-loc-chain="${esc(loc.chain)}" type="button">
                    Select Store
                  </button>
                </div>
              `).join("")}
            </div>
          ` : ""}
        </div>

        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">Step 3: Connect Your Personal Kroger Account (for Cart Push)</h2>
              <p class="small muted" style="margin: 2px 0 0;">Required by Kroger OAuth2 so PantryCart can push items directly into your Pickup / Delivery cart.</p>
            </div>
            <span class="badge ${krogerStatus.user_connected ? "badge-primary" : "badge-accent"}">
              ${krogerStatus.user_connected ? "Account Connected ✓" : "Not Signed In"}
            </span>
          </div>
          <div>
            <button class="btn btn-accent" id="connect-kroger-oauth-btn" type="button" ${krogerStatus.configured ? "" : "disabled"}>
              🛒 ${krogerStatus.user_connected ? "Reconnect Kroger Account" : "Connect Kroger Account"}
            </button>
          </div>
        </div>

        <div class="card stack-md">
          <div class="row-wrap" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">iOS Shortcut (Apple Health / Lose It! Sync)</h2>
              <p class="small muted" style="margin: 2px 0 0;">Configure and verify the 2-step shortcut used by This Week's Meal Calendar.</p>
            </div>
            <button class="btn btn-sm ${shortcutOk ? "" : "btn-primary"}" id="settings-shortcut-btn" type="button">
              ${shortcutOk ? "✓ Shortcut Verified (Manage)" : "Setup iOS Shortcut"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderHaTab(origin) {
    const yamlSnippet = `rest_command:
  pantrycart_low_stock:
    url: "${origin}/api/ha/low-stock"
    method: POST
    headers:
      X-API-Key: "YOUR_API_KEY_HERE"
      Content-Type: "application/json"
    payload: '{"item": "{{ item }}", "quantity": {{ quantity | default(1) }}, "list_type": "weekly"}'

sensor:
  - platform: rest
    name: PantryCart Weekly List Count
    resource: "${origin}/api/ha/lists"
    headers:
      X-API-Key: "YOUR_API_KEY_HERE"
    value_template: "{{ (value_json | selectattr('list_type', 'eq', 'weekly') | list | first).unchecked_count | default(0) }}"
    scan_interval: 120`;

    return `
      <div class="stack-md">
        <div class="card stack-md">
          <div class="row" style="justify-content: space-between;">
            <div>
              <h2 style="margin: 0; font-size: 1.08rem;">API Keys (Home Assistant / Shortcuts / RFID)</h2>
              <p class="small muted" style="margin: 2px 0 0;">Trigger low-stock additions from ESPHome weight sensors, NFC/RFID tags, or Apple Shortcuts.</p>
            </div>
            <button class="btn btn-primary btn-sm" id="create-key-btn">+ Generate API Key</button>
          </div>

          ${newlyCreatedKey ? `
            <div class="card" style="background: var(--primary-soft); border-color: var(--primary);">
              <div style="font-weight: 700; margin-bottom: 4px;">Save this API key now (shown once):</div>
              <code style="word-break: break-all; font-weight: 700;">${esc(newlyCreatedKey)}</code>
            </div>
          ` : ""}

          ${apiKeys.length === 0 ? `<p class="small muted" style="margin: 0;">No API keys created yet.</p>` : `
            <div class="stack-sm">
              ${apiKeys.map((k) => `
                <div class="row" style="justify-content: space-between; padding: 8px 10px; background: var(--bg); border-radius: 9px;">
                  <div>
                    <div style="font-weight: 700;">${esc(k.name)}</div>
                    <div class="small muted">Prefix: ${esc(k.key_prefix)} ${k.last_used_at ? `· Last used: ${esc(k.last_used_at.slice(0, 10))}` : ""}</div>
                  </div>
                  <button class="btn btn-sm btn-danger del-key-btn" data-id="${k.id}">Revoke</button>
                </div>
              `).join("")}
            </div>
          `}
        </div>

        <div class="card stack-sm">
          <h3 style="margin: 0;">Home Assistant <code>configuration.yaml</code> Example</h3>
          <p class="small muted" style="margin: 0;">When a pantry scale drops below threshold or an RFID tag is scanned, call <code>rest_command.pantrycart_low_stock</code>.</p>
          <div class="code-block">${esc(yamlSnippet)}</div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    document.getElementById("logout-btn")?.addEventListener("click", onLogout);

    document.querySelectorAll(".subtab").forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = btn.dataset.tab;
        state.settingsTab = tab;
        render();
      });
    });

    document.getElementById("add-member-btn")?.addEventListener("click", () => {
      openModal("Add Household Member or Guest", `
        <form id="add-user-form" class="stack-md">
          <div>
            <label class="field-label">Display Name</label>
            <input class="input" name="display_name" placeholder="e.g. Sarah" required />
          </div>
          <div>
            <label class="field-label">Username</label>
            <input class="input" name="username" placeholder="e.g. sarah" required />
          </div>
          <div>
            <label class="field-label">Password</label>
            <input class="input" name="password" type="password" minlength="4" required />
          </div>
          <div>
            <label class="field-label">Account Role</label>
            <select class="select" name="role">
              <option value="member">Household Member (Full Access)</option>
              <option value="admin">Admin (Full Access + Manage Accounts)</option>
              <option value="guest">Guest (Add/check items &amp; personal walking path only)</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit">Create Account</button>
        </form>
      `, (close) => {
        document.getElementById("add-user-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const role = f.role.value;
          try {
            await api("/api/auth/users", {
              method: "POST",
              body: {
                display_name: f.display_name.value.trim(),
                username: f.username.value.trim(),
                password: f.password.value,
                is_admin: role === "admin",
                is_guest: role === "guest",
              },
            });
            users = await api("/api/auth/users");
            close();
            render();
            toast("Account added!");
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
    });

    document.querySelectorAll(".del-user-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this household member?")) return;
        await api(`/api/auth/users/${btn.dataset.id}`, { method: "DELETE" });
        users = await api("/api/auth/users");
        render();
      });
    });

    document.getElementById("change-pw-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api("/api/auth/change-password", {
          method: "POST",
          body: { current_password: f.current_password.value, new_password: f.new_password.value },
        });
        f.reset();
        toast("Password updated!");
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("cat-search")?.addEventListener("input", (e) => {
      catSearch = e.target.value;
      render();
      const el = document.getElementById("cat-search");
      el?.focus();
      el?.setSelectionRange(catSearch.length, catSearch.length);
    });

    const openCatModal = (existing) => {
      openModal(existing ? `Edit ${existing.display_name}` : "Add Product Package Size", `
        <form id="cat-form" class="stack-md">
          <div class="grid-2">
            <div>
              <label class="field-label">Display Name</label>
              <input class="input" name="display_name" value="${esc(existing?.display_name || "")}" placeholder="e.g. Chicken Broth" required />
            </div>
            <div>
              <label class="field-label">Match Key (lowercase)</label>
              <input class="input" name="canonical_name" value="${esc(existing?.canonical_name || "")}" placeholder="e.g. chicken broth" required />
            </div>
          </div>
          <div>
            <label class="field-label">Aliases (comma-separated)</label>
            <input class="input" name="aliases" value="${esc((existing?.aliases || []).join(", "))}" placeholder="chicken stock, low sodium chicken broth" />
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">Default Department</label>
              <select class="select" name="default_department">
                ${["Produce", "Bakery & Deli", "Meat & Seafood", "Dry Goods", "Beverages", "Frozen", "Dairy & Eggs", "Household & Personal", "Other"].map((d) => `
                  <option value="${esc(d)}" ${d === (existing?.default_department || "Dry Goods") ? "selected" : ""}>${esc(d)}</option>
                `).join("")}
              </select>
            </div>
            <div>
              <label class="field-label">US Store Package Label</label>
              <input class="input" name="package_label" value="${esc(existing?.package_label || "")}" placeholder="e.g. 32 oz carton" required />
            </div>
          </div>
          <div class="grid-2">
            <div>
              <label class="field-label">Package Size (number)</label>
              <input class="input" name="package_size" type="number" step="0.01" min="0.01" value="${esc(existing?.package_size || 1)}" required />
            </div>
            <div>
              <label class="field-label">Package Unit</label>
              <select class="select" name="package_unit">
                ${["oz", "fl_oz", "lb", "count", "clove", "bunch", "head", "g", "ml", "cup", "tbsp"].map((u) => `
                  <option value="${u}" ${u === (existing?.package_unit || "oz") ? "selected" : ""}>${u}</option>
                `).join("")}
              </select>
            </div>
          </div>
          <label class="row small">
            <input type="checkbox" name="is_pantry_staple" ${existing?.is_pantry_staple ? "checked" : ""} />
            <span>Pantry Staple (unchecked by default when generating weekly lists)</span>
          </label>
          <div class="row" style="justify-content: space-between;">
            ${existing ? `<button class="btn btn-danger" type="button" id="del-cat-btn">Delete</button>` : `<span></span>`}
            <button class="btn btn-primary" type="submit">Save Product</button>
          </div>
        </form>
      `, (close) => {
        document.getElementById("del-cat-btn")?.addEventListener("click", async () => {
          await api(`/api/catalog/${existing.id}`, { method: "DELETE" });
          catalog = await api("/api/catalog");
          close();
          render();
          toast("Deleted product");
        });

        document.getElementById("cat-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target;
          const body = {
            display_name: f.display_name.value.trim(),
            canonical_name: f.canonical_name.value.trim(),
            aliases: f.aliases.value.split(",").map((x) => x.trim()).filter(Boolean),
            default_department: f.default_department.value,
            package_label: f.package_label.value.trim(),
            package_size: Number(f.package_size.value),
            package_unit: f.package_unit.value,
            is_pantry_staple: f.is_pantry_staple.checked,
          };
          if (existing) {
            await api(`/api/catalog/${existing.id}`, { method: "PUT", body });
          } else {
            await api("/api/catalog", { method: "POST", body });
          }
          catalog = await api("/api/catalog");
          close();
          render();
          toast("Product saved");
        });
      });
    };

    document.getElementById("add-cat-btn")?.addEventListener("click", () => openCatModal(null));
    document.querySelectorAll(".edit-cat-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = catalog.find((c) => c.id === Number(btn.dataset.id));
        if (item) openCatModal(item);
      });
    });

    document.getElementById("create-key-btn")?.addEventListener("click", async () => {
      const name = prompt("Name for this API key (e.g. Home Assistant):", "Home Assistant");
      if (!name) return;
      const res = await api("/api/auth/api-keys", { method: "POST", body: { name } });
      newlyCreatedKey = res.raw_key;
      apiKeys = await api("/api/auth/api-keys");
      render();
    });

    document.querySelectorAll(".del-key-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/auth/api-keys/${btn.dataset.id}`, { method: "DELETE" });
        apiKeys = await api("/api/auth/api-keys");
        render();
      });
    });

    document.getElementById("settings-shortcut-btn")?.addEventListener("click", () => {
      openShortcutSetupModal(state, () => render());
    });

    document.getElementById("kroger-config-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = document.getElementById("save-kroger-btn");
      btn.disabled = true;
      btn.textContent = "Verifying...";
      try {
        await api("/api/kroger/config", {
          method: "PUT",
          body: {
            client_id: f.client_id.value.trim(),
            client_secret: f.client_secret.value.trim(),
            redirect_uri: f.redirect_uri.value.trim(),
            linked_store_id: f.linked_store_id.value ? Number(f.linked_store_id.value) : null,
          },
        });
        krogerStatus = await api("/api/kroger/status");
        toast("Kroger API credentials verified & saved!");
        render();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = "Save & Verify Credentials";
      }
    });

    document.getElementById("kroger-zip-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        krogerSearchResults = await api(`/api/kroger/locations?zip_code=${encodeURIComponent(e.target.zip_code.value.trim())}`);
        if (!krogerSearchResults.length) toast("No Kroger stores found near that ZIP.", true);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("settings-theme-light")?.addEventListener("click", () => {
      if (window.__pantrySetTheme) window.__pantrySetTheme("light");
      else {
        localStorage.setItem("pantrycart_theme", "light");
        document.documentElement.dataset.theme = "light";
      }
      render();
    });

    document.getElementById("settings-theme-dark")?.addEventListener("click", () => {
      if (window.__pantrySetTheme) window.__pantrySetTheme("dark");
      else {
        localStorage.setItem("pantrycart_theme", "dark");
        document.documentElement.dataset.theme = "dark";
      }
      render();
    });

    document.querySelectorAll(".select-kroger-loc-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const targetSel = document.getElementById("kroger-target-store-select");
        const targetSid = targetSel && targetSel.value ? Number(targetSel.value) : null;
        if (targetSid) {
          await api(`/api/stores/${targetSid}`, {
            method: "PUT",
            body: {
              kroger_location_id: btn.dataset.locId,
              kroger_location_name: btn.dataset.locName,
              kroger_location_address: btn.dataset.locAddr,
            },
          });
        }
        await api("/api/kroger/location", {
          method: "PUT",
          body: {
            location_id: btn.dataset.locId,
            location_name: btn.dataset.locName,
            location_address: btn.dataset.locAddr,
            location_chain: btn.dataset.locChain,
            linked_store_id: targetSid,
          },
        });
        let syncMsg = "";
        if (targetSid) {
          const syncRes = await api(`/api/kroger/sync-store/${targetSid}`, { method: "POST" }).catch(() => null);
          if (syncRes && syncRes.synced_count > 0) {
            syncMsg = ` · synced ${syncRes.synced_count} aisles`;
          }
        }
        const [newStatus, updatedStores] = await Promise.all([
          api("/api/kroger/status"),
          api("/api/stores"),
        ]);
        krogerStatus = newStatus;
        if (Array.isArray(stores) && Array.isArray(updatedStores)) {
          stores.splice(0, stores.length, ...updatedStores);
        }
        krogerSearchResults = [];
        toast(`Selected ${btn.dataset.locName}${syncMsg}!`);
        render();
      });
    });

    document.getElementById("connect-kroger-oauth-btn")?.addEventListener("click", async () => {
      try {
        const res = await api("/api/kroger/oauth/start");
        window.location.href = res.authorize_url;
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  render();
}
