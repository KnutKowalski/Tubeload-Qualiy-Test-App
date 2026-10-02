const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");

let win = null;
let coreProcess = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "string" ? 0 : address.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port, child) {
  const url = `http://127.0.0.1:${port}/api/health`;

  for (let i = 0; i < 120; i++) {
    if (child.killed || child.exitCode !== null) {
      return false;
    }

    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // noch nicht bereit
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

async function createWindow() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const port = await getFreePort();
  const dataDir = path.join(app.getPath("userData"), "data");

  const coreDir = app.isPackaged
    ? path.join(process.resourcesPath, "core")
    : path.join(__dirname, "..", "core");

  const entry = path.join(coreDir, "dist", "index.js");
  const dashboard = path.join(coreDir, "public", "dashboard.html");

  coreProcess = spawn(process.execPath, [entry], {
    cwd: coreDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      TB_DATA_DIR: dataDir,
      TB_DASHBOARD: dashboard,
      PORT: String(port),
      TB_HEADLESS: process.env.TB_HEADLESS || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  coreProcess.stdout.on("data", (data) => {
    process.stdout.write(`[core] ${data}`);
  });

  coreProcess.stderr.on("data", (data) => {
    process.stderr.write(`[core] ${data}`);
  });

  coreProcess.on("exit", (code) => {
    console.log(`Core exited with code ${code}`);
  });

  const ready = await waitForHealth(port, coreProcess);

  if (!ready) {
    dialog.showErrorBox(
      "TubeLoad QA Startfehler",
      "Der TubeLoad-Core konnte nicht starten.\n\n" +
        "Prüfe:\n" +
        "- Ist Google Chrome oder Chromium installiert?\n" +
        "- Wurde desktop/core gebaut? npm --prefix core run build\n" +
        "- Optional TB_CHROME_PATH setzen.\n"
    );
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1320,
    height: 900,
    backgroundColor: "#111111",
    title: "TubeLoad QA",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.removeMenu?.();
  win.loadURL(`http://127.0.0.1:${port}`);

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  try {
    coreProcess?.kill("SIGINT");
  } catch {
    // ignore
  }
});

app.on("window-all-closed", () => {
  try {
    coreProcess?.kill("SIGINT");
  } catch {
    // ignore
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
