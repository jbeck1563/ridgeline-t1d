# Ridgeline T1D

**Stay on the ridge.** Staying in range is walking a ridge: a drop on the high side, a drop on the low side, and you are the one walking it. Ridgeline T1D is a self-hosted MCP server and report page that put your own Glooko data (Tandem t:slim X2 with Control-IQ, or Omnipod 5) in front of you and your AI assistant, so you manage your diabetes with your eyes open.

Originally forked from [rilhia/omni-endo-ai-mcp](https://github.com/rilhia/omni-endo-ai-mcp); this project now develops independently.

> [!IMPORTANT]
> **Not medical advice.** This tool is for understanding your data and asking better questions of your diabetes care team. It is not a medical device and must never be used to change your therapy. See the [disclaimer](#disclaimer).

> [!NOTE]
> **Compatibility.** Environment variables keep their original `OMNI_*` names (and `GLOOKO_*`), and the default SQLite file is still `omni-endo.db`, so existing deployments keep working unchanged.

## What it does

Ridgeline T1D exposes your diabetes history as analytical tools an AI can call over MCP (server name `ridgeline-t1d`): time in range, GMI and variability, best and worst days and hours, enriched bolus analysis (each bolus with the glucose and pump settings in force), basal delivery and pump modes, Control-IQ day review, week-over-week total daily dose trend, and Google Health context (activity, sleep, weight). It also serves a report page at `/` with the same numbers.

You ask things like: *"How was my time in range last month?"*, *"Why do I keep going high in the evenings?"*, *"Show me my worst day and tell me what happened."*

## Features

### 1. `POST /my-data` — a raw Glooko passthrough

**What.** With `OMNI_MYDATA=1`, the HTTP transport serves one extra route alongside
`/mcp`. Given `{startDate, endDate}` it returns `{startDate, endDate, data1, data2, data3}`
— the three raw Glooko payloads, straight from `fetchGlookoRange()`, bypassing the SQLite
archive and the range caps.

**How.** A client POSTs that shape to `/my-data` and this server answers from its own Glooko session, so the browser never holds a Glooko credential. `fetchGlookoRange()` already returns that identical object, so a reverse proxy can route `/my-data` here.

**Why.** One Glooko session and no credential in the browser.

**Auth.** `OMNI_MYDATA_BASIC` holds `user:password` and the route requires HTTP Basic —
not the `OMNI_HTTP_TOKEN` Bearer, because a browser cannot be made to send a Bearer on a
page's own `fetch()`, but it does replay Basic automatically on same-origin requests. The
full header is compared in constant time, and a 401 carries a realm so a browser prompts
by itself. **With `OMNI_MYDATA=1` and no `OMNI_MYDATA_BASIC` the route refuses to serve**
rather than defaulting to open — it would otherwise hand anyone who can reach the port a
live pull of your glucose history using the server's own Glooko credentials. Put a proxy
with the same credential in front as well; the app-level check is what protects the port
from anything already inside your Docker network. `/mcp` is unaffected and still Bearer.

### 2. Batched older-gap backfill

**What.** A query starting before the archive floor used to issue the whole gap as one
`pullAndIngest`. Against Glooko's live API a wide orientation probe (`start=2000-01-01`,
which `get_diabetes_summary`'s own description invites) measured 5+ minutes or hung —
past any client-side tool-call timeout. It now walks backward in year-sized batches,
reusing the cold-start shape, and stops after `MAX_EMPTY_BATCHES` consecutive empty years.

**Why the extra table.** A probe that finds nothing never moves the earliest-CGM epoch, so
the same empty span would be re-fetched from Glooko on *every* future wide query. A new
`meta` key-value table remembers the oldest epoch already probed. It is purely additive, so
`SCHEMA_VERSION` is deliberately **not** bumped — that would trigger the self-heal wipe and
force a destructive re-sync of a populated archive.

### 3. Tandem t:slim X2 (Control-IQ) through Glooko

**What.** Glooko's Tandem Source link delivers a Tandem pump's data in series this server
never requested. Control-IQ automatic correction boluses arrive only in `automaticBolus`
(disjoint from `deliveredBolus`; Glooko's daily bolus total is the sum of both), so they were
silently dropped. Tandem settings snapshots have no `maxBasalRate` and several named
profiles, which made `get_diabetes_summary` and `get_enriched_bolus_log` throw.

**How.** The client now also requests `automaticBolus`, the Control-IQ, Omnipod 5 and
generic pump-mode series (including `pumpOp5LimitedMode`, which `limited` basal state
always read but never fetched), `scheduledBasal`/`temporaryBasal`/`suspendBasal`/`lgsPlgs`,
`reservoirChange` and `pumpAlarm`. Automatic boluses get the class
`Automatic Correction Bolus`. A new `pump_mode` table holds possibly-overlapping
automatic / manual / sleep / exercise / limited / activity intervals, surfaced as
`pumpModes` in `get_basal_delivery`. Site changes are stored as `site` (old `pod` rows still
read), cartridge changes as `cartridge`. Settings use the active profile and every field is
optional. `get_diabetes_summary` adds `device` (pump, CGM, algorithm). Tool descriptions
and the prompt are device-neutral, with a short Control-IQ section.

**Archive.** `SCHEMA_VERSION` is 6, so an online archive is wiped and re-pulled once. An
offline archive (no Glooko credentials, e.g. the example database) is never wiped, since it
could not be re-pulled; it keeps working at its old version.

**Known gaps.** Tandem Source supplies no pump settings to Glooko: the settings shown are
the last ones uploaded some other way, possibly long ago. Glooko times are the pump's local
clock written as UTC.

### 4. Google Health context: `get_health_context`

**What.** A read-only pull of the Google Health API (the hub the Google Health app fills
from Health Connect on Android: Garmin Connect, Renpho Health, the phone itself) and one
tool, `get_health_context(start, end, granularity)`. It puts steps, active minutes,
workouts, sleep, resting HR, HRV, weight and body fat beside the same per-bucket
glucose/insulin row `get_trend` returns.

**How.** `src/health.js` refreshes an OAuth token from `OMNI_GHEALTH_CLIENT_ID`,
`OMNI_GHEALTH_CLIENT_SECRET` and `OMNI_GHEALTH_REFRESH_TOKEN` (a one-user client with the
`googlehealth.activity_and_fitness`, `.sleep` and `.health_metrics_and_measurements`
read-only scopes), pages `dataPoints`, and reads daily `dailyRollUp` totals in windows
inside the API's caps. Rows land in three additive tables (`health_sample`,
`health_session`, `health_daily`): no `SCHEMA_VERSION` bump, outside the Glooko wipe.
The first health tool call tops up under its own lock, so Google can never block Glooko;
a failure (for example an account not yet linked to Google Health) comes back as a
`healthSync` status with a fix-it hint.

**Why.** Context for glucose: activity, sleep and weight move insulin need. Each point is
stored at `physicalTime + utcOffset`, the same local-time-as-UTC frame as Glooko, so joins
need no time-zone library.

**Known gaps.** The Google Health API carries only weight and body fat %, not muscle,
water, bone or visceral fat; `health_sample` takes those types later from another source
without a schema change. The t:slim X2 clock is set by hand, so around a daylight-saving
change Glooko can be an hour off from health times.

### 5. Weekly total daily dose trend: `get_tdd_trend`

**What.** `get_tdd_trend(start, end)` answers "is my insulin use going up or down?". Per
Monday-start week (pump-local days): mean total daily dose, basal, bolus and automatic
correction units, basal/bolus split, the number of complete days behind each mean, and the
change vs the previous week. Weeks with fewer than 5 complete days are flagged and left out
of the change, the 4-week rolling mean and the slope (units per week, with the n of weeks).
Each week also carries mean glucose and time in range, plus two labelled proxies: TDD per kg
(Google Health weigh-in that week) and TDD per gram of logged carbs. They are proxies, not a
measured insulin sensitivity; the tool never computes an ISF, carb ratio or basal value.

### 6. The report page: `GET /` with `OMNI_WEB=1`

**What.** The web UI, served by this server. One static page
(`src/web/index.html`, no build step) shows glucose control, insulin with automatic
corrections counted, mode time, the Control-IQ day review, the weekly total daily dose
trend (table and inline SVG chart), Google Health context when
present, the settings in force, a copy-paste AI review prompt, and JSON exports (glucose
timeline, enriched bolus log, hourly trends) for a deep-dive window.

**How.** The page reads `GET /api/config` (configured unit and range, device, archive span),
`GET /api/report?start&end` (`get_diabetes_summary`, `get_basal_delivery` modes,
`get_controliq_review`, `get_tdd_trend`, `get_health_context`) and `GET /api/export?type&start&end`. Each
endpoint calls the MCP tools in process through an in-memory MCP client, so the page shows
the same numbers from the same archive as any MCP client; the browser parses no Glooko
data. The prompt states device facts (Control-IQ, user-set DIA, mode time from the pump's
mode records) and the caveat rule: evidence counts, "discuss with your endocrinologist
before changing settings", never a new setting value as an instruction.

**Auth.** Same Basic credential and fail-closed rule as `/my-data` (`OMNI_MYDATA_BASIC`;
503 when unset). `/mcp` and its Bearer are unchanged, and `/my-data` is unchanged.

### 7. Pasted Tandem pump settings: `get_pump_settings`

**What.** Glooko does not carry a Tandem pump's profile settings. t:connect web shows them
on its pump settings page as copyable text. Paste that text into the **Pump settings** box on
the report page and press Import: the server parses it and stores a snapshot keyed by the
upload date-time printed on the page (pump clock). Each snapshot holds every profile (name,
active flag, basal / correction factor / carb ratio / target BG segments, insulin duration,
carbs on/off, stated total daily basal), Control-IQ settings (weight, total daily insulin,
sleep schedules, insulin duration, target), CGM alerts, general settings and alerts. Units stay
as printed (mmol/L or mg/dL). Lines the parser does not know are listed as warnings, not
errors. Importing the same upload twice changes nothing.

**Privacy.** The name, date of birth, pump serial number and CGM transmitter ID are dropped
while parsing and never stored or logged.

**How.** `POST /api/pump-settings` with `{ "text": "..." }` (same Basic credential as `/`,
body capped at 64 KB) parses (`src/tandem-settings.js`) and stores into the
`pump_settings_upload` table, which the schema self-heal never wipes.
`GET /api/pump-settings[?at=]` and the MCP tool `get_pump_settings(at?)` return the snapshot in
effect at `at` (pump-local `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; the latest upload on or before
it, or the latest overall) plus every stored upload date. Nothing else reads these settings
yet. Snapshots cannot be edited or deleted from the page.

### Checks

Run `npm ci` then each:

`node --no-warnings test-tandem.mjs` feeds a synthetic Tandem fixture
(`test-tandem.fixture.json`) through ingest and the MCP tools.
`node --no-warnings test-health.mjs` feeds a synthetic Google Health fixture
(`test-health.fixture.json`) through ingest and `get_health_context`, including an
unlinked account.
`node --no-warnings test-controliq.mjs` runs the same Tandem fixture through
`get_controliq_review` (mode minutes per day, bolus split, flagged incomplete days).
`node --no-warnings test-tdd.mjs` seeds five synthetic weeks (one partial) and checks
`get_tdd_trend`: weekly means, flagged partial week, change, rolling mean, slope, proxies.
`node --no-warnings test-pump-settings.mjs` parses a synthetic t:connect paste (CRLF,
trailing spaces, three profiles, multi-segment schedules), checks identifiers are dropped and
a repeat import is a no-op, and covers `get_pump_settings` and `/api/pump-settings` (401
without the credential, 413 over the cap).
`node --no-warnings test-web.mjs` covers the page and `/api/*`: 401 without the credential,
200 and valid JSON with it from the synthetic fixture, and 503 without `OMNI_MYDATA_BASIC`.
`node test-mydata.mjs` covers the payload shape, anonymous / wrong-credential /
Bearer-instead-of-Basic requests, and re-execs itself without `OMNI_MYDATA_BASIC` to prove
the fail-closed branch. It uses the existing `__OMNI_FETCH_STUB__` seam, so it never
touches the network.

---

<a id="privacy--security"></a>
## 🔒 Privacy & Security: Your Data, Your Control
Because this involves sensitive medical credentials and data, it is designed with a **"local-first" architecture**.

* **No Middle Man:** your Glooko username and password never leave your machine. They are sent directly from your local Docker container to Glooko's servers. No third-party server ever sees them.
* **It runs on your computer:** the server, the database, and the analysis tools all run locally in Docker.
* **You choose the AI:** connect it to Claude Desktop, to Google Gemini via Open WebUI, or to a local model through Open WebUI. With a local model, your data never leaves your machine at all.

> [!IMPORTANT]
> If you use a cloud AI assistant (Claude, Gemini), most providers have a setting that allows them to "train" on your conversations. Before discussing your clinical data, consider turning off chat history / model training in that assistant's privacy settings, so your medical history stays private.

> [!TIP]
> Want to try it before connecting your own account? This repository ships with a small **example database** of real data so you can explore everything offline, with no Glooko login at all. Follow the "example data" path through Steps 2 and 3 below.

---

<a id="the-tough-love-ai-persona"></a>
## 🧐 The "Tough Love" AI Persona
The tool ships with a built-in AI persona: a **"Tough Love" Endocrinologist**.

Managing Type 1 Diabetes is hard, and placating a user doesn't improve Time in Range. The persona is direct, analytical, and uncompromising. It won't sugar-coat the data; it will tell you where your bolus timing is off, where you are over-correcting, or where your basal is failing to catch a drift. It is also built to work *efficiently*, pulling summaries first and only drilling into granular data when it needs to.

When you connect the tool, this persona is available as a selectable prompt called **"Clinical auditor persona"**. Selecting it is what turns the AI into the endocrinologist.

Its directness is a deliberate style, not authority. Everything it says is to help you *understand* what is happening and *ask better questions* of your diabetes care team. It does not, and should not, tell you to change settings such as your DIA or carb ratios. Any change to your therapy is a conversation for you and your healthcare professional.

---

> [!WARNING]
> Be aware that links in this document may take you away from this page. To open in a new tab, right-click and select **Open Link in New Tab**.

<a id="step-1-installing-docker"></a>
## 🛠️ Step 1: Getting Ready (Installing Docker)
To run this tool we use **Docker**. Think of Docker as a "shipping container" for software: it lets Ridgeline T1D run perfectly on your computer without you installing complicated code libraries by hand.

This may require a restart, so make sure you are ready for that before starting.

### **For Windows Users**
1. **Download:** Go to the [Docker installation instructions for Windows](https://docs.docker.com/desktop/setup/install/windows-install/), read the options, and download the one that suits your machine. For most users this is **Docker Desktop for Windows - x86_64**.
2. **Install:** Run the `.exe`. **Important:** during installation, ensure **"Use WSL 2 instead of Hyper-V"** is checked.
3. **Restart:** Your computer will likely ask to restart.
4. **Start:** Open "Docker Desktop" from the Start Menu and accept the terms.

> [!WARNING]
> If you see a WSL version issue, see [this guide](https://docs.docker.com/desktop/setup/install/windows-install/#option-1-install-or-update-wsl-via-the-terminal) to resolve it.

### **For Mac Users**
1. **Download:** Go to the [Docker installation instructions for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).
   - Choose **"Apple Chip"** for a newer Mac (M1, M2, M3, M4).
   - Choose **"Intel Chip"** for an older Mac.
2. **Install:** Open the `.dmg` and drag Docker into your **Applications** folder.
3. **Start:** Open Docker from Applications. You may need to enter your Mac password to grant permission.

> [!NOTE]
> Make sure Docker Desktop is actually *running* (you'll see its whale icon in your menu bar or system tray) before continuing.

---

<a id="step-2-getting-the-files"></a>
## 📂 Step 2: Getting the Files
1. **Get the code:** `git clone https://github.com/jbeck1563/ridgeline-t1d` (or download the ZIP from that page).
2. **Remember where it lives:** the folder location matters for the steps below. For example:
   `/home/you/ridgeline-t1d`

Inside, you should see:
* `src/` (the application code)
* `examples/` (the example database)
* `docker-compose.yml`
* `Dockerfile`
* `.env.example`
* ...and a few other small files.

### Create the `data` folder
The tool keeps its database in a folder called `data`, which sits at the same level as the `src` folder. You need to create it now, and what you put in it depends on whether you want to explore the included example data or use your own.

4. **Create the folder.** In your project folder (the one containing `src/`), create a new, empty folder called exactly `data`.

5. **Now follow the line that matches you:**

   **To use the included example data (no Glooko account needed):**
   Copy the database file out of the `examples` folder and into your new `data` folder, so you have:
   ```
   examples/omni-endo.db   ->   data/omni-endo.db
   ```
   That is all the `data` folder needs. The tool will read this example database and never contact Glooko.

   **To use your own Glooko data:**
   Leave the `data` folder **completely empty**. The tool will download your own data into it from Glooko on the first run. (If you copied the example database in earlier to try it, delete `data/omni-endo.db` now, so your real data is not mixed with mine.)

> [!NOTE]
> The example data is my own real diabetes data, shared on purpose so people have something genuine to explore. Either way, your data lives in this `data` folder and stays on your machine.

---

<a id="step-3-configure-your-settings"></a>
## ⚙️ Step 3: Configure Your Settings (`.env`)
The tool reads its settings from a file called `.env`. The repository includes a template called `.env.example`, you make your own copy and fill it in.

### Before you start: making hidden files visible

Files whose names start with a dot (like `.env`) are hidden by default on both Mac and Windows. You need to make them visible before you can see, copy, or rename them.

#### On a Mac

1. Open **Finder** and navigate to your project folder.
2. Press **Cmd + Shift + .** (Command, Shift, and the full stop key together). Hidden files will appear, shown in a slightly greyed-out style.
3. Press the same shortcut again to hide them when you are done.

Alternatively, you can do everything from Terminal without needing to see the file at all:
```bash
cp .env.example .env
```
Run this from inside your project folder. It copies the template to `.env` in one step.

#### On Windows

1. Open **File Explorer** and navigate to your project folder.
2. Click the **View** tab at the top of the window.
3. Check the box labelled **"Hidden items"**. Hidden files will now appear, shown with a slightly faded icon.
4. On Windows 11, go to **View → Show → Hidden items** instead.

To rename the copy: right-click `.env.example`, choose **Copy**, then **Paste**, then right-click the new copy and choose **Rename**. Type `.env` and press Enter. Windows may warn you that changing the extension could make the file unusable — click **Yes**.

> [!NOTE]
> Windows can be reluctant to save a file with no name before the dot. If your text editor saves it as `.env.txt` by default, rename it and remove the `.txt` part, confirming the extension change when prompted. In Notepad, use **File → Save As**, set **Save as type** to **All Files (*.*)**, and type `.env` as the filename.

---

1. **Copy the template:** Make a copy of `.env.example` and rename the copy to exactly `.env` (just `.env`, nothing before the dot).
2. **Open `.env`** in any text editor and edit it for one of the two scenarios below.

There are two ways to run the tool: with the **included example data** (no Glooko login, the quickest way to try it), or with **your own Glooko data**. Pick the scenario that applies to you. Each one tells you how to set `.env` here in Step 3; the matching `data` folder setup was already covered in [Step 2](#step-2-getting-the-files).

### Scenario 1: Just trying it with the example data (no Glooko login)
This is the easiest way to start, and it never contacts Glooko.

* `GLOOKO_EMAIL` and `GLOOKO_PASSWORD`: **leave both blank.** Blank credentials put the tool in offline mode, so it only ever reads the example database.
* `GLOOKO_GLUCOSE_UNIT`: set to `mmol`. The example data is mine, and I am British, so it is recorded in mmol/L.
* `OMNI_TOKEN`: set any hard-to-guess phrase. It is only used by the Open WebUI path (Section B) and the OpenAPI interface (Section C); the Claude Desktop path does not use it. It is simplest to set it anyway so it is ready if you try those paths.
* The display settings (`OMNI_UNITS`, `OMNI_LOWER`, `OMNI_UPPER`) can be left at their mmol defaults to view it the way I do.

The example `.env` below is ready to use for a test against the provided data. Copy it as-is to use it:

```bash
# ============================================================================
#  Ridgeline T1D: configuration
# ============================================================================
#  Copy this file to ".env" (same folder) and fill in the two REQUIRED values
#  below. Everything else has sensible defaults you can leave alone.
#
#  Docker reads this file literally: do NOT put quotes around values, and a
#  line starting with "#" is a comment.
# ============================================================================

# --- Glooko login (OPTIONAL) ------------------------------------------------
#  Your Glooko email and password let the server download YOUR data and keep it
#  up to date. They stay on your machine and are never shared.
#
#  LEAVE THESE BLANK to run in OFFLINE mode: the server will NEVER contact
#  Glooko and will serve only the data already in its database (for example, a
#  sample database shipped with the project). This is the safe way to explore
#  with example data, or to run against a database you have already built.
#
#  Fill them in to download and refresh your own data.
GLOOKO_EMAIL=
GLOOKO_PASSWORD=

# --- IMPORTANT if you provide a Glooko login: your Glooko account's unit ------
#  Glooko sends your data in whatever glucose unit your Glooko ACCOUNT is set to
#  (often mg/dL for US accounts, mmol/L elsewhere). Set this to match your Glooko
#  account so the data is interpreted correctly as it is downloaded. Getting this
#  wrong corrupts the stored data (e.g. a 162 mg/dL reading stored as 162 mmol/L).
#
#  This is SEPARATE from OMNI_UNITS below: this one is how your data ARRIVES from
#  Glooko; OMNI_UNITS is how you want to SEE it. They can differ (e.g. a US user
#  whose Glooko is mg/dL could still choose to view everything in mmol/L).
#
#  Values: "mmol" (mmol/L, default) or "mgdl" (mg/dL). Only matters when you have
#  a Glooko login; ignored in offline mode.
GLOOKO_GLUCOSE_UNIT=mmol

# --- A secret token --------------------------------------------------------
#  Any hard-to-guess phrase. It protects the data endpoint used by Open WebUI
#  and the OpenAPI interface, so only you (and the tools on your own machine)
#  can reach it. The Claude Desktop path does not use it, but it is simplest to
#  set it anyway so it is ready if you try the other paths.
#  To generate a strong one, run:  openssl rand -hex 16
OMNI_TOKEN=change-me-to-a-secret

# --- OPTIONAL: your preferred glucose unit and target range ----------------
#  Set these once to your preference and every tool uses them by default, so you
#  never have to specify them per question. You (or the AI) can still override
#  them for a one-off query without changing this file.
#
#  OMNI_UNITS:  "mmol" (mmol/L, default) or "mgdl" (mg/dL).
#  OMNI_LOWER:  low/hypo boundary, IN THE UNIT ABOVE. Readings below = time-low.
#  OMNI_UPPER:  high/hyper boundary, IN THE UNIT ABOVE. Readings above = time-high.
#
#  IMPORTANT: the boundaries must be in the same unit as OMNI_UNITS. For mmol the
#  usual range is 3.9 to 10.0; for mgdl it is 70 to 180. If you leave these blank
#  the defaults are 3.9/10.0 for mmol or 70/180 for mgdl.
OMNI_UNITS=mmol
OMNI_LOWER=3.9
OMNI_UPPER=10.0

# --- OPTIONAL: how far back to load on first run ---------------------------
#  Only used when you HAVE provided a Glooko login above. On first use the
#  server downloads your history from this date to now. If you leave it blank,
#  it defaults to 3 MONTHS before today, which is fast and is the amount in the
#  example database. Set an earlier date to capture more history.
#  Format: YYYY-MM-DD.
OMNI_OLDEST_DATE=
```

When your `.env` is ready, the `data` folder you created in [Step 2](#step-2-getting-the-files) should contain the example database (`data/omni-endo.db`).

### Scenario 2: Using your own Glooko data
To connect your own account and download your own history, set these in `.env`:

1. **Add your Glooko login:** set `GLOOKO_EMAIL` and `GLOOKO_PASSWORD` to your normal Glooko credentials.
2. **Set the remaining values to match you:**
   * `GLOOKO_GLUCOSE_UNIT` — the unit your **Glooko account** is set to (`mmol` or `mgdl`). Get this right, it is how your data is read as it downloads.
   * `OMNI_TOKEN` — your secret token (any hard-to-guess phrase).
   * `OMNI_UNITS` — how you want to **see** your data (`mmol` or `mgdl`).
   * `OMNI_LOWER` / `OMNI_UPPER` — your target blood sugar range, in the unit you chose for `OMNI_UNITS`.
   * `OMNI_OLDEST_DATE` (optional) — how far back to load on the first run; blank limits it to the last 3 months.

When your `.env` is ready, the `data` folder you created in [Step 2](#step-2-getting-the-files) should be empty, ready for your download.

> [!IMPORTANT]
> `GLOOKO_GLUCOSE_UNIT` (how your data **arrives** from Glooko) and `OMNI_UNITS` (how you want to **see** it) are different settings. They can be the same, but they do not have to be.

---

<a id="ports-and-docker-compose"></a>
## 🔌 Ports (only if one is already in use)

> [!NOTE]
> **You can skip this for now.** You do not need to change anything here to get started, the defaults work for almost everyone. This section is here next to the other configuration so it is easy to find. Come back to it **only if**, when you later start the stack (Section B or C), you see an error like "port is already allocated" or a page won't load. If you only use Claude Desktop (Section A), you can ignore ports entirely.

The Open WebUI and OpenAPI paths run a small stack of containers, and that stack uses three ports on your machine. These are set in **`docker-compose.yml`**, not in `.env`. You only need to touch them if one of these ports is **already being used by another program** on your computer.

### The three ports

| Purpose | Default | You open it at |
|---------|---------|----------------|
| Data server (MCP / SSE / API) | `3033` | used internally; also reachable at `http://localhost:3033` |
| API explorer + Ollama API bridge | `8000` | `http://localhost:8000/docs` |
| Open WebUI chat interface | `8083` | `http://localhost:8083` |

> [!NOTE]
> The **Claude Desktop** path (Section A) does not use these ports at all, it talks to its own container directly. So a port clash only ever affects the Open WebUI and OpenAPI paths.

### How to change a port

In `docker-compose.yml` each port appears as a mapping in the form `"HOST:CONTAINER"`, for example:

```yaml
ports:
  - "8083:8080"
```

The **left** number is the port on *your machine* (the host). The **right** number is the port *inside the container*.

> [!IMPORTANT]
> **Only ever change the left (host) number. Never change the right (container) number.** The container-side port is referenced by other parts of the stack (for example, the bridge reaches the data server at `http://ridgeline:3033/mcp`, and Open WebUI listens internally on `8080`). Changing a right-hand number will break those internal connections.

So if something else on your machine is already using `8083`, you would change only the host side:

```yaml
ports:
  - "8090:8080"      # changed 8083 to 8090; the 8080 stays
```

Pick any free port you like (adding a few hundred is a safe bet, e.g. `8083` → `8090`, `8000` → `8200`, `3033` → `3133`).

### What changing a host port affects

This is the part to be careful about, because a host port appears in more than one place:

* **The address you type in your browser changes to match.** If you change Open WebUI to `"8090:8080"`, you now open **http://localhost:8090** instead of `http://localhost:8083`. The same applies to `8000` (the OpenAPI page) and `3033`. Anywhere in this README that mentions the old port, mentally substitute your new one.
* **The internal address does *not* change.** The URL you enter inside Open WebUI to reach the tools, `http://ridgeline:3033/mcp`, stays exactly the same even if you remapped the host `3033`. That address uses Docker's internal network (the container port and service name), which the host port does not affect. Do not change it.
* **If you use the Claude Desktop path, nothing changes there either** — it does not go through these ports.

If you change a port **after** you have already started the stack, restart it so the change takes effect (`docker compose down` then `docker compose up -d`). If you have not started it yet, there is nothing to restart, your change will simply be used when you first start it in Section B or C.

---

<a id="step-4-build-the-tool"></a>
## ▶️ Step 4: Build and Start the Tool
Now we build the Docker image that the tool uses, and start the stack. This one command does both: it builds the local image, downloads the other containers the stack needs, and starts everything.

1. **Open a Terminal:**
   - **Windows:** open "PowerShell" from the Start Menu.
   - **Mac:** open "Terminal" (Cmd + Space, type Terminal).
2. **Go to the folder:** type `cd` then a space, then drag your project folder into the terminal window so the path fills in, and press Enter. For example:
   `cd /FULL/PATH/TO/ridgeline-t1d`
3. **Build and start it:** run this command and press Enter:
   ```bash
   docker compose up -d --build
   ```
   The first time, Docker builds the local image and downloads the other containers, then starts all of them in the background. This can take a few minutes. Subsequent starts are just `docker compose up -d` (no rebuild needed).

To check that everything is running:
```bash
docker compose ps
```
You should see the containers listed as running (`ridgeline`, `mcpo`, and `open-webui`). You can also watch the logs with `docker compose logs -f ridgeline`.

> [!IMPORTANT]
> If you ever download a newer version of this tool, rebuild and restart with `docker compose up -d --build`. A plain start can reuse an old cached image and run outdated code.

> [!NOTE]
> **Claude Desktop users:** the Claude Desktop path (Section A) launches its own container on demand and does not actually need this stack running. Running it does no harm, but if you *only* plan to use Claude Desktop, you can stop the stack again with `docker compose down` after confirming the build worked. The Open WebUI (Section B) and OpenAPI (Section C) paths **do** need the stack running.

You now have everything built and running. There are three ways to use it: **Claude Desktop** (Section A), **Open WebUI** (Section B), or the **OpenAPI interface** (Section C). You can use all three or just pick a favourite.

> [!NOTE]
> **First query on your own data may be slow.** If you set this up with your own Glooko account (an empty `data` folder), the very first question you ask (or the first call you make in Section C) triggers a download of your history from Glooko before it can answer. This can take from a few seconds to a minute or so depending on how much history you requested. It only happens once; after that your data is stored locally and answers are fast. (If you are using the example data, there is no download and the first query is immediate.)

### Switching from the example data to your own data later
If you started with the example data and now want to use your own Glooko account, do this:

1. **Stop the tool.** If you are running the Open WebUI / OpenAPI stack, run `docker compose down` in the project folder. If you only use Claude Desktop, fully quit Claude Desktop.
2. **Edit `.env`:** add your `GLOOKO_EMAIL` and `GLOOKO_PASSWORD`, and set the other values to match you (see Scenario 2 in Step 3).
3. **Empty the `data` folder:** delete (or move elsewhere as a backup) `data/omni-endo.db`, so the example data is not mixed with yours.
4. **Start again:** run `docker compose up -d` (Open WebUI / OpenAPI), or reopen Claude Desktop. On the next query the tool downloads your own history into the now-empty `data` folder.

---


## 💬 Section A: Use it with Claude Desktop

With Claude Desktop, Claude launches its own copy of the tool on demand and reads your data directly. You do **not** need to keep anything running in the terminal for this — Claude starts and stops the container itself.

### A1. Find your Claude config file
Claude Desktop is configured by a file called `claude_desktop_config.json`.

* **Mac:** `/Users/<yourname>/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

The easiest way to open it: in Claude Desktop go to **Settings → Developer → Edit Config**. That opens the right file for you.

### A2. Add the ridgeline-t1d server
Add an `mcpServers` entry to the file. The block below is a template; change those two paths to match *your* setup.

```json
{
  "mcpServers": {
    "ridgeline-t1d": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--env-file",
        "/FULL/PATH/TO/ridgeline-t1d/.env",
        "-v",
        "/FULL/PATH/TO/ridgeline-t1d/data:/data",
        "ridgeline-t1d"
      ]
    }
  }
}
```

If the file already has an `mcpServers` section, add just the `"ridgeline-t1d"` block inside it rather than pasting the whole thing.

**How this relates to your setup — change these two paths:**

Both paths above start with the project folder, `/FULL/PATH/TO/ridgeline-t1d`. Yours will be wherever you moved the extracted folder in Step 2. Replace the placeholder with yours in both places:

* **The `--env-file` line** must point to your `.env` file: `<your project folder>/.env`
* **The `-v` line** must point to your `data` folder: `<your project folder>/data:/data`

The part **after** the colon (`:/data`) is the path *inside* the container and must be left exactly as it is — only change the part before the colon.

The last line, `ridgeline-t1d`, is the name of the Docker image you built in Step 4, and stays the same for everyone.

> [!TIP]
> Easiest way to get your exact path: in a terminal, `cd` into your project folder and run `pwd` (Mac) or `cd` with no arguments (Windows shows the path). Copy what it prints and use it in both lines above.

> [!NOTE]
> Always use the full path. On Mac it starts with `/Users/yourname/...`; on Windows it looks like `C:\\Users\\YourName\\...` (note the double backslashes, which JSON requires).

### A3. Restart Claude Desktop
Fully quit Claude Desktop (on Mac, Cmd + Q, not just closing the window) and open it again, so it picks up the new config.

### A4. Make sure the tools are loaded
In a chat, open the connector / tools menu. You should see **ridgeline-t1d** with its tools.

<kbd><img src="docs/images/Claude1.png" width="700"></kbd>

> [!IMPORTANT]
> Claude Desktop has a setting for how it loads tools. If it is set to **"Load tools when needed"**, it may not show the summary and trend tools straight away. For the best experience, set it to **"Tools already loaded"** so every tool is available immediately. This is the single most common setup snag.

<kbd><img src="docs/images/Claude2.png" width="700"></kbd>

*(Image: the Claude Desktop connector menu showing "Tool access" set to "Tools already loaded".)*

### A5. Select the persona and ask away
From the same menu, choose the **"Clinical auditor persona"** prompt, then ask your question. 

<kbd><img src="docs/images/Claude3.png" width="900"></kbd>

An example using the data I have given you...:

> *"Tell me about my diabetes data."*

<kbd><img src="docs/images/Claude4.png" width="900"></kbd>

Claude pulls the data and gives you it's interpretation. You can then discuss the findings...

<kbd><img src="docs/images/Claude5.png" width="900"></kbd>

*(Image: Claude using the tools to answer a question about your data.)*

---

<a id="section-b-open-webui"></a>

## 🛑 How to Stop
* **Claude Desktop path:** nothing to stop — Claude shuts the container down itself when it's done.
* **Open WebUI or OpenAPI path:** in your terminal, in the project folder, run:
  ```bash
  docker compose down
  ```

---

<a id="troubleshooting"></a>
## 🛠️ Troubleshooting
> [!NOTE]
> This section will grow over time. If you hit something not covered here, please open an issue and I'll help.

**Only some tools show up in Claude (e.g. just two).**
Set Claude's tool loading to **"Tools already loaded"** (Section A4). In "Load tools when needed" mode Claude may not surface the summary/trend tools for a given question.

**Claude seems to be running old behaviour after an update.**
Rebuild and restart the image: `docker compose up -d --build`. A cached image can keep running old code.

**"Port already in use".**
Another app is using a port (3033, 8000, or 8083). See [Ports (only if one is already in use)](#ports-and-docker-compose) for how to change it safely: change only the host (left) number of the mapping in `docker-compose.yml`, restart, and use the new port in your browser. Claude-Desktop-only users are unaffected.

**Open WebUI can't reach the MCP tools.**
Check the URL is `http://ridgeline:3033/mcp` (not `localhost`) and that the bearer token matches your `OMNI_TOKEN` exactly.

**The OpenAPI page rejects my requests (401 / unauthorised).**
Click **Authorize** at the top of `http://localhost:8000/docs` and paste your `OMNI_TOKEN`. The token must match the one in your `.env` exactly.

**I asked about a date and got nothing back.**
If you're using the **example data** (offline mode), only the example's date range is available. Ask the assistant what date range it holds first, or call `get_diabetes_summary` with a wide window and read `reportRange`.

**Gemini models don't appear in the model dropdown.**
Search for `gemini`, not `google`. The models are prefixed by engine name. If nothing appears, go back to **Admin Panel → Settings → Connections** and use the verify button to confirm the API key and base URL are accepted.

---



## Deploying under the new name

A deployer must change: the compose build context URL to `https://github.com/jbeck1563/ridgeline-t1d.git` (the old URL redirects), the image name (suggest `ridgeline-t1d:<sha>`), and the Claude MCP connection name to `ridgeline-t1d`. Keep every `OMNI_*` / `GLOOKO_*` variable, the SQLite file and `/mcp`, `/my-data`, `/`, `/api/*` as they are.

## License

MIT. The example database is the original author's own data, shared for exploration.

### Disclaimer

