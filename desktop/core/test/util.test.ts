import { test } from "node:test";
import assert from "node:assert/strict";

import { sleep, qualityHeight, viewportFor } from "../src/util";

test("sleep kehrt sofort zurück, wenn das Signal bereits abgebrochen ist", async () => {
  const ac = new AbortController();
  ac.abort();

  const t0 = Date.now();
  await sleep(5000, ac.signal);

  assert.ok(Date.now() - t0 < 200, "sleep darf nicht warten");
});

test("sleep wird durch späteres Abbrechen beendet", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  const t0 = Date.now();
  await sleep(5000, ac.signal);

  assert.ok(Date.now() - t0 < 1000);
});

test("sleep behandelt NaN/negative Werte ohne Hängen", async () => {
  const t0 = Date.now();
  await sleep(Number.NaN);
  await sleep(-5);

  assert.ok(Date.now() - t0 < 200);
});

test("qualityHeight und viewportFor", () => {
  assert.equal(qualityHeight("auto"), undefined);
  assert.equal(qualityHeight("1080p"), 1080);
  assert.deepEqual(viewportFor("auto"), { width: 1280, height: 720 });
  assert.deepEqual(viewportFor("1080p"), { width: 1920, height: 1080 });
  assert.deepEqual(viewportFor("144p"), { width: 256, height: 144 });
});
