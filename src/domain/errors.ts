export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", msg, details);
export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) =>
  new ApiError(409, code, msg, details);

export const ERR = {
  ALLERGEN_CONFLICT: "ALLERGEN_CONFLICT",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  INVALID_STATE: "INVALID_STATE",
  MENU_NOT_ACTIVE: "MENU_NOT_ACTIVE",
  DEPENDENCY_NOT_MET: "DEPENDENCY_NOT_MET",
  VALIDATION: "VALIDATION",
} as const;

export function requireFields(body: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null);
  if (missing.length) throw badRequest(`missing fields: ${missing.join(", ")}`, { missing });
}

export function requirePositiveInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw badRequest(`${name} must be a positive integer`);
  return v;
}
