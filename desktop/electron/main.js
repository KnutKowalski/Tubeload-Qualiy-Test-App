const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 2 * 60 * 1000;

let win = null;
let coreProcess = null;
let coreLogTail = "";
let logPath = null;
let logBytes = 0;

let port = 0;
let token = "";
let origin = "";

let quitting = false;
// true, solange der Core absichtlich beendet wird (Fenster zu, App beenden).
let stoppingCore = false;
let booting = false;
const restartTimes = [];

// ---------------------------------------------------------------------------
// Einzelinstanz: eine zweite Instanz würde einen zweiten Core + Browser starten.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(boot);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const p = typeof address === "string" || !address ? 0 : address.port;
      srv.close(() => resolve(p));
    });
  });
}

function appendCoreLog(chunk) {
  const text = String(chunk);

  coreLogTail = (coreLogTail + text).slice(-8000);

  if (!logPath || logBytes > MAX_LOG_BYTES) return;

  try {
    fs.appendFileSync(logPath, text);
    logBytes += Buffer.byteLength(text);
  } catch {
    // Logdatei nicht schreibbar – kein Grund, die App zu beenden.
  }
}

async function waitForHealth(child) {
  const url = `${origin}/api/health`;

  // 240 x 500 ms = 120 s Startfenster.
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return false;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // noch nicht bereit
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

function coreDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "core")
    : path.join(__dirname, "..", "core");
}

function startCore() {
  const dir = coreDir();
  const dataDir = path.join(app.getPath("userData"), "data");

  stoppingCore = false;

  const child = spawn(process.execPath, [path.join(dir, "dist", "index.js")], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      TB_DATA_DIR: dataDir,
      TB_DASHBOARD: path.join(dir, "public", "dashboard.html"),
      // Das Token wird in das ausgelieferte Dashboard eingesetzt; es verlässt die App nie.
      TB_TOKEN: token,
      PORT: String(port),
      TB_HEADLESS: process.env.TB_HEADLESS || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  coreProcess = child;

  child.stdout.on("data", (data) => {
    process.stdout.write(`[core] ${data}`);
    appendCoreLog(data);
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(`[core] ${data}`);
    appendCoreLog(data);
  });

  child.on("error", (err) => {
    appendCoreLog(`\n[Core konnte nicht gestartet werden: ${err.message}]\n`);
  });

  child.on("exit", (code, signal) => {
    appendCoreLog(`\n[Core-Prozess beendet: Code ${code}, Signal ${signal}]\n`);

    if (coreProcess === child) coreProcess = null;

    if (!quitting && !stoppingCore) scheduleRestart();
  });

  return child;
}

function stopCore() {
  stoppingCore = true;

  try {
    // SIGTERM löst im Core einen geordneten Shutdown aus (unter Windows hartes Beenden).
    coreProcess?.kill("SIGTERM");
  } catch {
    // Prozess bereits beendet
  }
}

// Stürzt der Core ab, wird er neu gestartet. Das Dashboard verbindet sich von selbst
// wieder (gleicher Port, gleiches Token). Bei Absturzschleifen wird aufgegeben.
function scheduleRestart() {
  const now = Date.now();

  while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) {
    restartTimes.shift();
  }

  if (restartTimes.length >= MAX_RESTARTS) {
    showStartError(
      `Der TubeLoad-Core ist ${MAX_RESTARTS}× kurz hintereinander abgestürzt.`
    );
    quitApp();
    return;
  }

  restartTimes.push(now);

  setTimeout(() => {
    if (quitting || stoppingCore || coreProcess) return;
    startCore();
  }, 1500);
}

function showStartError(headline) {
  dialog.showErrorBox(
    "TubeLoad QA Startfehler",
    headline +
      "\n\n" +
      "Letzte Core-Ausgabe:\n" +
      "---------------------------\n" +
      (coreLogTail.trim() || "(keine Ausgabe – Core evtl. vor dem Start abgestürzt)") +
      "\n---------------------------\n\n" +
      "Vollständiges Log: " + logPath + "\n\n" +
      "Prüfe:\n" +
      "- Ist Google Chrome, Chromium oder Microsoft Edge installiert?\n" +
      "- Läuft noch eine alte App-Instanz im Hintergrund? Beenden und neu starten\n" +
      "- Optional TB_CHROME_PATH auf den Browser-Pfad setzen"
  );
}

function quitApp() {
  quitting = true;
  stopCore();
  app.quit();
}

// ---------------------------------------------------------------------------
// Fenster
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    backgroundColor: "#111111",
    title: "TubeLoad QA",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.removeMenu?.();

  const wc = win.webContents;

  // Das Fenster zeigt ausschließlich das lokale Dashboard.
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  wc.on("will-navigate", (event, url) => {
    if (url !== origin && !url.startsWith(origin + "/")) event.preventDefault();
  });

  wc.on("will-attach-webview", (event) => event.preventDefault());

  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  win.loadURL(origin + "/");

  win.on("closed", () => {
    win = null;
  });
}

async function boot() {
  if (booting) return;
  booting = true;

  try {
    port = await getFreePort();
    token = crypto.randomBytes(24).toString("hex");
    origin = `http://127.0.0.1:${port}`;

    logPath = path.join(app.getPath("userData"), "core.log");
    logBytes = 0;

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "");
    } catch {
      // ohne Logdatei weiterarbeiten
    }

    const child = startCore();

    if (!(await waitForHealth(child))) {
      stopCore();
      showStartError("Der TubeLoad-Core konnte nicht starten.");
      quitApp();
      return;
    }

    createWindow();
  } finally {
    booting = false;
  }
}

// ---------------------------------------------------------------------------
// App-Lebenszyklus
// ---------------------------------------------------------------------------

app.on("activate", () => {
  // macOS: Dock-Klick nach geschlossenem Fenster -> Core und Fenster neu aufbauen.
  if (BrowserWindow.getAllWindows().length === 0 && !booting) {
    boot();
  }
});

app.on("before-quit", () => {
  quitting = true;
  stopCore();
});

app.on("window-all-closed", () => {
  stopCore();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
