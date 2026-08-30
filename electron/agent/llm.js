const REQUEST_TIMEOUT_MS = 60000;

// 调用方要分得清"网断了，等会儿再来"和"Key 填错了，重试一万次也是错"：前者该一直
// 重连，后者该立刻换备用模型或停下来喊人。kind 就是这个用途。
//   network   连不上、超时、对面 5xx —— 等等再来
//   rate      429，也是等等再来，但得等久点
//   auth      401/403，Key 不对
//   model     400/404，模型名不对或请求体不合这家的口味
//   response  连上了也答了，但答的不是能用的 JSON
function fail(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function kindFromStatus(status) {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate";
  }
  if (status >= 500) {
    return "network";
  }
  return "model";
}

// 两种接口格式。chat 是 /chat/completions 那套老规矩，用 messages 进、choices 出；
// responses 是后来那套，用 input 进、output 数组出，系统提示挪到了 instructions。
// 哪家用哪套由设置里选，主备各选各的——两家往往不是同一套。
const FORMATS = new Set(["chat", "responses"]);
const DEFAULT_FORMAT = "chat";

function formatOf(settings) {
  const wanted = String(settings?.apiFormat || "").trim();
  return FORMATS.has(wanted) ? wanted : DEFAULT_FORMAT;
}

// 地址里已经带着完整路径的就别再接一遍。有人习惯把整条 URL 填进去，也有人只填到 /v1。
function endpointUrl(baseUrl, format) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("请先填写 API Base URL");
  }
  const suffix = format === "responses" ? "/responses" : "/chat/completions";
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

function requestBody({ settings, messages, format }) {
  if (format === "responses") {
    // 系统提示在这套格式里叫 instructions，不再是 messages 里的一条。
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));
    return {
      model: settings.model,
      instructions,
      input,
      temperature: 0.2,
      // 这套格式默认把每一轮都存在服务端。我们不用那个状态，也没理由把采到的内容
      // 留在别人机器上。
      store: false,
    };
  }
  return {
    model: settings.model,
    temperature: 0.2,
    messages,
    // 筛选是分类任务，思维链会把一批 8 条拖到 45 秒、逼近超时线，实测关掉后不仅快
    // 7 倍，判定反而更稳定。MiMo 与 DeepSeek 都认这个字段。它是这两家的私有约定，
    // 所以只在 chat 这套里带——responses 那套换了别的写法，硬塞会被判 400。
    thinking: { type: "disabled" },
  };
}

// responses 这套的正文埋在 output 数组里。官方明确说过不保证在 output[0].content[0]：
// 那个数组里还会混着 reasoning、工具调用这些项，位置不固定，所以得遍历着找。
// 顶层的 output_text 是各家 SDK 的便捷属性、不在原始 JSON 里，但不少兼容实现会顺手
// 给一个，有就先用它。
function replyText(payload, format) {
  if (format !== "responses") {
    return payload.choices?.[0]?.message?.content || "";
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const parts = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function completeJson({ settings, messages, signal }) {
  if (!settings.apiKey) {
    throw fail("auth", "请先在设置里填写 API Key");
  }

  // 没有超时的话，一次卡住的请求会让整个筛选队列永远停在那里。
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const format = formatOf(settings);
  let response;
  try {
    response = await fetch(endpointUrl(settings.baseUrl, format), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody({ settings, messages, format })),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    // 主动取消（点了停止、换了一批）不是故障，原样往上抛，别被当成网络问题去重试。
    if (error.name === "AbortError" && signal?.aborted) {
      throw error;
    }
    if (error.name === "TimeoutError") {
      throw fail("network", `模型请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应）`);
    }
    // fetch 连不上时抛的是 TypeError，真正的原因埋在 cause 里
    throw fail("network", `连不上模型接口：${error.cause?.message || error.message}`);
  }

  // 响应头到了不等于内容能拿全。读 body 期间断网、代理掐流、超时到点，或者对面网关
  // 吐了一页 HTML，都会在这儿抛。这些是"那头或路上的毛病"，跟"模型答得不成样子"是
  // 两回事：后者不切备用也不重试，要是把断流也归进去，网抖几次就把筛选永久停了。
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (error.name === "AbortError" && signal?.aborted) {
      throw error;
    }
    if (!response.ok) {
      throw fail(kindFromStatus(response.status), `模型请求失败：HTTP ${response.status}`);
    }
    if (error.name === "TimeoutError") {
      throw fail("network", `模型响应读到一半超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    }
    throw fail("network", `模型响应没读完整：${error.cause?.message || error.message}`);
  }

  if (!response.ok) {
    const detail = payload.error?.message || payload.message || `HTTP ${response.status}`;
    throw fail(kindFromStatus(response.status), `模型请求失败：${detail}`);
  }

  const text = replyText(payload, format);
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw fail("response", `模型没有返回可用 JSON：${text.slice(0, 240)}`);
  }
  return { data: parsed, usage: payload.usage || null };
}

// 用量字段有三种叫法要认：chat 那套叫 prompt/completion_tokens，responses 那套改叫
// input/output_tokens；缓存命中 DeepSeek 直接给 prompt_cache_hit_tokens，另两家塞在
// xxx_tokens_details 里。
function describeUsage(usage) {
  if (!usage) {
    return "";
  }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const cached =
    Number(
      usage.prompt_cache_hit_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens,
    ) || 0;
  if (!prompt && !completion) {
    return "";
  }
  const total = `${prompt + completion} token`;
  return cached ? `${total}（前缀缓存 ${cached}）` : total;
}

async function testConnection(settings) {
  const { data } = await completeJson({
    settings,
    messages: [
      { role: "system", content: '只返回 JSON：{"ok":true}' },
      { role: "user", content: "ping" },
    ],
  });
  return Boolean(data.ok || data.action || data.thought);
}

module.exports = {
  completeJson,
  describeUsage,
  testConnection,
  modelError: fail,
};
