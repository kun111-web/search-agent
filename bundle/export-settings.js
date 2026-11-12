// 由 make-bundle.js 用 Electron 子进程调用，stdout 只通过管道交给父进程。
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { portableSettings } = require("./portable-settings");

app.setName("Search Agent");
const file = path.resolve(process.argv[2]);
app.setPath("userData", path.dirname(file));
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const config = portableSettings(parsed, (value) => safeStorage.decryptString(value));
    process.stdout.write(`SEARCH_AGENT_CONFIG:${JSON.stringify(config)}\n`, () => app.exit(0));
  } catch {
    // 不输出异常对象或配置，避免失败日志泄露凭据。
    process.stderr.write("无法导出模型配置，请在当前账户重新保存 Key 后重试。\n", () => app.exit(1));
  }
});
