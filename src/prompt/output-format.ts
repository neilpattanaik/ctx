import type { OutputFormat } from "../types";

export interface PromptFormatSection {
  key: string;
  body: string;
  title?: string;
}

export interface PromptFormatOptions {
  includeMarkers?: boolean;
  includeXmlDeclaration?: boolean;
  includeEmptySections?: boolean;
}

const XML_TAG_FALLBACK = "section";

function normalizeSectionKey(key: string): string {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized.length === 0) {
    return XML_TAG_FALLBACK;
  }

  if (/^[0-9]/.test(normalized)) {
    return `${XML_TAG_FALLBACK}_${normalized}`;
  }

  return normalized;
}

function sectionTitleFromKey(key: string): string {
  const cleaned = key.trim().replace(/[_-]+/g, " ");
  if (cleaned.length === 0) {
    return "Section";
  }

  return cleaned
    .split(/\s+/)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function escapeCdata(text: string): string {
  return text.replaceAll("]]>", "]]]]><![CDATA[>");
}

function normalizeSections(
  sections: readonly PromptFormatSection[],
  includeEmptySections: boolean,
): Array<{ tag: string; title: string; body: string }> {
  return sections
    .map((section) => ({
      tag: normalizeSectionKey(section.key),
      title:
        section.title && section.title.trim().length > 0
          ? section.title.trim()
          : sectionTitleFromKey(section.key),
      body: section.body,
    }))
    .filter((section) => includeEmptySections || section.body.trim().length > 0);
}

function renderMarkdownXmlTags(
  sections: readonly { tag: string; body: string }[],
  options: PromptFormatOptions,
): string {
  const parts: string[] = [];
  if (options.includeMarkers ?? true) {
    parts.push("<!-- CTX:BEGIN -->");
  }

  for (const section of sections) {
    parts.push(`<${section.tag}>`);
    parts.push(section.body);
    parts.push(`</${section.tag}>`);
  }

  if (options.includeMarkers ?? true) {
    parts.push("<!-- CTX:END -->");
  }

  return parts.join("\n");
}

function renderMarkdownSections(
  sections: readonly { title: string; body: string }[],
): string {
  return sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
}

function renderPlainSections(
  sections: readonly { title: string; body: string }[],
): string {
  return sections.map((section) => `${section.title}:\n${section.body}`).join("\n\n");
}

function renderXmlDocument(
  sections: readonly { tag: string; body: string }[],
  options: PromptFormatOptions,
): string {
  const parts: string[] = [];
  if (options.includeXmlDeclaration ?? true) {
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  }
  parts.push("<ctx_prompt>");
  for (const section of sections) {
    parts.push(`  <${section.tag}><![CDATA[${escapeCdata(section.body)}]]></${section.tag}>`);
  }
  parts.push("</ctx_prompt>");
  return parts.join("\n");
}

export function formatPromptOutput(
  format: OutputFormat,
  sections: readonly PromptFormatSection[],
  options: PromptFormatOptions = {},
): string {
  const normalized = normalizeSections(sections, options.includeEmptySections ?? false);

  switch (format) {
    case "markdown+xmltags":
      return renderMarkdownXmlTags(normalized, options);
    case "markdown":
      return renderMarkdownSections(normalized);
    case "plain":
      return renderPlainSections(normalized);
    case "xml":
      return renderXmlDocument(normalized, options);
    default: {
      const neverValue: never = format;
      throw new Error(`Unsupported output format: ${neverValue}`);
    }
  }
}
