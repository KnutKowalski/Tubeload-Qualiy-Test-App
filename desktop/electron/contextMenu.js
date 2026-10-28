/**
 * Rechtsklick-Menü für das Dashboard-Fenster. Electron zeigt von sich aus keins an;
 * ohne dieses Menü ginge Einfügen/Kopieren nur per Tastatur.
 *
 * Bewusst eine reine Funktion (kein Zugriff auf "electron"): so lässt sie sich ohne
 * Fenster testen. main.js macht daraus mit Menu.buildFromTemplate das echte Menü.
 *
 * params entspricht dem Parameter des "context-menu"-Ereignisses von webContents
 * (isEditable, selectionText, editFlags).
 */
function contextMenuTemplate(params) {
  const flags = (params && params.editFlags) || {};
  const hasSelection = typeof params?.selectionText === "string" && params.selectionText.trim() !== "";

  // Eingabefeld (URL, Zahlen, Skripttext): Bearbeiten-Menü.
  if (params?.isEditable) {
    return [
      { role: "undo", label: "Rückgängig", enabled: Boolean(flags.canUndo) },
      { role: "redo", label: "Wiederholen", enabled: Boolean(flags.canRedo) },
      { type: "separator" },
      { role: "cut", label: "Ausschneiden", enabled: Boolean(flags.canCut) },
      { role: "copy", label: "Kopieren", enabled: Boolean(flags.canCopy) },
      { role: "paste", label: "Einfügen", enabled: Boolean(flags.canPaste) },
      { type: "separator" },
      { role: "selectAll", label: "Alles auswählen", enabled: Boolean(flags.canSelectAll) },
    ];
  }

  // Markierter Text irgendwo im Dashboard (z. B. Fehlermeldung, Tabellenzelle): kopieren.
  if (hasSelection) {
    return [
      { role: "copy", label: "Kopieren", enabled: Boolean(flags.canCopy) || hasSelection },
      { role: "selectAll", label: "Alles auswählen" },
    ];
  }

  return null;
}

module.exports = { contextMenuTemplate };
