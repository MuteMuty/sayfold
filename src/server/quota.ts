// Workers AI's refusal once the account's daily free allocation is used up, from Flux or the correction model.
import { QUOTA_CODE, QUOTA_REFUSAL } from "./config.ts";

/**
 * Whether Workers AI refused because the account's daily free allocation is used up: an error (or Flux's
 * Error message) whose `code` is 3036, or whose text is in the refusal's own form (QUOTA_REFUSAL).
 */
export function isQuotaRefusal(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error !== "object") return QUOTA_REFUSAL.test(String(error));
  const e = error as { code?: unknown; message?: unknown; description?: unknown };
  if (e.code === QUOTA_CODE || e.code === String(QUOTA_CODE)) return true;
  const texts = [e.message, e.description].filter((t): t is string => typeof t === "string");
  return texts.some((t) => QUOTA_REFUSAL.test(t));
}
