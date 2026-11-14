# PantryCart — Household Recipe Book & Smart Grocery Lists

A self-hosted, single-container web app (PWA) designed for **Unraid + Cloudflare Tunnel** (and ready for **Home Assistant** sensors/webhooks).

## Features
- **Household Accounts (90-day persistent login)**: Separate accounts for you and your spouse with long-lived `HttpOnly` sessions and live 5-second sync while shopping.
- **Recipe Book + Web Scraper**: Paste any recipe URL to auto-import ingredients, servings, prep/cook times, and steps, plus an interactive **Cook Mode** with step check-off and live serving scaling (`0.5x`–`2x`).
- **"What do we want to eat this week?"**: Select recipes for the week, automatically merge duplicate ingredients, and calculate **how many packages to buy** using standard US grocery store sizes (e.g., `15 oz` cans, `32 oz` broth cartons, `1 head (~10 cloves)` garlic, `1 lb (4 sticks)` butter), while flagging pantry staples so you don't re-buy salt or olive oil every week.
- **Multi-Store & One-Off Lists**: Pre-seeded with **Weekly Grocery Trip**, **Costco Run**, **Home Depot**, and **IKEA**, plus instant one-off lists (e.g., "Quick stop for bananas").
- **Exact Store Department & Aisle Sorting**: Pre-configured layouts for **Kroger, Publix, Whole Foods, Costco, Home Depot, and IKEA** — plus unlimited custom stores. Assign an item to `Aisle 7` at Kroger and `Aisle 4` at Publix, and switching stores immediately re-sorts your list in walking order.
- **Home Assistant Ready**: Generate API keys in **Settings → Home Assistant & API** to push low-stock items from ESPHome weight sensors or RFID/NFC tags straight onto your active shopping list.

---

## Deploying on Unraid (Directly from GitHub)

### Option A: Unraid Compose Manager (No manual clone needed)
Create a new stack in Unraid Compose Manager (or Portainer / Dockge) and paste:
```yaml
services:
  pantrycart:
    build: https://github.com/arcygore/pantrycart.git#main
    container_name: pantrycart
    restart: unless-stopped
    ports:
      - "8095:8080"
    volumes:
      - /mnt/user/appdata/pantrycart:/app/data
    environment:
      - PANTRY_DB_PATH=/app/data/pantry.db
      - COOKIE_SECURE=auto
      - SESSION_DAYS=90
```
Then click **Compose Up**. To update later, run **Update Stack** / `docker compose build --no-cache && docker compose up -d`.

### Option B: Clone on Unraid
1. Clone this repository onto your Unraid server:
   ```bash
   git clone https://github.com/arcygore/pantrycart.git /mnt/user/appdata/pantrycart-src
   cd /mnt/user/appdata/pantrycart-src
   ```
2. Edit the volume path in `docker-compose.yml` to `/mnt/user/appdata/pantrycart:/app/data` and run:
   ```bash
   docker compose up -d --build
   ```

3. **Cloudflare Tunnel**: Point a public hostname (e.g., `groceries.yourdomain.com`) to `http://<UNRAID-IP>:8095`.
4. **First-Time Setup**: Open the URL in your browser, create your admin account, then go to **Settings → Household Accounts → + Add Member** to create your wife's login.
5. **Phone App Feel (PWA)**: On iOS Safari tap **Share → Add to Home Screen** (or Android Chrome **Install App**).

---

## Connecting to Home Assistant (Optional Future Sensors)

You can run PantryCart as its own Unraid container and connect Home Assistant over your LAN:
1. In PantryCart, open **Settings → Home Assistant & API** and click **+ Generate API Key**.
2. Copy the generated `configuration.yaml` snippet (`rest_command` + `rest` sensor).
3. Any ESPHome pantry scale or RFID/NFC automation can call `rest_command.pantrycart_low_stock` with `{"item": "Coffee Beans", "quantity": 1}` to drop the item straight into the **Beverages** section (and saved aisle) of your active grocery list.
4. You can also embed PantryCart inside a Home Assistant **Webpage Dashboard** card or sidebar panel.

---

## Running Tests (where Python 3.12+ is installed)
```bash
pip install -r requirements.txt
pytest
```
