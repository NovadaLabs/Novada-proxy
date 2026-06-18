import { vi, describe, it, expect, beforeEach } from "vitest";
import { validateCrawlParams, novadaProxyCrawl } from "../src/tools/crawl.js";
import type { ProxyAdapter, ProxyCredentials } from "../src/adapters/index.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { novadaProxyFetchSpy, novadaProxyRenderSpy } = vi.hoisted(() => ({
  novadaProxyFetchSpy: vi.fn(),
  novadaProxyRenderSpy: vi.fn(),
}));

vi.mock("../src/tools/fetch.js", () => ({
  novadaProxyFetch: novadaProxyFetchSpy,
}));

vi.mock("../src/tools/render.js", () => ({
  novadaProxyRender: novadaProxyRenderSpy,
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

const mockAdapter: ProxyAdapter = {
  name: "test",
  displayName: "Test",
  lastVerified: "2026-01-01",
  capabilities: { country: true, city: true, sticky: true },
  credentialDocs: "test",
  sensitiveFields: ["pass"] as readonly string[],
  loadCredentials: () => ({ user: "u", pass: "p", host: "h", port: "7777" }),
  buildProxyUrl: () => "http://u:p@h:7777",
};

const mockCreds: ProxyCredentials = { user: "u", pass: "p", host: "h", port: "7777" };

// ─── validateCrawlParams ──────────────────────────────────────────────────────

describe("validateCrawlParams", () => {
  it("accepts valid url with defaults", () => {
    const p = validateCrawlParams({ url: "https://example.com" });
    expect(p.url).toBe("https://example.com");
    expect(p.depth).toBe(3);
    expect(p.limit).toBe(10);
    expect(p.include_content).toBe(false);
    expect(p.timeout).toBe(60);
    expect(p.format).toBe("markdown");
  });

  it("rejects missing url", () => {
    expect(() => validateCrawlParams({})).toThrow("url is required");
  });

  it("rejects non-http url", () => {
    expect(() => validateCrawlParams({ url: "ftp://example.com" })).toThrow(
      "url must start with http://"
    );
  });

  it("rejects depth below 1", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", depth: 0 })).toThrow(
      "depth must be between 1 and 5"
    );
  });

  it("rejects depth above 5", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", depth: 6 })).toThrow(
      "depth must be between 1 and 5"
    );
  });

  it("rejects limit below 10", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", limit: 9 })).toThrow(
      "limit must be between 10 and 200"
    );
  });

  it("rejects limit above 200", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", limit: 201 })).toThrow(
      "limit must be between 10 and 200"
    );
  });

  it("rejects country with hyphens", () => {
    expect(() =>
      validateCrawlParams({ url: "https://example.com", country: "us-injected" })
    ).toThrow("country must be a 2-letter ISO code");
  });

  it("rejects timeout out of range", () => {
    expect(() =>
      validateCrawlParams({ url: "https://example.com", timeout: 0 })
    ).toThrow("timeout must be between 1 and 120");

    expect(() =>
      validateCrawlParams({ url: "https://example.com", timeout: 121 })
    ).toThrow("timeout must be between 1 and 120");
  });

  it("defaults depth to 3 (matches MCP schema default for max_depth)", () => {
    const p = validateCrawlParams({ url: "https://example.com" });
    expect(p.depth).toBe(3);
  });

  it("defaults limit to 10 (matches MCP schema default for max_pages)", () => {
    const p = validateCrawlParams({ url: "https://example.com" });
    expect(p.limit).toBe(10);
  });

  it("defaults include_content to false", () => {
    const p = validateCrawlParams({ url: "https://example.com" });
    expect(p.include_content).toBe(false);
  });

  it("passes include_content:true through", () => {
    const p = validateCrawlParams({ url: "https://example.com", include_content: true });
    expect(p.include_content).toBe(true);
  });

  it("accepts valid depth within range", () => {
    expect(validateCrawlParams({ url: "https://example.com", depth: 1 }).depth).toBe(1);
    expect(validateCrawlParams({ url: "https://example.com", depth: 5 }).depth).toBe(5);
  });

  it("accepts valid limit within range", () => {
    expect(validateCrawlParams({ url: "https://example.com", limit: 10 }).limit).toBe(10);
    expect(validateCrawlParams({ url: "https://example.com", limit: 200 }).limit).toBe(200);
  });

  it("accepts valid country code", () => {
    const p = validateCrawlParams({ url: "https://example.com", country: "US" });
    expect(p.country).toBe("US");
  });

  it("rejects invalid format", () => {
    expect(() =>
      validateCrawlParams({ url: "https://example.com", format: "html" })
    ).toThrow("format must be 'raw' or 'markdown'");
  });

  it("accepts format raw", () => {
    const p = validateCrawlParams({ url: "https://example.com", format: "raw" });
    expect(p.format).toBe("raw");
  });

  // ─── max_pages validation ──────────────────────────────────────────────────

  it("accepts max_pages within range", () => {
    const p = validateCrawlParams({ url: "https://example.com", max_pages: 10 });
    expect(p.max_pages).toBe(10);
  });

  it("rejects max_pages below 1", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", max_pages: 0 })).toThrow(
      "max_pages must be between 1 and 100"
    );
  });

  it("rejects max_pages above 100", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", max_pages: 101 })).toThrow(
      "max_pages must be between 1 and 100"
    );
  });

  it("max_pages takes precedence over limit", () => {
    const p = validateCrawlParams({ url: "https://example.com", max_pages: 20, limit: 100 });
    expect(p.max_pages).toBe(20);
  });

  // ─── max_depth validation ──────────────────────────────────────────────────

  it("accepts max_depth within range", () => {
    const p = validateCrawlParams({ url: "https://example.com", max_depth: 4 });
    expect(p.max_depth).toBe(4);
  });

  it("rejects max_depth below 1", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", max_depth: 0 })).toThrow(
      "max_depth must be between 1 and 5"
    );
  });

  it("rejects max_depth above 5", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", max_depth: 6 })).toThrow(
      "max_depth must be between 1 and 5"
    );
  });

  // ─── include_patterns validation ──────────────────────────────────────────

  it("accepts valid include_patterns", () => {
    const p = validateCrawlParams({ url: "https://example.com", include_patterns: ["/blog/", "/docs/"] });
    expect(p.include_patterns).toEqual(["/blog/", "/docs/"]);
  });

  it("rejects non-array include_patterns", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", include_patterns: "/blog/" })).toThrow(
      "include_patterns must be an array"
    );
  });

  it("rejects include_patterns with more than 20 entries", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `/path${i}/`);
    expect(() => validateCrawlParams({ url: "https://example.com", include_patterns: tooMany })).toThrow(
      "at most 20"
    );
  });

  it("rejects invalid regex in include_patterns", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", include_patterns: ["[invalid"] })).toThrow(
      "Invalid regex"
    );
  });

  // ─── exclude_patterns validation ──────────────────────────────────────────

  it("accepts valid exclude_patterns", () => {
    const p = validateCrawlParams({ url: "https://example.com", exclude_patterns: ["/tag/", "\\?page="] });
    expect(p.exclude_patterns).toEqual(["/tag/", "\\?page="]);
  });

  it("rejects non-array exclude_patterns", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", exclude_patterns: "/tag/" })).toThrow(
      "exclude_patterns must be an array"
    );
  });

  it("rejects invalid regex in exclude_patterns", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", exclude_patterns: ["(unclosed"] })).toThrow(
      "Invalid regex"
    );
  });

  // ─── render mode validation ────────────────────────────────────────────────

  it("accepts render mode none", () => {
    const p = validateCrawlParams({ url: "https://example.com", render: "none" });
    expect(p.render).toBe("none");
  });

  it("accepts render mode render", () => {
    const p = validateCrawlParams({ url: "https://example.com", render: "render" });
    expect(p.render).toBe("render");
  });

  it("accepts render mode browser", () => {
    const p = validateCrawlParams({ url: "https://example.com", render: "browser" });
    expect(p.render).toBe("browser");
  });

  it("rejects invalid render mode", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", render: "turbo" })).toThrow(
      "render must be"
    );
  });

  // ─── output_format validation ──────────────────────────────────────────────

  it("accepts output_format markdown", () => {
    const p = validateCrawlParams({ url: "https://example.com", output_format: "markdown" });
    expect(p.output_format).toBe("markdown");
  });

  it("accepts output_format html", () => {
    const p = validateCrawlParams({ url: "https://example.com", output_format: "html" });
    expect(p.output_format).toBe("html");
  });

  it("accepts output_format text", () => {
    const p = validateCrawlParams({ url: "https://example.com", output_format: "text" });
    expect(p.output_format).toBe("text");
  });

  it("rejects invalid output_format", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", output_format: "json" })).toThrow(
      "output_format must be"
    );
  });

  // ─── extract_fields validation ─────────────────────────────────────────────

  it("accepts valid extract_fields", () => {
    const p = validateCrawlParams({ url: "https://example.com", extract_fields: ["title", "description"] });
    expect(p.extract_fields).toEqual(["title", "description"]);
  });

  it("rejects non-array extract_fields", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: "title" })).toThrow(
      "extract_fields must be an array"
    );
  });

  it("rejects empty extract_fields", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: [] })).toThrow(
      "between 1 and 20"
    );
  });

  it("rejects extract_fields with more than 20 entries", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `field${i}`);
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: tooMany })).toThrow(
      "between 1 and 20"
    );
  });

  it("rejects extract field over 50 chars", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: ["a".repeat(51)] })).toThrow(
      "max 50"
    );
  });

  it("rejects extract_fields with ReDoS pattern characters", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: ["(a+)+"] })).toThrow(
      "alphanumeric/underscore/colon/hyphen"
    );
  });

  it("rejects extract_fields with special characters", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", extract_fields: ["field with spaces"] })).toThrow(
      "alphanumeric/underscore/colon/hyphen"
    );
  });

  it("accepts extract_fields with allowed characters", () => {
    const p = validateCrawlParams({ url: "https://example.com", extract_fields: ["og:title", "my_field", "field-name"] });
    expect(p.extract_fields).toEqual(["og:title", "my_field", "field-name"]);
  });

  it("rejects include_patterns entries over 100 chars", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", include_patterns: ["a".repeat(101)] })).toThrow(
      "at most 100 characters"
    );
  });

  it("rejects exclude_patterns entries over 100 chars", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", exclude_patterns: ["b".repeat(101)] })).toThrow(
      "at most 100 characters"
    );
  });

  // ─── rate_limit validation ─────────────────────────────────────────────────

  it("defaults rate_limit to 2", () => {
    const p = validateCrawlParams({ url: "https://example.com" });
    expect(p.rate_limit).toBe(2);
  });

  it("accepts valid rate_limit", () => {
    const p = validateCrawlParams({ url: "https://example.com", rate_limit: 5 });
    expect(p.rate_limit).toBe(5);
  });

  it("rejects rate_limit below 0.5", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", rate_limit: 0.1 })).toThrow(
      "rate_limit must be between 0.5 and 10"
    );
  });

  it("rejects rate_limit above 10", () => {
    expect(() => validateCrawlParams({ url: "https://example.com", rate_limit: 11 })).toThrow(
      "rate_limit must be between 0.5 and 10"
    );
  });
});

// ─── novadaProxyCrawl integration ─────────────────────────────────────────────

function makeFetchResponse(
  url: string,
  html: string,
  statusCode = 200,
  cacheHit = false
): string {
  return JSON.stringify({
    ok: true,
    tool: "novada_proxy_fetch",
    data: {
      url,
      status_code: statusCode,
      content: html,
    },
    meta: {
      latency_ms: 50,
      cache_hit: cacheHit,
      truncated: false,
      quota: { credits_estimated: 1, note: "" },
    },
  });
}

function makeRenderResponse(
  url: string,
  html: string,
  statusCode = 200
): string {
  return JSON.stringify({
    ok: true,
    tool: "novada_proxy_render",
    data: {
      url,
      status_code: statusCode,
      content: html,
    },
    meta: {
      latency_ms: 200,
      truncated: false,
      quota: { credits_estimated: 5, note: "" },
    },
  });
}

describe("novadaProxyCrawl", () => {
  beforeEach(() => {
    novadaProxyFetchSpy.mockReset();
    novadaProxyRenderSpy.mockReset();
  });

  it("returns valid JSON with correct tool name", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("novada_proxy_crawl");
  });

  it("includes start_url and domain in data", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.start_url).toBe("https://example.com");
    expect(result.data.domain).toBe("example.com");
  });

  it("crawls at least the start URL", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>No links</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.urls_crawled).toBe(1);
    expect(result.data.pages).toHaveLength(1);
    expect(result.data.pages[0].url).toBe("https://example.com");
    expect(result.data.pages[0].depth).toBe(0);
  });

  it("follows internal links up to depth limit", async () => {
    // Root page has 2 internal links
    const rootHtml = `<html><body>
      <a href="/page1">Page 1</a>
      <a href="/page2">Page 2</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(
        makeFetchResponse("https://example.com/page1", "<html><body>Page 1</body></html>")
      )
      .mockResolvedValueOnce(
        makeFetchResponse("https://example.com/page2", "<html><body>Page 2</body></html>")
      );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.urls_crawled).toBe(3);
    expect(result.data.depth_reached).toBe(1);
  });

  it("does not follow external links", async () => {
    const rootHtml = `<html><body>
      <a href="https://external.com/page">External</a>
      <a href="/internal">Internal</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(
        makeFetchResponse("https://example.com/internal", "<html><body>Internal</body></html>")
      );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    // Only example.com and /internal crawled — external.com excluded
    expect(result.data.urls_crawled).toBe(2);
  });

  it("respects limit parameter", async () => {
    // Root page with many links, limit=1 means only root is crawled
    const manyLinksHtml = Array.from({ length: 20 }, (_, i) =>
      `<a href="/page${i}">Page ${i}</a>`
    ).join("\n");
    const rootHtml = `<html><body>${manyLinksHtml}</body></html>`;

    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", rootHtml)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 2, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.urls_crawled).toBeLessThanOrEqual(10);
  });

  it("records errors per page but continues crawling", async () => {
    const rootHtml = `<html><body>
      <a href="/good">Good</a>
      <a href="/bad">Bad</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(
        makeFetchResponse("https://example.com/good", "<html><body>Good</body></html>")
      )
      .mockRejectedValueOnce(new Error("Network error"));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.data.urls_crawled).toBe(3);

    const failedPage = result.data.pages.find((p: { error?: string }) => p.error !== undefined);
    expect(failedPage).toBeDefined();
    expect(failedPage.error).toContain("Network error");
  });

  it("does not revisit already-visited URLs", async () => {
    // Both sub-pages link back to root
    const rootHtml = `<html><body><a href="/sub">Sub</a></body></html>`;
    const subHtml = `<html><body><a href="/">Back to root</a></body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/sub", subHtml));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 2, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    // Root should only be visited once despite sub linking back
    expect(result.data.urls_crawled).toBe(2);
    // novadaProxyFetch called exactly twice
    expect(novadaProxyFetchSpy).toHaveBeenCalledTimes(2);
  });

  it("includes content when include_content is true", async () => {
    const html = "<html><body>Page content here</body></html>";
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10, include_content: true, format: "raw" },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    expect(page.content).toBeDefined();
  });

  it("includes sitemap_hint when sitemap not crawled", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>No links</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.sitemap_hint).toContain("sitemap.xml");
  });

  it("includes latency_ms in meta", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(typeof result.meta.latency_ms).toBe("number");
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("throws for an invalid start URL", async () => {
    await expect(
      novadaProxyCrawl(
        { url: "not-a-url", depth: 1, limit: 10 },
        mockAdapter,
        mockCreds
      )
    ).rejects.toThrow("Invalid URL");
  });

  it("counts credits as pages minus cache hits", async () => {
    novadaProxyFetchSpy
      .mockResolvedValueOnce(
        makeFetchResponse("https://example.com", "<html><body>Hello</body></html>", 200, false)
      )
    ;

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.meta.quota.credits_estimated).toBe(1); // 1 page, 0 cache hits
  });

  // ─── F2 fix tests: field should be new_links not links_found ─────────────────
  it("should use 'new_links' field name (not 'links_found') in page results", async () => {
    const rootHtml = `<html><body>
      <a href="/page1">Page 1</a>
      <a href="/page2">Page 2</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", rootHtml)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    // After F2's fix: field is new_links, not links_found
    expect(page).toHaveProperty("new_links");
    expect(page.new_links).toBeGreaterThanOrEqual(0);
  });

  // ─── F2 fix tests: total_links field should exist ────────────────────────────
  it("should include 'total_links' count per page", async () => {
    // Page with 3 links: 2 internal (one duplicate) + 1 external
    const rootHtml = `<html><body>
      <a href="/page1">Page 1</a>
      <a href="/page2">Page 2</a>
      <a href="/page1">Page 1 again</a>
      <a href="https://external.com">External</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", rootHtml)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    // total_links counts all internal links on the page (deduplicated within page)
    expect(page).toHaveProperty("total_links");
    expect(typeof page.total_links).toBe("number");
    // Exactly 2 unique internal links on this page (/page1 and /page2)
    expect(page.total_links).toBe(2);
  });

  // ─── F2 fix tests: credit counting with double fetches ───────────────────────
  it("should estimate 2x credits when include_content=true and format=markdown", async () => {
    const rootHtml = `<html><body>
      <a href="/page1">Page 1</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", "# Root", 200, false))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml, 200, false))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/page1", "# Page 1", 200, false))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/page1", "<html><body>Page 1</body></html>", 200, false));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10, include_content: true, format: "markdown" },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    // 2 pages, 0 cache hits, 2 extra raw fetches = 2 - 0 + 2 = 4 credits
    expect(result.meta.quota.credits_estimated).toBe(4);
  });

  // ─── New features: max_pages / max_depth aliases ────────────────────────────

  it("respects max_pages parameter", async () => {
    const manyLinksHtml = Array.from({ length: 20 }, (_, i) =>
      `<a href="/page${i}">Page ${i}</a>`
    ).join("\n");
    const rootHtml = `<html><body>${manyLinksHtml}</body></html>`;

    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", rootHtml)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", max_pages: 5, max_depth: 2 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.urls_crawled).toBeLessThanOrEqual(5);
    expect(result.data.pages_crawled).toBeLessThanOrEqual(5);
  });

  it("includes pages_crawled in response", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.pages_crawled).toBe(1);
  });

  // ─── New features: include_patterns ──────────────────────────────────────────

  it("follows only URLs matching include_patterns", async () => {
    const rootHtml = `<html><body>
      <a href="/blog/post1">Blog Post</a>
      <a href="/about">About</a>
      <a href="/blog/post2">Another Blog Post</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/blog/post1", "<html><body>Post 1</body></html>"))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/blog/post2", "<html><body>Post 2</body></html>"));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10, include_patterns: ["/blog/"] },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    // Root + 2 blog pages = 3 (root is always crawled, include_patterns affect discovered links)
    const urls = result.data.pages.map((p: { url: string }) => p.url);
    expect(urls).toContain("https://example.com/blog/post1");
    expect(urls).toContain("https://example.com/blog/post2");
    expect(urls).not.toContain("https://example.com/about");
  });

  // ─── New features: exclude_patterns ──────────────────────────────────────────

  it("skips URLs matching exclude_patterns", async () => {
    const rootHtml = `<html><body>
      <a href="/page1">Page 1</a>
      <a href="/tag/news">Tag Page</a>
      <a href="/page2">Page 2</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/page1", "<html><body>Page 1</body></html>"))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/page2", "<html><body>Page 2</body></html>"));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10, exclude_patterns: ["/tag/"] },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const urls = result.data.pages.map((p: { url: string }) => p.url);
    expect(urls).toContain("https://example.com/page1");
    expect(urls).toContain("https://example.com/page2");
    expect(urls).not.toContain("https://example.com/tag/news");
  });

  // ─── New features: render mode ─────────────────────────────────────────────

  it("uses novadaProxyRender when render mode is 'render'", async () => {
    const html = `<html><head><title>Rendered Page</title></head><body>JS Content</body></html>`;
    novadaProxyRenderSpy.mockResolvedValue(makeRenderResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        render: "render",
        browser_ws: "wss://fake-browser",
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.data.urls_crawled).toBe(1);
    expect(novadaProxyRenderSpy).toHaveBeenCalled();
    expect(novadaProxyFetchSpy).not.toHaveBeenCalled();
  });

  it("charges 5 credits per page in render mode", async () => {
    novadaProxyRenderSpy.mockResolvedValue(
      makeRenderResponse("https://example.com", "<html><body>Rendered</body></html>")
    );

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        render: "render",
        browser_ws: "wss://fake-browser",
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.meta.quota.credits_estimated).toBe(5);
  });

  // ─── New features: extract_fields ──────────────────────────────────────────

  it("extracts fields from each page when extract_fields provided", async () => {
    const html = `<html>
      <head>
        <title>Example Page</title>
        <meta name="description" content="A test page">
        <meta property="og:image" content="https://example.com/img.jpg">
      </head>
      <body>Content</body>
    </html>`;

    novadaProxyFetchSpy.mockResolvedValue(makeFetchResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        extract_fields: ["title", "description", "image"],
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    expect(page.extracted_fields).toBeDefined();
    expect(page.extracted_fields.title).toBe("Example Page");
    expect(page.extracted_fields.description).toBe("A test page");
    expect(page.extracted_fields.image).toBe("https://example.com/img.jpg");
  });

  it("returns null for fields not found in the page", async () => {
    const html = `<html><head><title>Simple Page</title></head><body>Content</body></html>`;
    novadaProxyFetchSpy.mockResolvedValue(makeFetchResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        extract_fields: ["title", "price", "author"],
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    expect(page.extracted_fields.title).toBe("Simple Page");
    expect(page.extracted_fields.price).toBeNull();
    expect(page.extracted_fields.author).toBeNull();
  });

  // ─── New features: title extraction ────────────────────────────────────────

  it("extracts page title from <title> tag", async () => {
    const html = `<html><head><title>My Test Page</title></head><body>Content</body></html>`;
    novadaProxyFetchSpy.mockResolvedValue(makeFetchResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.pages[0].title).toBe("My Test Page");
  });

  it("falls back to <h1> when no <title> tag exists", async () => {
    const html = `<html><body><h1>Page Heading</h1><p>Content</p></body></html>`;
    novadaProxyFetchSpy.mockResolvedValue(makeFetchResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.pages[0].title).toBe("Page Heading");
  });

  // ─── New features: errors array ────────────────────────────────────────────

  it("includes errors array when pages fail", async () => {
    const rootHtml = `<html><body><a href="/broken">Broken</a></body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockRejectedValueOnce(new Error("Connection refused"));

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.errors).toBeDefined();
    expect(result.data.errors).toHaveLength(1);
    expect(result.data.errors[0].url).toBe("https://example.com/broken");
    expect(result.data.errors[0].error).toContain("Connection refused");
    expect(result.data.errors[0].depth).toBe(1);
  });

  it("does not include errors array when all pages succeed", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>OK</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.errors).toBeUndefined();
  });

  // ─── New features: output_format ───────────────────────────────────────────

  it("respects output_format='html' when include_content=true", async () => {
    const html = `<html><body><h1>Hello</h1><p>World</p></body></html>`;
    novadaProxyFetchSpy.mockResolvedValue(makeFetchResponse("https://example.com", html));

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        include_content: true,
        output_format: "html",
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const page = result.data.pages[0];
    // HTML format should contain HTML tags
    expect(page.content).toContain("<h1>");
  });

  // ─── Backward compatibility ────────────────────────────────────────────────

  it("works with legacy depth and limit params", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.data.urls_crawled).toBe(1);
  });

  it("max_pages takes precedence over limit", async () => {
    const manyLinksHtml = Array.from({ length: 20 }, (_, i) =>
      `<a href="/page${i}">Page ${i}</a>`
    ).join("\n");
    const rootHtml = `<html><body>${manyLinksHtml}</body></html>`;

    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", rootHtml)
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", max_pages: 3, limit: 100, depth: 2 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.data.urls_crawled).toBeLessThanOrEqual(3);
  });

  // ─── Rate limiting ────────────────────────────────────────────────────────

  // ─── Fix 3: render mode without browser_ws returns structured error ──────────

  it("returns error when render mode is set but browser_ws is missing", async () => {
    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        render: "render",
        // browser_ws intentionally omitted
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.error.message).toContain("browser_ws is required");
    expect(result.error.agent_instruction).toContain("NOVADA_BROWSER_WS");
    // fetch should NOT have been called
    expect(novadaProxyFetchSpy).not.toHaveBeenCalled();
    expect(novadaProxyRenderSpy).not.toHaveBeenCalled();
  });

  it("still works with rate_limit parameter", async () => {
    novadaProxyFetchSpy.mockResolvedValue(
      makeFetchResponse("https://example.com", "<html><body>Hello</body></html>")
    );

    const raw = await novadaProxyCrawl(
      { url: "https://example.com", depth: 1, limit: 10, rate_limit: 5 },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
  });

  // ─── Combined patterns ────────────────────────────────────────────────────

  it("combines include and exclude patterns correctly", async () => {
    const rootHtml = `<html><body>
      <a href="/blog/post1">Blog Post</a>
      <a href="/blog/draft-secret">Draft</a>
      <a href="/about">About</a>
    </body></html>`;

    novadaProxyFetchSpy
      .mockResolvedValueOnce(makeFetchResponse("https://example.com", rootHtml))
      .mockResolvedValueOnce(makeFetchResponse("https://example.com/blog/post1", "<html><body>Post 1</body></html>"));

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        include_patterns: ["/blog/"],
        exclude_patterns: ["/draft"],
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const urls = result.data.pages.map((p: { url: string }) => p.url);
    expect(urls).toContain("https://example.com/blog/post1");
    expect(urls).not.toContain("https://example.com/blog/draft-secret");
    expect(urls).not.toContain("https://example.com/about");
  });
});

// ─── INC-69: Double render call deduplication ─────────────────────────────────

describe("INC-69: render call dedup — single render per page in render mode", () => {
  beforeEach(() => {
    novadaProxyFetchSpy.mockReset();
    novadaProxyRenderSpy.mockReset();
  });

  it("calls novadaProxyRender exactly once per page even when include_content and markdown format are requested", async () => {
    const startHtml = `<html><body><h1>Page Title</h1><p>Content</p></body></html>`;
    novadaProxyRenderSpy.mockResolvedValue(
      makeRenderResponse("https://example.com", startHtml)
    );

    await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        render: "render",
        include_content: true,
        output_format: "markdown",
        browser_ws: "ws://browser:3000",
      },
      mockAdapter,
      mockCreds
    );

    // With dedup fix: render called exactly once (for HTML), markdown is derived locally
    expect(novadaProxyRenderSpy).toHaveBeenCalledTimes(1);
    expect(novadaProxyRenderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com", format: "html" }),
      "ws://browser:3000"
    );
  });

  it("content is still returned (markdown converted from the single HTML render)", async () => {
    const startHtml = `<html><body><h1>Test Heading</h1><p>Body text here</p></body></html>`;
    novadaProxyRenderSpy.mockResolvedValue(
      makeRenderResponse("https://example.com", startHtml)
    );

    const raw = await novadaProxyCrawl(
      {
        url: "https://example.com",
        depth: 1,
        limit: 10,
        render: "render",
        include_content: true,
        output_format: "markdown",
        browser_ws: "ws://browser:3000",
      },
      mockAdapter,
      mockCreds
    );

    const result = JSON.parse(raw);
    const pages = result.data.pages as Array<{ content?: string }>;
    expect(pages.length).toBeGreaterThan(0);
    const page = pages[0];
    expect(page.content).toBeDefined();
    // Should contain markdown-converted heading from HTML
    expect(page.content).toContain("Test Heading");
  });
});
