// The part of kit-settings.mjs that bin/sync.ts calls, typed for its --strict check. Not copied into any repo.
export function completeKitSettings(
    root: string,
    env: Readonly<Record<string, string | undefined>>,
    options?: { check?: boolean },
): { ok: true; changed: boolean } | { ok: false; error: string; skipped?: true };
