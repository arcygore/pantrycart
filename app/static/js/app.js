import { api } from "./api.js";
import { ICONS, esc, toast } from "./utils.js";
import { renderAuthView } from "./views/auth.js";
import { renderListsView } from "./views/lists.js";
import { renderPantryView } from "./views/pantry.js";
import { renderPlannerView } from "./views/planner.js";
import { renderRecipesView } from "./views/recipes.js";
import { renderSettingsView } from "./views/settings.js";
import { renderStoresView } from "./views/stores.js";

const NAV_ITEMS = [
  { id: "lists", label: "Lists", icon: ICONS.list },
  { id: "planner", label: "This Week", mobileLabel: "Plan", icon: ICONS.calendar },
  { id: "recipes", label: "Recipes", icon: ICONS.book },
  { id: "pantry", label: "Pantry", icon: ICONS.pantry },
  { id: "stores", label: "Stores", icon: ICONS.store },
  { id: "settings", label: "Settings", icon: ICONS.settings },
];

const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((i) => i.id !== "settings");

const state = {
  user: null,
  view: "lists",
  activeListId: null,
  activeStoreId: null,
  showChecked: false,
  settingsTab: "household",
};

let activePollTimer = null;

function _applyInitialHashRoute() {
  const h = window.location.hash || "";
  if (!h.startsWith("#")) return;
  const clean = h.slice(1);
  const [viewPart, queryPart] = clean.split("?");
  if (NAV_ITEMS.some((i) => i.id === viewPart)) {
    state.view = viewPart;
  }
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    if (params.get("shortcut_verified") === "1") {
      state.shortcutJustVerified = true;
      state.view = "planner";
    }
    if (params.get("kroger_connected") === "1") {
      state.krogerJustConnected = true;
      state.view = "lists";
    }
    if (params.get("tab")) {
      state.settingsTab = params.get("tab");
    }
    window.history.replaceState(null, "", "/#" + state.view);
  }
}

const THEME_STORAGE_KEY = "pantrycart_theme";

function _applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage quota errors
  }
  document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
    const isDark = normalized === "dark";
    btn.textContent = isDark ? "☀️ Light" : "🌙 Dark";
    btn.title = isDark ? "Switch to Light Mode" : "Switch to Dark Mode";
  });
}

window.__pantrySetTheme = _applyTheme;

async function bootstrap() {
  try {
    _applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "light");
  } catch {
    _applyTheme("light");
  }
  const buildId = window.__PANTRYCART_BUILD__ || "";
  if ("caches" in window) {
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => !buildId || !k.endsWith(buildId))
          .map((k) => caches.delete(k))
      ))
      .catch(() => {});
  }
  if ("serviceWorker" in navigator) {
    const buildQ = buildId ? `?v=${buildId}` : "";
    navigator.serviceWorker
      .register(`/sw.js${buildQ}`, { updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
  _applyInitialHashRoute();

  const root = document.getElementById("app");
  try {
    const status = await api("/api/auth/status");
    if (status.needs_setup || !status.user) {
      renderAuthView(root, status.needs_setup, (user) => {
        state.user = user;
        renderShell();
      });
      return;
    }
    state.user = status.user;
    renderShell();
  } catch (err) {
    root.innerHTML = `<div class="loading-screen"><p>Failed to connect: ${esc(err.message)}</p></div>`;
  }
}

function renderShell() {
  const root = document.getElementById("app");
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/static/icon.svg" alt="PantryCart" />
          <span>PantryCart</span>
        </div>
        <nav class="sidebar-nav">
          ${NAV_ITEMS.map((item) => `
            <button class="sidebar-btn ${state.view === item.id ? "active" : ""}" data-nav="${item.id}">
              ${item.icon}
              <span>${item.label}</span>
            </button>
          `).join("")}
        </nav>
        <div class="sidebar-footer">
          <span style="font-weight: 600;">${esc(state.user.display_name)}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="badge">@${esc(state.user.username)}</span>
            ${state.user.is_guest ? `<span class="badge badge-accent">Guest</span>` : ""}
            <span class="badge" style="opacity: 0.75;" title="App Version">v1.5</span>
            <button type="button" class="btn btn-sm theme-toggle-btn" style="padding: 2px 8px; min-height: 24px; font-size: 0.74rem;"></button>
          </span>
        </div>
      </aside>

      <main class="main-content">
        <header class="mobile-header">
          <div class="brand-inline">
            <img src="/static/icon.svg" alt="PantryCart" />
            <span>PantryCart</span>
          </div>
          <span class="row" style="gap: 6px; align-items: center;">
            <button type="button" class="btn btn-sm theme-toggle-btn" style="padding: 3px 9px; min-height: 30px; font-size: 0.78rem;"></button>
            <button type="button" class="btn btn-sm mobile-settings-btn ${state.view === "settings" ? "active" : ""}" data-nav="settings" aria-label="Settings" title="Settings &amp; Account (${esc(state.user.display_name)})">${ICONS.settings}</button>
          </span>
        </header>
        <div id="view-root"></div>
      </main>

      <nav class="bottom-nav">
        ${MOBILE_NAV_ITEMS.map((item) => `
          <button class="nav-btn ${state.view === item.id ? "active" : ""}" data-nav="${item.id}">
            ${item.icon}
            <span>${item.mobileLabel || item.label}</span>
          </button>
        `).join("")}
      </nav>
    </div>
  `;

  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.nav));
  });

  _applyTheme(document.documentElement.dataset.theme || "light");
  document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      _applyTheme(next);
    });
  });

  loadCurrentView();
}

function navigate(viewId) {
  state.view = viewId;
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === viewId);
  });
  loadCurrentView();
}

async function loadCurrentView() {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }

  const viewRoot = document.getElementById("view-root");
  if (!viewRoot) return;
  viewRoot.innerHTML = `<div class="loading-screen" style="min-height: 240px;"><div class="spinner"></div></div>`;

  try {
    if (state.view === "lists") {
      activePollTimer = await renderListsView(viewRoot, state, navigate);
    } else if (state.view === "planner") {
      await renderPlannerView(viewRoot, state, navigate);
    } else if (state.view === "recipes") {
      await renderRecipesView(viewRoot, state);
    } else if (state.view === "pantry") {
      await renderPantryView(viewRoot, state);
    } else if (state.view === "stores") {
      await renderStoresView(viewRoot, state);
    } else if (state.view === "settings") {
      await renderSettingsView(viewRoot, state, async () => {
        await api("/api/auth/logout", { method: "POST" });
        state.user = null;
        bootstrap();
      }, navigate);
    }
  } catch (err) {
    if (err.status === 401) {
      bootstrap();
      return;
    }
    toast(err.message, true);
    viewRoot.innerHTML = `<div class="card empty-state"><p>${esc(err.message)}</p></div>`;
  }
}

bootstrap();
