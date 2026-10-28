import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

// Reine Funktion der Desktop-App (kein Electron nötig).
const { contextMenuTemplate } = createRequire(__filename)(
  path.resolve(__dirname, "..", "..", "electron", "contextMenu.js")
) as { contextMenuTemplate: (p: unknown) => Array<{ role?: string; label?: string; type?: string; enabled?: boolean }> | null };

const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

test("Eingabefeld: Rückgängig, Ausschneiden, Kopieren, Einfügen, Alles auswählen", () => {
  const t = contextMenuTemplate({ isEditable: true, selectionText: "", editFlags: allFlags })!;

  assert.deepEqual(
    t.filter((i) => i.role).map((i) => i.role),
    ["undo", "redo", "cut", "copy", "paste", "selectAll"]
  );
  assert.deepEqual(
    t.filter((i) => i.role).map((i) => i.label),
    ["Rückgängig", "Wiederholen", "Ausschneiden", "Kopieren", "Einfügen", "Alles auswählen"]
  );
  assert.ok(t.every((i) => i.type === "separator" || i.enabled === true));
});

test("Eingabefeld: Einträge folgen den Möglichkeiten (leere Zwischenablage, nichts markiert)", () => {
  const t = contextMenuTemplate({
    isEditable: true,
    selectionText: "",
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
  })!;
  const enabled = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i.enabled]));

  assert.deepEqual(enabled, { undo: false, redo: false, cut: false, copy: false, paste: false, selectAll: true });

  // Fehlende editFlags brechen nichts: alles gesperrt
  const bare = contextMenuTemplate({ isEditable: true })!;

  assert.ok(bare.filter((i) => i.role).every((i) => i.enabled === false));
});

test("Markierter Text außerhalb von Eingabefeldern: nur Kopieren und Alles auswählen", () => {
  const t = contextMenuTemplate({ isEditable: false, selectionText: "Fehler: Zeile 3", editFlags: { canCopy: true } })!;

  assert.deepEqual(
    t.map((i) => i.role),
    ["copy", "selectAll"]
  );
  assert.equal(t[0].enabled, true);
});

test("Nichts Markiertes und kein Eingabefeld: kein Menü", () => {
  assert.equal(contextMenuTemplate({ isEditable: false, selectionText: "", editFlags: allFlags }), null);
  assert.equal(contextMenuTemplate({ isEditable: false, selectionText: "   " }), null);
  assert.equal(contextMenuTemplate(undefined), null);
  assert.equal(contextMenuTemplate(null), null);
});
