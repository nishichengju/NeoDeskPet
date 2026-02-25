export function stripToolProtocolDisplayArtifacts(text: string): string {
  let out = String(text ?? '')
  if (!out) return ''

  out = out.replace(/<<<\[\s*TOOL_(REQUEST|RESULT)\s*\]>>>[\s\S]*?<<<\[\s*END_TOOL_\1\s*\]>>>/gi, '')
  out = out.replace(/<<<\[\s*END_TOOL_(?:REQUEST|RESULT)\s*\]>{0,3}/gi, '')
  // 有些流式分段会只残留一行裸 `<<<` 或 `<<<[TOO...`（协议头被切断）；这类行一律视为协议残片清掉。
  out = out.replace(/(?:^|\r?\n)[ \t]*<<<(?:\[[^\r\n]*)?[ \t]*(?=\r?\n|$)/g, '')

  // 流式中断/截断时，起始标记可能只输出到 `>>`、`]`，甚至停在 `TOOL_` 中间；一律从该处截断显示文本。
  const dangling = out.search(/<<<\[\s*TOOL_/i)
  if (dangling >= 0) out = out.slice(0, dangling)

  // 更极端的截断：只剩下 `<<<` / `<<<[` 且不带 TOOL_，同样从该残片开始截断。
  const bareDangling = out.search(/<<<(?:\[[^\r\n]*)?$/)
  if (bareDangling >= 0) out = out.slice(0, bareDangling)

  return out
}
