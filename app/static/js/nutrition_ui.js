import { api } from "./api.js";
import { esc, fmtQty, openModal, toast } from "./utils.js";

export const SHORTCUT_NAME = "PantryCart Log Macros";

export function isShortcutReady(state) {
  return Boolean(state?.user?.shortcut_verified || localStorage.getItem("pantrycart_shortcut_verified") === "1");
}

export function renderMacroStrip(m, compact = false) {
  if (!m || m.calories === null && m.calories_per_serving === null) {
    return "";
  }
  const cal = m.calories ?? m.calories_per_serving;
  if (cal === null || cal === undefined) return "";
  const p = m.protein_g ?? 0;
  const c = m.carbs_g ?? 0;
  const f = m.fat_g ?? 0;
  if (compact) {
    return `
      <span class="macro-strip">
        <span class="macro-chip cal">${Math.round(cal)} kcal</span>
        <span class="macro-chip pro">${fmtQty(p)}g P</span>
        <span class="macro-chip">${fmtQty(c)}g C</span>
        <span class="macro-chip">${fmtQty(f)}g F</span>
      </span>
    `;
  }
  return `
    <div class="macro-strip">
      <span class="macro-chip cal">${Math.round(cal)} kcal</span>
      <span class="macro-chip pro">${fmtQty(p)}g Protein</span>
      <span class="macro-chip">${fmtQty(c)}g Carbs</span>
      <span class="macro-chip">${fmtQty(f)}g Fat</span>
      ${m.fiber_g ? `<span class="macro-chip">${fmtQty(m.fiber_g)}g Fiber</span>` : ""}
    </div>
  `;
}

export function launchShortcutLog(payload) {
  const jsonText = JSON.stringify(payload);
  const origin = window.location.origin;
  const url =
    `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}` +
    `&input=text&text=${encodeURIComponent(jsonText)}` +
    `&x-success=${encodeURIComponent(origin + "/#planner")}`;
  window.location.href = url;
}

export async function setShortcutVerifiedFlag(state, verified) {
  await api("/api/nutrition/shortcut-verified", {
    method: "POST",
    body: { verified },
  });
  if (state?.user) state.user.shortcut_verified = verified;
  if (verified) {
    localStorage.setItem("pantrycart_shortcut_verified", "1");
  } else {
    localStorage.removeItem("pantrycart_shortcut_verified");
  }
}

export function openShortcutSetupModal(state, onStatusChanged) {
  const verified = isShortcutReady(state);
  const origin = window.location.origin;
  const samplePayload = JSON.stringify({
    mode: "log",
    day: "Mon",
    meals: "Creamy Tuscan Chicken, Eggs",
    calories: 683,
    protein_g: 58.6,
    carbs_g: 11.7,
    fat_g: 43.5,
    fiber_g: 2.0,
  });

  openModal("2-Step iOS Shortcut Setup (Apple Health / Lose It! Sync)", `
    <div class="stack-md">
      <div class="card" style="background: ${verified ? "var(--primary-soft)" : "var(--accent-soft)"}; border-color: ${verified ? "#b7dcc8" : "#fcd34d"}; padding: 12px;">
        <div style="font-weight: 800; font-size: 0.95rem;">
          Status: ${verified ? "✓ Step 1 Complete — Shortcut Verified!" : "🔒 Step 1 Required — Shortcut Not Verified Yet"}
        </div>
        <p class="small" style="margin: 4px 0 0;">
          ${verified
            ? `Your <strong>"${esc(SHORTCUT_NAME)}"</strong> shortcut is marked ready. All <strong>Log Meals</strong> buttons are unlocked!`
            : `Create the <strong>"${esc(SHORTCUT_NAME)}"</strong> shortcut on your iPhone/iPad once, then verify it below to unlock the grayed-out <strong>Log Meals</strong> buttons.`}
        </p>
      </div>

      <div class="card stack-sm" style="background: var(--bg);">
        <h4 style="margin: 0;">Step 1: Add "${esc(SHORTCUT_NAME)}" in Apple Shortcuts</h4>
        <p class="small muted" style="margin: 0;">
          Because iOS 15+ blocks unsigned <code>.shortcut</code> files from local self-hosted servers, tapping the button below opens Apple Shortcuts directly so you can build the 5-line action in ~45 seconds (or you can download the raw template if you sign on macOS).
        </p>
        <div class="row-wrap" style="gap: 8px; margin-top: 4px;">
          <a class="btn btn-primary btn-sm" href="shortcuts://create-shortcut" style="text-decoration: none;">
            📲 Open Apple Shortcuts App
          </a>
          <a class="btn btn-sm" href="/api/nutrition/ios-shortcut" download="PantryCart Log Macros.shortcut" style="text-decoration: none;">
            ⬇ Raw .shortcut File
          </a>
        </div>
        <ol class="small" style="margin: 6px 0 0; padding-left: 18px;">
          <li>Name the new shortcut <strong><code>${esc(SHORTCUT_NAME)}</code></strong> (exact spelling).</li>
          <li>Add <strong>Get Dictionary from Input</strong> (reads <code>Shortcut Input</code>).</li>
          <li>Add <strong>If</strong> <code>Dictionary Value [calories]</code> <em>is greater than</em> <code>0</code>:</li>
          <li>Inside the If block, add <strong>Log Health Sample</strong> actions reading keys <code>calories</code> (kcal), <code>protein_g</code> (g), <code>carbs_g</code> (g), <code>fat_g</code> (g), and <code>fiber_g</code> (g).</li>
          <li>Tap <strong>Done</strong> — Apple Health automatically shares logged nutrition with any connected tracker!</li>
        </ol>
        <details class="small" style="margin-top: 4px;">
          <summary style="cursor: pointer; font-weight: 700;">Preview JSON sent to Shortcut</summary>
          <pre class="code-block" style="margin-top: 6px; font-size: 0.74rem; white-space: pre-wrap;">${esc(samplePayload)}</pre>
        </details>
      </div>

      <div class="card stack-sm" style="background: var(--bg);">
        <h4 style="margin: 0;">Step 2: Verify &amp; Unlock "Log Meals" Buttons</h4>
        <p class="small muted" style="margin: 0;">
          On your iPhone/iPad, tap <strong>Test &amp; Verify on Device</strong> to trigger a test ping (and auto-unlock on return), or click <strong>Confirm Shortcut Is Added</strong>.
        </p>
        <div class="row-wrap" style="gap: 8px; margin-top: 4px;">
          <button class="btn btn-accent btn-sm" id="test-ios-shortcut-btn" type="button">
            🔍 Test &amp; Verify on iPhone/iPad
          </button>
          <button class="btn btn-primary btn-sm" id="confirm-ios-shortcut-btn" type="button">
            ✓ Confirm Shortcut Added &amp; Unlock
          </button>
          ${verified ? `
            <button class="btn btn-danger btn-sm" id="reset-ios-shortcut-btn" type="button">
              Lock / Reset Step 1
            </button>
          ` : ""}
        </div>
      </div>
    </div>
  `, (close) => {
    document.getElementById("test-ios-shortcut-btn")?.addEventListener("click", async () => {
      const verifyPayload = JSON.stringify({ mode: "verify", calories: 0 });
      const callbackSuccess = `${origin}/#planner?shortcut_verified=1`;
      const callbackError = `${origin}/#planner`;
      window.location.href =
        `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}` +
        `&input=text&text=${encodeURIComponent(verifyPayload)}` +
        `&x-success=${encodeURIComponent(callbackSuccess)}` +
        `&x-error=${encodeURIComponent(callbackError)}`;
    });

    document.getElementById("confirm-ios-shortcut-btn")?.addEventListener("click", async () => {
      await setShortcutVerifiedFlag(state, true);
      close();
      if (onStatusChanged) onStatusChanged(true);
      toast("Step 1 complete! All 'Log Meals' buttons are now unlocked.");
    });

    document.getElementById("reset-ios-shortcut-btn")?.addEventListener("click", async () => {
      await setShortcutVerifiedFlag(state, false);
      close();
      if (onStatusChanged) onStatusChanged(false);
      toast("Shortcut status reset to Step 1 (locked).");
    });
  });
}

export function openLoseItQuickCardModal(recipe, state, { onSaved } = {}) {
  let workingRecipe = { ...recipe };
  let baseServings = Number(workingRecipe.servings) || 1;
  let portions = Number(workingRecipe.custom_portions) || baseServings;
  let shortcutOk = isShortcutReady(state);

  const calcPerPortion = (baseVal) => {
    if (baseVal === null || baseVal === undefined) return null;
    const totalBatch = Number(baseVal) * baseServings;
    return totalBatch / Math.max(portions, 0.25);
  };

  const renderBody = () => {
    const hasMacros = workingRecipe.calories_per_serving !== null && workingRecipe.calories_per_serving !== undefined;
    const calPortion = calcPerPortion(workingRecipe.calories_per_serving);
    const proPortion = calcPerPortion(workingRecipe.protein_g);
    const carbPortion = calcPerPortion(workingRecipe.carbs_g);
    const fatPortion = calcPerPortion(workingRecipe.fat_g);
    const fibPortion = calcPerPortion(workingRecipe.fiber_g);

    const totalCal = hasMacros ? Math.round(Number(workingRecipe.calories_per_serving) * baseServings) : null;
    const totalPro = hasMacros ? Number(workingRecipe.protein_g || 0) * baseServings : null;
    const totalCarb = hasMacros ? Number(workingRecipe.carbs_g || 0) * baseServings : null;
    const totalFat = hasMacros ? Number(workingRecipe.fat_g || 0) * baseServings : null;

    return `
      <div class="stack-md">
        <div class="card" style="background: var(--bg); padding: 12px;">
          <label class="field-label">Custom Batch Divider ("Divided into how many containers/portions?")</label>
          <div class="row-wrap" style="gap: 8px; align-items: center;">
            <span class="small muted">Recipe default: ${fmtQty(baseServings)} srv &rarr;</span>
            <input class="input" id="loseit-portions-input" type="number" step="0.5" min="0.5" max="100" value="${fmtQty(portions)}" style="width: 90px; min-height: 36px;" />
            <span class="small muted">portions</span>
            <button class="btn btn-primary btn-sm" id="save-portions-btn" type="button">Save Portion Count</button>
          </div>
        </div>

        ${!hasMacros ? `
          <div class="card stack-sm" style="background: var(--accent-soft); border-color: #fcd34d;">
            <p class="small" style="margin: 0; color: #92400e;">
              No macro values saved on this recipe yet. Click below to calculate them automatically from the ingredient list!
            </p>
            <button class="btn btn-primary btn-sm" id="calc-macros-now-btn" type="button">
              ✨ Auto-Calculate Macros from Ingredients
            </button>
          </div>
        ` : `
          <div class="nutrition-card">
            <div class="nutrition-card-title">
              Lose It! Quick-Entry Card
              <div class="small muted" style="font-weight: 600; font-size: 0.8rem;">
                ${esc(workingRecipe.title)} · 1 of ${fmtQty(portions)} portions
              </div>
            </div>
            <div class="nutrition-row" style="font-size: 1.08rem; font-weight: 900;">
              <span>Calories</span>
              <span>${Math.round(calPortion)} kcal</span>
            </div>
            <div class="nutrition-row"><span>Protein</span><strong>${fmtQty(proPortion)} g</strong></div>
            <div class="nutrition-row"><span>Total Carbs</span><strong>${fmtQty(carbPortion)} g</strong></div>
            <div class="nutrition-row"><span>Total Fat</span><strong>${fmtQty(fatPortion)} g</strong></div>
            <div class="nutrition-row"><span>Dietary Fiber</span><strong>${fmtQty(fibPortion)} g</strong></div>
            <div class="small muted" style="margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border);">
              <strong>Entire Batch Total:</strong> ${totalCal} kcal · ${fmtQty(totalPro)}g P · ${fmtQty(totalCarb)}g C · ${fmtQty(totalFat)}g F
            </div>
          </div>

          <div class="row-wrap" style="justify-content: space-between; gap: 8px;">
            <button class="btn btn-sm" id="copy-loseit-card-btn" type="button">
              📋 Copy for Lose It! Custom Food
            </button>
            <button class="btn btn-sm ${shortcutOk ? "btn-log-ready" : "btn-locked"}" id="log-portion-ios-btn" type="button" title="${shortcutOk ? "Send 1 portion to Apple Health via iOS Shortcut" : "Complete Step 1 Shortcut Setup first"}">
              ${shortcutOk ? "📲 Log 1 Portion (iOS Shortcut)" : "🔒 Log 1 Portion (Setup Shortcut First)"}
            </button>
          </div>
        `}
      </div>
    `;
  };

  openModal(`Macros & Lose It! Card — ${recipe.title}`, renderBody(), (close) => {
    const bindCard = () => {
      document.getElementById("loseit-portions-input")?.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        if (val > 0) {
          portions = val;
          // Re-render card numbers cleanly without losing input focus
          const cardEl = document.querySelector(".nutrition-card");
          if (cardEl && workingRecipe.calories_per_serving !== null) {
            const cal = Math.round(calcPerPortion(workingRecipe.calories_per_serving));
            const pro = fmtQty(calcPerPortion(workingRecipe.protein_g));
            const carb = fmtQty(calcPerPortion(workingRecipe.carbs_g));
            const fat = fmtQty(calcPerPortion(workingRecipe.fat_g));
            const fib = fmtQty(calcPerPortion(workingRecipe.fiber_g));
            cardEl.querySelector(".nutrition-card-title .small").textContent = `${workingRecipe.title} · 1 of ${fmtQty(portions)} portions`;
            const rows = cardEl.querySelectorAll(".nutrition-row span:last-child, .nutrition-row strong");
            if (rows.length >= 5) {
              rows[0].textContent = `${cal} kcal`;
              rows[1].textContent = `${pro} g`;
              rows[2].textContent = `${carb} g`;
              rows[3].textContent = `${fat} g`;
              rows[4].textContent = `${fib} g`;
            }
          }
        }
      });

      document.getElementById("save-portions-btn")?.addEventListener("click", async () => {
        const updated = await api(`/api/recipes/${workingRecipe.id}/portions`, {
          method: "PATCH",
          body: { custom_portions: portions },
        });
        workingRecipe = updated;
        if (onSaved) onSaved(updated);
        toast(`Saved ${fmtQty(portions)} portions for ${workingRecipe.title}`);
      });

      document.getElementById("calc-macros-now-btn")?.addEventListener("click", async () => {
        const est = await api(`/api/nutrition/estimate-recipe/${workingRecipe.id}`, { method: "POST" });
        workingRecipe = { ...workingRecipe, ...est };
        if (onSaved) onSaved(workingRecipe);
        document.getElementById("modal-body").innerHTML = renderBody();
        bindCard();
        toast("Calculated estimated macros!");
      });

      document.getElementById("copy-loseit-card-btn")?.addEventListener("click", async () => {
        const txt = [
          `${workingRecipe.title} (1/${fmtQty(portions)} recipe)`,
          `Calories: ${Math.round(calcPerPortion(workingRecipe.calories_per_serving))} kcal`,
          `Protein: ${fmtQty(calcPerPortion(workingRecipe.protein_g))}g`,
          `Carbs: ${fmtQty(calcPerPortion(workingRecipe.carbs_g))}g`,
          `Fat: ${fmtQty(calcPerPortion(workingRecipe.fat_g))}g`,
          `Fiber: ${fmtQty(calcPerPortion(workingRecipe.fiber_g))}g`,
        ].join("\n");
        try {
          await navigator.clipboard.writeText(txt);
          toast("Copied Lose It! macro summary to clipboard!");
        } catch {
          toast("Summary ready to copy from the card above.");
        }
      });

      document.getElementById("log-portion-ios-btn")?.addEventListener("click", () => {
        if (!shortcutOk) {
          close();
          openShortcutSetupModal(state, (nowOk) => {
            shortcutOk = nowOk;
            if (onSaved) onSaved(workingRecipe);
          });
          return;
        }
        launchShortcutLog({
          mode: "log",
          day: "Today",
          meals: workingRecipe.title,
          calories: Math.round(calcPerPortion(workingRecipe.calories_per_serving)),
          protein_g: Number(calcPerPortion(workingRecipe.protein_g).toFixed(1)),
          carbs_g: Number(calcPerPortion(workingRecipe.carbs_g).toFixed(1)),
          fat_g: Number(calcPerPortion(workingRecipe.fat_g).toFixed(1)),
          fiber_g: Number(calcPerPortion(workingRecipe.fiber_g).toFixed(1)),
        });
      });
    };

    bindCard();
  });
}
