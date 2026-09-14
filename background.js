// 点击工具栏图标时打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));
