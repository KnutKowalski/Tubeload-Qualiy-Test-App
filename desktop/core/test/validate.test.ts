import { test } from "node:test";
import assert from "node:assert/strict";

import { LIMITS } from "../src/limits";
import { parseSessionInput, ValidationError } from "../src/validate";

const URL_OK = "https://www.youtube.com/watch?v=abc";

test("Defaults: sichere Werte, keine Dauerschleife", () => {
  const s = parseSessionInput({ url: URL_OK });

  assert.equal(s.kind, "video");
  assert.equal(s.quality, "auto");
  assert.equal(s.repeat, false);
  assert.equal(s.maxLoops, LIMITS.defaultLoops);
  assert.equal(s.maxRuntimeSec, LIMITS.defaultRuntimeSec);
  assert.equal(s.mute, true);
  assert.equal(s.consentMode, "reject");
});

test("Defaults lassen sich übergeben, explizite Werte und feste Obergrenzen gelten weiter", () => {
  const d = { loops: 5, runtimeSec: 600 };
  const s = parseSessionInput({ url: URL_OK }, d);

  assert.equal(s.maxLoops, 5);
  assert.equal(s.maxRuntimeSec, 600);
  assert.equal(parseSessionInput({ url: URL_OK, maxLoops: 2 }, d).maxLoops, 2);
  assert.throws(() => parseSessionInput({ url: URL_OK, maxLoops: LIMITS.maxLoops + 1 }, d), ValidationError);
});

test("Interaktionen: Standard leer; Skripttext und Liste werden normalisiert, Fehler abgelehnt", () => {
  assert.deepEqual(parseSessionInput({ url: URL_OK }).interactions, []);
  assert.deepEqual(parseSessionInput({ url: URL_OK, interactions: "30 pause 5\n1:00 seek -10" }).interactions, [
    { at: 30, action: "pause", value: 5 },
    { at: 60, action: "seek", value: -10 },
  ]);
  assert.deepEqual(parseSessionInput({ url: URL_OK, interactions: [{ at: 5, action: "next" }] }).interactions, [
    { at: 5, action: "next" },
  ]);

  // Schritte dürfen nicht hinter der maximalen Laufzeit liegen
  assert.throws(() => parseSessionInput({ url: URL_OK, maxRuntimeSec: 60, interactions: "61 next" }), ValidationError);
  assert.doesNotThrow(() => parseSessionInput({ url: URL_OK, maxRuntimeSec: 60, interactions: "60 next" }));

  for (const bad of ["10 tanzen", 5, [{ at: 1, action: "zufall" }]]) {
    assert.throws(() => parseSessionInput({ url: URL_OK, interactions: bad }), ValidationError, JSON.stringify(bad));
  }
});

test("lehnt fremde/gefährliche URLs ab", () => {
  for (const url of ["file:///etc/hostname", "http://127.0.0.1:7777/", "https://evil.example/x"]) {
    assert.throws(() => parseSessionInput({ url }), ValidationError, url);
  }
});

test("lehnt Nicht-Objekte und fehlende URL ab", () => {
  for (const v of [null, undefined, 5, "x", [], {}]) {
    assert.throws(() => parseSessionInput(v), ValidationError);
  }
});

test("lehnt ungültige Optionen ab (kein stilles Durchwinken)", () => {
  const bad: Record<string, unknown>[] = [
    { quality: "8k" },
    { kind: "channel" }, // passt nicht zur Video-URL
    { maxRuntimeSec: "abc" },
    { maxRuntimeSec: Number.NaN },
    { maxRuntimeSec: -1 },
    { maxRuntimeSec: LIMITS.maxRuntimeSec + 1 },
    { maxLoops: 0 },
    { maxLoops: LIMITS.maxLoops + 1 },
    { startTimeoutSec: 1 },
    { repeat: "yes" },
    { mute: 1 },
    { consentMode: "maybe" },
  ];

  for (const extra of bad) {
    assert.throws(
      () => parseSessionInput({ url: URL_OK, ...extra }),
      ValidationError,
      JSON.stringify(extra)
    );
  }
});

test("ignoriert unbekannte/alte Felder (z. B. humanize aus alten schedules.json)", () => {
  const s = parseSessionInput({ url: URL_OK, humanize: true, id: "x", repeat: true });

  assert.equal(s.repeat, true);
  assert.equal("humanize" in s, false);
  assert.equal("id" in s, false);
});
