const fs = require("node:fs");
const path = require("node:path");

/**
 * 覆盖写整份文件。直接 writeFileSync 的话，写到一半断电或崩溃就会留下半份内容，
 * 而归档、判定缓存这些都是整份 JSON，坏一个字节等于整份读不回来。先写临时文件再
 * 改名，改名在同一分区上是原子的：要么还是旧的那份，要么已经是完整的新那份。
 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

module.exports = { writeFileAtomic };
