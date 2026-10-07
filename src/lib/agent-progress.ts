/** Only this small, structured vocabulary crosses the public log boundary. */
const ACTIVITIES = {
  recognize: "识别题目文字",
  transcribe: "转录题目与公式",
  crop: "裁切原图中的题目插图",
  typeset: "排版题目与答题区",
  generate: "生成 Word 文档",
  check: "核对文字、插图与版面",
  revise: "修正文档",
} as const;

const TAG_SOURCE = String.raw`\[progress:(recognize|transcribe|crop|typeset|generate|check|revise)(?: page=([1-9]\d{0,2}))?(?: question=([1-9]\d{0,2}))?\]`;

export function progressLabel(tag: string): string | undefined {
  const match = new RegExp(`^${TAG_SOURCE}$`).exec(tag);
  if (!match) return undefined;
  const [, activity, page, question] = match;
  const location = [page ? `第 ${page} 张图片` : "", question ? `第 ${question} 题` : ""].filter(Boolean).join(" · ");
  return `正在${ACTIVITIES[activity as keyof typeof ACTIVITIES]}${location ? `（${location}）` : ""}`;
}

/** Snapshots have already been sanitized once; preserve only canonical labels. */
export function isProgressLabel(text: string): boolean {
  return Object.values(ACTIVITIES).some(activity =>
    new RegExp(`^正在${activity}(?:（(?:第 [1-9]\\d{0,2} 张图片(?: · 第 [1-9]\\d{0,2} 题)?|第 [1-9]\\d{0,2} 题)）)?$`).test(text),
  );
}

/** Handles tags split across stream chunks; reports each tag once per message. */
export class AgentProgressReporter {
  private buffer = "";
  private seen = new Set<string>();

  consume(record: Record<string, unknown>, emit: (tag: string) => void): void {
    if (record.type === "message_start") {
      this.buffer = "";
      this.seen.clear();
    }
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (event?.type !== "text_delta" || typeof event.delta !== "string") return;
      this.buffer += event.delta;
    } else if (record.type === "message_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return;
      const content = message.content;
      this.buffer = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(block => block?.type === "text").map(block => block.text ?? "").join("\n") : "";
    } else {
      return;
    }
    for (const match of this.buffer.matchAll(new RegExp(TAG_SOURCE, "g"))) {
      if (this.seen.has(match[0])) continue;
      this.seen.add(match[0]);
      emit(match[0]);
    }
    // Retain enough trailing text for a tag split across chunks.
    this.buffer = this.buffer.slice(-256);
  }
}
