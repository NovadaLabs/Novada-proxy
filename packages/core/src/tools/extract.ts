import { novadaProxyFetch, type FetchParams } from "./fetch.js";
import { novadaProxyRender } from "./render.js";
import { decodeHtmlEntities, htmlToMarkdown, unicodeSafeTruncate, countHtmlTags, contentDensity } from "../utils.js";
import type { ProxyAdapter, ProxyCredentials } from "../adapters/index.js";
import type { ProxySuccessResponse } from "../types.js";
import { SAFE_COUNTRY, SAFE_CITY, SAFE_SESSION_ID } from "../validation.js";

export interface ExtractParams {
  url: string;
  fields: string[];
  schema?: Record<string, string>;
  country?: string;
  city?: string;
  session_id?: string;
  timeout?: number;
  render_fallback?: boolean;  // if true, auto-retry via novada_proxy_render on TLS/bot failure
}

/**
 * Extract structured data from a URL using pattern matching on the fetched HTML.
 *
 * Strategy: fetch the raw HTML, then use regex + heuristic extraction for each
 * requested field. This is a lightweight alternative to LLM-based extraction —
 * fast, deterministic, and zero additional API cost.
 *
 * For more complex extraction needs, agents can use novada_proxy_fetch(format="raw")
 * and do their own parsing.
 */
// Error messages that indicate the proxy fetch failed hard and render may succeed
const RENDER_ESCALATION_PATTERNS = [
  "TLS", "SSL", "socket disconnect", "secure TLS",
  "ECONNRESET", "ECONNREFUSED",
  "403", "blocked", "bot detection",
];

export function shouldEscalateToRender(msg: string): boolean {
  return RENDER_ESCALATION_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
}

export async function novadaProxyExtract(
  params: ExtractParams,
  adapter: ProxyAdapter,
  credentials: ProxyCredentials,
  browserWsEndpoint?: string
): Promise<string> {
  const { url, fields, schema, country, city, session_id, timeout = 60, render_fallback = false } = params;

  const startTime = Date.now();
  let html = "";
  let usedRender = false;
  let fetchWarning: string | undefined;

  // Attempt 1: proxy fetch (fast, cheap)
  try {
    const fetchParams: FetchParams = { url, format: "raw", country, city, session_id, timeout };
    const fetchResultStr = await novadaProxyFetch(fetchParams, adapter, credentials);
    const fetchResult = JSON.parse(fetchResultStr) as ProxySuccessResponse;
    html = (fetchResult.data.content as string) || "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Auto-escalate to render if enabled and the error suggests a JS/TLS block
    if (render_fallback && browserWsEndpoint && shouldEscalateToRender(msg)) {
      try {
        const renderResultStr = await novadaProxyRender({ url, format: "html", timeout }, browserWsEndpoint);
        const renderResult = JSON.parse(renderResultStr) as ProxySuccessResponse;
        html = (renderResult.data.content as string) || "";
        usedRender = true;
        fetchWarning = `Proxy fetch failed (${msg.slice(0, 80)}...) — escalated to render automatically`;
      } catch (renderErr) {
        // Both failed — re-throw the original fetch error
        throw err;
      }
    } else {
      throw err;
    }
  }

  const latency_ms = Date.now() - startTime;

  // ── Schema mode: LLM-ready extraction ─────────────────────────────────────
  if (schema) {
    const markdown = htmlToMarkdown(html);
    const truncated = unicodeSafeTruncate(markdown, 50000);
    const tagCount = countHtmlTags(html);
    const density = contentDensity(truncated.length, tagCount);

    const schemaEntries = Object.entries(schema)
      .map(([key, desc]) => `- ${key}: ${desc}`)
      .join("\n");

    const extractionPrompt =
      `Extract the following fields from the page content provided in data.content of this response. Return ONLY a JSON object with the field names as keys. If a field cannot be found, set its value to null.\n\nFields to extract:\n${schemaEntries}`;

    const result: ProxySuccessResponse = {
      ok: true,
      tool: "novada_proxy_extract",
      data: {
        mode: "llm_extract",
        url,
        schema: schema as Record<string, unknown>,
        content: truncated,
        extraction_prompt: extractionPrompt,
        content_length: truncated.length,
        ...(fetchWarning ? { fetch_warning: fetchWarning } : {}),
      },
      meta: {
        latency_ms,
        country,
        session_id,
        content_density: density,
        quota: {
          credits_estimated: usedRender ? 5 : 1,
          note: "Check dashboard.novada.com for real-time balance",
        },
      },
    };

    if (!result.meta.country) delete result.meta.country;
    if (!result.meta.session_id) delete result.meta.session_id;

    return JSON.stringify(result);
  }

  // ── Heuristic mode (default) ────────────────────────────────────────────────
  // Extract each requested field using pattern-based heuristics
  const extractedFields: Record<string, string | string[] | null> = {};

  for (const field of fields) {
    extractedFields[field] = extractField(html, field, url);
  }

  const result: ProxySuccessResponse = {
    ok: true,
    tool: "novada_proxy_extract",
    data: {
      mode: "heuristic",
      url,
      fields: extractedFields as Record<string, unknown>,
      ...(fetchWarning ? { fetch_warning: fetchWarning } : {}),
      ...(usedRender ? { extracted_via: "render" } : { extracted_via: "proxy_fetch" }),
    },
    meta: {
      latency_ms,
      country,
      session_id,
      // render costs 5 credits when used as fallback, else 1
      quota: {
        credits_estimated: usedRender ? 5 : 1,
        note: "Check dashboard.novada.com for real-time balance",
      },
    },
  };

  if (!result.meta.country) delete result.meta.country;
  if (!result.meta.session_id) delete result.meta.session_id;

  return JSON.stringify(result);
}

/**
 * Heuristic field extraction from HTML.
 *
 * Uses common patterns: meta tags, Open Graph, Schema.org JSON-LD, headings,
 * and semantic HTML. Falls back to regex scanning for common field names.
 */
export function extractField(html: string, field: string, baseUrl?: string): string | string[] | null {
  const f = field.toLowerCase().trim();

  // --- Title ---
  if (f === "title" || f === "name" || f === "product_name") {
    return (
      extractMetaContent(html, "og:title") ??
      extractJsonLd(html, "name") ??
      extractTag(html, "title") ??
      extractTag(html, "h1") ??
      null
    );
  }

  // --- Price ---
  if (f === "price" || f === "cost") {
    return (
      extractJsonLd(html, "price") ??
      extractJsonLd(html, "lowPrice") ??
      extractMetaContent(html, "product:price:amount") ??
      extractPriceFromHtml(html) ??
      null
    );
  }

  // --- Currency ---
  if (f === "currency") {
    return (
      extractJsonLd(html, "priceCurrency") ??
      extractMetaContent(html, "product:price:currency") ??
      null
    );
  }

  // --- Description ---
  if (f === "description" || f === "summary") {
    return (
      extractMetaContent(html, "og:description") ??
      extractMetaContent(html, "description") ??
      extractJsonLd(html, "description") ??
      null
    );
  }

  // --- Image ---
  if (f === "image" || f === "thumbnail" || f === "photo") {
    return (
      extractMetaContent(html, "og:image") ??
      extractJsonLd(html, "image") ??
      extractFirstImage(html, baseUrl) ??
      null
    );
  }

  // --- Rating / Reviews ---
  if (f === "rating" || f === "score") {
    return (
      extractJsonLd(html, "ratingValue") ??
      null
    );
  }
  if (f === "review_count" || f === "reviews" || f === "rating_count") {
    return (
      extractJsonLd(html, "reviewCount") ??
      extractJsonLd(html, "ratingCount") ??
      null
    );
  }

  // --- Author ---
  if (f === "author" || f === "creator") {
    return (
      extractJsonLd(html, "author") ??
      extractMetaContent(html, "author") ??
      extractMetaContent(html, "article:author") ??
      null
    );
  }

  // --- Date ---
  if (f === "date" || f === "published" || f === "publish_date") {
    return (
      extractJsonLd(html, "datePublished") ??
      extractMetaContent(html, "article:published_time") ??
      extractMetaContent(html, "date") ??
      null
    );
  }

  // --- URL / Canonical ---
  if (f === "url" || f === "canonical") {
    return (
      extractMetaContent(html, "og:url") ??
      extractCanonical(html) ??
      null
    );
  }

  // --- Links (returns array) ---
  if (f === "links" || f === "urls") {
    return extractAllLinks(html, baseUrl);
  }

  // --- Headings (returns array) ---
  if (f === "headings" || f === "h1" || f === "h2") {
    const tag = f === "h2" ? "h2" : "h1";
    return extractAllTags(html, tag);
  }

  // --- Generic fallback: try JSON-LD, then meta ---
  return (
    extractJsonLd(html, field) ??
    extractMetaContent(html, field) ??
    null
  );
}

// --- Extraction helpers ---

function extractMetaContent(html: string, name: string): string | null {
  // Match both name= and property= attributes
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegex(name)}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function extractJsonLd(html: string, key: string): string | null {
  const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!ldBlocks) return null;

  for (const block of ldBlocks) {
    const jsonMatch = block.match(/>([^<]+)</s);
    if (!jsonMatch?.[1]) continue;
    try {
      const data = JSON.parse(jsonMatch[1]);
      const value = deepFind(data, key);
      if (value !== undefined) {
        return typeof value === "object" ? JSON.stringify(value) : String(value);
      }
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return null;
}

function extractTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const m = html.match(re);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : null;
}

function extractAllTags(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) results.push(decodeHtmlEntities(m[1]).trim());
  }
  return results.length ? results : [];
}

function extractAllLinks(html: string, baseUrl?: string): string[] {
  // INC-71: supports pagination links (?page=N, /page/N) and <a> tags nested inside
  // <li>, <div>, <span> etc. Nested tags already work via regex; the key fix is resolving
  // query-string-only hrefs (?page=2) and /page/N paths when baseUrl is provided.
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  const seen = new Set<string>(); // O(1) dedup instead of O(n) array includes
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    // Skip bare fragments and javascript: URIs
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    let resolved = href;
    if (!href.startsWith("http") && baseUrl) {
      // Handles: relative paths (/about), query-string pagination (?page=2),
      // /page/N pagination, and ../sibling traversals
      try { resolved = new URL(href, baseUrl).toString(); } catch { continue; }
    }
    if (resolved.startsWith("http") && !seen.has(resolved)) {
      seen.add(resolved);
      results.push(resolved);
    }
  }
  return results.slice(0, 50); // cap at 50 links
}

function extractCanonical(html: string): string | null {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

const SKIP_IMAGE_PATTERNS = /icon|logo|pixel|tracking|1x1|spacer/i;

function extractFirstImage(html: string, baseUrl?: string): string | null {
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (!src || SKIP_IMAGE_PATTERNS.test(src)) continue;
    if (src.startsWith("data:")) continue;
    if (src.startsWith("http")) return src;
    if (baseUrl) {
      try { return new URL(src, baseUrl).toString(); } catch { continue; }
    }
  }
  return null;
}

function extractPriceFromHtml(html: string): string | null {
  // Strategy 1: price inside an element with "price" in its class (most reliable)
  const priceClassRe = /(?:class=["'][^"']*price[^"']*["'][^>]*>)\s*[^<]*?([$€£¥]\s*[\d,.]+)/i;
  const m = priceClassRe.exec(html);
  if (m?.[1]) return m[1].trim();

  // Strategy 2: collect ALL currency patterns, return the most likely product price
  // (skip very small amounts like $0, $1, $2 which are often shipping thresholds or discounts)
  const allPricesRe = /([$€£¥])\s*(\d[\d,.]*)/g;
  const prices: Array<{ raw: string; value: number }> = [];
  let pm: RegExpExecArray | null;
  while ((pm = allPricesRe.exec(html)) !== null) {
    const raw = `${pm[1]}${pm[2]}`.trim();
    const value = parseFloat(pm[2].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) prices.push({ raw, value });
  }
  if (prices.length === 0) return null;

  // Filter out likely noise: prices under $5 are usually shipping/discount thresholds
  const plausible = prices.filter(p => p.value >= 5);
  if (plausible.length > 0) {
    // Return the first plausible price (most likely the product price in page order)
    return plausible[0].raw;
  }
  // If all prices are under $5, return the highest one
  prices.sort((a, b) => b.value - a.value);
  return prices[0].raw;
}

export function deepFind(obj: unknown, key: string, depth: number = 0): unknown {
  if (depth > 20) return undefined;
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return undefined;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFind(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];

  for (const v of Object.values(record)) {
    const found = deepFind(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Validation ---

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function validateExtractParams(raw: Record<string, unknown>): ExtractParams {
  if (!raw.url || typeof raw.url !== "string") {
    throw new Error("url is required and must be a string");
  }
  if (!raw.url.startsWith("http://") && !raw.url.startsWith("https://")) {
    throw new Error("url must start with http:// or https://");
  }

  // Validate schema (takes precedence over fields)
  let schema: Record<string, string> | undefined;
  if (raw.schema !== undefined) {
    if (typeof raw.schema !== "object" || raw.schema === null || Array.isArray(raw.schema)) {
      throw new Error("schema must be an object with string keys and string values");
    }
    const schemaObj = raw.schema as Record<string, unknown>;
    const keys = Object.keys(schemaObj);
    if (keys.length === 0) {
      throw new Error("schema must have at least 1 field");
    }
    if (keys.length > 20) {
      throw new Error("schema must have at most 20 fields");
    }
    for (const [key, val] of Object.entries(schemaObj)) {
      if (!KEY_PATTERN.test(key) || key.length > 50) {
        throw new Error("schema keys must be alphanumeric/underscore, start with letter, max 50 chars");
      }
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new Error("schema values must be non-empty strings");
      }
      if (val.length > 200) {
        throw new Error("schema value descriptions must be 200 characters or less");
      }
    }
    schema = schemaObj as Record<string, string>;
  }

  // fields is required only when schema is not provided
  if (!schema) {
    if (!raw.fields || !Array.isArray(raw.fields) || raw.fields.length === 0) {
      throw new Error("fields is required — provide an array of field names to extract (e.g. [\"title\", \"price\", \"description\"])");
    }
    if (raw.fields.length > 20) {
      throw new Error("fields must contain at most 20 field names");
    }
    for (const f of raw.fields) {
      if (typeof f !== "string" || f.length > 50) {
        throw new Error("each field must be a string of 50 characters or less");
      }
    }
  }

  if (raw.country !== undefined) {
    if (typeof raw.country !== "string" || raw.country.length > 10 || !SAFE_COUNTRY.test(raw.country)) {
      throw new Error("country must be a 2-letter ISO code with no hyphens (e.g. US, DE, GB)");
    }
  }
  if (raw.city !== undefined) {
    if (typeof raw.city !== "string" || raw.city.length > 50 || !SAFE_CITY.test(raw.city)) {
      throw new Error("city must contain only letters, numbers, underscores, max 50 chars");
    }
  }
  if (raw.session_id !== undefined) {
    if (typeof raw.session_id !== "string" || raw.session_id.length > 64 || !SAFE_SESSION_ID.test(raw.session_id)) {
      throw new Error("session_id must contain only letters, numbers, and underscores, max 64 chars (no hyphens)");
    }
  }

  const timeout = raw.timeout !== undefined ? Number(raw.timeout) : 60;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
    throw new Error("timeout must be between 1 and 120 seconds");
  }

  return {
    url: raw.url,
    fields: (raw.fields as string[] | undefined) ?? [],
    schema,
    country: raw.country as string | undefined,
    city: raw.city as string | undefined,
    session_id: raw.session_id as string | undefined,
    timeout,
    render_fallback: raw.render_fallback === true,
  };
}
