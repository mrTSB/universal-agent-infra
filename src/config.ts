// ---------------------------------------------------------------------------
// Persistent API key storage
// Keys are saved to .agents/keys.json (gitignored) and injected into
// process.env so all existing code keeps working without modification.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const KEYS_DIR  = ".agents";
const KEYS_FILE = join(KEYS_DIR, "keys.json");

export type StoredKeys = {
  ANTHROPIC_API_KEY?:  string;
  OPENROUTER_API_KEY?: string;
};

let _keys: StoredKeys = {};

// ── Load from disk on startup ────────────────────────────────────────────────

function load(): void {
  try {
    const raw = readFileSync(KEYS_FILE, "utf-8");
    _keys = JSON.parse(raw) as StoredKeys;
    // Inject into process.env so the rest of the app reads them normally
    for (const [k, v] of Object.entries(_keys)) {
      if (v) process.env[k] = v;
    }
    if (Object.keys(_keys).length > 0) {
      console.log(`[config] Loaded ${Object.keys(_keys).length} key(s) from ${KEYS_FILE}`);
    }
  } catch {
    // File doesn't exist yet — normal on first run
  }
}

load();

// ── Public API ───────────────────────────────────────────────────────────────

/** Get a key, checking both in-memory store and process.env as fallback. */
export function get(name: keyof StoredKeys): string | undefined {
  return _keys[name] ?? process.env[name];
}

/**
 * Persist one or more keys.
 * Pass empty string to clear a key; omit a field to leave it unchanged.
 */
export function save(patch: Partial<Record<keyof StoredKeys, string>>): void {
  for (const [k, v] of Object.entries(patch) as [keyof StoredKeys, string][]) {
    if (v && v.trim()) {
      _keys[k] = v.trim();
      process.env[k] = v.trim();
    } else if (v === "") {
      delete _keys[k];
      delete process.env[k];
    }
    // If v is undefined, field was omitted — leave unchanged
  }

  try {
    mkdirSync(KEYS_DIR, { recursive: true });
    writeFileSync(KEYS_FILE, JSON.stringify(_keys, null, 2));
    console.log(`[config] Keys saved to ${KEYS_FILE}`);
  } catch (err) {
    console.error("[config] Failed to write keys file:", err);
    throw err;
  }
}

/** Returns which keys are currently set (never exposes values). */
export function status(): { ANTHROPIC_API_KEY: boolean; OPENROUTER_API_KEY: boolean } {
  return {
    ANTHROPIC_API_KEY:  !!(get("ANTHROPIC_API_KEY")),
    OPENROUTER_API_KEY: !!(get("OPENROUTER_API_KEY")),
  };
}
