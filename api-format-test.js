// 两种接口格式各打一遍真实 HTTP，看请求体和解析对不对。
// 起一个本地服务假装模型：既验证我们发出去的形状，也验证我们认不认它回的形状。
const http = require("node:http");

const { completeJson, describeUsage } = require("./electron/agent/llm");
const { ModelPool } = require("./electron/agent/model-pool");

let pass = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

// 记下每个进来的请求，测试结束后逐条比对
const seen = [];

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        seen.push({ url: req.url, body: parsed, auth: req.headers.authorization });
        const reply = handler(req.url, parsed);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const MESSAGES = [
  { role: "system", content: "只返回 JSON" },
  { role: "user", content: "第一条" },
];

async function run() {
  console.log("\n【一】chat 格式：老路子不能被改坏");
  const chatServer = await startServer(() => ({
    status: 200,
    payload: {
      choices: [{ message: { content: '{"keep":true}' } }],
      usage: { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 20 },
    },
  }));
  const chatBase = `http://127.0.0.1:${chatServer.address().port}/v1`;

  const chatOut = await completeJson({
    settings: { baseUrl: chatBase, model: "m-chat", apiKey: "k1", apiFormat: "chat" },
    messages: MESSAGES,
  });
  const chatReq = seen.at(-1);
  check("chat 打到 /chat/completions", chatReq.url === "/v1/chat/completions", chatReq.url);
  check("chat 用 messages 传内容", Array.isArray(chatReq.body.messages) && chatReq.body.messages.length === 2);
  check("chat 保留关思考的私有字段", chatReq.body.thinking?.type === "disabled");
  check("chat 不该冒出 input 字段", chatReq.body.input === undefined);
  check("chat 解析出 JSON", chatOut.data.keep === true);
  check("带上 Bearer", chatReq.auth === "Bearer k1", chatReq.auth);

  console.log("\n【二】responses 格式：换路子、换请求体、换解析");
  const respServer = await startServer(() => ({
    status: 200,
    payload: {
      output: [
        // 真实响应里前面常垫着 reasoning 项，正文不在 output[0]
        { id: "rs_1", type: "reasoning", content: [], summary: [] },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", annotations: [], text: '{"keep":false,"why":"不相关"}' }],
        },
      ],
      usage: { input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 25 } },
    },
  }));
  const respBase = `http://127.0.0.1:${respServer.address().port}/v1`;

  const respOut = await completeJson({
    settings: { baseUrl: respBase, model: "m-resp", apiKey: "k2", apiFormat: "responses" },
    messages: MESSAGES,
  });
  const respReq = seen.at(-1);
  check("responses 打到 /responses", respReq.url === "/v1/responses", respReq.url);
  check("系统提示挪进 instructions", respReq.body.instructions === "只返回 JSON", respReq.body.instructions);
  check("其余内容进 input", respReq.body.input?.[0]?.content === "第一条");
  check("input 里不再带 system", !respReq.body.input?.some((item) => item.role === "system"));
  check("responses 不该带 messages", respReq.body.messages === undefined);
  check("关掉服务端存档 store:false", respReq.body.store === false);
  check("不塞 chat 那套的私有字段", respReq.body.thinking === undefined);
  check("越过 reasoning 项取到正文", respOut.data.keep === false && respOut.data.why === "不相关");

  console.log("\n【三】兼容实现给了顶层 output_text");
  const flatServer = await startServer(() => ({
    status: 200,
    payload: { output_text: '{"keep":true}', output: [] },
  }));
  const flatOut = await completeJson({
    settings: {
      baseUrl: `http://127.0.0.1:${flatServer.address().port}/v1`,
      model: "m",
      apiKey: "k",
      apiFormat: "responses",
    },
    messages: MESSAGES,
  });
  check("顶层 output_text 也认", flatOut.data.keep === true);

  console.log("\n【四】地址已带全路径就不该再接一遍");
  const dupOut = await completeJson({
    settings: {
      baseUrl: `http://127.0.0.1:${respServer.address().port}/v1/responses`,
      model: "m",
      apiKey: "k",
      apiFormat: "responses",
    },
    messages: MESSAGES,
  });
  check("不重复拼 /responses", seen.at(-1).url === "/v1/responses", seen.at(-1).url);
  check("重复拼检查后仍能解析", dupOut.data.keep === false);

  console.log("\n【五】格式填错、没填，退回 chat");
  await completeJson({
    settings: { baseUrl: chatBase, model: "m", apiKey: "k", apiFormat: "乱填的" },
    messages: MESSAGES,
  });
  check("非法格式退回 chat", seen.at(-1).url === "/v1/chat/completions", seen.at(-1).url);
  await completeJson({
    settings: { baseUrl: chatBase, model: "m", apiKey: "k" },
    messages: MESSAGES,
  });
  check("没填格式退回 chat", seen.at(-1).url === "/v1/chat/completions", seen.at(-1).url);

  console.log("\n【六】responses 那套没答出正文时，得报错而不是崩");
  const emptyServer = await startServer(() => ({
    status: 200,
    payload: { output: [{ type: "reasoning", content: [] }] },
  }));
  let emptyError = null;
  try {
    await completeJson({
      settings: {
        baseUrl: `http://127.0.0.1:${emptyServer.address().port}/v1`,
        model: "m",
        apiKey: "k",
        apiFormat: "responses",
      },
      messages: MESSAGES,
    });
  } catch (error) {
    emptyError = error;
  }
  check("只有 reasoning 时报 response 类错误", emptyError?.kind === "response", emptyError?.message);
  let brokenShape = null;
  try {
    await completeJson({
      settings: { baseUrl: chatBase, model: "m", apiKey: "k", apiFormat: "responses" },
      messages: MESSAGES,
    });
  } catch (error) {
    brokenShape = error;
  }
  check(
    "拿 chat 的响应按 responses 解，不崩只报错",
    brokenShape?.kind === "response",
    brokenShape?.message,
  );

  console.log("\n【七】主备各用各的格式");
  const notes = [];
  const pool = new ModelPool(
    {
      baseUrl: `http://127.0.0.1:${chatServer.address().port}/v1`,
      model: "主",
      apiKey: "k1",
      apiFormat: "chat",
      fallbackBaseUrl: respBase,
      fallbackModel: "备",
      fallbackApiKey: "k2",
      fallbackApiFormat: "responses",
    },
    (message) => notes.push(message),
  );
  check("两家都算候选", pool.candidates.length === 2);
  check("主模型带的是 chat", pool.candidates[0].settings.apiFormat === "chat");
  check("备用带的是 responses", pool.candidates[1].settings.apiFormat === "responses");
  const poolOut = await pool.complete({ messages: MESSAGES });
  check("走主模型的 chat 路子", seen.at(-1).url === "/v1/chat/completions", seen.at(-1).url);
  check("池子里也解析得出", poolOut.data.keep === true);

  console.log("\n【八】主模型断了，备用按自己的格式顶上");
  const deadServer = await startServer(() => ({ status: 500, payload: { error: { message: "炸了" } } }));
  const deadPool = new ModelPool(
    {
      baseUrl: `http://127.0.0.1:${deadServer.address().port}/v1`,
      model: "坏的",
      apiKey: "k1",
      apiFormat: "chat",
      fallbackBaseUrl: respBase,
      fallbackModel: "备",
      fallbackApiKey: "k2",
      fallbackApiFormat: "responses",
    },
    () => {},
  );
  const failover = await deadPool.complete({ messages: MESSAGES });
  check("顶上来的是 responses 那条路", seen.at(-1).url === "/v1/responses", seen.at(-1).url);
  check("顶上来之后解析正常", failover.data.keep === false);
  check("首选粘在备用上", deadPool.index === 1);

  console.log("\n【九】地址、模型、Key 缺一样就不算候选");
  const onlyKey = new ModelPool({ apiKey: "k", baseUrl: "", model: "" }, () => {});
  check("只有 Key 不算配好", !onlyKey.hasKey());
  const noModel = new ModelPool({ apiKey: "k", baseUrl: "http://x/v1", model: "  " }, () => {});
  check("模型名是空格也不算", !noModel.hasKey());
  const skipMain = new ModelPool(
    {
      baseUrl: "",
      model: "",
      apiKey: "k1",
      fallbackBaseUrl: respBase,
      fallbackModel: "备",
      fallbackApiKey: "k2",
      fallbackApiFormat: "responses",
    },
    () => {},
  );
  check("主模型没填全时备用直接当首选", skipMain.candidates.length === 1 && skipMain.candidates[0].role === "备用模型");
  const skipOut = await skipMain.complete({ messages: MESSAGES });
  check("不去撞主模型那个空地址", seen.at(-1).url === "/v1/responses", seen.at(-1).url);
  check("备用独自也能出结果", skipOut.data.keep === false);
  let emptyPool = null;
  try {
    await new ModelPool({}, () => {}).complete({ messages: MESSAGES });
  } catch (error) {
    emptyPool = error;
  }
  check("全空时提示填齐三样", emptyPool?.kind === "auth" && /地址/.test(emptyPool.message), emptyPool?.message);

  console.log("\n【十】两种格式的用量都要认");
  check(
    "chat 的用量",
    describeUsage({ prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 20 }) ===
      "40 token（前缀缓存 20）",
    describeUsage({ prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 20 }),
  );
  check(
    "responses 的用量",
    describeUsage({ input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 25 } }) ===
      "52 token（前缀缓存 25）",
    describeUsage({ input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 25 } }),
  );
  check("没有用量就不显示", describeUsage(null) === "");

  // 关完再退。close 是异步的，没等它就 process.exit 会把 libuv 的断言撞出来。
  await Promise.all(
    [chatServer, respServer, flatServer, emptyServer, deadServer].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );

  console.log(`\n${failures.length ? "有问题" : "全过"}：${pass} 项通过，${failures.length} 项失败`);
  for (const item of failures) {
    console.log(`  - ${item}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
