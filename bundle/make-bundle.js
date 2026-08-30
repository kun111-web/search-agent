// 组装桌面上的分发包：安装程序，加一个双击就能把本机配置搬到另一台机器的脚本。
// 脚本里的配置是跑这条命令时本机的当前配置，所以换了 Key 之后要再跑一次。
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SETUP = path.join(ROOT, "dist", "Search Agent Setup.exe");
const TEMPLATE = path.join(__dirname, "import-config.ps1.template");
const LAUNCHER = path.join(__dirname, "一键导入配置.cmd");
const SETTINGS = path.join(process.env.APPDATA, "Search Agent", "agent-settings.json");
const OUT = path.join(process.env.USERPROFILE, "Desktop", "Search Agent 分发包");

function die(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(SETUP)) {
    die(`没找到安装包 ${SETUP}\n先跑 npm run dist。`);
  }
  if (!fs.existsSync(SETTINGS)) {
    die(`本机还没有配置文件 ${SETTINGS}\n先打开程序、在设置里填好 Key 保存一次。`);
  }

  const config = fs.readFileSync(SETTINGS, "utf8").trim();
  // 配置是塞进 PowerShell 的单引号 here-string 里的，行首出现 '@ 会把脚本截断
  if (/^\s*'@/m.test(config)) {
    die("配置内容里有会把脚本截断的字符，先看看 agent-settings.json 是不是坏了。");
  }
  const parsed = JSON.parse(config);

  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(SETUP, path.join(OUT, "Search Agent Setup.exe"));
  fs.copyFileSync(LAUNCHER, path.join(OUT, path.basename(LAUNCHER)));

  // Windows PowerShell 5.1 读没有 BOM 的 UTF-8 会按 ANSI 解，中文会烂掉，所以补上 BOM
  const script = fs.readFileSync(TEMPLATE, "utf8").replace("__CONFIG_JSON__", config);
  fs.writeFileSync(path.join(OUT, "import-config.ps1"), `\uFEFF${script}`, "utf8");

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  console.log(`分发包已生成：${OUT}`);
  for (const name of fs.readdirSync(OUT)) {
    const size = fs.statSync(path.join(OUT, name)).size;
    console.log(`  ${name}  ${size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${size} 字节`}`);
  }
  const keyOf = (key) => (key ? `Key ${key.length} 位` : "没有 Key");
  console.log(`装的是 ${version}。`);
  console.log(`  主模型  ${parsed.model} / ${keyOf(parsed.apiKey)}`);
  // 备用模型没带 Key 等于没有备用：主模型断线时白试一次，还会把"两家都不行"的计数推上去
  console.log(`  备用    ${parsed.fallbackModel || "没配"} / ${keyOf(parsed.fallbackApiKey)}`);
  if (parsed.fallbackModel && !parsed.fallbackApiKey) {
    console.log("  备用模型没带 Key，装到别的机器上主模型断了不会自动顶上。");
  }
  if (parsed.apiKey || parsed.fallbackApiKey) {
    console.log("脚本里是明文 Key，这个文件夹别整个发给不该看到 Key 的人。");
  }
}

main();
