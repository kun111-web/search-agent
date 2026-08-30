// 全链路统一的"最新到最旧"。采集、排队、筛选输出、入库读取都得用同一把尺子，
// 否则每一环各按自己的插入顺序摆，界面上就会看到批次之间前后颠倒。
//
// ts 是内容自己写的时间，最可靠，但不是每条都有（没有时间的列表条目就是 0）。
// ts 相同或都缺时退到"先后"：运行期看 arrival（同一次采集内递增的到达序号），
// 归档看 savedAt（跨会话仍然单调的入库时刻）。两者都比不出来时，Array.prototype.sort
// 的稳定性会保住原有相对顺序——对没有时间的列表页来说，那正是页面上的先后。

function byNewestFirst(left, right) {
  return (right.ts || 0) - (left.ts || 0) || (right.arrival || 0) - (left.arrival || 0);
}

// 早先入库的档案没有 ts 字段，退用入库时刻。两者同一个量纲，混在一起排得动；要是
// 把缺 ts 的一律当 0，升级之后已有的档案会被后来带时间戳的整批挤到最底下去。入库
// 时刻总比内容时间晚一点，代价是这些老条目会稍微偏前，比整块沉底好得多。
function archivedStamp(item) {
  return Number(item.ts) || Date.parse(item.savedAt) || 0;
}

function byArchivedNewestFirst(left, right) {
  return archivedStamp(right) - archivedStamp(left);
}

module.exports = { byNewestFirst, byArchivedNewestFirst };
