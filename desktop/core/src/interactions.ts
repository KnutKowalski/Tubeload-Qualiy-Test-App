import { ValidationError } from "./errors";
import { LIMITS } from "./limits";
import { INTERACTION_ACTIONS, type InteractionAction, type InteractionStep } from "./types";

/**
 * Interaktionsskript: eine feste, wiederholbare Abfolge von Steuerungsschritten
 * (Pause, Sprung vor/zurück, nächstes/vorheriges Video), mit der sich messen lässt,
 * wie schnell der Player danach wieder läuft. Bewusst OHNE Zufall: dasselbe Skript
 * erzeugt bei jedem Lauf dieselben Aktionen zu denselben Zeitpunkten.
 *
 * Textformat, eine Zeile pro Schritt (# beginnt einen Kommentar):
 *
 *   <Zeit> <Aktion> [Wert]
 *   30 pause 5       nach 30 s: 5 s pausieren, dann fortsetzen
 *   1:00 seek +30    nach 1:00 min: 30 s vorspulen
 *   90 seek -15      nach 90 s: 15 s zurückspulen
 *   2:00 next        nächstes Video (Playlist/Kanal)
 *   2:30 previous    vorheriges Video (Playlist/Kanal)
 */

const ALIASES: Record<string, InteractionAction> = {
  pause: "pause",
  pausieren: "pause",
  seek: "seek",
  spulen: "seek",
  sprung: "seek",
  next: "next",
  weiter: "next",
  naechstes: "next",
  nächstes: "next",
  previous: "previous",
  prev: "previous",
  zurueck: "previous",
  zurück: "previous",
  vorheriges: "previous",
};

const DEFAULT_PAUSE_SEC = 5;

function fail(where: string, msg: string): never {
  throw new ValidationError(`${where}: ${msg}`);
}

function toInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}

/** Prüft einen Schritt und liefert die normalisierte Form. */
function checkStep(raw: unknown, where: string, maxRuntimeSec: number): InteractionStep {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(where, "muss ein Objekt mit at, action und ggf. value sein.");
  }

  const o = raw as Record<string, unknown>;

  for (const k of Object.keys(o)) {
    if (k !== "at" && k !== "action" && k !== "value") fail(where, `unbekanntes Feld "${k}".`);
  }

  const at = toInt(o.at);

  if (at === null || at < 0 || at > maxRuntimeSec) {
    fail(where, `"at" muss eine ganze Zahl zwischen 0 und ${maxRuntimeSec} (Sekunden) sein.`);
  }

  if (typeof o.action !== "string" || !(INTERACTION_ACTIONS as readonly string[]).includes(o.action)) {
    fail(where, `"action" muss eine von ${INTERACTION_ACTIONS.join(", ")} sein.`);
  }

  const action = o.action as InteractionAction;
  const hasValue = o.value !== undefined && o.value !== null;

  if (action === "pause") {
    const value = hasValue ? toInt(o.value) : DEFAULT_PAUSE_SEC;

    if (value === null || value < 1 || value > LIMITS.maxPauseSec) {
      fail(where, `Pause: Dauer muss zwischen 1 und ${LIMITS.maxPauseSec} Sekunden liegen.`);
    }

    return { at, action, value };
  }

  if (action === "seek") {
    const value = hasValue ? toInt(o.value) : null;

    if (value === null || value === 0 || Math.abs(value) > LIMITS.maxSeekSec) {
      fail(where, `Sprung: Sekunden ungleich 0, höchstens ±${LIMITS.maxSeekSec} (z. B. +30 oder -15).`);
    }

    return { at, action, value };
  }

  if (hasValue) fail(where, `"${action}" hat keinen Wert.`);

  return { at, action };
}

/** Ein Schritt belegt die Zeit bis zu seinem Ende (bei Pausen die Pausendauer). */
function busySec(s: InteractionStep): number {
  return s.action === "pause" ? (s.value ?? 0) : 0;
}

/** Sortiert (stabil) und prüft Anzahl und Abstände; Schritte dürfen sich nicht überlappen. */
function finalize(steps: InteractionStep[], origin: (i: number) => string): InteractionStep[] {
  if (steps.length > LIMITS.maxInteractionSteps) {
    throw new ValidationError(`Höchstens ${LIMITS.maxInteractionSteps} Interaktionsschritte erlaubt.`);
  }

  const order = steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at || a.i - b.i);

  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1];
    const cur = order[k];
    const earliest = prev.s.at + busySec(prev.s) + LIMITS.minInteractionGapSec;

    if (cur.s.at < earliest) {
      fail(
        origin(cur.i),
        `zu früh nach ${origin(prev.i)}: frühestens bei ${earliest} s ` +
          `(Mindestabstand ${LIMITS.minInteractionGapSec} s, Pausen zählen mit).`
      );
    }
  }

  return order.map((x) => x.s);
}

function parseTime(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);

  const m = /^(\d{1,3}):([0-5]?\d)$/.exec(token);

  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseValue(token: string): number | null {
  const m = /^([+-]?\d+)s?$/i.exec(token);

  return m ? Number(m[1]) : null;
}

/** Wandelt das Skript (Text) in Schritte um. Fehler nennen die Zeilennummer. */
export function parseInteractionScript(text: string, maxRuntimeSec: number): InteractionStep[] {
  const steps: InteractionStep[] = [];
  const lines: number[] = [];

  text.split(/\r?\n/).forEach((line, idx) => {
    const code = line.replace(/#.*$/, "").trim();

    if (!code) return;

    const where = `Skript, Zeile ${idx + 1}`;
    const tok = code.split(/\s+/);

    if (tok.length < 2 || tok.length > 3) {
      fail(where, 'erwartet "<Zeit> <Aktion> [Wert]", z. B. "30 pause 5".');
    }

    const at = parseTime(tok[0]);

    if (at === null) fail(where, `Zeit "${tok[0]}" ungültig (Sekunden oder m:ss).`);

    const action = ALIASES[tok[1].toLowerCase()];

    if (!action) fail(where, `Aktion "${tok[1]}" unbekannt (pause, seek, next, previous).`);

    let value: number | undefined;

    if (tok.length === 3) {
      const v = parseValue(tok[2]);

      if (v === null) fail(where, `Wert "${tok[2]}" ungültig (ganze Zahl, z. B. +30 oder -15).`);

      value = v;
    }

    steps.push(checkStep({ at, action, ...(value !== undefined ? { value } : {}) }, where, maxRuntimeSec));
    lines.push(idx + 1);
  });

  return finalize(steps, (i) => `Skript, Zeile ${lines[i]}`);
}

/**
 * Nimmt Skripttext (Dashboard) oder eine Schrittliste (API, gespeicherte Zeitpläne).
 * Leer/fehlend ergibt eine leere Liste.
 */
export function parseInteractions(raw: unknown, maxRuntimeSec: number): InteractionStep[] {
  if (raw === undefined || raw === null) return [];

  if (typeof raw === "string") {
    if (raw.length > 10_000) throw new ValidationError("Skript ist zu lang.");

    return parseInteractionScript(raw, maxRuntimeSec);
  }

  if (!Array.isArray(raw)) {
    throw new ValidationError('"interactions" muss ein Skripttext oder eine Liste von Schritten sein.');
  }

  if (raw.length > LIMITS.maxInteractionSteps) {
    throw new ValidationError(`Höchstens ${LIMITS.maxInteractionSteps} Interaktionsschritte erlaubt.`);
  }

  const steps = raw.map((item, i) => checkStep(item, `Interaktion ${i + 1}`, maxRuntimeSec));

  return finalize(steps, (i) => `Interaktion ${i + 1}`);
}

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Skript als lesbarer Text (Anzeige, Rundlauf mit parseInteractionScript). */
export function formatInteractionScript(steps: InteractionStep[]): string {
  return steps
    .map((s) => {
      const v = s.value === undefined ? "" : s.action === "seek" && s.value > 0 ? ` +${s.value}` : ` ${s.value}`;

      return `${clock(s.at)} ${s.action}${v}`;
    })
    .join("\n");
}
