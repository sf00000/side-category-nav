/* 侧边分类导航 —— Side Panel 逻辑
 * 数据模型：树状结构，每个分类节点 = { id, name, collapsed, links[], children[] }
 */

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  indentEnabled: true,     // 是否启用固定缩进（子分类与链接按层级缩进）
  indentSize: 16,          // 每级缩进宽度(px)
  defaultCollapsed: false, // 新建分类默认折叠
  openInNewTab: true,      // 链接在新标签页打开
  aiProvider: "deepseek",  // AI 服务商
  aiKey: "",               // 用户自己的 API Key（仅存本地）
  aiModel: "",             // 自定义模型名，留空用默认
  aiMaxItems: 250,         // AI 整理单次处理的链接上限
  lastCategoryId: ""       // 「☆ 当前页」上次选择的分类
};

// 路线 A：用户自带 API Key，直连大模型，无后端
const AI_PROVIDERS = {
  deepseek: { name: "DeepSeek", type: "openai", url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  openai:   { name: "OpenAI",   type: "openai", url: "https://api.openai.com/v1/chat/completions",   model: "gpt-4o-mini" },
  claude:   { name: "Claude",   type: "claude", url: "https://api.anthropic.com/v1/messages",        model: "claude-3-5-haiku-latest" }
};

let state = { categories: [], settings: { ...DEFAULT_SETTINGS } };
let searchQuery = ""; // 实时搜索关键字（不持久化）

/* ---------------- 工具 ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

const faviconUrl = (url) =>
  chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(url) + "&size=32");

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return url; }
};

/* ---------------- 树操作 ---------------- */
function newCategory(name, collapsed) {
  return { id: uid(), name, collapsed, links: [], children: [] };
}

// 在树中查找节点，返回 { node, parentList }；parentList 为 null 表示是顶层
function findNode(id, list = state.categories, parentList = null) {
  for (const n of list) {
    if (n.id === id) return { node: n, parentList: parentList || list };
    const r = findNode(id, n.children, n.children);
    if (r) return r;
  }
  return null;
}

// id 是否位于 root 的子树中（含 root 自身）
function inSubtree(root, id) {
  if (root.id === id) return true;
  return root.children.some((c) => inSubtree(c, id));
}

// 统计子树中链接总数（递归）
function countLinks(node) {
  return node.links.length + node.children.reduce((s, c) => s + countLinks(c), 0);
}

// 统计子树中分类总数（递归）
function countCategories(node) {
  return node.children.reduce((s, c) => s + 1 + countCategories(c), 0);
}

// 数据迁移：旧版数据没有 children 字段，补齐
function migrate(list) {
  for (const n of list) {
    if (!Array.isArray(n.children)) n.children = [];
    if (!Array.isArray(n.links)) n.links = [];
    migrate(n.children);
  }
}

/* ---------------- 存储 ---------------- */
async function loadState() {
  const data = await chrome.storage.local.get(["categories", "settings"]);
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  migrate(state.categories);
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function save() {
  await chrome.storage.local.set({
    categories: state.categories,
    settings: state.settings
  });
}

/* ---------------- 渲染 ---------------- */
function applySettingsToUI() {
  const s = state.settings;
  // 关闭固定缩进 = 把每级缩进宽度直接置 0
  document.documentElement.style.setProperty("--indent", (s.indentEnabled ? s.indentSize : 0) + "px");
  $("#setIndentEnabled").checked = s.indentEnabled;
  $("#setIndentSize").value = s.indentSize;
  $("#indentSizeLabel").textContent = s.indentSize + "px";
  $("#setDefaultCollapsed").checked = s.defaultCollapsed;
  $("#setOpenInNewTab").checked = s.openInNewTab;
  $("#setAiProvider").value = s.aiProvider;
  $("#setAiKey").value = s.aiKey;
  $("#setAiModel").value = s.aiModel;
  $("#setAiModel").placeholder = "默认：" + AI_PROVIDERS[s.aiProvider].model;
  $("#setAiMaxItems").value = s.aiMaxItems;
}

/* ---------------- 搜索过滤 ---------------- */
// 关键字高亮（先转义再包 <mark>，防注入）
function highlight(text) {
  const esc = escapeHtml(text);
  if (!searchQuery) return esc;
  const q = escapeHtml(searchQuery).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return esc.replace(new RegExp(q, "gi"), (m) => `<mark>${m}</mark>`);
}

// 递归过滤：分类名命中 → 保留整棵；否则按链接标题/网址过滤并下钻子分类
function filterTree(list, q) {
  const out = [];
  for (const cat of list) {
    if (cat.name.toLowerCase().includes(q)) {
      out.push({ ...cat, collapsed: false });
      continue;
    }
    const links = cat.links.filter((l) =>
      l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q));
    const children = filterTree(cat.children, q);
    if (links.length > 0 || children.length > 0) {
      out.push({ ...cat, links, children, collapsed: false });
    }
  }
  return out;
}

function render() {
  const list = $("#categoryList");
  list.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();
  const display = q ? filterTree(state.categories, q) : state.categories;

  const emptyEl = $("#emptyState");
  if (state.categories.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector("p").textContent = "还没有任何分类";
    emptyEl.querySelector(".dim").classList.remove("hidden");
  } else if (q && display.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector("p").textContent = `没有匹配「${searchQuery.trim()}」的链接或分类`;
    emptyEl.querySelector(".dim").classList.add("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }

  display.forEach((cat) => list.appendChild(renderCategory(cat, 0)));
}

function renderCategory(cat, depth) {
  const el = document.createElement("div");
  el.className = "category" + (cat.collapsed ? " collapsed" : "");
  el.dataset.id = cat.id;
  el.dataset.depth = depth;

  const header = document.createElement("div");
  header.className = "cat-header";
  header.dataset.action = "toggle-cat";
  header.draggable = true;
  header.style.paddingLeft = `calc(8px + ${depth} * var(--indent))`;
  header.innerHTML = `
    <span class="cat-arrow">▼</span>
    <span class="cat-name">${highlight(cat.name)}</span>
    <span class="cat-count">${countLinks(cat)}</span>
    <div class="cat-actions">
      <button data-action="add-link" title="添加链接">＋</button>
      <button data-action="add-subcat" title="新建子分类">⧉</button>
      <button data-action="rename-cat" title="重命名">✎</button>
      <button data-action="del-cat" class="danger" title="删除分类（含子分类）">✕</button>
    </div>
  `;
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "cat-body";

  cat.links.forEach((link) => {
    const row = document.createElement("div");
    row.className = "link-row";
    row.dataset.linkId = link.id;
    row.draggable = true;
    row.style.paddingLeft = `calc(8px + ${depth + 1} * var(--indent))`;
    row.innerHTML = `
      <span class="drag-handle">⠿</span>
      <img class="favicon" src="${faviconUrl(link.url)}" onerror="this.style.visibility='hidden'" />
      <a href="${escapeHtml(link.url)}" title="${escapeHtml(link.url)}"
         ${state.settings.openInNewTab ? 'target="_blank" rel="noopener"' : ""}>${highlight(link.title)}</a>
      <div class="link-actions">
        <button data-action="edit-link" title="编辑">✎</button>
        <button data-action="del-link" class="danger" title="删除">✕</button>
      </div>
    `;
    body.appendChild(row);
  });

  cat.children.forEach((child) => body.appendChild(renderCategory(child, depth + 1)));

  el.appendChild(body);
  return el;
}

/* ---------------- 弹窗 ---------------- */
function openModal({ title, bodyHtml, onOk, onOpen }) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalMask").classList.remove("hidden");
  const firstInput = $("#modalBody input");
  if (firstInput) firstInput.focus();
  if (onOpen) onOpen($("#modalBody"));

  $("#modalOk").onclick = async () => {
    const ok = await onOk($("#modalBody"));
    if (ok !== false) closeModal();
  };
  $("#modalCancel").onclick = closeModal;
  $("#modalMask").onclick = (e) => { if (e.target.id === "modalMask") closeModal(); };
}

function closeModal() { $("#modalMask").classList.add("hidden"); }

/* ---------------- 分类操作 ---------------- */
function addCategory(parent) {
  openModal({
    title: parent ? `在「${parent.name}」下新建子分类` : "新建分类",
    bodyHtml: `<label>分类名称<input type="text" id="m-catName" placeholder="例如：量化研究" /></label>`,
    onOk: async (body) => {
      const name = body.querySelector("#m-catName").value.trim();
      if (!name) return false;
      const cat = newCategory(name, state.settings.defaultCollapsed);
      if (parent) {
        parent.children.unshift(cat); // 新建子分类排在最前
        parent.collapsed = false; // 展开父分类让新子分类可见
      } else {
        state.categories.unshift(cat); // 新建分类排在最前
      }
      await save();
      render();
    }
  });
}

function renameCategory(cat) {
  openModal({
    title: "重命名分类",
    bodyHtml: `<label>分类名称<input type="text" id="m-catName" value="${escapeHtml(cat.name)}" /></label>`,
    onOk: async (body) => {
      const name = body.querySelector("#m-catName").value.trim();
      if (!name) return false;
      cat.name = name;
      await save();
      render();
    }
  });
}

function deleteCategory(cat) {
  const subCount = countCategories(cat);
  const linkCount = countLinks(cat);
  openModal({
    title: "删除分类",
    bodyHtml: `<p class="note">确定删除分类「${escapeHtml(cat.name)}」吗？<br/>将一并删除 ${subCount} 个子分类、共 ${linkCount} 个链接，且不可恢复。</p>`,
    onOk: async () => {
      const found = findNode(cat.id);
      if (found) {
        const i = found.parentList.findIndex((n) => n.id === cat.id);
        found.parentList.splice(i, 1);
      }
      await save();
      render();
    }
  });
}

/* ---------------- 链接操作 ---------------- */
function linkFormHtml({ title = "", url = "" } = {}) {
  return `
    <label>标题（必填，面板里显示的名字）
      <input type="text" id="m-linkTitle" required placeholder="例如：东方财富 - 沪深行情" value="${escapeHtml(title)}" />
    </label>
    <label>网址
      <input type="url" id="m-linkUrl" placeholder="https://..." value="${escapeHtml(url)}" />
    </label>
    <p class="note">💡 如果这个网页正开在标签页里，填完网址后会自动带入它的标题。</p>
  `;
}

function readLinkForm(body) {
  let url = body.querySelector("#m-linkUrl").value.trim();
  let title = body.querySelector("#m-linkTitle").value.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!title) return null; // 标题必填，不允许只存一个裸链接
  return { title, url };
}

// 网址输入完后，从已打开的标签页里匹配标题并自动填入
function attachTabTitleAutofill(body) {
  const urlInput = body.querySelector("#m-linkUrl");
  const titleInput = body.querySelector("#m-linkTitle");
  if (!urlInput || !titleInput) return;
  urlInput.addEventListener("change", async () => {
    if (titleInput.value.trim()) return;
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      const tabs = await chrome.tabs.query({});
      const norm = (u) => (u || "").replace(/\/+$/, "");
      const hit = tabs.find((t) => t.url && norm(t.url) === norm(url));
      if (hit && hit.title) titleInput.value = hit.title;
    } catch { /* 忽略，手动填即可 */ }
  });
}

function addLink(cat, preset) {
  openModal({
    title: `添加链接到「${cat.name}」`,
    bodyHtml: linkFormHtml(preset),
    onOpen: attachTabTitleAutofill,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      cat.links.push({ id: uid(), ...data });
      await save();
      render();
    }
  });
}

function editLink(cat, link) {
  openModal({
    title: "编辑链接",
    bodyHtml: linkFormHtml(link),
    onOpen: attachTabTitleAutofill,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      Object.assign(link, data);
      await save();
      render();
    }
  });
}

/* ---------------- 收藏当前页 ---------------- */
// 把树拍平成带层级的选项列表
function flattenTree(list, depth = 0, out = []) {
  for (const n of list) {
    out.push({ node: n, depth });
    flattenTree(n.children, depth + 1, out);
  }
  return out;
}

async function addCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    alert("当前页面无法收藏（仅支持 http/https 页面）。");
    return;
  }
  if (state.categories.length === 0) {
    alert("请先点击「＋ 分类」创建一个分类。");
    return;
  }
  const flat = flattenTree(state.categories);
  // 记住上次选择的分类，下次默认选中
  const lastId = state.settings.lastCategoryId;
  const lastExists = lastId && flat.some(({ node }) => node.id === lastId);
  const options = flat
    .map(({ node, depth }) =>
      `<option value="${node.id}"${node.id === lastId && lastExists ? " selected" : ""}>${"　".repeat(depth)}${escapeHtml(node.name)}</option>`)
    .join("");
  openModal({
    title: "收藏当前页",
    bodyHtml: `
      <label>添加到分类
        <select id="m-catSelect">${options}</select>
      </label>
      ${linkFormHtml({ title: tab.title || "", url: tab.url })}
    `,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      const found = findNode(body.querySelector("#m-catSelect").value);
      if (!found) return false;
      if (found.node.links.some((l) => l.url === data.url)) {
        alert("该分类下已收藏过这个网址。");
        return false;
      }
      found.node.links.push({ id: uid(), ...data });
      state.settings.lastCategoryId = found.node.id; // 记住本次选择
      await save();
      render();
    }
  });
}

/* ---------------- AI 整理 ---------------- */
async function callAI(userPrompt) {
  const s = state.settings;
  const p = AI_PROVIDERS[s.aiProvider];
  if (!s.aiKey) throw new Error("尚未配置 API Key");
  const model = s.aiModel.trim() || p.model;
  const sys = "你是网页收藏整理助手，只输出 JSON，不输出任何其他文字。";

  let resp;
  if (p.type === "openai") {
    resp = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.aiKey },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 8192 // 250 条建议的 JSON 可能很长，防止输出被截断
      })
    });
  } else {
    // Claude：浏览器直连需要显式声明 dangerous-direct-browser-access
    resp = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.aiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: sys,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
  }

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200);
    throw new Error(`${p.name} API 返回 ${resp.status}：${detail}`);
  }
  const data = await resp.json();
  return p.type === "openai" ? data.choices[0].message.content : data.content[0].text;
}

// 收集全部链接及其当前分类路径
function collectItems() {
  const items = [];
  const walk = (list, path) => {
    for (const n of list) {
      const p = path ? path + "/" + n.name : n.name;
      n.links.forEach((l) => items.push({ title: l.title, url: l.url, current: p }));
      walk(n.children, p);
    }
  };
  walk(state.categories, "");
  return items;
}

// 按分类路径解析节点；不存在则返回 null
function resolvePath(path) {
  const parts = String(path).split("/").map((s) => s.trim()).filter(Boolean);
  let list = state.categories, node = null;
  for (const part of parts) {
    node = list.find((c) => c.name === part);
    if (!node) return null;
    list = node.children;
  }
  return node;
}

function applyAiMoves(moves) {
  for (const m of moves) {
    // 找到链接当前所在分类
    let found = null;
    const walk = (list) => {
      for (const n of list) {
        const i = n.links.findIndex((l) => l.url === m.url);
        if (i >= 0) { found = { cat: n, i }; return true; }
        if (walk(n.children)) return true;
      }
      return false;
    };
    walk(state.categories);
    if (!found) continue;

    // 解析目标分类
    let target = null;
    if (m.to.startsWith("新建：")) {
      const name = m.to.slice(3).trim();
      if (!name) continue;
      target = state.categories.find((c) => c.name === name);
      if (!target) {
        target = newCategory(name, false);
        state.categories.push(target);
      }
    } else {
      target = resolvePath(m.to);
      if (!target) continue; // 模型给了不存在的路径，跳过
    }

    const [link] = found.cat.links.splice(found.i, 1);
    target.links.push(link);
    target.collapsed = false;
  }
}

// 解析模型输出：先尝试整体解析 JSON 数组；若输出被截断（Unterminated），
// 退化为逐对象抢救——解析所有完整的 {...}，丢弃不完整的尾部。
function parseMovesJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return { items: JSON.parse(arrMatch[0]), truncated: false }; } catch { /* 落入抢救逻辑 */ }
  }
  const items = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.url && obj.category) items.push(obj);
    } catch { /* 跳过损坏对象 */ }
  }
  return { items, truncated: true };
}

async function aiOrganize() {
  const s = state.settings;
  if (!s.aiKey) {
    $("#settingsPanel").classList.remove("hidden");
    alert("请先在设置里填写 AI 的 API Key（仅存本地，不会上传到任何服务器）。");
    return;
  }
  const items = collectItems();
  const limit = state.settings.aiMaxItems || 250;
  if (items.length === 0) { alert("还没有任何链接可整理。"); return; }
  if (items.length > limit) {
    alert(`当前共 ${items.length} 个链接，超过单次上限 ${limit} 条（可在设置中调整，用于控制 Token 消耗）。请先手动归置一部分。`);
    return;
  }
  const catPaths = [...new Set(items.map((i) => i.current))];

  openModal({
    title: "AI 整理收藏",
    bodyHtml: `<p class="note" id="aiStatus">正在调用 ${AI_PROVIDERS[s.aiProvider].name}（${items.length} 个链接），请稍候…</p>`,
    onOk: () => {}
  });
  const okBtn = $("#modalOk");
  okBtn.style.display = "none";

  const prompt =
    `我有以下网页收藏，每行格式：标题 | 网址 | 当前分类。\n` +
    `现有分类：${catPaths.map((c) => "「" + c + "」").join("、")}\n\n` +
    `请判断每个网页最合适的分类，规则：\n` +
    `1. 优先归入现有分类之一（用完整路径表示，如 "量化/数据"）；\n` +
    `2. 都不合适时输出 "新建：<分类名>"；\n` +
    `3. 只有确实需要变动的才输出，保持原样的不要输出。\n\n` +
    `收藏列表：\n${items.map((it, i) => `${i + 1}. ${it.title} | ${it.url} | ${it.current}`).join("\n")}\n\n` +
    `严格输出 JSON 数组：[{"url":"...","category":"..."}]，不要输出任何其他内容。`;

  try {
    const text = await callAI(prompt);
    const { items: json, truncated } = parseMovesJson(text);

    const moves = [];
    for (const item of json) {
      const it = items.find((x) => x.url === item.url);
      if (!it || !item.category) continue;
      const to = String(item.category).trim();
      if (to === it.current) continue;
      moves.push({ url: it.url, title: it.title, from: it.current, to });
    }

    if (moves.length === 0) {
      $("#aiStatus").textContent = truncated
        ? "模型输出不完整且未能恢复任何建议，请重试（或减少链接数量）。"
        : "AI 认为当前分类已经合理，无需调整。";
      return;
    }

    // 每条建议一个勾选框，人工逐条确认后只应用选中的
    $("#aiStatus").innerHTML =
      `<p class="note">` +
      (truncated ? `⚠️ 模型输出被截断，已恢复其中完整的建议。<br/>` : "") +
      `AI 建议调整 <b>${moves.length}</b> 个链接，勾选要应用的（默认全选）：</p>` +
      `<div class="ai-moves">` +
      moves.map((m, i) =>
        `<label class="ai-move">
          <input type="checkbox" data-move-idx="${i}" checked />
          <span class="ai-move-text">${escapeHtml(m.title)}<br/>
            <span class="dim">${escapeHtml(m.from)} → <b>${escapeHtml(m.to)}</b></span>
          </span>
        </label>`).join("") +
      `</div>
      <div class="ai-moves-tools">
        <button type="button" id="aiCheckAll">全选</button>
        <button type="button" id="aiUncheckAll">全不选</button>
      </div>`;

    $("#aiCheckAll").onclick = () =>
      document.querySelectorAll("[data-move-idx]").forEach((c) => (c.checked = true));
    $("#aiUncheckAll").onclick = () =>
      document.querySelectorAll("[data-move-idx]").forEach((c) => (c.checked = false));

    okBtn.style.display = "";
    okBtn.textContent = "应用选中项";
    okBtn.onclick = async () => {
      const selected = moves.filter((_, i) =>
        document.querySelector(`[data-move-idx="${i}"]`)?.checked);
      if (selected.length === 0) {
        alert("没有勾选任何调整项。");
        return;
      }
      applyAiMoves(selected);
      await save();
      render();
      okBtn.textContent = "确定";
      closeModal();
      alert(`已应用 ${selected.length} 条调整。`);
    };
  } catch (err) {
    $("#aiStatus").textContent = "调用失败：" + err.message;
  }
}

/* ---------------- 从收藏夹导入（递归保留层级） ---------------- */
// 收集整棵树中已存在的 URL 与标题，用于导入去重
function collectExistingKeys() {
  const urls = new Set(), titles = new Set();
  const walk = (list) => list.forEach((n) => {
    n.links.forEach((l) => { urls.add(l.url); titles.add(l.title); });
    walk(n.children);
  });
  walk(state.categories);
  return { urls, titles };
}

function bookmarkFolderToCategory(folder, skip) {
  const cat = newCategory(folder.title || "未命名", state.settings.defaultCollapsed);
  for (const n of folder.children || []) {
    if (n.url) {
      const link = { id: uid(), title: n.title || hostOf(n.url), url: n.url };
      if (skip && skip(link)) continue;
      cat.links.push(link);
    } else if (n.children) {
      cat.children.push(bookmarkFolderToCategory(n, skip));
    }
  }
  return cat;
}

function importFromBookmarks() {
  openModal({
    title: "从浏览器收藏夹导入",
    bodyHtml: `<p class="note">导入规则：<br/>· 书签栏下的文件夹 → 递归导入为分类树（子文件夹变成子分类）<br/>· 直接散放在书签栏上的单个收藏 → 归入「书签栏（散置链接）」分类<br/>· <b>URL 或标题已存在于面板中的链接一律跳过</b>（与 AI 归类结果不冲突）。</p>`,
    onOk: async () => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0]?.children?.find((n) => n.id === "1") || tree[0]?.children?.[0];
      if (!bar || !bar.children) return;

      const existing = new Set(state.categories.map((c) => c.name));
      const keys = collectExistingKeys();
      let skipped = 0;
      const skip = (link) => {
        if (keys.urls.has(link.url) || keys.titles.has(link.title)) { skipped++; return true; }
        keys.urls.add(link.url);
        keys.titles.add(link.title);
        return false;
      };
      let addedFolders = 0;
      let addedLoose = 0;

      // 1) 文件夹 → 分类树
      for (const folder of bar.children) {
        if (folder.url || !folder.children) continue;
        if (existing.has(folder.title)) continue;
        const cat = bookmarkFolderToCategory(folder, skip);
        if (countLinks(cat) === 0) continue;
        state.categories.push(cat);
        existing.add(cat.name);
        addedFolders++;
      }

      // 2) 散置的单个收藏 → 归入「书签栏（散置链接）」
      const LOOSE_NAME = "书签栏（散置链接）";
      const looseLinks = bar.children
        .filter((n) => n.url)
        .map((n) => ({ id: uid(), title: n.title || hostOf(n.url), url: n.url }))
        .filter((l) => !skip(l));
      if (looseLinks.length > 0) {
        let looseCat = state.categories.find((c) => c.name === LOOSE_NAME);
        if (!looseCat) {
          looseCat = newCategory(LOOSE_NAME, state.settings.defaultCollapsed);
          state.categories.push(looseCat);
        }
        for (const link of looseLinks) {
          looseCat.links.push(link);
          addedLoose++;
        }
      }

      await save();
      render();
      if (addedFolders === 0 && addedLoose === 0) {
        alert(skipped > 0
          ? `没有可导入的新内容（${skipped} 个链接已存在，已跳过）。`
          : "没有可导入的内容（收藏夹为空）。");
      } else {
        alert(`导入完成：${addedFolders} 个分类，${addedLoose} 个散置链接` +
          (skipped > 0 ? `（跳过 ${skipped} 个已存在的链接）` : "") + "。");
      }
    }
  });
}

/* ---------------- 拖拽排序 ---------------- */
let dragCtx = null; // { kind: 'category'|'link', id, sourceCatId? }

function clearDropHints() {
  document.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) =>
    el.classList.remove("drop-before", "drop-after", "drop-into"));
}

// 根据鼠标在行内的纵向位置决定落点：上 1/3 前插，中 1/3 放入，下 1/3 后插
function dropZone(e, el, allowInto) {
  const r = el.getBoundingClientRect();
  const ratio = (e.clientY - r.top) / r.height;
  if (allowInto) {
    if (ratio < 0.3) return "before";
    if (ratio > 0.7) return "after";
    return "into";
  }
  return ratio < 0.5 ? "before" : "after";
}

function bindDragEvents() {
  const list = $("#categoryList");

  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".link-row");
    const header = e.target.closest(".cat-header");
    if (row) {
      const catEl = row.closest(".category");
      dragCtx = { kind: "link", id: row.dataset.linkId, sourceCatId: catEl.dataset.id };
    } else if (header) {
      dragCtx = { kind: "category", id: header.parentElement.dataset.id };
    } else {
      dragCtx = null;
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  });

  list.addEventListener("dragover", (e) => {
    if (!dragCtx) return;
    const header = e.target.closest(".cat-header");
    const row = e.target.closest(".link-row");
    clearDropHints();

    if (header) {
      const targetId = header.parentElement.dataset.id;
      // 分类不能放进自己或自己的后代
      if (dragCtx.kind === "category") {
        const src = findNode(dragCtx.id);
        if (!src || inSubtree(src.node, targetId)) return;
      }
      const zone = dropZone(e, header, true);
      header.classList.add("drop-" + zone);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    } else if (row && dragCtx.kind === "link") {
      if (row.dataset.linkId === dragCtx.id) return;
      const zone = dropZone(e, row, false);
      row.classList.add("drop-" + zone);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  });

  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) clearDropHints();
  });

  list.addEventListener("drop", async (e) => {
    if (!dragCtx) return;
    e.preventDefault();
    const header = e.target.closest(".cat-header");
    const row = e.target.closest(".link-row");

    if (dragCtx.kind === "category" && header) {
      await dropCategory(dragCtx.id, header.parentElement.dataset.id, dropZone(e, header, true));
    } else if (dragCtx.kind === "link" && row) {
      await dropLinkOnLink(dragCtx, row, dropZone(e, row, false));
    } else if (dragCtx.kind === "link" && header) {
      await dropLinkOnCategory(dragCtx, header.parentElement.dataset.id);
    }

    clearDropHints();
    dragCtx = null;
    render();
  });

  list.addEventListener("dragend", () => {
    clearDropHints();
    dragCtx = null;
  });
}

// 移动分类到目标分类的 前/后/内部
async function dropCategory(srcId, targetId, zone) {
  const src = findNode(srcId);
  const target = findNode(targetId);
  if (!src || !target) return;
  if (inSubtree(src.node, targetId)) return; // 防止拖进自己的子树

  // 先从原位置摘除
  const i = src.parentList.findIndex((n) => n.id === srcId);
  src.parentList.splice(i, 1);

  if (zone === "into") {
    target.node.children.push(src.node);
    target.node.collapsed = false;
  } else {
    // 摘除后重新定位目标（同一列表时索引可能已变化）
    const t = findNode(targetId);
    const j = t.parentList.findIndex((n) => n.id === targetId);
    t.parentList.splice(zone === "before" ? j : j + 1, 0, src.node);
  }
  await save();
}

// 链接拖到另一条链接的前/后
async function dropLinkOnLink(ctx, row, zone) {
  const src = findNode(ctx.sourceCatId);
  const targetCatEl = row.closest(".category");
  const target = findNode(targetCatEl.dataset.id);
  if (!src || !target) return;

  const li = src.node.links.findIndex((l) => l.id === ctx.id);
  if (li < 0) return;
  const [link] = src.node.links.splice(li, 1);

  // 摘除后重新找目标行所在分类与索引
  const t = findNode(target.node.id);
  const ti = t.node.links.findIndex((l) => l.id === row.dataset.linkId);
  t.node.links.splice(zone === "before" ? ti : ti + 1, 0, link);
  await save();
}

// 链接拖到分类标题 → 移入该分类
async function dropLinkOnCategory(ctx, targetCatId) {
  if (ctx.sourceCatId === targetCatId) return;
  const src = findNode(ctx.sourceCatId);
  const target = findNode(targetCatId);
  if (!src || !target) return;

  const li = src.node.links.findIndex((l) => l.id === ctx.id);
  if (li < 0) return;
  const [link] = src.node.links.splice(li, 1);
  target.node.links.push(link);
  target.node.collapsed = false;
  await save();
}

/* ---------------- 导出 / 恢复 JSON 备份 ---------------- */
function exportBackup() {
  const data = {
    app: "side-category-nav",
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: state.categories,
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `side-nav-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      alert("备份文件不是合法的 JSON，恢复失败。");
      return;
    }
    if (!data || !Array.isArray(data.categories)) {
      alert("备份文件格式不正确（缺少 categories 字段），恢复失败。");
      return;
    }
    // 统计备份内容，让用户确认
    let linkCount = 0, catCount = 0;
    const walk = (list) => list.forEach((n) => {
      catCount++;
      linkCount += (n.links || []).length;
      walk(n.children || []);
    });
    walk(data.categories);

    openModal({
      title: "恢复备份",
      bodyHtml: `<p class="note">备份内容：${catCount} 个分类、${linkCount} 个链接` +
        (data.exportedAt ? `（导出于 ${new Date(data.exportedAt).toLocaleString("zh-CN")}）` : "") +
        `。<br/><b>恢复将覆盖当前所有分类与设置，且不可撤销。</b>建议先导出当前数据。</p>`,
      onOk: async () => {
        migrate(data.categories); // 兼容旧版本结构
        state.categories = data.categories;
        state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        await save();
        applySettingsToUI();
        render();
        alert("恢复完成。");
      }
    });
  };
  reader.readAsText(file);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // 列表点击事件委托
  $("#categoryList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "toggle-cat" && e.target.closest(".cat-actions")) return; // 点在操作按钮上不算折叠

    const catEl = e.target.closest(".category");
    const found = findNode(catEl?.dataset.id);
    if (!found) return;
    const cat = found.node;

    switch (action) {
      case "toggle-cat":
        cat.collapsed = !cat.collapsed;
        save().then(render);
        break;
      case "add-link": addLink(cat); break;
      case "add-subcat": addCategory(cat); break;
      case "rename-cat": renameCategory(cat); break;
      case "del-cat": deleteCategory(cat); break;
      case "edit-link": {
        const link = cat.links.find((l) => l.id === e.target.closest(".link-row")?.dataset.linkId);
        if (link) editLink(cat, link);
        break;
      }
      case "del-link": {
        const linkId = e.target.closest(".link-row")?.dataset.linkId;
        cat.links = cat.links.filter((l) => l.id !== linkId);
        save().then(render);
        break;
      }
    }
  });

  bindDragEvents();

  // 搜索
  $("#searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    $("#searchClear").classList.toggle("hidden", !searchQuery);
    render();
  });
  $("#searchClear").onclick = () => {
    searchQuery = "";
    $("#searchInput").value = "";
    $("#searchClear").classList.add("hidden");
    render();
  };

  // 备份 / 恢复
  $("#btnExport").onclick = exportBackup;
  $("#btnImportBackup").onclick = () => $("#backupFileInput").click();
  $("#backupFileInput").onchange = (e) => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = ""; // 允许重复选择同一文件
  };

  // 工具栏
  $("#btnAddPage").onclick = addCurrentPage;
  $("#btnAiOrganize").onclick = aiOrganize;
  $("#btnAddCategory").onclick = () => addCategory(null);
  $("#btnImport").onclick = importFromBookmarks;
  $("#btnSettings").onclick = () => $("#settingsPanel").classList.toggle("hidden");
  $("#btnExpandAll").onclick = () => {
    const walk = (list) => list.forEach((c) => { c.collapsed = false; walk(c.children); });
    walk(state.categories);
    save().then(render);
  };
  $("#btnCollapseAll").onclick = () => {
    const walk = (list) => list.forEach((c) => { c.collapsed = true; walk(c.children); });
    walk(state.categories);
    save().then(render);
  };

  // 设置
  $("#setIndentEnabled").onchange = async (e) => {
    state.settings.indentEnabled = e.target.checked;
    await save();
    applySettingsToUI();
  };
  $("#setIndentSize").oninput = async (e) => {
    state.settings.indentSize = Number(e.target.value);
    await save();
    applySettingsToUI();
  };
  $("#setDefaultCollapsed").onchange = async (e) => {
    state.settings.defaultCollapsed = e.target.checked;
    await save();
  };
  $("#setOpenInNewTab").onchange = async (e) => {
    state.settings.openInNewTab = e.target.checked;
    await save();
    render();
  };

  // AI 设置
  $("#setAiProvider").onchange = async (e) => {
    state.settings.aiProvider = e.target.value;
    await save();
    applySettingsToUI(); // 刷新默认模型占位提示
  };
  $("#setAiKey").onchange = async (e) => {
    state.settings.aiKey = e.target.value.trim();
    await save();
  };
  $("#setAiModel").onchange = async (e) => {
    state.settings.aiModel = e.target.value.trim();
    await save();
  };
  $("#setAiMaxItems").onchange = async (e) => {
    const v = Math.max(10, Math.min(500, Number(e.target.value) || 250));
    state.settings.aiMaxItems = v;
    e.target.value = v;
    await save();
  };
}

/* ---------------- 启动 ---------------- */
(async function init() {
  await loadState();
  applySettingsToUI();
  render();
  bindEvents();
})();
