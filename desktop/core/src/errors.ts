/** Ungültige Eingabe (API, gespeicherte Dateien). Wird als HTTP 400 gemeldet. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
