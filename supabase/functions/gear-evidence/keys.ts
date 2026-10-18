// Hosted runtimes inject named key maps. Prefer default; an unnamed single key
// is unambiguous. Never fall back to revoked legacy JWT keys.
export function platformKey(value: string | undefined, prefix: string): string {
  try {
    const keys: unknown = JSON.parse(value || "{}");
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return "";
    const map = keys as Record<string, unknown>;
    if (typeof map.default === "string" && map.default.startsWith(prefix))
      return map.default;
    const candidates = Object.values(map).filter(
      (key): key is string => typeof key === "string" && key.startsWith(prefix),
    );
    return candidates.length === 1 ? candidates[0] : "";
  } catch {
    return "";
  }
}
