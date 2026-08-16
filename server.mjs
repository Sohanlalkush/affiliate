import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- .env loader (zero dependencies) --------------------------------------
const envFile = path.join(__dirname, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

const env = process.env;

const PORT = Number(env.PORT || 8787);
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGIN || "https://pharmalite.in,http://localhost:4321")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const EKARO_TOKEN = env.EARNKARO_API_TOKEN || "";
const AMAZON_TAG = env.AMAZON_TAG || "pharmalite-21";
/* `netmeds` / `truemeds` pins a partner; `first` prefers Netmeds when both
   succeed (the order the site was built with). */
const PREFERRED_PARTNER = (env.PREFERRED_PARTNER || "first").trim().toLowerCase();
const NETMEDS_TIMEOUT_MS = Number(env.NETMEDS_TIMEOUT_MS || 6000);
const TRUEMEDS_TIMEOUT_MS = Number(env.TRUEMEDS_TIMEOUT_MS || 8000);
const EKARO_TIMEOUT_MS = Number(env.EKARO_TIMEOUT_MS || 6000);
const TOTAL_TIMEOUT_MS = Number(env.TOTAL_TIMEOUT_MS || 14500);
const MAX_TERM_LENGTH = 80;

const NETMEDS_API = "https://www.netmeds.com/ext/search/application/api/v1.0/products";
const TRUEMEDS_API = "https://nal.tmmumbai.in/SearchService/getSearchSuggestion";
const EKARO_API = "https://ekaro-api.affiliaters.in/api/converter/public";

// ---- helpers ---------------------------------------------------------------

function cleanTerm(raw) {
  if (!raw) return "";
  let out = "";
  for (const ch of String(raw)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH);
}

async function fetchJson(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    return { status: 0, ok: false, json: null, text: "", error: err };
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// ---- partner lookups -------------------------------------------------------

/**
 * Netmeds: search, take the first result with `sellable: true` that actually
 * MATCHES the term. The API has a trap: a query with no results returns a
 * random 12-item fallback list (all sellable), so "first sellable" alone
 * would send visitors to shampoo. The match rule is deliberately layered:
 *   - the FIRST significant query token must appear in the item name
 *   - every numeric token must appear (numbers are strong identity signals)
 *   - at least half of the remaining word tokens must appear
 * URL is https://www.netmeds.com/product/{slug}
 */
function netmedsMatches(itemName, term) {
  const tokens = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return true;
  const name = (itemName || "").toLowerCase();
  if (!name.includes(tokens[0])) return false;
  const numeric = tokens.filter((t) => /^[0-9]+$/.test(t));
  for (const n of numeric) {
    if (!name.includes(n)) return false;
  }
  const words = tokens.filter((t) => /[a-z]/.test(t)).slice(1);
  if (!words.length) return true;
  const matched = words.filter((w) => name.includes(w)).length;
  return matched >= Math.ceil(words.length / 2);
}

async function findNetmeds(term) {
  if (!EKARO_TOKEN) return null;
  const url = `${NETMEDS_API}?q=${encodeURIComponent(term)}`;
  const r = await fetchJson(url, { headers: { accept: "application/json" } }, NETMEDS_TIMEOUT_MS);
  if (!r.ok || !r.json || !Array.isArray(r.json.items)) return null;
  const hit = r.json.items.find(
    (it) => it && it.slug && it.sellable === true && netmedsMatches(it.name, term),
  );
  if (!hit) return null;
  /* Same rule as Truemeds: the visitor's final URL is always an Ekaro
     shortlink, so both partners earn through the same account. */
  const converted = await convertEkaro(`https://www.netmeds.com/product/${hit.slug}`);
  if (!converted) return null;
  return { url: converted, partner: "netmeds" };
}

/**
 * Truemeds: search suggestions, among products where `available === true`
 * pick the one with the LOWEST selling price, build the deep link, then
 * convert it through the Ekaro converter for the affiliate shortlink.
 */
async function findTruemeds(term) {
  if (!EKARO_TOKEN) return null;
  const url = `${TRUEMEDS_API}?searchString=${encodeURIComponent(term)}`;
  const r = await fetchJson(
    url,
    { headers: { accept: "application/json, text/plain, */*" } },
    TRUEMEDS_TIMEOUT_MS,
  );
  if (!r.ok || !r.json) return null;
  const list = r.json.responseData && r.json.responseData.productList;
  if (!Array.isArray(list)) return null;
  /* The list carries the searched product FIRST and possible substitutes as
     `suggestion` rows after it. A substitute is a DIFFERENT medicine, so the
     same token matcher as Netmeds filters them out: a match must be for the
     searched product itself. Among matching available products, the LOWEST
     price wins. */
  const candidates = list
    .map((x) => x && x.product)
    .filter(
      (p) =>
        p &&
        p.available === true &&
        typeof p.productUrlSuffix === "string" &&
        p.productUrlSuffix.length > 0 &&
        netmedsMatches(p.skuName, term),
    );
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) => num(a.sellingPrice) - num(b.sellingPrice) || num(a.mrp) - num(b.mrp),
  );
  const best = candidates[0];
  const deal = `https://www.truemeds.in/${best.productUrlSuffix}`;
  const converted = await convertEkaro(deal);
  if (!converted) return null;
  return { url: converted, partner: "truemeds" };
}

/**
 * Ekaro link converter. Success shape: `{ "success": 1, "data": "<url>" }`.
 * Any other shape, non-2xx, or invalid URL in `data` is a failure.
 *
 * The API REJECTS non-browser requests: with Node's default
 * `User-Agent: node` it answers 401 "Please authenticate" even with a valid
 * token. A browser-like UA, an `Origin` and an `Accept` header are required.
 */
async function convertEkaro(deal) {
  const r = await fetchJson(
    EKARO_API,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EKARO_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Origin: "https://ek.affiliaters.in",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      body: JSON.stringify({ deal, convert_option: "convert_only" }),
    },
    EKARO_TIMEOUT_MS,
  );
  if (!r.json) return null;
  const { success, data } = r.json;
  if (success !== 1 || typeof data !== "string") return null;
  const url = data.trim();
  if (!/^https:\/\/[^/]+/.test(url)) return null;
  return url;
}

/** Last-resort backup: plain Amazon search with the affiliate tag. */
function amazonUrl(term) {
  return `https://www.amazon.in/s?k=${encodeURIComponent(term)}&tag=${encodeURIComponent(AMAZON_TAG)}`;
}

// ---- HTTP server -----------------------------------------------------------

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, origin, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(origin),
    ...extraHeaders,
  });
  res.end(data);
}

async function handleAvailability(req, res, origin) {
  const started = Date.now();
  let term = "";
  try {
    const raw = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { ok: false, reason: "invalid_json" }, origin);
    }
    const slug = cleanTerm(payload.slug);
    const name = cleanTerm(payload.name);
    const composition = cleanTerm(payload.composition);
    term = name || slug || composition;
    if (!term) {
      return send(res, 400, { ok: false, reason: "no_search_term" }, origin);
    }

    /* Both partners queried in parallel; Netmeds wins if both succeed
       (it is the first partner configured). The overall deadline exists so
       the browser is never left hanging: if it fires first, the Amazon
       backup is returned instead. */
    const netmedsP = findNetmeds(term);
    const truemedsP = findTruemeds(term);
    const overall = new Promise((resolve) =>
      setTimeout(() => resolve([null, null, true]), TOTAL_TIMEOUT_MS),
    );
    const [netmeds, truemeds, timedOut] = await Promise.race([
      Promise.all([netmedsP, truemedsP]).then((r) => [...r, false]),
      overall,
    ]);

    let hit;
    if (timedOut) {
      hit = null;
    } else if (PREFERRED_PARTNER === "netmeds") {
      hit = netmeds;
    } else if (PREFERRED_PARTNER === "truemeds") {
      hit = truemeds;
    } else {
      hit = netmeds || truemeds;
    }
    const url = hit ? hit.url : amazonUrl(term);
    const partner = hit ? hit.partner : "amazon";
    const ms = Date.now() - started;

    console.log(
      `[${new Date().toISOString()}] POST ${term} -> ${partner} (${ms}ms)${timedOut ? " [deadline] " : " "}${url}`,
    );
    return send(res, 200, { ok: true, url, partner }, origin);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR ${term}:`, err);
    return send(res, 200, { ok: true, url: amazonUrl(term), partner: "amazon" }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = origin ? ALLOWED_ORIGINS.includes(origin) : false;
  const requestedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const route = requestedUrl.pathname;

  if (req.method === "OPTIONS") {
    if (origin && !allowed) return send(res, 403, { ok: false, reason: "origin_not_allowed" }, origin);
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (req.method === "GET" && route === "/health") {
    return send(res, 200, { ok: true, uptime: process.uptime(), tokenConfigured: Boolean(EKARO_TOKEN) }, origin);
  }

  if (req.method === "POST" && (route === "/" || route === "/availability")) {
    if (origin && !allowed) return send(res, 403, { ok: false, reason: "origin_not_allowed" }, origin);
    return handleAvailability(req, res, origin);
  }

  return send(res, 404, { ok: false, reason: "not_found" }, origin);
});

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] affiliate availability API on http://localhost:${PORT}`);
  console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`  ekaro token: ${EKARO_TOKEN ? "configured" : "NOT configured (Truemeds disabled -> Amazon backup)"}`);
  console.log(`  budget: netmeds ${NETMEDS_TIMEOUT_MS}ms | truemeds ${TRUEMEDS_TIMEOUT_MS}ms + ekaro ${EKARO_TIMEOUT_MS}ms | hard cap ${TOTAL_TIMEOUT_MS}ms`);
});