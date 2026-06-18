import { novadaProxyFetch } from "./fetch.js";
import { novadaProxyRender } from "./render.js";
import { htmlToMarkdown, htmlToText, unicodeSafeTruncate } from "../utils.js";
import type { ProxyAdapter, ProxyCredentials } from "../adapters/index.js";
import type { ProxySuccessResponse } from "../types.js";
import { SAFE_COUNTRY, QUOTA_NOTE } from "../validation.js";

export interface CrawlParams {
  url: string;              // Starting URL
  depth?: number;           // Max depth (default 2, max 5)
  limit?: number;           // [Legacy] Max total URLs to crawl (default 10, max 200)
  max_pages?: number;       // Alias for limit (default 10, max 100) — takes precedence if both set
  max_depth?: number;       // Alias for depth — takes precedence if both set
  include_content?: boolean; // Return page content too, not just URLs (default false)
  include_patterns?: string[]; // Regex patterns — only follow URLs matching at least one
  exclude_patterns?: string[]; // Regex patterns — skip URLs matching any
  render?: "none" | "render" | "browser"; // Render mode: none=proxy fetch (default), render/browser=JS rendering
  output_format?: "markdown" | "html" | "text"; // Content format (default "markdown")
  extract_fields?: string[]; // Fields to extract from each page (title, description, etc.)
  country?: string;
  timeout?: number;         // Per-page timeout in seconds
  format?: "markdown" | "raw"; // Legacy format param (overridden by output_format)
  rate_limit?: number;      // Max requests per second (default 2, max 10)
  browser_ws?: string;      // Browser WS endpoint (injected by MCP layer, not user-facing)
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  title?: string;           // Page title (always extracted when available)
  status_code?: number;
  total_links: number;      // all extracted links before deduplication
  new_links: number;        // links not yet seen globally
  content?: string;         // only if include_content=true
  extracted_fields?: Record<string, string | null>; // only if extract_fields provided
  links_found?: string[];   // discovered outgoing links on this page
  error?: string;           // if this page failed
}

// ─── Link extraction (reused from map.ts pattern) ──────────────────────────────

/**
 * Extract internal links from HTML. Resolves relative URLs against origin,
 * deduplicates, and filters to same domain + subdomains.
 */
function extractInternalLinks(
  html: string,
  pageUrl: string,
  hostname: string,
  seen: Set<string>,
  includePatterns?: RegExp[],
  excludePatterns?: RegExp[]
): { allLinks: string[]; newLinks: string[] } {
  // INC-71: allow ?page=N pagination hrefs — removed the [^"'#?] exclusion that dropped
  // query-string-only hrefs. Fragments (#) and javascript: are handled below.
  const hrefRe = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  const allLinks: string[] = [];
  const newLinks: string[] = [];
  const pageDedup = new Set<string>(); // dedup within this page
  const newLinksSet = new Set<string>(); // O(1) dedup for new links

  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    // Skip javascript: and mailto: pseudo-schemes (INC-71)
    if (/^(?:javascript|mailto|tel|data):/i.test(raw)) continue;

    let resolved: string;
    try {
      resolved = new URL(raw, pageUrl).toString();
    } catch {
      continue; // skip malformed hrefs
    }

    // Normalise: strip trailing slash
    resolved = resolved.replace(/\/$/, "");

    // Must be same domain or subdomain
    let resolvedHostname: string;
    try {
      resolvedHostname = new URL(resolved).hostname;
    } catch {
      continue;
    }

    if (resolvedHostname === hostname || resolvedHostname.endsWith(`.${hostname}`)) {
      // Skip non-page resources (images, stylesheets, scripts, etc.)
      const path = new URL(resolved).pathname.toLowerCase();
      if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|tar|gz)$/.test(path)) {
        continue;
      }

      // Apply include patterns: if set, URL must match at least one
      if (includePatterns && includePatterns.length > 0) {
        if (!includePatterns.some(re => re.test(resolved))) continue;
      }

      // Apply exclude patterns: if set, skip URLs matching any
      if (excludePatterns && excludePatterns.length > 0) {
        if (excludePatterns.some(re => re.test(resolved))) continue;
      }

      // Count for total_links (dedup within page only)
      if (!pageDedup.has(resolved)) {
        pageDedup.add(resolved);
        allLinks.push(resolved);
      }

      // Count for new_links (not seen globally)
      if (!seen.has(resolved) && !newLinksSet.has(resolved)) {
        newLinksSet.add(resolved);
        newLinks.push(resolved);
      }
    }
  }

  return { allLinks, newLinks };
}

// ─── Title extraction ────────────────────────────────────────────────────────

function extractTitle(html: string): string | undefined {
  // Try <title> tag first
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (title) return title;
  }
  // Fall back to first <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }
  return undefined;
}

// ─── Simple field extraction (reuses extract.ts patterns) ──────────────────────

function extractSimpleField(html: string, field: string): string | null {
  const lower = field.toLowerCase();

  // Open Graph meta tags
  const ogMatch = html.match(new RegExp(`<meta[^>]+property=["']og:${lower}["'][^>]+content=["']([^"']+)["']`, "i"))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${lower}["']`, "i"));
  if (ogMatch?.[1]) return ogMatch[1];

  // Standard meta tags
  const metaMatch = html.match(new RegExp(`<meta[^>]+name=["']${lower}["'][^>]+content=["']([^"']+)["']`, "i"))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${lower}["']`, "i"));
  if (metaMatch?.[1]) return metaMatch[1];

  // Special cases
  if (lower === "title") return extractTitle(html) ?? null;

  return null;
}

// ─── Concurrency helper ────────────────────────────────────────────────────────

/**
 * Process an array of items with bounded concurrency. Returns results in the
 * same order as the input array.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let activeCount = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (activeCount < concurrency) {
        activeCount++;
        resolve();
      } else {
        queue.push(() => {
          activeCount++;
          resolve();
        });
      }
    });
  }

  function release(): void {
    activeCount--;
    const next = queue.shift();
    if (next) next();
  }

  await Promise.all(
    items.map(async (item, idx) => {
      await acquire();
      try {
        results[idx] = await fn(item);
      } finally {
        release();
      }
    })
  );

  return results;
}

// ─── Rate limiter ────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter with a wait queue to prevent burst races.
 * Multiple concurrent callers waiting on the same token will each get
 * serialized via a single scheduled drain rather than per-waiter sleeps.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly rate: number; // tokens per ms
  private waitQueue: Array<() => void> = [];
  private drainScheduled = false;

  constructor(rps: number) {
    this.maxTokens = rps;
    this.tokens = rps;
    this.lastRefill = Date.now();
    this.rate = rps / 1000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    if (this.waitQueue.length >= 100) {
      throw new Error("Rate limiter queue full — too many concurrent requests");
    }
    return new Promise<void>(resolve => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    // Wait for just enough time for the next token to be available
    const waitMs = Math.max(0, (1 - this.tokens) / this.rate);
    setTimeout(() => {
      this.drainScheduled = false;
      this.refill();
      while (this.tokens >= 1 && this.waitQueue.length > 0) {
        this.tokens--;
        this.waitQueue.shift()!();
      }
      // If there are still waiters, schedule another drain
      if (this.waitQueue.length > 0) {
        this.scheduleDrain();
      }
    }, waitMs);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }
}

// ─── Page fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch a page using the appropriate mode (proxy or render).
 * Always returns raw HTML in `html` for link extraction.
 * Returns the user's requested format in `userContent` (if different from raw HTML).
 */
async function fetchPage(
  url: string,
  format: "raw" | "markdown",
  renderMode: "none" | "render" | "browser",
  adapter: ProxyAdapter,
  credentials: ProxyCredentials,
  browserWs: string | undefined,
  country: string | undefined,
  timeout: number
): Promise<{ html: string; userContent?: string; statusCode?: number; cacheHit: boolean }> {
  if (renderMode !== "none" && browserWs) {
    // Single render call: always fetch HTML for link extraction.
    // If the user wants markdown, convert locally — avoids a second billed render call (INC-69).
    const htmlResultStr = await novadaProxyRender(
      { url, format: "html", timeout },
      browserWs
    );
    const htmlResult = JSON.parse(htmlResultStr) as ProxySuccessResponse;
    const rawHtml = (htmlResult.data.content as string) || "";
    const statusCode = htmlResult.data.status_code as number | undefined;

    // Convert locally instead of making a second render call
    let userContent: string | undefined;
    if (format !== "raw") {
      userContent = htmlToMarkdown(rawHtml);
    }

    return {
      html: rawHtml,
      userContent,
      statusCode,
      cacheHit: false, // render calls are never cached
    };
  }

  // Standard proxy fetch
  const resultStr = await novadaProxyFetch(
    { url, format, country, timeout },
    adapter,
    credentials
  );
  const result = JSON.parse(resultStr) as ProxySuccessResponse;
  return {
    html: (result.data.content as string) || "",
    statusCode: result.data.status_code as number | undefined,
    cacheHit: result.meta.cache_hit === true,
  };
}

// ─── Main crawl function ───────────────────────────────────────────────────────

const DEFAULT_CRAWL_CONCURRENCY = 3;
const DEFAULT_RATE_LIMIT = 2; // requests per second

export async function novadaProxyCrawl(
  params: CrawlParams,
  adapter: ProxyAdapter,
  credentials: ProxyCredentials
): Promise<string> {
  // Resolve aliases: max_pages takes precedence over limit, max_depth over depth
  // Defaults: 10 pages, depth 3 (aligned with MCP schema)
  const maxPages = params.max_pages ?? params.limit ?? 10;
  const maxDepth = params.max_depth ?? params.depth ?? 3;
  const {
    url,
    include_content = false,
    include_patterns,
    exclude_patterns,
    render: renderMode = "none",
    output_format,
    extract_fields,
    country,
    timeout = 60,
    format: legacyFormat = "markdown",
    rate_limit: rateLimit = DEFAULT_RATE_LIMIT,
    browser_ws,
  } = params;

  // Fix 3: Fail fast if render mode requested without browser_ws
  if (renderMode !== "none" && !browser_ws) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "PROVIDER_NOT_CONFIGURED",
        message: "browser_ws is required when render mode is 'render' or 'browser'. Set NOVADA_BROWSER_WS env var.",
        recoverable: false,
        agent_instruction: "Either set NOVADA_BROWSER_WS or use render='none'.",
      },
    });
  }

  // Resolve output format: output_format takes precedence over legacy format
  const resolvedFormat = output_format ?? (legacyFormat === "raw" ? "html" : legacyFormat);
  // For fetch calls, translate output_format to fetch-compatible format
  const fetchFormat: "raw" | "markdown" = resolvedFormat === "html" ? "raw" : "markdown";

  const startTime = Date.now();

  // Compile include/exclude patterns
  let compiledInclude: RegExp[] | undefined;
  let compiledExclude: RegExp[] | undefined;
  if (include_patterns && include_patterns.length > 0) {
    compiledInclude = include_patterns.map(p => new RegExp(p, "i"));
  }
  if (exclude_patterns && exclude_patterns.length > 0) {
    compiledExclude = exclude_patterns.map(p => new RegExp(p, "i"));
  }

  // Parse origin for relative-URL resolution and same-domain filtering
  let origin: string;
  let hostname: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    hostname = parsed.hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const visited = new Set<string>();
  const pages: CrawlPageResult[] = [];
  const errors: Array<{ url: string; error: string; depth: number }> = [];
  let totalDiscovered = 0;
  let cachedPages = 0;
  let extraRawFetches = 0;
  let renderCredits = 0;

  const rateLimiter = new RateLimiter(rateLimit);

  // BFS: queue is an array of { url, depth } items
  interface QueueItem { url: string; depth: number }
  let currentLevel: QueueItem[] = [{ url: url.replace(/\/$/, ""), depth: 0 }];
  visited.add(url.replace(/\/$/, ""));

  let deepestReached = 0;

  // Concurrency is bounded by rate limit
  const crawlConcurrency = Math.min(DEFAULT_CRAWL_CONCURRENCY, rateLimit);

  while (currentLevel.length > 0 && pages.length < maxPages) {
    // Cap this level to remaining budget
    const remaining = maxPages - pages.length;
    const batch = currentLevel.slice(0, remaining);

    const batchResults = await mapWithConcurrency(
      batch,
      crawlConcurrency,
      async (item: QueueItem): Promise<{ page: CrawlPageResult; newLinks: string[] }> => {
        // Rate limit
        await rateLimiter.acquire();

        try {
          // For link extraction we always need raw HTML. For content delivery
          // we may need a different format.
          const needRawForLinks = include_content && fetchFormat !== "raw";
          const isRenderMode = renderMode !== "none";

          // Primary fetch: get content in the user's requested format.
          // In render mode, fetchPage always returns raw HTML in .html and
          // the user's format in .userContent (if format !== raw).
          const primaryFormat = include_content ? fetchFormat : "raw";
          const primary = await fetchPage(
            item.url,
            primaryFormat === "markdown" ? "markdown" : "raw",
            renderMode,
            adapter,
            credentials,
            browser_ws,
            country,
            timeout
          );

          if (isRenderMode && !primary.cacheHit) {
            renderCredits += 5; // Browser API costs 5 credits
          }

          // primary.html is always raw HTML (guaranteed by fetchPage).
          let linksHtml = primary.html;
          let contentForUser: string | undefined;

          if (isRenderMode) {
            // fetchPage already fetched HTML for links and user format separately.
            if (include_content) {
              // Use userContent if available (markdown/text mode), else raw html
              contentForUser = primary.userContent !== undefined ? primary.userContent : primary.html;
            }
          } else if (include_content && needRawForLinks) {
            // Proxy fetch: we fetched as markdown for the user's content, but we need raw HTML for links.
            await rateLimiter.acquire();
            const rawResult = await fetchPage(
              item.url,
              "raw",
              "none", // always use proxy for link extraction
              adapter,
              credentials,
              undefined,
              country,
              timeout
            );
            linksHtml = rawResult.html;
            contentForUser = primary.html;
            if (!rawResult.cacheHit) extraRawFetches++;
          } else if (include_content) {
            contentForUser = primary.html;
          }

          if (primary.cacheHit) cachedPages++;

          // Convert content to requested output format (non-render path only;
          // render path already returns the correct format from fetchPage)
          if (!isRenderMode && contentForUser !== undefined && resolvedFormat === "text") {
            contentForUser = htmlToText(contentForUser);
          }

          const { allLinks, newLinks } = extractInternalLinks(
            linksHtml,
            item.url, // use current page URL as base for relative link resolution
            hostname,
            visited,
            compiledInclude,
            compiledExclude
          );

          // Extract title from raw HTML (always attempt)
          const title = extractTitle(linksHtml);

          const page: CrawlPageResult = {
            url: item.url,
            depth: item.depth,
            title,
            status_code: primary.statusCode,
            total_links: allLinks.length,
            new_links: newLinks.length,
          };

          if (include_content && contentForUser !== undefined) {
            page.content = contentForUser;
          }

          // Extract fields if requested (always use raw HTML for field extraction)
          if (extract_fields && extract_fields.length > 0) {
            const fields: Record<string, string | null> = {};
            for (const field of extract_fields) {
              fields[field] = extractSimpleField(linksHtml, field);
            }
            page.extracted_fields = fields;
          }

          return { page, newLinks };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ url: item.url, error: msg, depth: item.depth });
          return {
            page: {
              url: item.url,
              depth: item.depth,
              total_links: 0,
              new_links: 0,
              error: msg,
            },
            newLinks: [],
          };
        }
      }
    );

    // Collect results and build next level
    const nextLevel: QueueItem[] = [];

    for (const { page, newLinks } of batchResults) {
      pages.push(page);
      if (page.depth > deepestReached) deepestReached = page.depth;

      // Add newly discovered links to next level if within depth
      for (const link of newLinks) {
        totalDiscovered++;
        if (!visited.has(link) && page.depth + 1 <= maxDepth) {
          visited.add(link);
          nextLevel.push({ url: link, depth: page.depth + 1 });
        }
      }
    }

    // Move to next depth level
    currentLevel = nextLevel;
  }

  const latency_ms = Date.now() - startTime;

  // Check for sitemap.xml hint
  const sitemapUrl = `${origin}/sitemap.xml`;
  const sitemapHint = !visited.has(sitemapUrl)
    ? `${sitemapUrl} (not crawled — check manually for a complete URL list)`
    : undefined;

  // Compute credit estimate
  const baseCredits = pages.length - cachedPages;
  const totalCredits = renderMode !== "none"
    ? renderCredits
    : baseCredits + extraRawFetches;

  const result: ProxySuccessResponse = {
    ok: true,
    tool: "novada_proxy_crawl",
    data: {
      start_url: url,
      domain: hostname,
      pages_crawled: pages.length,
      depth_reached: deepestReached,
      urls_crawled: pages.length,   // backward compat
      urls_discovered: totalDiscovered,
      pages: pages as unknown as Record<string, unknown>[],
      ...(errors.length > 0 ? { errors: errors as unknown as Record<string, unknown>[] } : {}),
      ...(sitemapHint ? { sitemap_hint: sitemapHint } : {}),
    },
    meta: {
      latency_ms,
      country,
      quota: {
        credits_estimated: totalCredits,
        note: QUOTA_NOTE,
      },
    },
  };

  if (!result.meta.country) delete result.meta.country;

  return JSON.stringify(result);
}

// ─── Validation ────────────────────────────────────────────────────────────────

export function validateCrawlParams(raw: Record<string, unknown>): CrawlParams {
  if (!raw.url || typeof raw.url !== "string") {
    throw new Error("url is required and must be a string");
  }
  if (!raw.url.startsWith("http://") && !raw.url.startsWith("https://")) {
    throw new Error("url must start with http:// or https://");
  }

  // Handle max_pages (new) and limit (legacy) — max_pages takes precedence
  // When neither is set: default 10 (matches MCP schema default for max_pages)
  let limit: number;
  if (raw.max_pages !== undefined) {
    limit = Number(raw.max_pages);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw new Error("max_pages must be between 1 and 100");
    }
  } else if (raw.limit !== undefined) {
    limit = Number(raw.limit);
    if (!Number.isFinite(limit) || limit < 10 || limit > 200) {
      throw new Error("limit must be between 10 and 200");
    }
  } else {
    limit = 10;
  }

  // Handle max_depth (new) and depth (legacy) — max_depth takes precedence
  // When neither is set: default 3 (matches MCP schema default for max_depth)
  let depth: number;
  if (raw.max_depth !== undefined) {
    depth = Number(raw.max_depth);
    if (!Number.isFinite(depth) || depth < 1 || depth > 5) {
      throw new Error("max_depth must be between 1 and 5");
    }
  } else if (raw.depth !== undefined) {
    depth = Number(raw.depth);
    if (!Number.isFinite(depth) || depth < 1 || depth > 5) {
      throw new Error("depth must be between 1 and 5");
    }
  } else {
    depth = 3;
  }

  if (raw.country !== undefined) {
    if (typeof raw.country !== "string" || raw.country.length > 10 || !SAFE_COUNTRY.test(raw.country)) {
      throw new Error("country must be a 2-letter ISO code with no hyphens (e.g. US, DE, GB)");
    }
  }

  const timeout = raw.timeout !== undefined ? Number(raw.timeout) : 60;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
    throw new Error("timeout must be between 1 and 120 seconds");
  }

  if (raw.format !== undefined && raw.format !== "raw" && raw.format !== "markdown") {
    throw new Error("format must be 'raw' or 'markdown'");
  }

  // Validate output_format
  const validOutputFormats = ["markdown", "html", "text"];
  if (raw.output_format !== undefined && !validOutputFormats.includes(raw.output_format as string)) {
    throw new Error("output_format must be 'markdown', 'html', or 'text'");
  }

  // Validate render mode
  const validRenderModes = ["none", "render", "browser"];
  if (raw.render !== undefined && !validRenderModes.includes(raw.render as string)) {
    throw new Error("render must be 'none', 'render', or 'browser'");
  }

  // Validate include_patterns
  let includePatterns: string[] | undefined;
  if (raw.include_patterns !== undefined) {
    if (!Array.isArray(raw.include_patterns)) {
      throw new Error("include_patterns must be an array of regex strings");
    }
    if (raw.include_patterns.length > 20) {
      throw new Error("include_patterns can have at most 20 entries");
    }
    for (const p of raw.include_patterns) {
      if (typeof p !== "string") {
        throw new Error("each include_pattern must be a string");
      }
      if (p.length > 100) {
        throw new Error(`include_patterns entries must be at most 100 characters (got ${p.length})`);
      }
      // Reject nested quantifiers (ReDoS risk): (a+)+, (a*)+, (a{2,})*
      if (/([+*}])\s*[)]\s*[+*{?]/.test(p) || /([+*])\s*[+*]/.test(p)) {
        throw new Error(`include_patterns contains potentially unsafe nested quantifiers: ${p}`);
      }
      try {
        new RegExp(p);
      } catch {
        throw new Error(`Invalid regex in include_patterns: ${p}`);
      }
    }
    includePatterns = raw.include_patterns as string[];
  }

  // Validate exclude_patterns
  let excludePatterns: string[] | undefined;
  if (raw.exclude_patterns !== undefined) {
    if (!Array.isArray(raw.exclude_patterns)) {
      throw new Error("exclude_patterns must be an array of regex strings");
    }
    if (raw.exclude_patterns.length > 20) {
      throw new Error("exclude_patterns can have at most 20 entries");
    }
    for (const p of raw.exclude_patterns) {
      if (typeof p !== "string") {
        throw new Error("each exclude_pattern must be a string");
      }
      if (p.length > 100) {
        throw new Error(`exclude_patterns entries must be at most 100 characters (got ${p.length})`);
      }
      if (/([+*}])\s*[)]\s*[+*{?]/.test(p) || /([+*])\s*[+*]/.test(p)) {
        throw new Error(`exclude_patterns contains potentially unsafe nested quantifiers: ${p}`);
      }
      try {
        new RegExp(p);
      } catch {
        throw new Error(`Invalid regex in exclude_patterns: ${p}`);
      }
    }
    excludePatterns = raw.exclude_patterns as string[];
  }

  // Validate extract_fields
  let extractFields: string[] | undefined;
  if (raw.extract_fields !== undefined) {
    if (!Array.isArray(raw.extract_fields)) {
      throw new Error("extract_fields must be an array of field name strings");
    }
    if (raw.extract_fields.length === 0 || raw.extract_fields.length > 20) {
      throw new Error("extract_fields must have between 1 and 20 entries");
    }
    for (const f of raw.extract_fields) {
      if (typeof f !== "string" || f.length > 50) {
        throw new Error("each extract field must be a string with max 50 characters");
      }
      if (!/^[a-zA-Z0-9_:\-]{1,50}$/.test(f)) {
        throw new Error(`extract_fields entries must be alphanumeric/underscore/colon/hyphen (got: ${f})`);
      }
    }
    extractFields = raw.extract_fields as string[];
  }

  // Validate rate_limit
  const rateLimit = raw.rate_limit !== undefined ? Number(raw.rate_limit) : 2;
  if (!Number.isFinite(rateLimit) || rateLimit < 0.5 || rateLimit > 10) {
    throw new Error("rate_limit must be between 0.5 and 10 requests per second");
  }

  return {
    url: raw.url,
    depth,
    limit,
    max_pages: raw.max_pages !== undefined ? limit : undefined,
    max_depth: raw.max_depth !== undefined ? depth : undefined,
    include_content: raw.include_content === true,
    include_patterns: includePatterns,
    exclude_patterns: excludePatterns,
    render: (raw.render as CrawlParams["render"]) || "none",
    output_format: raw.output_format as CrawlParams["output_format"],
    extract_fields: extractFields,
    country: raw.country as string | undefined,
    timeout,
    format: (raw.format as "markdown" | "raw") || "markdown",
    rate_limit: rateLimit,
  };
}
