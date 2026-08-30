// 开程序默认要盯的那几个站。两处用到它：会话是空的时候按这份列表把标签页摆好；
// 采集面板拿它把勾选默认勾上，开了程序直接点「开始采集」就行。
//
// 顺序有意义：采集面板按这个顺序勾，界面上的块序也跟着它走。
//
// 这里故意是空的：盯哪些站是各人自己的事，不跟着代码一起发出去。想让程序一开就把
// 常看的几个站摆好，按下面注释掉的样子填进去即可；留空则开程序给一个空标签页，
// 手动打开的站照样能勾选采集。
const DEFAULT_SITES = [
  // { url: "https://example.com/", label: "站点名" },
];

// 只比主机名。默认地址里带着 #/ 这样的前端路由，用户在站内点两下地址就变了，
// 一字不差地比会认不出这还是同一个站；www. 前缀也不该算区别。
function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

module.exports = {
  DEFAULT_SITES,
  siteHost,
};
