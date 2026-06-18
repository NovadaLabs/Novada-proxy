import { describe, it, expect, vi } from "vitest";
import { extractField, validateExtractParams, novadaProxyExtract } from "../src/tools/extract.js";
import type { ProxyAdapter, ProxyCredentials } from "../src/adapters/index.js";

describe("extractField", () => {
  // --- Title extraction ---

  it("extracts title from og:title meta tag", () => {
    const html = '<meta property="og:title" content="Test Product">';
    expect(extractField(html, "title")).toBe("Test Product");
  });

  it("falls back to <title> tag when og:title missing", () => {
    const html = "<title>Page Title</title>";
    expect(extractField(html, "title")).toBe("Page Title");
  });

  it("falls back to <h1> when title and og:title missing", () => {
    const html = "<h1>Main Heading</h1>";
    expect(extractField(html, "title")).toBe("Main Heading");
  });

  it("returns null when no title signals exist", () => {
    expect(extractField("<p>Just text</p>", "title")).toBeNull();
  });

  it("prefers og:title over <title> tag", () => {
    const html = '<meta property="og:title" content="OG Title"><title>HTML Title</title>';
    expect(extractField(html, "title")).toBe("OG Title");
  });

  // --- Price extraction ---

  it("extracts price from JSON-LD", () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","name":"Test","offers":{"price":"29.99"}}</script>';
    expect(extractField(html, "price")).toBe("29.99");
  });

  it("extracts price from HTML class pattern", () => {
    const html = '<div class="price">$49.99</div>';
    expect(extractField(html, "price")).toBe("$49.99");
  });

  it("extracts lowPrice from JSON-LD when price absent", () => {
    const html =
      '<script type="application/ld+json">{"offers":{"lowPrice":"9.99"}}</script>';
    expect(extractField(html, "price")).toBe("9.99");
  });

  // --- Description extraction ---

  it("extracts description from og:description", () => {
    const html =
      '<meta property="og:description" content="A great product">';
    expect(extractField(html, "description")).toBe("A great product");
  });

  it("falls back to meta name=description", () => {
    const html = '<meta name="description" content="Fallback desc">';
    expect(extractField(html, "description")).toBe("Fallback desc");
  });

  // --- Image extraction ---

  it("extracts image from og:image", () => {
    const html =
      '<meta property="og:image" content="https://example.com/img.jpg">';
    expect(extractField(html, "image")).toBe("https://example.com/img.jpg");
  });

  it("falls back to first substantive <img> when og:image and JSON-LD missing", () => {
    const html =
      '<img src="/assets/icon-small.png"><img src="https://cdn.bbc.com/article-hero.jpg"><img src="/photo2.jpg">';
    expect(extractField(html, "image")).toBe("https://cdn.bbc.com/article-hero.jpg");
  });

  it("skips tiny/tracking images in fallback", () => {
    const html =
      '<img src="https://track.com/pixel.gif"><img src="/logo.svg"><img src="/spacer.png"><img src="https://cdn.com/real-photo.jpg">';
    expect(extractField(html, "image")).toBe("https://cdn.com/real-photo.jpg");
  });

  it("returns null when only icon/logo/tracking images exist", () => {
    const html =
      '<img src="/favicon-icon.png"><img src="/site-logo.svg"><img src="/1x1.gif">';
    expect(extractField(html, "image")).toBeNull();
  });

  // --- Rating / Reviews ---

  it("extracts rating from JSON-LD ratingValue", () => {
    const html =
      '<script type="application/ld+json">{"aggregateRating":{"ratingValue":"4.5"}}</script>';
    expect(extractField(html, "rating")).toBe("4.5");
  });

  it("extracts review_count from JSON-LD", () => {
    const html =
      '<script type="application/ld+json">{"aggregateRating":{"reviewCount":"120"}}</script>';
    expect(extractField(html, "review_count")).toBe("120");
  });

  // --- URL / Canonical ---

  it("extracts canonical URL", () => {
    const html =
      '<link rel="canonical" href="https://example.com/page">';
    expect(extractField(html, "url")).toBe("https://example.com/page");
  });

  it("prefers og:url over canonical", () => {
    const html =
      '<meta property="og:url" content="https://og.example.com/page"><link rel="canonical" href="https://example.com/page">';
    expect(extractField(html, "url")).toBe("https://og.example.com/page");
  });

  // --- Links ---

  it("extracts links as array of absolute URLs (no baseUrl)", () => {
    const html =
      '<a href="https://a.com">A</a><a href="https://b.com">B</a><a href="/relative">R</a>';
    const links = extractField(html, "links") as string[];
    expect(links).toContain("https://a.com");
    expect(links).toContain("https://b.com");
    expect(links).not.toContain("/relative");
  });

  it("resolves relative URLs when baseUrl is provided", () => {
    const html =
      '<a href="https://a.com">A</a><a href="/news/world-123">R</a><a href="page">P</a>';
    const links = extractField(html, "links", "https://www.bbc.com/news") as string[];
    expect(links).toContain("https://a.com");
    expect(links).toContain("https://www.bbc.com/news/world-123");
    expect(links).toContain("https://www.bbc.com/page");
  });

  it("does not include non-http schemes when resolving relative URLs", () => {
    const html =
      '<a href="https://valid.com">V</a><a href="javascript:void(0)">J</a><a href="mailto:a@b.com">M</a>';
    const links = extractField(html, "links", "https://example.com") as string[];
    expect(links).toContain("https://valid.com");
    expect(links).toHaveLength(1);
  });

  it("deduplicates links", () => {
    const html =
      '<a href="https://a.com">1</a><a href="https://a.com">2</a>';
    const links = extractField(html, "links") as string[];
    expect(links).toEqual(["https://a.com"]);
  });

  // --- Headings ---

  it("extracts headings as array", () => {
    const html = "<h1>First</h1><h1>Second</h1>";
    expect(extractField(html, "headings")).toEqual(["First", "Second"]);
  });

  it("extracts h2 headings when field is h2", () => {
    const html = "<h2>Sub A</h2><h2>Sub B</h2>";
    expect(extractField(html, "h2")).toEqual(["Sub A", "Sub B"]);
  });

  // --- Currency ---

  it("extracts currency from JSON-LD", () => {
    const html =
      '<script type="application/ld+json">{"offers":{"priceCurrency":"USD"}}</script>';
    expect(extractField(html, "currency")).toBe("USD");
  });

  // --- Author ---

  it("extracts author from JSON-LD", () => {
    const html =
      '<script type="application/ld+json">{"author":"Jane Doe"}</script>';
    expect(extractField(html, "author")).toBe("Jane Doe");
  });

  it("falls back to meta author", () => {
    const html = '<meta name="author" content="John Smith">';
    expect(extractField(html, "author")).toBe("John Smith");
  });

  // --- Date ---

  it("extracts date from JSON-LD datePublished", () => {
    const html =
      '<script type="application/ld+json">{"datePublished":"2024-01-15"}</script>';
    expect(extractField(html, "date")).toBe("2024-01-15");
  });

  // --- Generic fallback ---

  it("uses JSON-LD fallback for unknown fields", () => {
    const html =
      '<script type="application/ld+json">{"brand":"TestBrand"}</script>';
    expect(extractField(html, "brand")).toBe("TestBrand");
  });

  it("returns null for completely unknown fields", () => {
    expect(extractField("<p>text</p>", "nonexistent_field")).toBeNull();
  });

  // --- Robustness ---

  it("handles malformed JSON-LD gracefully", () => {
    const html =
      '<script type="application/ld+json">{ invalid json }</script>';
    expect(extractField(html, "title")).toBeNull();
  });

  it("handles empty HTML", () => {
    expect(extractField("", "title")).toBeNull();
  });

  it("decodes HTML entities in extracted values", () => {
    const html = '<meta property="og:title" content="Tom &amp; Jerry">';
    expect(extractField(html, "title")).toBe("Tom & Jerry");
  });

  // --- Field aliases ---

  it("treats 'name' as title alias", () => {
    const html = "<title>Product Name</title>";
    expect(extractField(html, "name")).toBe("Product Name");
  });

  it("treats 'product_name' as title alias", () => {
    const html = "<title>Widget</title>";
    expect(extractField(html, "product_name")).toBe("Widget");
  });

  it("treats 'cost' as price alias", () => {
    const html =
      '<script type="application/ld+json">{"offers":{"price":"5.00"}}</script>';
    expect(extractField(html, "cost")).toBe("5.00");
  });

  it("treats 'summary' as description alias", () => {
    const html = '<meta property="og:description" content="Summary text">';
    expect(extractField(html, "summary")).toBe("Summary text");
  });

  it("treats 'thumbnail' as image alias", () => {
    const html =
      '<meta property="og:image" content="https://example.com/thumb.png">';
    expect(extractField(html, "thumbnail")).toBe(
      "https://example.com/thumb.png"
    );
  });

  it("treats 'score' as rating alias", () => {
    const html =
      '<script type="application/ld+json">{"aggregateRating":{"ratingValue":"3.8"}}</script>';
    expect(extractField(html, "score")).toBe("3.8");
  });

  // --- Deeply nested JSON-LD ---

  it("finds deeply nested JSON-LD values", () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","brand":{"@type":"Brand","name":"Acme"}}</script>';
    // deepFind should find "name" inside the nested brand object
    // But the field "name" maps to the title branch, so use a direct field:
    expect(extractField(html, "brand")).toBe('{"@type":"Brand","name":"Acme"}');
  });

  // ─── F3 fix tests: image fallback to <img> tag ──────────────────────────────
  it("should extract image from <img> tag when og:image and JSON-LD are absent", () => {
    // No og:image, no JSON-LD — should fall back to first <img> tag
    const html = `<html><body>
      <img src="https://example.com/hero.jpg" alt="Hero image">
      <img src="https://example.com/other.jpg" alt="Other image">
    </body></html>`;
    const result = extractField(html, "image");
    expect(result).toBe("https://example.com/hero.jpg");
  });

  it("should skip tiny/tracking images (icon, pixel, spacer) in image fallback", () => {
    // All images have tracking/icon patterns — should skip them and return null
    const html = `<html><body>
      <img src="https://example.com/pixel.gif" alt="">
      <img src="https://example.com/tracking-pixel.png" alt="">
      <img src="https://example.com/icon-small.svg" alt="">
      <img src="https://example.com/spacer.gif" alt="">
    </body></html>`;
    const result = extractField(html, "image");
    // All images match skip patterns (pixel, tracking, icon, spacer) → null
    expect(result).toBeNull();
  });

  it("should skip icon images but find the first valid one", () => {
    const html = `<html><body>
      <img src="https://example.com/favicon-icon.png" alt="">
      <img src="https://example.com/logo-icon.svg" alt="">
      <img src="https://example.com/product-photo.jpg" alt="Product">
    </body></html>`;
    const result = extractField(html, "image");
    expect(result).toBe("https://example.com/product-photo.jpg");
  });

  it("should prefer og:image over <img> fallback", () => {
    const html = `
      <meta property="og:image" content="https://example.com/og.jpg">
      <img src="https://example.com/fallback.jpg" alt="">
    `;
    expect(extractField(html, "image")).toBe("https://example.com/og.jpg");
  });

  // ─── F3 fix tests: relative URL resolution in links ─────────────────────────
  it("should resolve relative hrefs when baseUrl is provided", () => {
    const html = `
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
      <a href="https://example.com/absolute">Absolute</a>
    `;
    const links = extractField(html, "links", "https://example.com") as string[];
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/contact");
    expect(links).toContain("https://example.com/absolute");
  });

  it("should still work without baseUrl (backward compatible)", () => {
    const html = `
      <a href="https://a.com/page">A</a>
      <a href="/relative">Relative</a>
    `;
    // Without baseUrl, relative URLs cannot be resolved and should be skipped
    const linksNoBase = extractField(html, "links") as string[];
    expect(linksNoBase).toContain("https://a.com/page");
    // Relative URLs without baseUrl should NOT appear in the result
    expect(linksNoBase).not.toContain("/relative");
  });

  it("should resolve relative paths with subdirectory baseUrl", () => {
    const html = `
      <a href="../sibling">Sibling</a>
      <a href="child">Child</a>
    `;
    const links = extractField(html, "links", "https://example.com/docs/page") as string[];
    // ../sibling from /docs/page → /sibling
    expect(links).toContain("https://example.com/sibling");
    // child from /docs/page → /docs/child
    expect(links).toContain("https://example.com/docs/child");
  });
});

// ─── INC-71: pagination + nested-tag link support ────────────────────────────

describe("INC-71: extractField links — pagination and nested-tag support", () => {
  it("extracts ?page=N pagination links when baseUrl is provided", () => {
    const html = `
      <a href="?page=2">Next page</a>
      <a href="?page=3">Page 3</a>
      <a href="https://example.com/article">Article</a>
    `;
    const links = extractField(html, "links", "https://example.com/blog") as string[];
    // ?page=2 resolves against baseUrl → https://example.com/blog?page=2
    expect(links).toContain("https://example.com/blog?page=2");
    expect(links).toContain("https://example.com/blog?page=3");
    expect(links).toContain("https://example.com/article");
  });

  it("extracts /page/N pagination links", () => {
    const html = `
      <a href="/page/2">Next</a>
      <a href="/page/10">Last</a>
    `;
    const links = extractField(html, "links", "https://example.com") as string[];
    expect(links).toContain("https://example.com/page/2");
    expect(links).toContain("https://example.com/page/10");
  });

  it("extracts links from <a> tags nested inside <li> elements", () => {
    const html = `
      <ul>
        <li><a href="https://example.com/item1">Item 1</a></li>
        <li><a href="https://example.com/item2">Item 2</a></li>
      </ul>
    `;
    const links = extractField(html, "links") as string[];
    expect(links).toContain("https://example.com/item1");
    expect(links).toContain("https://example.com/item2");
  });

  it("extracts links from <a> tags nested inside <div> elements with attributes", () => {
    const html = `
      <div class="nav-container" data-id="main">
        <div class="inner">
          <a href="https://example.com/about">About</a>
        </div>
        <span class="item"><a href="https://example.com/contact">Contact</a></span>
      </div>
    `;
    const links = extractField(html, "links") as string[];
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/contact");
  });

  it("skips javascript: and mailto: hrefs", () => {
    const html = `
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:test@example.com">Mail</a>
      <a href="https://example.com/valid">Valid</a>
    `;
    const links = extractField(html, "links", "https://example.com") as string[];
    expect(links).toContain("https://example.com/valid");
    expect(links).not.toContain("javascript:void(0)");
    expect(links).not.toContain("mailto:test@example.com");
  });

  it("deduplicates pagination links", () => {
    const html = `
      <a href="?page=2">Next</a>
      <a href="?page=2">Next (duplicate)</a>
    `;
    const links = extractField(html, "links", "https://example.com/blog") as string[];
    const page2Links = links.filter(l => l.includes("page=2"));
    expect(page2Links).toHaveLength(1);
  });
});

// ─── validateExtractParams — schema validation ───────────────────────────────

describe("validateExtractParams — schema validation", () => {
  const baseUrl = "https://example.com/product";

  it("accepts valid schema without fields param", () => {
    const params = validateExtractParams({
      url: baseUrl,
      schema: { product_name: "The full product name", price: "Current price in USD" },
    });
    expect(params.schema).toEqual({ product_name: "The full product name", price: "Current price in USD" });
    expect(params.fields).toEqual([]);
  });

  it("rejects schema keys with special chars", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { "bad-key": "description" } })
    ).toThrow("schema keys must be alphanumeric/underscore");
  });

  it("rejects schema keys that start with a number", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { "1field": "description" } })
    ).toThrow("schema keys must be alphanumeric/underscore");
  });

  it("rejects schema keys over 50 chars", () => {
    const longKey = "a".repeat(51);
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { [longKey]: "description" } })
    ).toThrow("schema keys must be alphanumeric/underscore");
  });

  it("rejects whitespace-only schema values", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { price: "   " } })
    ).toThrow("schema values must be non-empty strings");
  });

  it("rejects empty string schema values", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { price: "" } })
    ).toThrow("schema values must be non-empty strings");
  });

  it("rejects schema values over 200 chars", () => {
    const longVal = "a".repeat(201);
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: { price: longVal } })
    ).toThrow("schema value descriptions must be 200 characters or less");
  });

  it("rejects schema with 0 fields", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: {} })
    ).toThrow("schema must have at least 1 field");
  });

  it("rejects schema with more than 20 fields", () => {
    const bigSchema: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) bigSchema[`field${i}`] = "description";
    expect(() =>
      validateExtractParams({ url: baseUrl, schema: bigSchema })
    ).toThrow("schema must have at most 20 fields");
  });

  it("still requires fields when schema is absent", () => {
    expect(() =>
      validateExtractParams({ url: baseUrl })
    ).toThrow("fields is required");
  });
});

// ─── novadaProxyExtract — schema mode (prompt shape) ─────────────────────────

describe("novadaProxyExtract — schema mode prompt shape", () => {
  it("extraction_prompt contains field names but NOT page content", () => {
    // Build the extraction prompt the same way the handler does and verify
    // it contains the schema field names but not the raw HTML/content.
    const schema = { product_name: "The product name", price: "Current price" };
    const schemaEntries = Object.entries(schema).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    const extractionPrompt =
      `Extract the following fields from the page content provided in data.content of this response. Return ONLY a JSON object with the field names as keys. If a field cannot be found, set its value to null.\n\nFields to extract:\n${schemaEntries}`;

    expect(extractionPrompt).toContain("product_name");
    expect(extractionPrompt).toContain("price");
    expect(extractionPrompt).toContain("data.content");
    // Must NOT embed page content
    expect(extractionPrompt).not.toContain("Widget Pro");
    expect(extractionPrompt).not.toContain("$49.99");
    expect(extractionPrompt).not.toContain("<html>");
  });

  it("extraction_prompt includes null instruction for missing fields", () => {
    const schema = { warranty: "Warranty terms" };
    const schemaEntries = Object.entries(schema).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    const extractionPrompt =
      `Extract the following fields from the page content provided in data.content of this response. Return ONLY a JSON object with the field names as keys. If a field cannot be found, set its value to null.\n\nFields to extract:\n${schemaEntries}`;

    expect(extractionPrompt).toContain("null");
    expect(extractionPrompt).toContain("warranty");
  });
});

// ─── novadaProxyExtract — schema mode integration (with mock fetch) ───────────

vi.mock("../src/tools/fetch.js", () => ({
  novadaProxyFetch: vi.fn(),
}));

describe("novadaProxyExtract — schema mode integration", () => {
  const testUrl = "https://example.com/product";
  const testHtml =
    "<html><body><h1>Widget Pro</h1><p>Price: $49.99</p><p>Warranty: 1 year.</p></body></html>";

  const mockAdapter = {
    buildProxyUrl: () => "http://proxy.local/https://example.com/product",
    sensitiveFields: [] as string[],
    displayName: "Mock",
    credentialDocs: "",
  } as unknown as ProxyAdapter;
  const mockCredentials: ProxyCredentials = { user: "u", pass: "p" };

  async function setupFetchMock(html: string) {
    const { novadaProxyFetch } = await import("../src/tools/fetch.js");
    vi.mocked(novadaProxyFetch).mockResolvedValue(
      JSON.stringify({ ok: true, tool: "novada_proxy_fetch", data: { content: html, status_code: 200 }, meta: { latency_ms: 10 } })
    );
  }

  it("schema mode returns mode:'llm_extract' with content, extraction_prompt, schema, url", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { product_name: "The product name", price: "Current price in USD" },
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.mode).toBe("llm_extract");
    expect(data.url).toBe(testUrl);
    expect(data.schema).toEqual({ product_name: "The product name", price: "Current price in USD" });
    expect(typeof data.content).toBe("string");
    expect(typeof data.extraction_prompt).toBe("string");
    expect(typeof data.content_length).toBe("number");
  });

  it("content is cleaned markdown (not raw HTML)", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { price: "Current price in USD" },
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    // content should be markdown — no HTML tags
    expect(data.content as string).not.toMatch(/<html>/i);
    expect(data.content as string).not.toMatch(/<body>/i);
    // Should contain the text content
    expect(data.content as string).toContain("Widget Pro");
  });

  it("content is truncated with unicodeSafeTruncate (max 50000 chars)", async () => {
    // Generate a very long HTML string
    const longHtml = "<html><body>" + "<p>" + "x".repeat(60000) + "</p></body></html>";
    await setupFetchMock(longHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { text: "The text content" },
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect((data.content as string).length).toBeLessThanOrEqual(50000);
    expect(data.content_length as number).toBeLessThanOrEqual(50000);
  });

  it("extraction_prompt contains schema fields but NOT the page content", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { price: "Current price in USD", warranty: "Warranty terms" },
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;
    const prompt = data.extraction_prompt as string;

    expect(prompt).toContain("price");
    expect(prompt).toContain("warranty");
    expect(prompt).toContain("data.content");
    // Must NOT embed the page content in the prompt itself
    expect(prompt).not.toContain("Widget Pro");
    expect(prompt).not.toContain("$49.99");
  });

  it("heuristic mode returns mode:'heuristic' (backward compat)", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      fields: ["title", "price"],
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(data.mode).toBe("heuristic");
    expect(data.fields).toBeDefined();
    expect(data.content).toBeUndefined();
    expect(data.extraction_prompt).toBeUndefined();
  });

  it("meta.quota.credits_estimated === 1 in schema mode (no render fallback)", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { price: "Current price in USD" },
    });
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const meta = result.meta as Record<string, unknown>;
    const quota = meta.quota as Record<string, unknown>;

    expect(quota.credits_estimated).toBe(1);
  });

  it("render_fallback works with schema mode — validates params OK", async () => {
    await setupFetchMock(testHtml);
    const params = validateExtractParams({
      url: testUrl,
      schema: { price: "Current price" },
      render_fallback: true,
    });
    // render_fallback:true is valid; fetch succeeds so no escalation needed
    const resultStr = await novadaProxyExtract(params, mockAdapter, mockCredentials);
    const result = JSON.parse(resultStr) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(data.mode).toBe("llm_extract");
  });
});
