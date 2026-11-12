// 分发格式需要可移植的 Key；账户绑定的 enc:v1 密文不能原样带到另一台电脑。
function portableSettings(settings, decrypt) {
  const next = { ...settings };
  for (const field of ["apiKey", "fallbackApiKey"]) {
    const value = String(next[field] || "");
    if (!value.startsWith("enc:v1:")) continue;
    let decoded;
    try {
      decoded = decrypt(Buffer.from(value.slice("enc:v1:".length), "base64"));
    } catch {
      throw new Error(`${field === "apiKey" ? "主模型" : "备用模型"} Key 无法在当前账户解密，请重新保存配置后再生成分发包`);
    }
    if (typeof decoded !== "string" || !decoded.trim() || decoded.startsWith("enc:v1:")) {
      throw new Error("Key 解密结果无效，未生成分发配置");
    }
    next[field] = decoded;
  }
  return next;
}

module.exports = { portableSettings };
