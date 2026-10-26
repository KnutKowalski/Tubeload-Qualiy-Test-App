import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CsvWriter, csvEscape } from "../src/csv";
import type { Sample } from "../src/types";

function sample(over: Partial<Sample> = {}): Sample {
  return {
    ts: 0,
    sessionId: "s1",
    kind: "video",
    queueIndex: 0,
    url: "https://www.youtube.com/watch?v=abc",
    state: "playing",
    currentTime: 1.23456,
    duration: 10,
    bufferedSec: 5,
    quality: "720p",
    width: 1280,
    height: 720,
    bandwidthMBps: 0.5,
    cpuPercent: 1,
    ramMb: 100,
    rendererCpuPercent: 2,
    jsHeapMb: 3,
    stalls: 0,
    stallSec: 0,
    startupMs: 1200,
    droppedFrames: 0,
    totalFrames: 100,
    ...over,
  };
}

test("csvEscape: Anführungszeichen, Kommas, Zeilenumbrüche, Formeln", () => {
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape("a\nb"), '"a\nb"');
  assert.equal(csvEscape("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvEscape("+1"), "'+1");
  assert.equal(csvEscape("@x"), "'@x");
  assert.equal(csvEscape(-5), "-5");
  assert.equal(csvEscape(undefined), "");
});

test("CsvWriter: böse sessionId erzeugt keine zusätzlichen Spalten/Zeilen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-csv-"));
  const file = path.join(dir, "samples.csv");

  const w = new CsvWriter(file);
  w.append(sample({ sessionId: '=cmd|\' /C calc\'!A0,"x"\nINJECTED', note: "a,b" }));
  await w.close();

  const text = fs.readFileSync(file, "utf-8");
  const header = text.split("\n")[0].split(",");

  assert.ok(header.includes("note"));
  // Header + eine Datenzeile (die Zeilenumbrüche stehen innerhalb von Anführungszeichen)
  assert.equal(text.trimEnd().split(/\n(?=\d{4}-\d{2}-\d{2}T)/).length, 2);
  assert.ok(text.includes("\"'=cmd|"), "Formel wird neutralisiert und gequotet");
});

test("CsvWriter: rotiert bei Größenlimit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-csv-"));
  const file = path.join(dir, "samples.csv");

  const w = new CsvWriter(file, 600);
  for (let i = 0; i < 20; i++) w.append(sample({ sessionId: `s${i}` }));
  await w.close();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));

  assert.ok(files.length >= 2, `erwartet rotierte Dateien, gefunden: ${files.join(", ")}`);

  for (const f of files) {
    assert.ok(fs.readFileSync(path.join(dir, f), "utf-8").startsWith("timestamp,"), f);
  }
});

test("CsvWriter: Schreibfehler crasht den Prozess nicht, deaktiviert den Export und close() kehrt zurück", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-csv-"));
  const file = path.join(dir, "samples.csv");
  const w = new CsvWriter(file);

  w.append(sample());

  const internals = w as unknown as { stream: fs.WriteStream; broken: boolean };

  assert.equal(internals.broken, false);

  // Platte voll o. Ä.: der Stream meldet einen Fehler. Ohne Error-Handler wäre das ein Absturz.
  internals.stream.destroy(new Error("Platte voll (Test)"));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(internals.broken, true, "Export muss deaktiviert sein");

  const sizeBefore = fs.statSync(file).size;

  for (let i = 0; i < 5; i++) w.append(sample());

  assert.equal(fs.statSync(file).size, sizeBefore, "nach dem Fehler wird nichts mehr geschrieben");

  // close() darf beim Beenden der App nicht hängen bleiben.
  await Promise.race([
    w.close(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("close() hängt nach einem Schreibfehler")), 2000)),
  ]);
});
