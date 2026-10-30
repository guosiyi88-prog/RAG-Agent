/**
 * 增量 SSE 解析器（`06` spec「SSE 消费」/ `10-ui-user.md` §3.2）。
 *
 * 纯字符串逻辑：不碰网络、不碰 DOM、不引用任何宿主全局对象，所以能被 `node:test` 直接喂输入输出。
 * 用 fetch + ReadableStream 的页面只做「读一块 → push → 处理吐出来的帧」，不用 EventSource：
 * 后者带不了 `X-User-Session` 这类自定义头，某些内置浏览器还会把整个流缓冲到结束才显示。
 *
 * 帧格式对齐 `05-api.md` §3.2 的后端序列化：`event: <name>\ndata: <json>\n\n`。
 *
 * 这个文件唯一值得写测试的地方是**帧边界**：一帧被网络拆成两块时，天真实现会把 JSON 切成两半，
 * 页面表现为「答案偶尔缺几个字或整条消失」，且只在弱网下才复现。所以半帧一律留在内部缓冲区里，
 * 下次 push 继续拼。
 */

/** 分帧用空行：`\r\n\r\n` 与 `\n\n` 都算，顺带吃下 `\r\n\n` 这种混排（代理/网关会改写行尾）。 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * 解析一帧的 `event:` / `data:` 行。
 *
 * - **多行 data 支持**：按 SSE 规范把多个 `data:` 行的值用 `\n` 拼接（`data: a` + ` data: b` → `"a\nb"`）。
 *   后端 `serializeFrame` 永远只发一行 data，这里支持多行只是兜底，不让网关拆行时炸掉。
 * - **注释行**（`:` 开头）整行丢弃：那可能是心跳，也可能只是人写的调试标记。
 * - **未知事件名照原样吐出**，不白名单过滤：新增事件名时不该先改解析器。
 * - `id:` / `retry:` 忽略：我们不走 EventSource，也不做它的重连协商。
 * - 只有注释、既无 event 又无 data 的帧返回 null（心跳不该变成一条空事件丢给页面）。
 */
function parseFrame(raw) {
  if (raw === "") return null;

  let event = "";
  let hasEvent = false;
  const dataLines = [];

  for (const line of raw.split(/\r?\n|\r/)) {
    if (line.trim() === "") continue;
    // 吃掉行首空白再判字段名：规范不允许字段名前有空格，但网关重写行尾、或者别处手工拼接
    // 出来的 ` data: b` 很常见，容忍它比丢掉一行数据便宜得多。
    const body = line.replace(/^[ \t]+/, "");
    // 冒号开头 = 注释行。判首字符而不是 includes，避免把 JSON 里的冒号当注释。
    if (body.charCodeAt(0) === 58 /* ":" */) continue;

    const colon = body.indexOf(":");
    const field = colon === -1 ? body : body.slice(0, colon);
    let value = colon === -1 ? "" : body.slice(colon + 1);
    // 规范：冒号后只吃掉**一个**前导空格，其余空格属于数据本身。
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      event = value.trim();
      hasEvent = true;
    }
  }

  if (!hasEvent && dataLines.length === 0) return null;
  return {
    event: hasEvent && event !== "" ? event : "message",
    data: dataLines.join("\n"),
  };
}

/**
 * 新建一个增量解析器。
 * @returns {{ push(chunk: string): Array<{ event: string, data: string }>, reset(): void }}
 */
export function createSseParser() {
  let buffer = "";

  return {
    /**
     * 喂一块文本（网络块的边界可以落在任何位置，包括落在 `\n\n` 中间或 JSON 中间），
     * 返回这一块之后**刚刚凑齐**的完整帧，按到达顺序排列。凑不齐的部分留在缓冲区里。
     */
    push(chunk) {
      if (chunk != null && chunk !== "") buffer += String(chunk);

      const frames = [];
      for (;;) {
        const match = FRAME_SEPARATOR.exec(buffer);
        if (!match) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
      }
      return frames;
    },

    /** 清空缓冲区：换一条流（重试、切会话）时必须调用，否则上一轮半帧会粘到新流的第一帧上。 */
    reset() {
      buffer = "";
    },
  };
}
