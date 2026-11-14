import { api } from "../api.js";
import { esc, toast } from "../utils.js";

export function renderAuthView(container, needsSetup, onSuccess) {
  container.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-brand">
          <img src="/static/icon.svg" alt="PantryCart" />
          <div>
            <h1>PantryCart</h1>
            <p>${needsSetup ? "Create your household admin account" : "Sign in to your household lists"}</p>
          </div>
        </div>

        <form id="auth-form" class="stack-md">
          ${needsSetup ? `
            <div>
              <label class="field-label" for="auth-display">Your Name</label>
              <input class="input" id="auth-display" name="display_name" placeholder="e.g. Ryan" required />
            </div>
          ` : ""}
          <div>
            <label class="field-label" for="auth-user">Username</label>
            <input class="input" id="auth-user" name="username" autocomplete="username" placeholder="e.g. ryan" required />
          </div>
          <div>
            <label class="field-label" for="auth-pass">Password</label>
            <input class="input" id="auth-pass" name="password" type="password" autocomplete="${needsSetup ? "new-password" : "current-password"}" required />
          </div>
          <button class="btn btn-primary" type="submit" id="auth-submit">
            ${needsSetup ? "Create Household & Sign In" : "Sign In"}
          </button>
          <p class="muted small" style="margin: 4px 0 0; text-align: center;">
            ${needsSetup
              ? "You can add your spouse's account right away inside Settings."
              : "Sessions stay signed in on your device for 90 days."}
          </p>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById("auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("auth-submit");
    btn.disabled = true;
    try {
      const username = form.username.value.trim();
      const password = form.password.value;
      let res;
      if (needsSetup) {
        const display_name = form.display_name.value.trim();
        res = await api("/api/auth/setup", {
          method: "POST",
          body: { username, display_name, password },
        });
      } else {
        res = await api("/api/auth/login", {
          method: "POST",
          body: { username, password },
        });
      }
      onSuccess(res.user);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}
