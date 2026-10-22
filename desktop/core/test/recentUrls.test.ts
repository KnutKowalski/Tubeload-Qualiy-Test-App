import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LIMITS } from "../src/limits";
import { RecentUrls } from "../src/recentUrls";
import { ValidationError } from "../src/validate";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-recent-")), "sub", "recent-urls.json");
const v = (id: string) => `https://www.youtube.com/watch?v=${id}`;

test("URLs überleben einen Neustart (neue Instanz liest dieselbe Datei)", () => {
  const file = tmpFile();
  const a = new RecentUrls(file);

  a.add(v("eins"));
  a.add(v("zwei"));

  const b = new RecentUrls(file);

  assert.deepEqual(b.all(), [v("zwei"), v("eins")], "neueste zuerst");
});

test("Duplikate rücken nach vorn, die Liste ist begrenzt", () => {
  const r = new RecentUrls(undefined, 3);

  for (const id of ["a", "b", "c"]) r.add(v(id));

  r.add(v("a"));
  assert.deepEqual(r.all(), [v("a"), v("c"), v("b")]);

  r.add(v("d"));
  assert.deepEqual(r.all(), [v("d"), v("a"), v("c")], "älteste fällt heraus");
});

test("Standardgrenze entspricht LIMITS.maxRecentUrls", () => {
  const r = new RecentUrls();

  for (let i = 0; i < LIMITS.maxRecentUrls + 5; i++) r.add(v(`id${i}`));

  assert.equal(r.all().length, LIMITS.maxRecentUrls);
});

test("ungültige URLs werden abgelehnt und nicht gespeichert", () => {
  const r = new RecentUrls();

  for (const bad of ["file:///etc/passwd", "http://127.0.0.1:7777/", "https://evil.example/x", "", "   ", 5, null, undefined]) {
    assert.throws(() => r.add(bad), ValidationError, String(bad));
  }

  assert.throws(() => r.add(v("x".repeat(LIMITS.maxUrlLength))), ValidationError, "zu lang");
  assert.deepEqual(r.all(), []);
});

test("Entfernen: meldet, ob etwas entfernt wurde, und speichert", () => {
  const file = tmpFile();
  const r = new RecentUrls(file);

  r.add(v("a"));
  r.add(v("b"));

  assert.equal(r.remove(v("a")), true);
  assert.equal(r.remove(v("a")), false);
  assert.equal(r.remove(42), false);
  assert.deepEqual(new RecentUrls(file).all(), [v("b")]);
});

test("kaputte oder manipulierte Datei: gültige Einträge bleiben, Rest wird verworfen", () => {
  const file = tmpFile();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify([v("ok"), v("ok"), "file:///etc/passwd", 7, null, " " + v("ok2") + " "])
  );

  assert.deepEqual(new RecentUrls(file).all(), [v("ok"), v("ok2")]);

  fs.writeFileSync(file, "{kaputt");
  assert.deepEqual(new RecentUrls(file).all(), [], "kaputtes JSON bringt die App nicht zum Absturz");

  fs.writeFileSync(file, JSON.stringify({ not: "a list" }));
  assert.deepEqual(new RecentUrls(file).all(), []);
});

test("Speichern hinterlässt keine .tmp-Datei", () => {
  const file = tmpFile();

  new RecentUrls(file).add(v("a"));

  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["recent-urls.json"]);
});
