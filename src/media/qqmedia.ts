export interface QqMediaSegment {
  type: "text" | "image" | "video";
  content: string;
}

const DEFAULT_QQIMG_CLOSE_VARIANTS = ["qqimg", "img"];
const DEFAULT_QQVIDEO_CLOSE_VARIANTS = ["qqvideo", "video"];

interface ParseQqMediaOptions {
  imageCloseVariants?: string[];
  videoCloseVariants?: string[];
}

interface TagMatch {
  type: "image" | "video";
  index: number;
  end: number;
  content: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeVariants(values: string[] | undefined, fallback: string[]): string[] {
  const fromInput = Array.isArray(values)
    ? values.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return fromInput.length > 0 ? fromInput : fallback;
}

function buildTagRegex(openTag: string, closeVariants: string[]): RegExp {
  const pattern = closeVariants.map((v) => escapeRegExp(v)).join("|");
  return new RegExp(`<${escapeRegExp(openTag)}>([^<>]+)<\\/(?:${pattern})>`, "gi");
}

function collectTagMatches(
  text: string,
  type: "image" | "video",
  openTag: string,
  closeVariants: string[],
): TagMatch[] {
  const regex = buildTagRegex(openTag, closeVariants);
  const output: TagMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const content = String(match[1] || "").trim();
    if (!content) continue;
    output.push({
      type,
      index: match.index,
      end: match.index + match[0].length,
      content,
    });
  }
  return output;
}

function normalizeTextPart(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseQqMediaSegments(rawText: string, options: ParseQqMediaOptions = {}): QqMediaSegment[] {
  const text = String(rawText ?? "");
  if (!text.trim()) return [];

  const imageCloseVariants = sanitizeVariants(options.imageCloseVariants, DEFAULT_QQIMG_CLOSE_VARIANTS);
  const videoCloseVariants = sanitizeVariants(options.videoCloseVariants, DEFAULT_QQVIDEO_CLOSE_VARIANTS);

  const imageMatches = collectTagMatches(text, "image", "qqimg", imageCloseVariants);
  const videoMatches = collectTagMatches(text, "video", "qqvideo", videoCloseVariants);
  const allMatches = [...imageMatches, ...videoMatches].sort((a, b) => a.index - b.index || a.end - b.end);

  if (allMatches.length === 0) {
    const onlyText = normalizeTextPart(text);
    if (!onlyText) return [];
    return [{ type: "text", content: onlyText }];
  }

  const output: QqMediaSegment[] = [];
  let cursor = 0;

  for (const item of allMatches) {
    if (item.index < cursor) continue;
    const before = normalizeTextPart(text.slice(cursor, item.index));
    if (before) output.push({ type: "text", content: before });
    output.push({ type: item.type, content: item.content });
    cursor = item.end;
  }

  const tail = normalizeTextPart(text.slice(cursor));
  if (tail) output.push({ type: "text", content: tail });
  return output;
}
