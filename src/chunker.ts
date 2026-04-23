/**
 * Advanced hierarchical semantic chunking strategy.
 *
 * Features:
 * - Parses markdown into hierarchical tree structure
 * - Detects and preserves code blocks (never splits them)
 * - Collects full parent section context
 * - Builds complete breadcrumb paths
 * - Generates semantic chunks with full hierarchy
 */

import { createLogger } from "./logger.ts";

const log = createLogger("chunker");

export interface CodeBlock {
  start: number;              // Character position start
  end: number;                // Character position end
  language: string;           // "ts", "js", "bash", etc
  content: string;            // The code block content
}

export interface TreeNode {
  level: number;              // 1-6 (heading level)
  title: string;              // "Emails"
  content: string;            // Content between this heading and next same/higher level
  children: TreeNode[];       // Child nodes
  parent: TreeNode | null;    // Parent reference
  codeBlocks: CodeBlock[];    // Code blocks in this content
}

export interface SemanticChunk {
  // Content
  content: string;            // Full chunk (parent context + node content)

  // Hierarchy
  title: string;              // "Emails"
  breadcrumb: string;         // "Defining schemas > Strings > Emails"
  level: number;              // Deepest level (4 in this example)

  // Full hierarchy (for database columns)
  h1?: string;                // "Defining schemas"
  h2?: string;                // "Strings"
  h3?: string;                // "String formats"
  h4?: string;                // "Emails"

  // Parent context (full sections)
  parentContext: string;      // Complete content of all parent sections

  // Code metadata
  hasCodeBlock: boolean;
  codeLanguages: string[];    // ["ts", "bash"]
}

/**
 * Detect code blocks in content (``` or ~~~)
 */
function detectCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeRegex = /```([\w]*)\n([\s\S]*?)```|~~~([\w]*)\n([\s\S]*?)~~~/g;

  let match;
  while ((match = codeRegex.exec(content)) !== null) {
    const language = match[1] || match[3] || "text";
    const codeContent = match[2] || match[4] || "";

    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      language: language.toLowerCase(),
      content: codeContent,
    });
  }

  return blocks;
}

/**
 * Check if a character position is inside any code block
 */
function isInCodeBlock(pos: number, codeBlocks: CodeBlock[]): boolean {
  return codeBlocks.some((block) => pos >= block.start && pos <= block.end);
}

/**
 * Parse markdown text into a hierarchical tree structure
 */
function buildMarkdownTree(text: string): TreeNode {
  const root: TreeNode = {
    level: 0,
    title: "Root",
    content: "",
    children: [],
    parent: null,
    codeBlocks: [],
  };

  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let lastIndex = 0;
  let match;
  const headings: Array<{ level: number; title: string; index: number }> = [];

  // Collect all headings with their positions
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({
      level: match[1].length,
      title: match[2].trim(),
      index: match.index,
    });
  }

  // Build tree structure
  const nodeStack: TreeNode[] = [root];

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeadingIndex = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const contentStart = heading.index + text.substring(heading.index).indexOf("\n") + 1;
    const contentEnd = nextHeadingIndex;
    const content = text.substring(contentStart, contentEnd).trim();

    const node: TreeNode = {
      level: heading.level,
      title: heading.title,
      content: content,
      children: [],
      parent: null,
      codeBlocks: detectCodeBlocks(content),
    };

    // Find correct parent based on level
    while (nodeStack.length > 1 && nodeStack[nodeStack.length - 1].level >= heading.level) {
      nodeStack.pop();
    }

    const parent = nodeStack[nodeStack.length - 1];
    node.parent = parent;
    parent.children.push(node);
    nodeStack.push(node);
  }

  return root;
}

/**
 * Collect full parent context (all parent sections from H1 up to current level)
 */
function collectFullParentContext(node: TreeNode): string {
  const contexts: string[] = [];
  let current = node.parent;

  while (current && current.level > 0) {
    // Add heading and content
    const heading = "#".repeat(current.level) + " " + current.title;
    contexts.unshift(`${heading}\n\n${current.content}`);
    current = current.parent;
  }

  return contexts.join("\n\n---\n\n");
}

/**
 * Build breadcrumb path from root to current node
 */
function buildBreadcrumb(node: TreeNode): string {
  const parts: string[] = [];
  let current: TreeNode | null = node;

  while (current && current.level > 0) {
    parts.unshift(current.title);
    current = current.parent;
  }

  return parts.join(" > ");
}

/**
 * Get full hierarchy (h1, h2, h3, h4 from the path)
 */
function getHierarchy(node: TreeNode): { h1?: string; h2?: string; h3?: string; h4?: string } {
  const hierarchy: { h1?: string; h2?: string; h3?: string; h4?: string } = {};
  let current: TreeNode | null = node;

  const path: TreeNode[] = [];
  while (current && current.level > 0) {
    path.unshift(current);
    current = current.parent;
  }

  for (const n of path) {
    if (n.level === 1) hierarchy.h1 = n.title;
    else if (n.level === 2) hierarchy.h2 = n.title;
    else if (n.level === 3) hierarchy.h3 = n.title;
    else if (n.level === 4) hierarchy.h4 = n.title;
  }

  return hierarchy;
}

/**
 * Split content by paragraphs while respecting code block boundaries
 */
function splitContentRespectingCodeBlocks(
  content: string,
  codeBlocks: CodeBlock[],
  maxSize: number
): string[] {
  const segments: string[] = [];
  const paragraphs = content.split(/\n\n+/);

  let currentSegment = "";

  for (const paragraph of paragraphs) {
    // Check if paragraph overlaps with code block
    const paragraphStart = content.indexOf(paragraph);
    const paragraphEnd = paragraphStart + paragraph.length;
    const overlapsCode = codeBlocks.some(
      (block) => !(paragraphEnd < block.start || paragraphStart > block.end)
    );

    // If adding this paragraph would exceed max size and we have content
    if (currentSegment.length + paragraph.length > maxSize && currentSegment.length > 50) {
      segments.push(currentSegment.trim());
      currentSegment = "";
    }

    // Add paragraph to current segment
    if (currentSegment) {
      currentSegment += "\n\n";
    }
    currentSegment += paragraph;

    // If this paragraph overlaps code, force segment end after it
    if (overlapsCode && currentSegment.length > 100) {
      segments.push(currentSegment.trim());
      currentSegment = "";
    }
  }

  // Add final segment
  if (currentSegment.trim().length > 50) {
    segments.push(currentSegment.trim());
  }

  return segments;
}

/**
 * Create chunks from a tree node
 */
function chunkNode(
  node: TreeNode,
  parentContext: string,
  maxSize: number = 1000
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];

  if (node.content.length === 0) {
    return chunks;
  }

  const breadcrumb = buildBreadcrumb(node);
  const hierarchy = getHierarchy(node);
  const nodeHeading = "#".repeat(node.level) + " " + node.title;
  const nodeWithHeading = `${nodeHeading}\n\n${node.content}`;

  // Prepare code languages
  const codeLanguages = [...new Set(node.codeBlocks.map((b) => b.language))];
  const hasCodeBlock = codeLanguages.length > 0;

  // Check total size
  const totalContent = parentContext.length + nodeWithHeading.length;

  if (totalContent < maxSize) {
    // Single chunk
    const fullContent = parentContext
      ? `${parentContext}\n\n---\n\n${nodeWithHeading}`
      : nodeWithHeading;

    chunks.push({
      content: fullContent,
      title: node.title,
      breadcrumb,
      level: node.level,
      h1: hierarchy.h1,
      h2: hierarchy.h2,
      h3: hierarchy.h3,
      h4: hierarchy.h4,
      parentContext: parentContext,
      hasCodeBlock,
      codeLanguages,
    });
  } else {
    // Split into multiple chunks
    const segments = splitContentRespectingCodeBlocks(node.content, node.codeBlocks, maxSize);

    for (let i = 0; i < segments.length; i++) {
      const segmentHeading = i === 0 ? nodeHeading : `${nodeHeading} (part ${i + 1})`;
      const segmentContent = `${segmentHeading}\n\n${segments[i]}`;

      const fullContent = parentContext
        ? `${parentContext}\n\n---\n\n${segmentContent}`
        : segmentContent;

      // Check if this segment has code blocks
      const segmentCodeBlocks = node.codeBlocks.filter(
        (block) => block.content.includes(segments[i]) || segments[i].includes(block.content)
      );

      chunks.push({
        content: fullContent,
        title: node.title + (i > 0 ? ` (${i + 1})` : ""),
        breadcrumb,
        level: node.level,
        h1: hierarchy.h1,
        h2: hierarchy.h2,
        h3: hierarchy.h3,
        h4: hierarchy.h4,
        parentContext: parentContext,
        hasCodeBlock: segmentCodeBlocks.length > 0,
        codeLanguages: segmentCodeBlocks.length > 0
          ? [...new Set(segmentCodeBlocks.map((b) => b.language))]
          : [],
      });
    }
  }

  return chunks;
}

/**
 * Recursively chunk tree nodes
 */
function chunkTreeNodes(node: TreeNode, maxSize: number = 1000): SemanticChunk[] {
  const allChunks: SemanticChunk[] = [];

  // Chunk this node with its parent context
  if (node.level > 0) {
    const parentContext = collectFullParentContext(node);
    const nodeChunks = chunkNode(node, parentContext, maxSize);
    allChunks.push(...nodeChunks);
  }

  // Recursively chunk children
  for (const child of node.children) {
    allChunks.push(...chunkTreeNodes(child, maxSize));
  }

  return allChunks;
}

/**
 * Main export: Chunk text semantically with full hierarchy
 */
export function chunkTextSemantic(text: string, maxSize: number = 1000): SemanticChunk[] {
  log.debug(`chunkTextSemantic: ${text.length} chars | maxSize=${maxSize}`);

  const root = buildMarkdownTree(text);
  log.trace(`chunkTextSemantic: ${text.length} chars → tree built`);

  const chunks = chunkTreeNodes(root, maxSize);
  log.trace(`chunkTextSemantic: ${chunks.length} chunks before filtering`);

  const filtered = chunks.filter((chunk) => {
    const words = chunk.content.split(/\s+/).length;
    return chunk.content.length >= 50 && words >= 5;
  });

  log.debug(`chunkTextSemantic: ${text.length} chars → ${filtered.length} chunks`);
  return filtered;
}

/**
 * Format chunks for LLM context with section headers
 */
export function formatChunksForContext(chunks: SemanticChunk[]): string {
  return chunks
    .map((chunk) => {
      return `# ${chunk.breadcrumb}\n\n${chunk.content}`;
    })
    .join("\n\n---\n\n");
}
