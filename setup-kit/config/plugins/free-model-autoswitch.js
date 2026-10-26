// OpenCode V2 Free Model Auto-Fallback Plugin
// Automatically switches to the next ranked free AI coding model when the
// current free model's usage/quota/rate-limit finishes (HTTP 429, 402, 403, 503
// or quota/rate-limit error messages) so work on the project continues nonstop.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_FREE_CHAIN = [
  "google/gemini-2.5-pro",
  "openrouter/qwen/qwen3-coder:free",
  "openrouter/deepseek/deepseek-r1:free",
  "openrouter/deepseek/deepseek-chat-v3-0324:free",
  "google/gemini-2.5-flash",
  "mistral/codestral-latest",
  "groq/llama-3.3-70b-versatile",
  "groq/qwen-qwq-32b",
  "ollama/qwen2.5-coder:14b",
  "ollama/deepseek-coder-v2:16b",
];

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown when a free model's quota finishes
const exhaustedUntil = (globalThis.__freeModelExhaustedUntil ??= new Map());

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

function loadChain() {
  try {
    const chainFile = join(getConfigDir(), "free-fallback-chain.json");
    if (existsSync(chainFile)) {
      const parsed = JSON.parse(readFileSync(chainFile, "utf8"));
      if (parsed && parsed.enabled === false) return { enabled: false, chain: [] };
      if (Array.isArray(parsed?.chain) && parsed.chain.length > 0) {
        return { enabled: true, chain: parsed.chain };
      }
    }
  } catch (_) {}
  return { enabled: true, chain: DEFAULT_FREE_CHAIN };
}

function saveSwitchStatus(statusObj) {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const statusFile = join(dir, "free-fallback-status.json");
    writeFileSync(statusFile, JSON.stringify(statusObj, null, 2), "utf8");
  } catch (_) {}
}

function splitModelRef(ref) {
  const idx = String(ref).indexOf("/");
  if (idx === -1) return null;
  return {
    providerID: ref.slice(0, idx),
    id: ref.slice(idx + 1),
    full: ref,
  };
}

function isQuotaOrRateLimitError(status, message = "", type = "") {
  if (status === 429 || status === 402 || status === 503 || status === 529) return true;
  const combined = `${type} ${message}`.toLowerCase();
  return /429|quota|rate[-_ ]?limit|too many requests|exhausted|exceeded|insufficient|credit|balance|capacity|overloaded/.test(
    combined
  );
}

function pickNextModel(currentFull, chain) {
  const now = Date.now();
  const parsedChain = chain.map(splitModelRef).filter(Boolean);
  if (parsedChain.length === 0) return null;

  const currentIdx = parsedChain.findIndex((m) => m.full === currentFull);
  const startIdx = currentIdx >= 0 ? currentIdx + 1 : 0;

  for (let offset = 0; offset < parsedChain.length; offset++) {
    const candidate = parsedChain[(startIdx + offset) % parsedChain.length];
    if (candidate.full === currentFull) continue;
    const until = exhaustedUntil.get(candidate.full) || 0;
    if (until <= now) {
      return candidate;
    }
  }
  // If all were marked exhausted, clear oldest cooldown and pick next in order
  exhaustedUntil.clear();
  return parsedChain[startIdx % parsedChain.length];
}

const locationHash = [...import.meta.url].reduce(
  (hash, ch) => (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0,
  11
);

export default {
  id: `free-model-autoswitch-${locationHash.toString(16)}`,

  async setup(ctx) {
    // 1. Intercept HTTP 429 / 402 / 503 responses from providers immediately
    await ctx.session.hook("http.response", async (event) => {
      const status = event.response?.status;
      if (status !== 429 && status !== 402 && status !== 503) return;

      const { enabled, chain } = loadChain();
      if (!enabled) return;

      const currentFull = `${event.model.providerID}/${event.model.id}`;
      exhaustedUntil.set(currentFull, Date.now() + COOLDOWN_MS);

      const next = pickNextModel(currentFull, chain);
      if (!next) return;

      try {
        await ctx.session.switchModel({
          sessionID: event.sessionID,
          model: { providerID: next.providerID, id: next.id },
        });
        saveSwitchStatus({
          lastSwitchAt: new Date().toISOString(),
          fromModel: currentFull,
          toModel: next.full,
          reason: `HTTP ${status} quota/rate-limit reached`,
          exhaustedModels: Array.from(exhaustedUntil.entries()).map(([m, until]) => ({
            model: m,
            cooldownUntil: new Date(until).toISOString(),
          })),
        });
      } catch (_) {}
    });

    // 2. Intercept retry decisions on quota/rate-limit errors, switch model, and auto-continue
    await ctx.session.hook("retry", async (event) => {
      const errStatus = event.error?.status;
      const errMsg = event.error?.message || "";
      const errType = event.error?.type || "";

      if (!isQuotaOrRateLimitError(errStatus, errMsg, errType)) return;

      const { enabled, chain } = loadChain();
      if (!enabled) return;

      const currentFull = `${event.model.providerID}/${event.model.id}`;
      exhaustedUntil.set(currentFull, Date.now() + COOLDOWN_MS);

      const next = pickNextModel(currentFull, chain);
      if (!next) return;

      try {
        await ctx.session.switchModel({
          sessionID: event.sessionID,
          model: { providerID: next.providerID, id: next.id },
        });
        saveSwitchStatus({
          lastSwitchAt: new Date().toISOString(),
          fromModel: currentFull,
          toModel: next.full,
          reason: errMsg || `Status ${errStatus}`,
          exhaustedModels: Array.from(exhaustedUntil.entries()).map(([m, until]) => ({
            model: m,
            cooldownUntil: new Date(until).toISOString(),
          })),
        });
        // Schedule immediate retry on the newly switched model
        event.decision = { retry: true, delay: 1200 };
      } catch (_) {}
    });
  },
};
