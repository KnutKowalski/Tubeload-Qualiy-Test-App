/** Ungültige Eingabe (API, gespeicherte Dateien). Wird als HTTP 400 gemeldet. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Speichern im Datenordner ist fehlgeschlagen (Platte voll, keine Rechte …). Wird als HTTP 500 mit Meldung gezeigt. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}
