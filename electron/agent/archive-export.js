const CSV_COLUMNS = [
  ["date", "日期"],
  ["time", "时间"],
  ["title", "标题"],
  ["summary", "摘要"],
  ["raw", "采集原文"],
  ["match", "命中理由"],
  ["source", "来源"],
  ["requirement", "筛选要求"],
  ["pageUrl", "来源页面"],
  ["savedAt", "入库时间"],
];

const FORMATS = new Set(["md", "csv", "json"]);

function pad(value) {
  return String(value).padStart(2, "0");
}

function localStamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function text(value) {
  return String(value ?? "");
}

// 标题这类要进单行结构的字段，换行会把 Markdown 的层级冲掉。
function flatten(value) {
  return text(value).replace(/\s*\r?\n\s*/g, " ").trim();
}

// 入库时间在文件里存的是 ISO（UTC）。给人看的 md / csv 要换成本地时间，
// 不然东八区导出来的时间会比实际早 8 小时；json 留原值给程序用。
function localTime(value) {
  const raw = text(value);
  if (!raw) {
    return "";
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : localStamp(parsed);
}

function countItems(days) {
  return days.reduce((sum, day) => sum + day.items.length, 0);
}

// Excel 会把以 = + - @ 开头的单元格当公式执行。这里的内容来自网页正文和模型
// 输出，等于把外部数据直接喂给公式引擎，先加个前导单引号把它变回文本。
function neutralize(value) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value) {
  const cell = neutralize(text(value));
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function cellValue(key, item, day) {
  if (key === "date") {
    return day.date;
  }
  if (key === "savedAt") {
    return localTime(item.savedAt);
  }
  return item[key];
}

function toCsv(days) {
  const rows = [CSV_COLUMNS.map(([, label]) => label).join(",")];
  for (const day of days) {
    for (const item of day.items) {
      rows.push(CSV_COLUMNS.map(([key]) => csvCell(cellValue(key, item, day))).join(","));
    }
  }
  // Excel 只在有 BOM 时才按 UTF-8 解析 CSV，缺了它中文会变乱码。
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function quoteBlock(value) {
  return text(value)
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function markdownItem(item, index) {
  const lines = [`### ${index}. ${flatten(item.title) || "未命名"}`, ""];
  const facts = [
    ["时间", flatten(item.time)],
    ["来源", flatten(item.source)],
    ["命中理由", flatten(item.match)],
    ["筛选要求", flatten(item.requirement)],
    ["来源页面", flatten(item.pageUrl)],
    ["入库时间", localTime(item.savedAt)],
  ].filter(([, value]) => value);
  if (facts.length) {
    lines.push(...facts.map(([label, value]) => `- ${label}：${value}`), "");
  }

  const summary = text(item.summary).trim();
  if (summary) {
    lines.push(summary, "");
  }
  // 摘要是模型转述的，原文才是采到的原话，一样时不必占两遍位置。
  // 旧归档里没有 raw 字段，那时的原文没被保存下来，只能不输出这一块。
  const raw = text(item.raw).trim();
  if (raw && raw !== summary) {
    lines.push(quoteBlock(raw), "");
  }
  return lines;
}

function toMarkdown(days, meta) {
  const lines = [
    "# 采集归档",
    "",
    `- 导出时间：${meta.exportedAt}`,
    `- 范围：${meta.scope}`,
    `- 共 ${days.length} 天、${countItems(days)} 篇`,
    "",
  ];
  for (const day of days) {
    lines.push("---", "", `## ${day.date} · ${day.items.length} 篇`, "");
    day.items.forEach((item, index) => {
      lines.push(...markdownItem(item, index + 1));
    });
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function toJson(days, meta) {
  return `${JSON.stringify(
    {
      exportedAt: meta.exportedAt,
      scope: meta.scope,
      dayCount: days.length,
      itemCount: countItems(days),
      days,
    },
    null,
    2,
  )}\n`;
}

/** 把归档序列化成给人看（md）、给表格用（csv）或给程序用（json）的文本。 */
function buildExport({ days, format, scope, now }) {
  const safeDays = (Array.isArray(days) ? days : []).filter((day) => day && Array.isArray(day.items));
  const meta = { exportedAt: localStamp(now), scope: scope || "全部" };
  const itemCount = countItems(safeDays);

  if (format === "csv") {
    return { content: toCsv(safeDays), itemCount, dayCount: safeDays.length };
  }
  if (format === "json") {
    return { content: toJson(safeDays, meta), itemCount, dayCount: safeDays.length };
  }
  return { content: toMarkdown(safeDays, meta), itemCount, dayCount: safeDays.length };
}

function formatFromPath(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filePath || ""));
  const ext = match ? match[1].toLowerCase() : "";
  return FORMATS.has(ext) ? ext : "md";
}

module.exports = {
  buildExport,
  formatFromPath,
  localStamp,
};
