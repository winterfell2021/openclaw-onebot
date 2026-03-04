export interface QqimgSegment {
  type: "text" | "image";
  content: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQqimgRegex(closeVariants: string[]): RegExp {
  const variants = closeVariants.length > 0 ? closeVariants : ["qqimg", "img"];
  const pattern = variants.map((v) => escapeRegExp(v)).join("|");
  return new RegExp(`<qqimg>([^<>]+)<\\/(?:${pattern})>`, "gi");
}

export function parseQqimgSegments(
  rawText: string,
  closeVariants: string[] = ["qqimg", "img"],
): QqimgSegment[] {
  const text = String(rawText ?? "");
  if (!text.trim()) return [];

  const regex = buildQqimgRegex(closeVariants);
  const output: QqimgSegment[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
    if (before) {
      output.push({ type: "text", content: before });
    }

    const image = String(match[1] || "").trim();
    if (image) {
      output.push({ type: "image", content: image });
    }

    lastIndex = match.index + match[0].length;
  }

  const tail = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
  if (tail) {
    output.push({ type: "text", content: tail });
  }

  return output;
}
