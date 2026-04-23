import { crypto } from "@std/crypto";

/**
 * Content type detection
 */
export type ContentType = "text" | "markdown" | "json" | "yaml";

/**
 * Result of fetching a source
 */
export interface FetchResult {
  content: string;
  checksum: string; // SHA256 hex string
  contentType: ContentType;
  fetchedAt: Date;
}

/**
 * Calculates SHA256 checksum of content
 */
export async function calculateChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Detects content type from URL and content
 */
function detectContentType(url: string, content: string): ContentType {
  // Check URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.endsWith(".md") || urlLower.endsWith(".markdown")) {
    return "markdown";
  }
  if (urlLower.endsWith(".json")) {
    return "json";
  }
  if (urlLower.endsWith(".yaml") || urlLower.endsWith(".yml")) {
    return "yaml";
  }
  if (urlLower.endsWith(".txt")) {
    return "text";
  }

  // Try to detect by content
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON, continue
    }
  }

  // Check for YAML indicators
  if (
    trimmed.includes(":") && !trimmed.includes("http://") &&
    !trimmed.includes("https://")
  ) {
    return "yaml";
  }

  // Check for markdown indicators
  if (
    trimmed.includes("#") ||
    trimmed.includes("```") ||
    trimmed.includes("---") ||
    trimmed.includes("**")
  ) {
    return "markdown";
  }

  // Default to text
  return "text";
}

/**
 * Fetches content from a URL (HTTP) or file path (file://)
 * Supports:
 * - HTTP/HTTPS URLs: https://example.com/docs.txt
 * - Local files: file:///path/to/docs.md
 *
 * @param urlOrPath - HTTP URL or file:// URL
 * @param options - Fetch options
 * @throws Error if fetch fails
 */
export async function fetchSource(
  urlOrPath: string,
  options?: { timeout?: number },
): Promise<FetchResult> {
  const timeout = options?.timeout || 30000;

  let content: string;

  // Handle file:// URLs
  if (urlOrPath.startsWith("file://")) {
    const filePath = urlOrPath.replace("file://", "");
    try {
      content = await Deno.readTextFile(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Local file not found: ${filePath}`);
      }
      throw new Error(
        `Failed to read local file ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    // Handle HTTP/HTTPS URLs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(urlOrPath, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      content = await response.text();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Fetch timeout after ${timeout}ms`);
        }
        throw error;
      }

      throw new Error(`Failed to fetch ${urlOrPath}: ${error}`);
    }
  }

  // Calculate checksum
  const checksum = await calculateChecksum(content);

  // Detect content type
  const contentType = detectContentType(urlOrPath, content);

  return {
    content,
    checksum,
    contentType,
    fetchedAt: new Date(),
  };
}

/**
 * Extracts markdown content from JSON object
 * Looks for 'content', 'text', 'md', 'markdown' fields
 */
export function extractMarkdownFromJSON(jsonContent: string): string {
  try {
    const obj = JSON.parse(jsonContent) as Record<string, unknown>;

    // Try common field names
    for (const fieldName of ["content", "text", "md", "markdown", "body"]) {
      if (fieldName in obj) {
        const value = obj[fieldName];
        if (typeof value === "string") {
          return value;
        }
      }
    }

    // If no content field found, return stringified JSON
    return JSON.stringify(obj, null, 2);
  } catch {
    // Not valid JSON, return as-is
    return jsonContent;
  }
}

/**
 * Processes fetched content based on its type
 * - JSON: Extracts markdown content
 * - YAML: Returns as-is (will be chunked as text)
 * - Markdown: Returns as-is
 * - Text: Returns as-is
 */
export function processContent(
  content: string,
  contentType: ContentType,
): string {
  switch (contentType) {
    case "json":
      return extractMarkdownFromJSON(content);
    case "yaml":
    case "markdown":
    case "text":
    default:
      return content;
  }
}
