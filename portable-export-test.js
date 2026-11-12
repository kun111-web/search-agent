// node .portable-export-test.js — real safeStorage export using throwaway keys/profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
if (process.versions.electron) {
  // Normal shutdown persists the new profile's encryption metadata before another process reads it.
  const { app, safeStorage } = require("electron");
  app.setName("Search Agent");
  app.setPath("userData", process.argv[2]);
  app.disableHardwareAcceleration();
  app.whenReady().then(() => {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    fs.writeFileSync(path.join(process.argv[2], "agent-settings.json"), JSON.stringify({
      model: "test-model", apiFormat: "chat",
      apiKey: "enc:v1:" + safeStorage.encryptString("test-main-not-a-real-key").toString("base64"),
      fallbackApiKey: "enc:v1:" + safeStorage.encryptString("test-fallback-not-a-real-key").toString("base64"),
    }));
    app.quit();
  }).catch(() => app.exit(1));
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portable-settings-test-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = { encoding: "utf8", windowsHide: true, timeout: 30000, env,
    stdio: ["ignore", "pipe", "pipe"] };
  execFileSync(require("electron"), [__filename, directory], options);
  const file = path.join(directory, "agent-settings.json");
  const original = fs.readFileSync(file, "utf8");
  const output = execFileSync(require("electron"), [path.join(__dirname, "bundle/export-settings.js"), file], options);
  const line = output.split(/\r?\n/).find(value => value.startsWith("SEARCH_AGENT_CONFIG:"));
  const decoded = JSON.parse(line.slice("SEARCH_AGENT_CONFIG:".length));
  assert.equal(decoded.apiKey, "test-main-not-a-real-key");
  assert.equal(decoded.fallbackApiKey, "test-fallback-not-a-real-key");
  assert.equal(decoded.model, "test-model");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  console.log("通过 safeStorage 主备 Key 跨进程导出，原始密文配置未被修改");
}
