import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LIMITS } from "../src/limits";
import { SETTING_BOUNDS, SettingsStore, defaultSettings, sessionDefaultsFrom } from "../src/settings";
import { StorageError } from "../src/errors";
import { ValidationError, parseSessionInput } from "../src/validate";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-set-")), "settings.json");

test("Standardwerte entsprechen der Dokumentation (3 Läufe, 30 Min., Sessions unbegrenzt, 5 Min. Abstand)", () => {
  assert.deepEqual(defaultSettings({}), {
    maxSessions: 0,
    defaultLoops: 3,
    defaultRuntimeMin: 30,
    minScheduleIntervalMin: 5,
  });
});

test("TB_MAX_SESSIONS bestimmt den Startwert; es gibt keine feste Obergrenze", () => {
  assert.equal(defaultSettings({ TB_MAX_SESSIONS: "6" }).maxSessions, 6);
  assert.equal(defaultSettings({ TB_MAX_SESSIONS: "99" }).maxSessions, 99);
  assert.equal(defaultSettings({ TB_MAX_SESSIONS: "2500" }).maxSessions, 2500);
  assert.equal(defaultSettings({ TB_MAX_SESSIONS: " 5 " }).maxSessions, 5);
  assert.equal(defaultSettings({ TB_MAX_SESSIONS: "0" }).maxSessions, 0, "0 = unbegrenzt");

  // Ungültiges und Leeres gilt als nicht gesetzt (Standard: unbegrenzt) – "" darf nicht als Zahl 0 durchrutschen
  for (const bad of ["1e400", "1e300", "abc", "", "  ", "-2"]) {
    assert.equal(defaultSettings({ TB_MAX_SESSIONS: bad }).maxSessions, LIMITS.defaultMaxSessions, JSON.stringify(bad));
  }

  assert.equal(LIMITS.defaultMaxSessions, 0);
});

test("Obergrenzen sind fest und aus LIMITS abgeleitet", () => {
  assert.deepEqual(SETTING_BOUNDS.maxSessions, { min: 0, max: null });
  assert.deepEqual(SETTING_BOUNDS.defaultLoops, { min: 1, max: 10 });
  assert.deepEqual(SETTING_BOUNDS.defaultRuntimeMin, { min: 1, max: 240 });
  assert.deepEqual(SETTING_BOUNDS.minScheduleIntervalMin, { min: 1, max: 60 });
});

test("update: Teilaktualisierung, Persistenz über Neustart, Event", () => {
  const file = tmpFile();
  const s = new SettingsStore(file, defaultSettings({}));
  let changes = 0;

  s.on("change", () => changes++);

  const next = s.update({ maxSessions: 5, defaultRuntimeMin: 90 });

  assert.deepEqual(next, { maxSessions: 5, defaultLoops: 3, defaultRuntimeMin: 90, minScheduleIntervalMin: 5 });
  assert.equal(changes, 1);

  const reloaded = new SettingsStore(file, defaultSettings({}));

  assert.deepEqual(reloaded.get(), next);
});

test("update: ungültige Werte werden abgelehnt, ohne etwas zu ändern", () => {
  const s = new SettingsStore(undefined, defaultSettings({}));
  const before = s.get();

  const bad: unknown[] = [
    { maxSessions: -1 },
    { maxSessions: -4 },
    { maxSessions: 2.5 },
    { maxSessions: 1e300 },
    { maxSessions: Number.POSITIVE_INFINITY },
    { maxSessions: "3" },
    { maxSessions: Number.NaN },
    { defaultLoops: 11 },
    { defaultRuntimeMin: 241 },
    { minScheduleIntervalMin: 0 },
    { minScheduleIntervalMin: 61 },
    { unbekannt: 1 },
    // ein gültiges und ein ungültiges Feld: nichts davon wird übernommen
    { maxSessions: 4, defaultLoops: 99 },
    null,
    [],
    "x",
  ];

  for (const b of bad) {
    assert.throws(() => s.update(b), ValidationError, JSON.stringify(b));
  }

  assert.deepEqual(s.get(), before);
});

test("reset stellt die Standardwerte wieder her und speichert", () => {
  const file = tmpFile();
  const s = new SettingsStore(file, defaultSettings({}));

  s.update({ maxSessions: 8, defaultLoops: 7 });
  assert.deepEqual(s.reset(), defaultSettings({}));
  assert.deepEqual(new SettingsStore(file, defaultSettings({})).get(), defaultSettings({}));
});

test("kaputte oder manipulierte Datei: ungültige Felder fallen auf den Standard zurück, gültige bleiben", () => {
  const file = tmpFile();

  fs.writeFileSync(file, JSON.stringify({ maxSessions: 4, defaultLoops: 9999, defaultRuntimeMin: "x", minScheduleIntervalMin: 10 }));

  assert.deepEqual(new SettingsStore(file, defaultSettings({})).get(), {
    maxSessions: 4,
    defaultLoops: 3,
    defaultRuntimeMin: 30,
    minScheduleIntervalMin: 10,
  });

  fs.writeFileSync(file, "{kaputt");
  assert.deepEqual(new SettingsStore(file, defaultSettings({})).get(), defaultSettings({}));
});

test("Einstellungen wirken als Standardwerte neuer Sessions, die Obergrenzen bleiben fest", () => {
  const d = sessionDefaultsFrom({ maxSessions: 3, defaultLoops: 7, defaultRuntimeMin: 90, minScheduleIntervalMin: 5 });
  const url = "https://www.youtube.com/watch?v=abc";

  const s = parseSessionInput({ url, repeat: true }, d);

  assert.equal(s.maxLoops, 7);
  assert.equal(s.maxRuntimeSec, 90 * 60);

  // explizite Angaben der Anfrage gelten weiterhin, aber nur bis zur festen Obergrenze
  assert.equal(parseSessionInput({ url, maxLoops: 2, maxRuntimeSec: 60 }, d).maxLoops, 2);
  assert.throws(() => parseSessionInput({ url, maxLoops: LIMITS.maxLoops + 1 }, d), ValidationError);
  assert.throws(() => parseSessionInput({ url, maxRuntimeSec: LIMITS.maxRuntimeSec + 1 }, d), ValidationError);
});

test("Schreibfehler: update/reset melden den Fehler und übernehmen nichts (kein vorgetäuschter Erfolg)", () => {
  // Der Datenordner ist eine Datei: Anlegen der Settings-Datei scheitert.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-set-")), "blocker");

  fs.writeFileSync(blocker, "x");

  const s = new SettingsStore(path.join(blocker, "settings.json"), defaultSettings({}));
  const before = s.get();
  let changes = 0;

  s.on("change", () => changes++);

  assert.throws(() => s.update({ maxSessions: 7 }), StorageError);
  assert.deepEqual(s.get(), before, "Wert darf sich nicht geändert haben");
  assert.throws(() => s.reset(), StorageError);
  assert.equal(changes, 0, "kein change-Ereignis bei Fehler");
});

test("Parallele Sessions: beliebig hohe Werte sind erlaubt, die übrigen Obergrenzen bleiben", () => {
  const s = new SettingsStore(undefined, defaultSettings({}));

  for (const n of [10, 11, 50, 500, 100_000]) {
    assert.equal(s.update({ maxSessions: n }).maxSessions, n, String(n));
  }

  assert.equal(s.update({ maxSessions: 0 }).maxSessions, 0, "0 = unbegrenzt");
  assert.throws(() => s.update({ maxSessions: -1 }), ValidationError);
  assert.throws(() => s.update({ defaultLoops: 11 }), ValidationError, "Läufe bleiben begrenzt");
  assert.throws(() => s.update({ defaultRuntimeMin: 241 }), ValidationError, "Laufzeit bleibt begrenzt");
});

test("Gespeicherter Wert über 10 überlebt einen Neustart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-set-")), "settings.json");

  new SettingsStore(file, defaultSettings({})).update({ maxSessions: 40 });

  assert.equal(new SettingsStore(file, defaultSettings({})).get().maxSessions, 40);
});
