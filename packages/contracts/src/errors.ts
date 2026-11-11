/** API contract: Errors. */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
