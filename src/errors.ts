/** Why foxloop refused an input. Callers can switch on `code`. */
export type FoxloopErrorCode = "bad-tool" | "bad-schema" | "bad-options" | "busy";

export class FoxloopError extends Error {
  readonly code: FoxloopErrorCode;
  constructor(code: FoxloopErrorCode, message: string) {
    super(message);
    this.name = "FoxloopError";
    this.code = code;
  }
}
