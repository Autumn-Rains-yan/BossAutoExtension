// content.js：注入 inject.js + 把拦截到的接口数据发给 background，
// 同时在 Boss 聊天页面自动从 localStorage 读取 sendMessage，填充并发送消息。

// ========= 悬浮日志面板（无需 DevTools，直接显示在页面右下角）=========
(function setupFloatingLog() {
  let panel = null;
  let logLines = [];
  const MAX_LINES = 60;

  function getPanel() {
    if (panel && document.body && document.body.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = "__bossAiLog__";
    panel.style.cssText = [
      "position:fixed", "bottom:10px", "right:10px", "z-index:2147483647",
      "width:420px", "max-height:280px", "overflow-y:auto",
      "background:rgba(0,0,0,0.82)", "color:#0f0", "font:11px/1.4 monospace",
      "padding:6px 8px", "border-radius:6px", "pointer-events:auto",
      "box-shadow:0 2px 12px rgba(0,0,0,.5)", "word-break:break-all"
    ].join(";");

    // 关闭按钮
    const close = document.createElement("span");
    close.textContent = "✕";
    close.style.cssText = "position:absolute;top:4px;right:8px;cursor:pointer;color:#f55;font-size:13px";
    close.onclick = () => { panel.style.display = "none"; };
    panel.appendChild(close);

    const inner = document.createElement("div");
    inner.id = "__bossAiLogInner__";
    panel.appendChild(inner);

    if (document.body) document.body.appendChild(panel);
    return panel;
  }

  window.__bossAiLog = function(msg) {
    const now = new Date();
    const ts  = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
    const line = `[${ts}] ${msg}`;
    logLines.push(line);
    if (logLines.length > MAX_LINES) logLines.shift();

    // 同时写入 localStorage 供事后查阅（ring buffer）
    try { localStorage.setItem("bossAi:debugLog", logLines.slice(-30).join("\n")); } catch (_) {}

    // 渲染到悬浮面板
    try {
      const p = getPanel();
      if (!p) return;
      p.style.display = "";
      const inner = p.querySelector("#__bossAiLogInner__");
      if (inner) {
        inner.innerHTML = logLines.map(l =>
          `<div style="border-bottom:1px solid #1a1a1a;padding:1px 0">${l.replace(/</g,"&lt;")}</div>`
        ).join("");
        p.scrollTop = p.scrollHeight;
      }
    } catch (_) {}
  };
})();

function trimAutomationValue(value) {
  return String(value || "").trim();
}

function normalizeSearchQueryText(value) {
  return trimAutomationValue(value).replace(/\s+/g, " ");
}

function runtimeSendMessageFromContent(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function splitAutomationConfigList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitAutomationConfigList(item));
  }

  return String(value || "")
    .split(/[\n,，;；]+/)
    .map((item) => trimAutomationValue(item))
    .filter(Boolean);
}

function normalizeConfiguredCityIds(value) {
  return [...new Set(
    splitAutomationConfigList(value)
      .map((item) => {
        const fromUrl = item.match(/[?&]city=(\d{4,})/i);
        if (fromUrl) {
          return fromUrl[1];
        }

        const direct = item.match(/\b(\d{4,})\b/);
        return direct ? direct[1] : "";
      })
      .filter(Boolean)
  )];
}

function normalizeConfiguredSearchKeywords(value) {
  return [...new Set(
    splitAutomationConfigList(value)
      .map((item) => normalizeSearchQueryText(item))
      .filter(Boolean)
  )];
}

function normalizeConfiguredMaxJobClicks(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return 30;
  }

  return Math.max(1, Math.min(300, parsed));
}

const TOTAL_CLICK_COUNT_STORAGE_KEY = "bossAi:runTotalClickCount";
const SEARCH_RESUME_SIGNAL_STORAGE_KEY = "bossAi:resumeAfterSearch";
const PENDING_TARGET_SWITCH_STORAGE_KEY = "bossAi:pendingTargetSwitch";

function getSavedTotalClickCount() {
  try {
    const parsed = Number.parseInt(
      window.localStorage.getItem(TOTAL_CLICK_COUNT_STORAGE_KEY) || "0",
      10
    );
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  } catch (_) {}

  return 0;
}

function setSavedTotalClickCount(count) {
  const normalized = Math.max(0, Number.parseInt(String(count ?? 0), 10) || 0);
  try {
    window.localStorage.setItem(
      TOTAL_CLICK_COUNT_STORAGE_KEY,
      String(normalized)
    );
  } catch (_) {}
  return normalized;
}

async function getAutomationSettingsForAuto() {
  const response = await runtimeSendMessageFromContent({
    type: "GET_AUTOMATION_SETTINGS",
  });

  if (!response?.ok) {
    throw new Error(response?.error || "读取自动执行配置失败。");
  }

  return {
    cityIds: normalizeConfiguredCityIds(response.settings?.cityIds),
    searchKeywords: normalizeConfiguredSearchKeywords(
      response.settings?.searchKeywords
    ),
    maxTotalJobClicksPerRun: normalizeConfiguredMaxJobClicks(
      response.settings?.maxTotalJobClicksPerRun ??
        response.settings?.maxJobClicksPerTarget
    ),
  };
}

function hasValidAutomationSettings(settings) {
  return (
    Array.isArray(settings?.cityIds) &&
    settings.cityIds.length > 0 &&
    Array.isArray(settings?.searchKeywords) &&
    settings.searchKeywords.length > 0
  );
}

function getSavedRotationIndex(key, length) {
  if (!length) {
    return 0;
  }

  let index = 0;
  try {
    const saved = parseInt(window.localStorage.getItem(key) || "0", 10);
    if (Number.isFinite(saved) && saved >= 0) {
      index = saved % length;
    }
  } catch (_) {
    index = 0;
  }
  return index;
}

function saveRotationIndices(queryIndex, cityIndex) {
  try {
    window.localStorage.setItem("bossAi:lastQueryIndex", String(queryIndex));
    window.localStorage.setItem("bossAi:lastCityIndex", String(cityIndex));
  } catch (_) {}
}

function clearSavedRotationIndices() {
  try {
    window.localStorage.removeItem("bossAi:lastQueryIndex");
    window.localStorage.removeItem("bossAi:lastCityIndex");
  } catch (_) {}
}

function setAutoRestartFlag(reason = "") {
  try {
    localStorage.setItem("bossAi:autoRestart", "1");
    if (reason) {
      logFromContent(`[autoRestart] 已写入页面重启标记：${reason}`);
    }
  } catch (_) {}
}

function clearAutoRestartFlag() {
  try {
    localStorage.removeItem("bossAi:autoRestart");
  } catch (_) {}
}

function setSearchResumeSignal(target) {
  try {
    localStorage.setItem(
      SEARCH_RESUME_SIGNAL_STORAGE_KEY,
      JSON.stringify({
        cityId: trimAutomationValue(target?.cityId),
        query: normalizeSearchQueryText(target?.query),
        ts: Date.now(),
      })
    );
  } catch (_) {}
}

function readSearchResumeSignal() {
  try {
    const raw = localStorage.getItem(SEARCH_RESUME_SIGNAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return {
      cityId: trimAutomationValue(parsed?.cityId),
      query: normalizeSearchQueryText(parsed?.query),
      ts: Number(parsed?.ts) || 0,
    };
  } catch (_) {
    return null;
  }
}

function clearSearchResumeSignal() {
  try {
    localStorage.removeItem(SEARCH_RESUME_SIGNAL_STORAGE_KEY);
  } catch (_) {}
}

function setPendingAutomationTarget(target) {
  try {
    localStorage.setItem(
      PENDING_TARGET_SWITCH_STORAGE_KEY,
      JSON.stringify({
        cityId: trimAutomationValue(target?.cityId),
        query: normalizeSearchQueryText(target?.query),
        cityIndex: Math.max(0, Number(target?.cityIndex) || 0),
        queryIndex: Math.max(0, Number(target?.queryIndex) || 0),
        ts: Date.now(),
      })
    );
  } catch (_) {}
}

function readPendingAutomationTarget() {
  try {
    const raw = localStorage.getItem(PENDING_TARGET_SWITCH_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const target = {
      cityId: trimAutomationValue(parsed?.cityId),
      query: normalizeSearchQueryText(parsed?.query),
      cityIndex: Math.max(0, Number(parsed?.cityIndex) || 0),
      queryIndex: Math.max(0, Number(parsed?.queryIndex) || 0),
      ts: Number(parsed?.ts) || 0,
    };

    if (!target.cityId || !target.query) {
      return null;
    }

    if (Date.now() - target.ts > 120000) {
      clearPendingAutomationTarget();
      return null;
    }

    return target;
  } catch (_) {
    return null;
  }
}

function clearPendingAutomationTarget() {
  try {
    localStorage.removeItem(PENDING_TARGET_SWITCH_STORAGE_KEY);
  } catch (_) {}
}

function shouldResumeCrawlingAfterSearch(target) {
  const signal = readSearchResumeSignal();
  if (!signal) {
    return false;
  }

  const signalMatches =
    signal.cityId === trimAutomationValue(target?.cityId) &&
    signal.query === normalizeSearchQueryText(target?.query);
  const isFresh = Date.now() - signal.ts <= 15000;

  return signalMatches && isFresh && isCurrentJobListMatchingTarget(target);
}

function getPreferredAutomationTarget(settings) {
  const cityIds = settings.cityIds || [];
  const searchKeywords = settings.searchKeywords || [];
  const pendingTarget = readPendingAutomationTarget();

  if (
    pendingTarget &&
    cityIds[pendingTarget.cityIndex] === pendingTarget.cityId &&
    searchKeywords[pendingTarget.queryIndex] === pendingTarget.query
  ) {
    return {
      cityIndex: pendingTarget.cityIndex,
      queryIndex: pendingTarget.queryIndex,
      cityId: pendingTarget.cityId,
      query: pendingTarget.query,
    };
  }

  return getCurrentAutomationTarget(settings);
}

function scheduleResumeCrawlingAfterSearch(target) {
  const state = ensureAutoBrowseState();
  clearAutoBrowsePrepareTimer();
  state.phase = "resume_after_search";

  state.prepareTimer = setTimeout(() => {
    state.prepareTimer = null;
    if (!state.started || !isJobListPage()) {
      return;
    }

    if (!isCurrentJobListMatchingTarget(target)) {
      logFromContent(
        `[resumeAfterSearch] 页面恢复后参数已变化，重新回到配置目标。currentUrl=${location.href}`
      );
      clearSearchResumeSignal();
      navigateToAutomationTarget(target, "搜索刷新恢复后重新应用配置");
      return;
    }

    clearSearchResumeSignal();
    clearAutoRestartFlag();
    clearPendingAutomationTarget();
    logFromContent(
      `自动浏览：检测到搜索刷新后的恢复标记，直接开始爬取 cityId=${target.cityId}，关键词=${target.query}。`
    );
    startCrawlingCurrentCityFromList();
  }, 1600);
}

function getCurrentAutomationTarget(settings) {
  const cityIds = settings.cityIds || [];
  const searchKeywords = settings.searchKeywords || [];
  const queryIndex = getSavedRotationIndex(
    "bossAi:lastQueryIndex",
    searchKeywords.length
  );
  const cityIndex = getSavedRotationIndex("bossAi:lastCityIndex", cityIds.length);

  return {
    queryIndex,
    cityIndex,
    query: searchKeywords[queryIndex] || "",
    cityId: cityIds[cityIndex] || "",
  };
}

function getNextAutomationTarget(settings, currentTarget) {
  const cityIds = settings.cityIds || [];
  const searchKeywords = settings.searchKeywords || [];
  if (!cityIds.length || !searchKeywords.length) {
    return {
      queryIndex: 0,
      cityIndex: 0,
      query: "",
      cityId: "",
    };
  }

  let nextQueryIndex = Number(currentTarget?.queryIndex) || 0;
  let nextCityIndex = (Number(currentTarget?.cityIndex) || 0) + 1;

  if (nextCityIndex >= cityIds.length) {
    nextCityIndex = 0;
    nextQueryIndex = (nextQueryIndex + 1) % searchKeywords.length;
  }

  return {
    queryIndex: nextQueryIndex,
    cityIndex: nextCityIndex,
    query: searchKeywords[nextQueryIndex] || "",
    cityId: cityIds[nextCityIndex] || "",
  };
}

function buildJobListUrlForConfig(cityId, query) {
  const targetUrl = new URL("https://www.zhipin.com/web/geek/jobs");
  const normalizedCityId = trimAutomationValue(cityId);
  const normalizedQuery = normalizeSearchQueryText(query);
  targetUrl.searchParams.set("city", normalizedCityId);
  targetUrl.searchParams.set("query", normalizedQuery);
  targetUrl.searchParams.set("industry", "");
  targetUrl.searchParams.set("position", normalizedQuery);
  return targetUrl.toString();
}

function parseJobListParams(url = location.href) {
  try {
    const parsed = new URL(url);
    return {
      cityId: trimAutomationValue(parsed.searchParams.get("city") || ""),
      query: normalizeSearchQueryText(
        parsed.searchParams.get("position") ||
          parsed.searchParams.get("query") ||
          ""
      ),
    };
  } catch (_) {
    return {
      cityId: "",
      query: "",
    };
  }
}

function isCurrentJobListMatchingTarget(target) {
  const params = parseJobListParams(location.href);
  return (
    isJobListPage() &&
    params.cityId === trimAutomationValue(target.cityId) &&
    params.query === normalizeSearchQueryText(target.query)
  );
}

function syncAutoBrowseConfig(state, settings, target) {
  state.cities = (settings.cityIds || []).slice();
  state.searchQueries = (settings.searchKeywords || []).slice();
  state.maxTotalJobClicksPerRun = normalizeConfiguredMaxJobClicks(
    settings.maxTotalJobClicksPerRun
  );
  state.totalClickedCount = getSavedTotalClickCount();
  state.cityIndex = Number(target.cityIndex) || 0;
  state.queryIndex = Number(target.queryIndex) || 0;
  state.currentCityId = target.cityId || "";
  state.currentQuery = target.query || "";
}

function redirectBackToConfiguredJobList(delayMs = 1800) {
  setTimeout(() => {
    if (location.href.includes("/web/geek/jobs")) {
      return;
    }

    getAutomationSettingsForAuto()
      .then((settings) => {
        if (!hasValidAutomationSettings(settings)) {
          return;
        }

        const target = getPreferredAutomationTarget(settings);
        location.href = buildJobListUrlForConfig(target.cityId, target.query);
      })
      .catch((error) => {
        chrome.runtime?.sendMessage?.({
          type: "LOG",
          text: `[redirect] 返回列表页失败：${error.message}`,
        });
      });
  }, delayMs);
}

(function () {
  var s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject.js");
  s.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(s);
})();

window.addEventListener("message", function (event) {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "BOSS_API_RESPONSE"
  )
    return;
  chrome.runtime.sendMessage({
    type: "BOSS_API_RESPONSE",
    payload: {
      apiType: event.data.apiType,
      url: event.data.url,
      body: event.data.body,
      ts: Date.now(),
    },
  });
});

// ========= 在 Boss 聊天页面自动读取 localStorage 并发送消息 =========

function isChatPage() {
  const href = location.href;
  return (
    href.includes("/web/geek/chat") ||
    href.includes("/geek/chat") ||
    href.includes("/geek/im")
  );
}

// 调试：每次 content.js 初始化时记录当前页面类型，方便确认聊天页脚本是否真正加载
try {
  chrome.runtime?.sendMessage?.({
    type: "LOG",
    text:
      "content.js 初始化，当前 URL = " +
      location.href +
      "，isChatPage=" +
      (isChatPage() ? "true" : "false") +
      "，isJobListPage=" +
      (location.href.includes("/web/geek/jobs") ? "true" : "false"),
  });
} catch (_) {}

// 自动恢复：若自动浏览意图为开启，但当前页面既不是职位列表页也不是聊天页
// （常见于点击职位卡片后 SPA 意外跳转到 /web/geek/job?query= 等非列表 URL），
// 则自动导航回正确的职位列表页，避免脚本静默停止。
(function autoRecoverToJobList() {
  try {
    const isRunningWanted = localStorage.getItem("bossAi:autoRunning") === "1";
    if (!isRunningWanted) return;
    const onJobList = location.href.includes("/web/geek/jobs");
    const onChat = isChatPage();
    if (onJobList || onChat) {
      return;
    }

    getAutomationSettingsForAuto()
      .then((settings) => {
        if (!hasValidAutomationSettings(settings)) {
          return;
        }

        const target = getPreferredAutomationTarget(settings);
        const targetUrl = buildJobListUrlForConfig(target.cityId, target.query);
        chrome.runtime?.sendMessage?.({
          type: "LOG",
          text:
            "[autoRecover] 检测到自动浏览开启但当前页面不是列表页（" +
            location.href +
            "），自动跳回列表页：" + targetUrl,
        });
        location.href = targetUrl;
      })
      .catch((error) => {
        chrome.runtime?.sendMessage?.({
          type: "LOG",
          text: `[autoRecover] 读取自动执行配置失败：${error.message}`,
        });
      });
  } catch (_) {}
})();

function findChatInput() {
  // Boss 直聘聊天页已知选择器（精确匹配，优先使用）
  const specificSelectors = [
    ".chat-im .chat-input[contenteditable='true']",
    ".chat-im .chat-input[contenteditable]",
    ".boss-chat-input[contenteditable]",
    "#chat-input",
    ".chat-input[contenteditable='true']",
    ".chat-input[contenteditable]",
  ];
  for (const sel of specificSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // 兜底：在聊天容器内搜索（避免抓到页面其他区域的空元素）
  const chatContainerSelectors = [
    ".chat-im",
    ".boss-chat",
    "[class*='chat-im']",
    "[class*='chat-box']",
    "[class*='chat-container']",
    "[class*='message-input']",
  ];
  for (const cSel of chatContainerSelectors) {
    const container = document.querySelector(cSel);
    if (!container) continue;
    const input =
      container.querySelector("[contenteditable='true']") ||
      container.querySelector("textarea") ||
      container.querySelector("input[type='text']");
    if (input) return input;
  }

  return null;
}

function findSendButton() {
  // 优先匹配带有发送文案的 .btn-send
  const btnSendList = document.querySelectorAll(
    ".chat-im .btn-send, .btn-send"
  );
  for (const btn of btnSendList) {
    const txt = (btn.innerText || btn.textContent || "").trim();
    if (txt && txt.includes("发送")) {
      return btn;
    }
  }

  // 兜底：仅在 .chat-im 容器内查找 button，避免误命中全页面 <a> 链接（如岗位卡片"发送简历"等）
  const chatContainer = document.querySelector(".chat-im") || document.querySelector("[class*='chat-im']");
  const scope = chatContainer || document;
  const buttons = scope.querySelectorAll("button");
  for (const btn of buttons) {
    const txt = (btn.innerText || btn.textContent || "").trim();
    if (!txt) continue;
    if (txt === "发送" || txt === "发 送") {
      return btn;
    }
  }
  return null;
}

// 统计聊天消息气泡数量，用于验证消息是否真的发送成功
// 注意：.chat-im 是输入框区域，消息列表在其外部，必须从 document 层面搜索
// 返回 -1 表示无法找到消息容器（不应用计数验证）
function countChatMessages() {
  // 消息项 class 为 message-item（已通过 DOM 检查确认），在 .chat-im 外部的聊天记录区域
  const selectors = [
    ".message-item",
    "[class*='message-item']",
    ".chat-record-item",
    "[class*='chat-record-item']",
    "[class*='chat-msg']",
  ];
  for (const sel of selectors) {
    // 排除左侧会话列表（.chat-list、.user-list 等）中的项，只计当前会话的消息气泡
    const chatBox = document.querySelector(".chat-conversation")
      || document.querySelector(".chat-content")
      || document.querySelector(".message-list")
      || document.querySelector("[class*='chat-conversation']")
      || document.querySelector("[class*='chat-content']");
    const root = chatBox || document;
    const els = root.querySelectorAll(sel);
    if (els.length > 0) return els.length;
  }
  return -1;
}

function getChatConversationRoot() {
  return document.querySelector(".chat-conversation")
    || document.querySelector(".chat-content")
    || document.querySelector(".message-list")
    || document.querySelector("[class*='chat-conversation']")
    || document.querySelector("[class*='chat-content']")
    || document;
}

function getInputText(input) {
  if (!input) return "";
  if (
    input.tagName === "TEXTAREA" ||
    input.tagName === "INPUT"
  ) {
    return input.value || "";
  }
  if (input.isContentEditable) {
    return input.innerText || input.textContent || "";
  }
  return "";
}

function normalizeChatText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

const CHAT_SEND_RECORD_KEY = "bossAi:lastChatSendRecord";
const CHAT_SEND_SENDING_MAX_AGE_MS = 25000;
const CHAT_SEND_SENT_MAX_AGE_MS = 90000;
const CHAT_SEND_FAILED_MAX_AGE_MS = 12000;

function extractBossJobId(rawJobId) {
  return String(rawJobId || "")
    .replace(/^.*\//, "")
    .replace(/\.html$/, "");
}

function hasMessageBubble(messageText) {
  const root = getChatConversationRoot();
  const normalized = normalizeChatText(messageText).replace(
    /^您好，我是求职者的AI Agent机器人，/,
    ""
  );

  if (!root || !normalized) {
    return false;
  }

  const snippets = [
    normalized.slice(0, 24),
    normalized.slice(-24),
  ].filter((snippet) => snippet && snippet.length >= 10);

  if (!snippets.length) {
    return false;
  }

  const selectors = [
    ".message-item",
    "[class*='message-item']",
    ".chat-record-item",
    "[class*='chat-record-item']",
    "[class*='chat-msg']",
  ];

  for (const sel of selectors) {
    const items = root.querySelectorAll(sel);
    for (const item of items) {
      const text = normalizeChatText(item.innerText || item.textContent || "");
      if (!text) {
        continue;
      }

      if (snippets.some((snippet) => text.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}

function updateStoredSendState(data, patch = {}) {
  const next = {
    ...data,
    ...patch,
    updatedAt: Date.now(),
  };

  try {
    localStorage.setItem("bossAi:lastHighJob", JSON.stringify(next));
  } catch (_) {}

  const jobId = next?.job?.id;
  if (jobId) {
    const key = "bossAiJob:" + jobId;

    try {
      const existedRaw = localStorage.getItem(key);
      const existed = existedRaw ? JSON.parse(existedRaw) : {};
      localStorage.setItem(key, JSON.stringify({ ...existed, ...next }));
    } catch (_) {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch (_) {}
    }
  }

  return next;
}

function hasRecentSendingState(data, maxAgeMs = 90000) {
  if (!data || data.status !== "sending") {
    return false;
  }

  const startedAt = Number(data.sendingStartedAt || data.updatedAt || 0);
  return startedAt > 0 && Date.now() - startedAt < maxAgeMs;
}

function buildChatSendSignature(data, messageText) {
  const params = new URLSearchParams(location.search);
  const currentJobId = extractBossJobId(params.get("jobId") || "");
  const rawDataJobId = (data.job && (data.job.id || data.job.jobId)) || "";
  const dataJobId = extractBossJobId(rawDataJobId);
  const bossId =
    params.get("bossId") ||
    params.get("encryptBossId") ||
    params.get("friendId") ||
    params.get("uid") ||
    "";

  return JSON.stringify({
    jobId: currentJobId || dataJobId || "",
    bossId: String(bossId || ""),
    message: normalizeChatText(messageText).slice(0, 240),
  });
}

function readChatSendRecord() {
  try {
    const raw = sessionStorage.getItem(CHAT_SEND_RECORD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function getChatSendRecordMaxAge(status) {
  if (status === "sent") {
    return CHAT_SEND_SENT_MAX_AGE_MS;
  }
  if (status === "failed") {
    return CHAT_SEND_FAILED_MAX_AGE_MS;
  }
  return CHAT_SEND_SENDING_MAX_AGE_MS;
}

function getRecentChatSendRecord(signature) {
  if (!signature) {
    return null;
  }

  const record = readChatSendRecord();
  if (!record || record.signature !== signature) {
    return null;
  }

  const updatedAt = Number(record.updatedAt || 0);
  if (!updatedAt) {
    return null;
  }

  const age = Date.now() - updatedAt;
  const maxAge = getChatSendRecordMaxAge(record.status);
  if (age < 0 || age > maxAge) {
    return null;
  }

  return record;
}

function writeChatSendRecord(signature, status, extra = {}) {
  if (!signature) {
    return null;
  }

  const record = {
    signature,
    status,
    updatedAt: Date.now(),
    ...extra,
  };

  try {
    sessionStorage.setItem(CHAT_SEND_RECORD_KEY, JSON.stringify(record));
  } catch (_) {}

  return record;
}

function clearBossChatCheckTimer() {
  if (window.__bossChatCheckTimer) {
    clearInterval(window.__bossChatCheckTimer);
    window.__bossChatCheckTimer = null;
  }
}

function clearBossChatStartDelayTimer() {
  if (window.__bossChatStartDelayTimer) {
    clearTimeout(window.__bossChatStartDelayTimer);
    window.__bossChatStartDelayTimer = null;
  }
}

function stopChatPollingTimers() {
  if (window.__bossChatTimer) {
    clearInterval(window.__bossChatTimer);
    window.__bossChatTimer = null;
  }
  clearBossChatCheckTimer();
  clearBossChatStartDelayTimer();
}

function fillAndSendFromLocalStorage() {
  // 并发锁：防止多次轮询同时进入导致重复发送
  if (window.__bossChatSending) return;

  if (!isChatPage()) return;

  const raw = localStorage.getItem("bossAi:lastHighJob");
  if (!raw) {
    window.__bossAiLog("❌ localStorage 中无 lastHighJob 数据，跳过。");
    return;
  }

  let data;
  try { data = JSON.parse(raw); } catch (_) {
    window.__bossAiLog("❌ lastHighJob JSON 解析失败，跳过。");
    return;
  }

  if (!data || !data.sendMessage) {
    window.__bossAiLog(`❌ lastHighJob 无 sendMessage 字段，跳过。raw=${raw.slice(0, 200)}`);
    return;
  }

  // jobId 一致性检查：确保当前聊天页确实是为这个职位打开的，防止给错误的 Boss 发消息
  const currentJobId = new URLSearchParams(location.search).get("jobId") || "";
  const rawDataJobId = (data.job && (data.job.id || data.job.jobId)) || "";
  // data.job.id 可能是完整路径 "/job_detail/023e3e073170e82d0nV.html"，提取纯 ID 部分
  const dataJobId = extractBossJobId(rawDataJobId);
  window.__bossAiLog(`jobId检查: URL里=${currentJobId}, 数据里(原始)=${rawDataJobId}, 提取后=${dataJobId}, sent=${data.sent}`);
  if (currentJobId && dataJobId && currentJobId !== dataJobId) {
    window.__bossAiLog(`❌ jobId 不一致，跳过。URL=${currentJobId}, data=${dataJobId}`);
    return;
  }

  if (data.sent || data.status === "sent") {
    window.__bossAiLog(`❌ 该职位已标记为已发送，跳过（jobId=${dataJobId || "未知"}）。`);
    return;
  }

  if (hasRecentSendingState(data)) {
    window.__bossAiLog(
      `⏳ 该职位仍处于发送确认中，跳过重复发送（jobId=${dataJobId || "未知"}）。`
    );
    return;
  }

  if (data.status === "sending") {
    window.__bossAiLog(
      `⚠️ 检测到过期的 sending 状态，重置后允许重新尝试（jobId=${dataJobId || "未知"}）。`
    );
    data = updateStoredSendState(data, {
      status: "pending",
      sendingStartedAt: null,
      sendAttemptId: null,
    });
  }

  const baseMsg = String(data.sendMessage || "").trim();
  if (!baseMsg) {
    window.__bossAiLog("❌ sendMessage 为空字符串，跳过。");
    return;
  }

  const prefix = "您好，我是求职者的AI Agent机器人，";
  let body = baseMsg.replace(/^[您你][好您好]*[，,。\.、\s]*/i, "");
  if (!body) body = baseMsg;
  const finalMsg = prefix + body;
  const chatSignature = buildChatSendSignature(data, finalMsg);
  window.__bossAiLog(`✅ 准备发送消息: ${finalMsg.slice(0, 80)}`);

  if (hasMessageBubble(finalMsg)) {
    window.__bossAiLog("✅ 当前会话中已存在相同消息，直接标记为已发送并跳过重复发送。");
    stopChatPollingTimers();
    window.__bossChatSending = false;
    window.__bossChatAttemptId = null;
    window.__bossChatSignature = null;
    data = updateStoredSendState(data, {
      sent: true,
      status: "sent",
      sendingStartedAt: null,
      sendAttemptId: null,
      sentAt: data.sentAt || Date.now(),
    });
    writeChatSendRecord(chatSignature, "sent");

    try {
      if (localStorage.getItem("bossAi:autoRunning") === "1") {
        localStorage.setItem("bossAi:autoRestart", "1");
        redirectBackToConfiguredJobList(1500);
      }
    } catch (_) {}

    return;
  }

  const recentRecord = getRecentChatSendRecord(chatSignature);
  if (recentRecord) {
    window.__bossAiLog(
      `⏳ 当前会话近期已处理过同一条消息（状态=${recentRecord.status}），跳过重复发送。`
    );
    return;
  }

  // ── Step 1: 找输入框 ──
  const input = findChatInput();
  window.__bossAiLog(`Step1 查找输入框: ${input ? `找到 #${input.id || input.className}` : "❌ 未找到"}`);
  if (!input) return;

  // ── Step 2: 写入消息 ──
  try {
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      input.focus();
      input.value = finalMsg;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      window.__bossAiLog("Step2 TEXTAREA/INPUT 填充完成");
    } else if (input.isContentEditable) {
      window.focus();
      input.focus();
      window.__bossAiLog(`Step2 contenteditable: hasFocus=${document.hasFocus()}, activeEl=${document.activeElement?.id || document.activeElement?.className}`);

      // 方法A：通过系统剪贴板 copy→paste，触发完全 trusted 的 paste 事件
      let methodAWorked = false;
      try {
        const ta = document.createElement("textarea");
        ta.value = finalMsg;
        ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(ta);
        if (copied) {
          input.focus();
          try {
            const r = document.createRange();
            r.selectNodeContents(input);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
          } catch (_) {}
          const pasted = document.execCommand("paste");
          methodAWorked = pasted && !!(input.innerText || "").trim();
          window.__bossAiLog(`方法A(clipboard): copy=${copied}, paste=${pasted}, innerText="${(input.innerText||'').slice(0,30)}", worked=${methodAWorked}`);
        } else {
          window.__bossAiLog("方法A: execCommand copy 返回 false（可能窗口无焦点）");
        }
      } catch (e) {
        window.__bossAiLog(`方法A 异常: ${e}`);
      }

      // 方法B：execCommand insertText（触发 trusted input 事件）
      if (!methodAWorked && !(input.innerText || "").trim()) {
        try {
          const range = document.createRange();
          range.selectNodeContents(input);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) {}
        const execRes = document.execCommand("insertText", false, finalMsg);
        window.__bossAiLog(`方法B(execCommand): result=${execRes}, innerText="${(input.innerText||'').slice(0,30)}"`);
      }

      // 方法C：合成 ClipboardEvent
      if (!(input.innerText || "").trim()) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", finalMsg);
          input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch (_) {}
        window.__bossAiLog(`方法C(synthetic paste): innerText="${(input.innerText||'').slice(0,30)}"`);
      }

      // 方法D：直接设置 innerText + 派发 InputEvent（最后兜底）
      if (!(input.innerText || "").trim()) {
        input.innerText = finalMsg;
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: finalMsg, bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        try {
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(input);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) {}
        window.__bossAiLog(`方法D(innerText): innerText="${(input.innerText||'').slice(0,30)}"`);
      }
    }
  } catch (e) {
    window.__bossAiLog(`❌ 写入消息时出错: ${e}`);
    return;
  }

  // ── Step 3: 验证写入 ──
  const textAfterFill = getInputText(input).trim();
  const sendBtnCheck  = findSendButton();
  const btnDisabled   = sendBtnCheck ? (sendBtnCheck.classList.contains("disabled") || sendBtnCheck.disabled) : null;
  window.__bossAiLog(`Step3 验证: text="${textAfterFill.slice(0,30)}", 发送按钮disabled=${btnDisabled}`);
  if (!textAfterFill) {
    window.__bossAiLog("❌ 输入框填充后仍为空，本轮放弃。");
    return;
  }

  // 写入成功后加锁，防止后续轮询重复处理
  const sendAttemptId = `${dataJobId || "unknown"}:${Date.now()}`;
  data = updateStoredSendState(data, {
    sent: false,
    status: "sending",
    sendingStartedAt: Date.now(),
    sendAttemptId,
    lastSendMessage: finalMsg,
  });
  writeChatSendRecord(chatSignature, "sending", { sendAttemptId });
  window.__bossChatSending = true;
  window.__bossChatAttemptId = sendAttemptId;
  window.__bossChatSignature = chatSignature;
  // 快照当前消息气泡数，用于后续验证消息是否真正发出
  const msgCountBefore = countChatMessages();

  // ── Step 4: 发送 ──
  // 优先点击发送按钮；若找不到按钮则用 Enter 键兜底（不同时使用，防止重复发送）
  const sendBtn = findSendButton();
  const sendMethod = sendBtn ? "button" : "enter";
  if (sendBtn) {
    const wasBtnDisabled = sendBtn.classList.contains("disabled") || sendBtn.disabled;
    try { sendBtn.classList.remove("disabled"); sendBtn.removeAttribute("disabled"); } catch (_) {}
    sendBtn.click();
    window.__bossAiLog(`Step4 点击发送按钮 (点击前disabled=${wasBtnDisabled})`);
  } else {
    try {
      const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent("keydown", init));
      input.dispatchEvent(new KeyboardEvent("keyup",   init));
    } catch (_) {}
    window.__bossAiLog("Step4 未找到发送按钮，用 Enter 键尝试发送");
  }

  // ── Step 5: 轮询检测是否发送成功（输入框被清空）──
  clearBossChatCheckTimer();

  const MAX_CHECKS = 24;
  const EMPTY_CONFIRM_CHECKS = 3;
  const MIN_RETRY_CHECKS = 8;
  let checks = 0;
  let consecutiveEmpty = 0;
  let buttonWasEnabled = false;
  window.__bossChatCheckTimer = setInterval(() => {
    checks += 1;
    const curInput = findChatInput();
    const curText  = curInput ? getInputText(curInput).trim() : null;

    if (curText === null) { consecutiveEmpty = 0; return; }

    const curBtn = findSendButton();
    const isBtnEnabled = curBtn && !curBtn.classList.contains("disabled") && !curBtn.disabled;
    if (isBtnEnabled) buttonWasEnabled = true;

    window.__bossAiLog(`checkTimer #${checks}: text="${curText.slice(0,20)}", btnEnabled=${isBtnEnabled}, consEmpty=${consecutiveEmpty}`);

    if (curText === "") {
      consecutiveEmpty += 1;
      const msgCountAfter = countChatMessages();
      const countIncreased = msgCountBefore >= 0 && msgCountAfter > msgCountBefore;
      const messageFound = hasMessageBubble(finalMsg);
      const acceptedByPage =
        countIncreased ||
        messageFound ||
        sendMethod === "button" ||
        buttonWasEnabled;

      window.__bossAiLog(
        `空框验证: countBefore=${msgCountBefore}, countAfter=${msgCountAfter}, btnWasEnabled=${buttonWasEnabled}, messageFound=${messageFound}, sendMethod=${sendMethod}`
      );

      if (consecutiveEmpty < EMPTY_CONFIRM_CHECKS) {
        return;
      }

      if (!acceptedByPage && checks < MIN_RETRY_CHECKS) {
        window.__bossAiLog("⏳ 输入框已清空，但仍在等待明确成功信号，继续观察。");
        return;
      }

      // 连续空框且已有足够成功信号，直接认定发送成功，避免误判导致重复发送
      if (acceptedByPage) {
        clearBossChatCheckTimer();
        window.__bossChatSending = false;
        window.__bossChatAttemptId = null;
        window.__bossChatSignature = null;
        if (window.__bossChatTimer) {
          clearInterval(window.__bossChatTimer);
          window.__bossChatTimer = null;
        }

        data = updateStoredSendState(data, {
          sent: true,
          status: "sent",
          sendingStartedAt: null,
          sendAttemptId: null,
          sentAt: Date.now(),
        });
        writeChatSendRecord(chatSignature, "sent", { sendAttemptId });

        const verifyDetail = countIncreased
          ? `消息数 ${msgCountBefore}→${msgCountAfter}`
          : messageFound
            ? "消息文本已出现在会话中"
            : sendMethod === "button"
              ? "发送按钮触发后输入框稳定清空"
              : "发送动作触发后输入框稳定清空";
        window.__bossAiLog(`✅ 发送成功！${verifyDetail}，职位=${(data.job && (data.job.title || data.job.listTitle)) || "未知"}，2.5秒后返回列表`);
        chrome.runtime?.sendMessage?.({ type: "LOG", text: `聊天页发送成功（${verifyDetail}）：${(data.job && (data.job.title || data.job.listTitle)) || "未知"}` });

        try { localStorage.setItem("bossAi:autoRestart", "1"); } catch (_) {}
        redirectBackToConfiguredJobList(2500);
        return;
      }

      if (checks >= MIN_RETRY_CHECKS) {
        window.__bossAiLog("↩️ 连续空框但缺少成功信号，重置为待重试，避免锁死。");
        consecutiveEmpty = 0;
        window.__bossChatSending = false;
        window.__bossChatAttemptId = null;
        window.__bossChatSignature = null;
        clearBossChatCheckTimer();
        data = updateStoredSendState(data, {
          sent: false,
          status: "pending",
          sendingStartedAt: null,
          sendAttemptId: null,
        });
        writeChatSendRecord(chatSignature, "failed", {
          sendAttemptId,
          reason: "empty-without-signal",
        });
        return;
      }

    } else {
      consecutiveEmpty = 0;
      if (checks >= MAX_CHECKS) {
        clearBossChatCheckTimer();
        window.__bossChatSending = false;
        window.__bossChatAttemptId = null;
        window.__bossChatSignature = null;
        data = updateStoredSendState(data, {
          sent: false,
          status: "pending",
          sendingStartedAt: null,
          sendAttemptId: null,
        });
        writeChatSendRecord(chatSignature, "failed", {
          sendAttemptId,
          reason: "timeout",
        });
        window.__bossAiLog("⚠️ 超时：输入框仍有内容，发送可能失败，请手动处理");
        chrome.runtime?.sendMessage?.({ type: "LOG", text: "聊天页：超时，输入框仍有内容，发送可能失败。" });
      }
    }
  }, 600);
}

function ensureChatAutoSendStarted() {
  if (!isChatPage()) return;

  window.__bossAiLog(`🚀 ensureChatAutoSendStarted, URL=${location.href}`);

  if (
    window.__bossChatSending ||
    window.__bossChatCheckTimer ||
    window.__bossChatTimer ||
    window.__bossChatStartDelayTimer
  ) {
    window.__bossAiLog("⏳ 已有发送流程在运行，跳过重复启动。");
    return;
  }

  const MAX_TRIES = 40;
  const INTERVAL_MS = 1000;
  let tries = 0;

  chrome.runtime?.sendMessage?.({ type: "LOG", text: "聊天页检测到进入会话，开始轮询尝试自动填充/发送消息。" });

  window.__bossChatStartDelayTimer = setTimeout(() => {
    window.__bossChatStartDelayTimer = null;
    window.__bossAiLog("⏰ 2秒延迟结束，开始轮询输入框");
    window.__bossChatTimer = setInterval(() => {
      tries += 1;
      if (tries === 1) window.__bossAiLog(`轮询开始，localStorage: ${JSON.stringify(JSON.parse(localStorage.getItem("bossAi:lastHighJob") || "{}")).slice(0, 200)}`);
      fillAndSendFromLocalStorage();
      if (tries >= MAX_TRIES && window.__bossChatTimer) {
        clearInterval(window.__bossChatTimer);
        window.__bossChatTimer = null;
        window.__bossAiLog("❌ 超过40次重试，放弃，请手动处理");
        chrome.runtime?.sendMessage?.({ type: "LOG", text: "长时间多次尝试后仍未能在聊天页自动填充/发送消息，后续请手动处理该会话。" });
      }
    }, INTERVAL_MS);
  }, 2000);
}

// 初次加载时，如果当前就是聊天页，立即启动一次
if (isChatPage()) {
  window.__bossAiLog("📄 页面初始化时已在聊天页，启动自动发送");
  ensureChatAutoSendStarted();
}

// 适配 Boss 的 SPA 路由：监听 URL 变化，进入 /web/geek/chat?... 时再启动一次自动发消息逻辑
(function watchUrlForChat() {
  let lastHref = location.href;
  setInterval(() => {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    window.__bossAiLog(`🔗 URL 变化: ${href.slice(0, 100)}`);
    if (isChatPage()) {
      window.__bossAiLog("📩 URL 跳转到聊天页，启动自动发送");
      chrome.runtime?.sendMessage?.({ type: "LOG", text: "检测到 URL 变更进入聊天页，重新启动自动发消息轮询。" });
      ensureChatAutoSendStarted();
    }
  }, 800);
})();

// ========= 在 Boss 列表页根据标记自动重新启动“从头执行”的自动浏览 =========

function isJobListPage() {
  const href = location.href;
  return href.includes("/web/geek/jobs");
}

function logFromContent(text) {
  try {
    chrome.runtime?.sendMessage?.({ type: "LOG", text });
  } catch (_) {}
}

function ensureAutoBrowseState() {
  if (!window.__bossAutoBrowse) {
    window.__bossAutoBrowse = {
      started: false,
      prepareTimer: null,
      scrollTimer: null,
      clickTimer: null,
      phase: null,
      queryIndex: 0,
      searchQueries: [],
      currentCityId: "",
      currentQuery: "",
      cityIndex: 0,
      cities: [],
      maxTotalJobClicksPerRun: 30,
      totalClickedCount: getSavedTotalClickCount(),
      scrollCountThisCity: 0,
      scrollsWithNoNewCards: 0,
      searchRecoveryCount: 0,
    };
  }
  return window.__bossAutoBrowse;
}

function getJobElementsForAuto() {
  // 排除右侧详情面板（.job-detail-box）内的推荐职位链接，避免滚动到底时误触打开新窗口
  const detailPanel = document.querySelector('.job-detail-box, [class*="job-detail-box"]');
  const allLinks = Array.from(document.querySelectorAll('a[href*="/job_detail/"]'));
  const jobLinks = detailPanel
    ? allLinks.filter(el => !detailPanel.contains(el))
    : allLinks;
  if (jobLinks.length) return jobLinks;
  const allWraps = Array.from(document.querySelectorAll(".job-card-wrap"));
  return detailPanel
    ? allWraps.filter(el => !detailPanel.contains(el))
    : allWraps;
}

// 这里直接使用窗口滚动，避免误选到不可滚动的容器导致“看起来不动”
function getScrollContainerForAuto() {
  return window;
}

function getElementClassNameForLog(element) {
  if (!element) {
    return "";
  }

  const className = element.className;
  if (typeof className === "string") {
    return className;
  }
  if (className && typeof className.baseVal === "string") {
    return className.baseVal;
  }
  if (className && typeof className.animVal === "string") {
    return className.animVal;
  }

  return String(className || "");
}

function getElementTextForLog(element, maxLength = 40) {
  return String(element?.innerText || element?.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function simulateClickAt(el) {
  el.scrollIntoView({ behavior: "instant", block: "center" });
  const rect = el.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);
  const topEl = document.elementFromPoint(cx, cy) || el;
  logFromContent(
    `[simulateClick] 坐标=(${cx},${cy})，目标=<${el.tagName} "${getElementTextForLog(el, 12)}">，` +
    `顶层元素=<${topEl.tagName} class="${getElementClassNameForLog(topEl).slice(0, 30)}" txt="${getElementTextForLog(topEl, 12)}">`
  );
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  topEl.dispatchEvent(new MouseEvent("mousedown", opts));
  topEl.dispatchEvent(new MouseEvent("mouseup", opts));
  topEl.dispatchEvent(new MouseEvent("click", opts));
  return topEl;
}

function setNativeValueForSearchInput(element, value) {
  if (!element) {
    return;
  }

  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) {
    descriptor.set.call(element, value);
    return;
  }

  element.value = value;
}

function findSearchInputForAuto() {
  const selectors = [
    ".job-search-box .job-search-form .search-input-box input",
    ".job-search-box .job-search-form .input-wrap .input",
    ".job-search-form .search-input-box input",
    ".job-search-form .input-wrap .input",
    ".job-search-form input[type='text']",
    "input[placeholder*='职位']",
    "input[placeholder*='岗位']",
    "input[placeholder*='公司']",
    "input[placeholder*='搜索']",
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element;
    }
  }

  return null;
}

function syncSearchFormForAuto(target) {
  const query = normalizeSearchQueryText(target?.query);
  if (!query) {
    logFromContent("[searchForm] 未提供有效关键词，跳过同步搜索框。");
    return false;
  }

  const input = findSearchInputForAuto();
  if (!input) {
    logFromContent(
      `[searchForm] 未找到职位搜索输入框，当前仍使用 URL 参数 cityId=${target?.cityId || ""}，query=${query}`
    );
    return false;
  }

  const previousValue = normalizeSearchQueryText(
    input.value || input.getAttribute("value") || ""
  );

  input.focus();
  setNativeValueForSearchInput(input, query);
  input.setAttribute("value", query);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();

  logFromContent(
    `[searchForm] 已同步搜索框：before="${previousValue}"，after="${query}"`
  );
  return true;
}

function prepareSearchButtonHrefForAuto(searchButton, target) {
  if (!(searchButton instanceof HTMLAnchorElement)) {
    return null;
  }

  const targetUrl = buildJobListUrlForConfig(target?.cityId, target?.query);
  const previousHref = searchButton.href || searchButton.getAttribute("href") || "";
  searchButton.setAttribute("href", targetUrl);
  searchButton.href = targetUrl;
  logFromContent(
    `[searchBtn] 已覆盖搜索按钮 href：before="${previousHref}"，after="${searchButton.href}"`
  );
  return targetUrl;
}

function clickSearchButtonForAuto(target) {
  logFromContent("[searchBtn] ▶ clickSearchButtonForAuto 被调用，当前 URL=" + location.href);
  syncSearchFormForAuto(target);

  const cityDialog = document.querySelector(".city-list-hot, .dialog-city, [class*='city'][class*='dialog'], [class*='city'][class*='modal']");
  logFromContent(`[searchBtn] 搜索区域检测：城市弹层=${cityDialog ? getElementClassNameForLog(cityDialog) : "未检测到"}`);

  // 收集所有文字精确等于"搜索"的叶子元素（排除含大量子内容的容器）
  const allEls = Array.from(document.querySelectorAll("button, a, span, input[type=submit], input[type=button]"));
  const exactMatch = allEls.filter(el => (el.innerText || el.textContent || "").trim() === "搜索");

  // 退一步：文字包含"搜索"但自身文字较短（<=4字）
  const looseMatch = Array.from(document.querySelectorAll("button, a, span, input[type=submit], input[type=button]"))
    .filter(el => {
      const txt = (el.innerText || el.textContent || "").trim();
      return txt.includes("搜索") && txt.length <= 4;
    });

  logFromContent(
    `[searchBtn] 精确匹配"搜索"=${exactMatch.length}个，宽松匹配=${looseMatch.length}个：` +
    looseMatch
      .map(
        (e) =>
          `<${e.tagName} class="${getElementClassNameForLog(e).slice(0, 20)}" txt="${getElementTextForLog(e, 20)}">`
      )
      .join(" | ")
  );

  const searchButton = exactMatch.find(e => e.tagName === "BUTTON")
    || exactMatch[0]
    || looseMatch.find(e => e.tagName === "BUTTON")
    || looseMatch[0];

  if (!searchButton) {
    // 最后兜底：打印页面上所有 button 的文字，供人工核对
    const allBtnTxts = Array.from(document.querySelectorAll("button"))
      .map(b => `"${(b.innerText||b.textContent||"").trim().slice(0,15)}"`)
      .join(", ");
    logFromContent(`[searchBtn] ⚠️ 完全未找到搜索元素。页面全部 button：${allBtnTxts}`);
    return false;
  }

  const preparedHref = prepareSearchButtonHrefForAuto(searchButton, target);
  setSearchResumeSignal(target);
  setAutoRestartFlag("搜索按钮可能触发列表页刷新");
  simulateClickAt(searchButton);
  logFromContent(`[searchBtn] ✅ 点击完毕，目标=<${searchButton.tagName} class="${getElementClassNameForLog(searchButton)}" txt="${getElementTextForLog(searchButton, 20)}">`);

  if (preparedHref) {
    setTimeout(() => {
      if (!isJobListPage() || isCurrentJobListMatchingTarget(target)) {
        return;
      }

      logFromContent(
        `[searchBtn] 点击后快速校验仍未命中目标，立即强制跳转。currentUrl=${location.href}，targetUrl=${preparedHref}`
      );
      location.href = preparedHref;
    }, 400);
  }

  return true;
}

function clearAutoBrowsePrepareTimer() {
  const state = ensureAutoBrowseState();
  if (state.prepareTimer) {
    clearTimeout(state.prepareTimer);
    state.prepareTimer = null;
  }
}

function navigateToAutomationTarget(target, reason) {
  const state = ensureAutoBrowseState();
  const targetUrl = buildJobListUrlForConfig(target.cityId, target.query);

  saveRotationIndices(target.queryIndex, target.cityIndex);
  setPendingAutomationTarget(target);
  syncAutoBrowseConfig(
    state,
    {
      cityIds: state.cities,
      searchKeywords: state.searchQueries,
    },
    target
  );

  state.phase = "navigate";
  logFromContent(
    `[navigate] ${reason}，切换到 cityId=${target.cityId}，关键词=${target.query}，URL=${targetUrl}`
  );

  try {
    setAutoRestartFlag(reason);
  } catch (_) {}

  if (isCurrentJobListMatchingTarget(target)) {
    logFromContent("[navigate] 当前列表页已经是目标组合，强制刷新页面后继续执行。");
    location.reload();
    return;
  }

  location.href = targetUrl;
}

function scheduleSearchClickAndCrawl(target, attempt = 1) {
  const state = ensureAutoBrowseState();
  clearAutoBrowsePrepareTimer();
  state.phase = "refresh_search";

  state.prepareTimer = setTimeout(() => {
    state.prepareTimer = null;

    if (!state.started || !isJobListPage()) {
      return;
    }

    const clicked = clickSearchButtonForAuto(target);
    if (!clicked) {
      if (attempt >= 8) {
        logFromContent(
          `[searchBtn] 连续 ${attempt} 次未找到搜索按钮，停止本轮自动执行。`
        );
        stopAutoBrowseAndChat("未找到搜索按钮");
        return;
      }

      logFromContent(
        `[searchBtn] 第 ${attempt} 次未找到搜索按钮，稍后重试。cityId=${target.cityId}，关键词=${target.query}`
      );
      scheduleSearchClickAndCrawl(target, attempt + 1);
      return;
    }

    state.phase = "wait_search_result";
    state.prepareTimer = setTimeout(() => {
      state.prepareTimer = null;
      if (!state.started || !isJobListPage()) {
        return;
      }

      if (!isCurrentJobListMatchingTarget(target)) {
        state.searchRecoveryCount =
          (Number(state.searchRecoveryCount) || 0) + 1;
        const currentParams = parseJobListParams(location.href);

        if (state.searchRecoveryCount > 3) {
          logFromContent(
            `[searchBtn] 搜索后页面仍未命中目标 cityId=${target.cityId}，关键词=${target.query}，实际 currentUrl=${location.href}，actualCityId=${currentParams.cityId}，actualQuery=${currentParams.query}，连续修正 ${state.searchRecoveryCount} 次失败，停止执行。`
          );
          stopAutoBrowseAndChat("搜索参数未命中配置");
          return;
        }

        logFromContent(
          `[searchBtn] 搜索后页面参数偏离目标，第 ${state.searchRecoveryCount} 次重新拉回 cityId=${target.cityId}，关键词=${target.query}。currentUrl=${location.href}，actualCityId=${currentParams.cityId}，actualQuery=${currentParams.query}`
        );
        clearSearchResumeSignal();
        navigateToAutomationTarget(
          target,
          `搜索后页面参数偏离目标，第 ${state.searchRecoveryCount} 次重新应用配置`
        );
        return;
      }

      state.searchRecoveryCount = 0;
      clearSearchResumeSignal();
      clearAutoRestartFlag();
      clearPendingAutomationTarget();

      logFromContent(
        `自动浏览：搜索已刷新，开始爬取 cityId=${target.cityId}，关键词=${target.query}。`
      );
      startCrawlingCurrentCityFromList();
    }, 2200);
  }, attempt === 1 ? 1400 : 800);
}

function switchToNextConfiguredTargetForAuto(reason = "当前组合已完成") {
  const state = ensureAutoBrowseState();
  const settings = {
    cityIds: state.cities || [],
    searchKeywords: state.searchQueries || [],
  };

  logFromContent(
    `[switchTarget] reason=${reason}，当前 cityIndex=${state.cityIndex}/${settings.cityIds.length}，` +
      `queryIndex=${state.queryIndex}/${settings.searchKeywords.length}`
  );

  if (state.scrollTimer) {
    clearInterval(state.scrollTimer);
    state.scrollTimer = null;
  }
  if (state.clickTimer) {
    clearInterval(state.clickTimer);
    state.clickTimer = null;
  }
  clearAutoBrowsePrepareTimer();

  if (!hasValidAutomationSettings(settings)) {
    logFromContent("[switchTarget] 缺少城市 ID 或搜索关键词配置，停止自动执行。");
    stopAutoBrowseAndChat("缺少自动执行配置");
    return;
  }

  const nextTarget = getNextAutomationTarget(settings, {
    cityIndex: state.cityIndex,
    queryIndex: state.queryIndex,
    cityId: state.currentCityId,
    query: state.currentQuery,
  });

  navigateToAutomationTarget(nextTarget, reason);
}

function startCrawlingCurrentCityFromList() {
  const state = ensureAutoBrowseState();
  state.phase = "crawling";
  state.scrollCountThisCity = 0;
  state.scrollsWithNoNewCards = 0;
  state.clicked = new Set();
  state.clickIndex = 0;

  const SCROLLS_NO_NEW_JOBS_THRESHOLD = 6;
  const MAX_TOTAL_JOB_CLICKS = normalizeConfiguredMaxJobClicks(
    state.maxTotalJobClicksPerRun
  );
  const SCROLL_INTERVAL = 2000;
  const CLICK_INTERVAL = 3000;
  clearAutoRestartFlag();
  clearPendingAutomationTarget();

  logFromContent(
    `自动浏览：本次运行总点击上限=${MAX_TOTAL_JOB_CLICKS}，所有城市和关键词组合共享，达到后自动停止。`
  );

  state.scrollTimer = setInterval(() => {
    const container = getScrollContainerForAuto();
    if (container === window) {
      window.scrollBy(0, 600);
    } else {
      container.scrollTop += 600;
    }
    state.scrollCountThisCity += 1;
    const jobs = getJobElementsForAuto();

    // jobs.length===0：DOM 中完全找不到职位卡片（页面底部/加载失败/DOM 变更）
    if (jobs.length === 0) {
      state.scrollsWithNoNewCards += 1;
      logFromContent(
        `[scrollTimer] 第 ${state.scrollCountThisCity} 次滚动 ⚠️ DOM 中未找到任何职位卡片，` +
        `clickIndex=${state.clickIndex}，scrollsWithNoNewCards=${state.scrollsWithNoNewCards}/${SCROLLS_NO_NEW_JOBS_THRESHOLD}，` +
        `clickTimer=${state.clickTimer ? "运行中" : "null"}，scrollTimer=运行中`
      );
      if (state.clickTimer) { clearInterval(state.clickTimer); state.clickTimer = null; }
      if (state.scrollsWithNoNewCards >= SCROLLS_NO_NEW_JOBS_THRESHOLD) {
        logFromContent("[scrollTimer] 触达无卡片阈值，准备切换到下一个配置组合。");
        switchToNextConfiguredTargetForAuto("无可用职位卡片");
      }
      return;
    }

    const allClicked =
      state.clickIndex >= jobs.length && jobs.length > 0;
    if (allClicked) {
      // 停止点击定时器，防止在无新卡片期间发生"幽灵点击"（误触底部 <a> 链接打开新窗口）
      if (state.clickTimer) {
        clearInterval(state.clickTimer);
        state.clickTimer = null;
      }
      state.scrollsWithNoNewCards += 1;
      logFromContent(
        `[scrollTimer] 第 ${state.scrollCountThisCity} 次滚动 — allClicked：` +
        `jobs=${jobs.length}，clickIndex=${state.clickIndex}，` +
        `scrollsWithNoNewCards=${state.scrollsWithNoNewCards}/${SCROLLS_NO_NEW_JOBS_THRESHOLD}`
      );
      if (
        state.scrollsWithNoNewCards >=
        SCROLLS_NO_NEW_JOBS_THRESHOLD
      ) {
        logFromContent("[scrollTimer] 触达无新卡片阈值，准备切换到下一个配置组合。");
        switchToNextConfiguredTargetForAuto("当前组合已触底");
      }
    } else {
      // 若之前因无新卡片暂停了点击定时器，现在新卡片已加载，重新启动
      if (state.scrollsWithNoNewCards > 0 && !state.clickTimer) {
        logFromContent(
          `[scrollTimer] 检测到新卡片加载（jobs=${jobs.length}），重新启动点击循环（之前 scrollsWithNoNewCards=${state.scrollsWithNoNewCards}）。`
        );
        state.clickTimer = setInterval(runOneClickCycle, CLICK_INTERVAL);
      }
      state.scrollsWithNoNewCards = 0;
      logFromContent(
        `[scrollTimer] 第 ${state.scrollCountThisCity} 次滚动，jobs=${jobs.length}，clickIndex=${state.clickIndex}，clickTimer=${state.clickTimer ? "运行中" : "null"}`
      );
    }
  }, SCROLL_INTERVAL);

  function runOneClickCycle() {
    const state = ensureAutoBrowseState();
    const jobs = getJobElementsForAuto();
    logFromContent(
      `[clickCycle] 触发：jobs=${jobs.length}，clickIndex=${state.clickIndex}，clicked.size=${state.clicked ? state.clicked.size : 0}，scrollsWithNoNew=${state.scrollsWithNoNewCards}`
    );
    if (!jobs.length) {
      logFromContent("[clickCycle] jobs.length=0，跳过本次点击。");
      return;
    }
    if (state.clickIndex >= jobs.length) {
      // 所有可见卡片已处理完；主动清除本定时器，防止持续运行误触底部 <a> 链接（打开新窗口）。
      // 滚动定时器会在新卡片出现时重启点击，或在触底阈值达到时切换到下一个配置组合。
      clearInterval(state.clickTimer);
      state.clickTimer = null;
      logFromContent(
        `[clickCycle] clickIndex(${state.clickIndex}) >= jobs(${jobs.length})，全部卡片已处理完，暂停点击定时器，等待滚动加载更多或切换到下一个配置组合。`
      );
      return;
    }

    if ((state.totalClickedCount || 0) >= MAX_TOTAL_JOB_CLICKS) {
      logFromContent(
        `自动浏览：本次运行已达到总点击上限 ${MAX_TOTAL_JOB_CLICKS}，停止自动执行。`
      );
      stopAutoBrowseAndChat("达到本次运行总点击上限");
      return;
    }

    const el = jobs[state.clickIndex++];
    if (!el) return;
    const id =
      el.getAttribute("data-jobid") ||
      el.getAttribute("href") ||
      `idx-${state.clickIndex}`;
    if (state.clicked.has(id)) {
      logFromContent(
        `自动浏览：跳过本轮已点击职位：${id}`
      );
      return;
    }
    state.clicked.add(id);
    state.totalClickedCount = setSavedTotalClickCount(
      (state.totalClickedCount || 0) + 1
    );

    // 暂停“下一个岗位”的定时器，等当前岗位 AI 结果返回后再决定是否继续下一个
    clearInterval(state.clickTimer);
    state.clickTimer = null;

    logFromContent(
      `自动浏览：点击职位：${id}（本次运行累计 ${state.totalClickedCount}/${MAX_TOTAL_JOB_CLICKS}）`
    );
    // 把滚动和点击都放在同一个 setTimeout 内，确保 scrollTimer 不会在对准元素后、点击前
    // 再次 scrollBy 移走目标，导致 elementFromPoint 返回错误元素从而走非信任事件路径。
    // 全程使用 el.click()（isTrusted=true），确保 Boss 的 JS 拦截器一定能处理该事件。
    setTimeout(() => {
      try {
        // 点击前先重新把元素滚到视口（scrollTimer 可能在此期间又滚了一次）
        const cardRectNow = el.getBoundingClientRect();
        const inViewport = cardRectNow.top >= 0 && cardRectNow.bottom <= window.innerHeight;
        if (!inViewport) {
          el.scrollIntoView({ behavior: "instant", block: "nearest" });
        }
        el.click();
      } catch (e) {
        logFromContent("自动浏览：点击职位时出错：" + e);
      }
    }, 600);

    // ====== 点击之后等待详情面板加载，再抓取 DOM 并调用 AI ======
    setTimeout(() => {
      try {
        const job = {};
        job.id = id;

        // 列表卡片：.job-card-wrap > .job-card-box，内有 .job-info、.job-title .job-name、.job-title .job-salary、.tag-list、.job-card-footer、.company-location
        const cardRoot =
          el.closest(".job-card-wrap") ||
          el.closest(".job-card-box") ||
          el.closest(".job-card-wrapper") ||
          el;
        const box = cardRoot.querySelector(".job-card-box") || cardRoot;
        job.listTitle =
          box.querySelector(".job-title .job-name")?.innerText?.trim() ||
          box.querySelector(".job-name")?.innerText?.trim() ||
          el.innerText.trim();
        job.listCompany =
          box.querySelector(".company-name")?.innerText?.trim() ||
          cardRoot.querySelector(".company-name")?.innerText?.trim() ||
          "";
        job.listSalary =
          box.querySelector(".job-title .job-salary")?.innerText?.trim() ||
          box.querySelector(".job-salary")?.innerText?.trim() ||
          "";
        const tagList = box.querySelector(".tag-list");
        job.listMeta = tagList
          ? Array.from(tagList.querySelectorAll("li"))
              .map((li) => li.innerText.trim())
              .filter(Boolean)
              .join(" ")
          : "";

        // 详情右侧面板信息
        const detailRoot =
          document.querySelector(".job-detail-box") ||
          document.querySelector('[class*="job-detail-box"]') ||
          document.body;
        const detailInfo =
          detailRoot.querySelector(".job-detail-info") || detailRoot;

        job.title =
          detailInfo.querySelector(".job-name")?.innerText?.trim() ||
          job.listTitle;
        job.salary =
          detailInfo.querySelector(".job-salary")?.innerText?.trim() ||
          job.listSalary;
        job.company =
          detailRoot.querySelector(".company-info .name, .company-name")?.innerText?.trim() ||
          job.listCompany;
        const areaEl = detailRoot.querySelector(
          ".job-area, .company-location, [class*='job-area'], [class*='address']"
        );
        job.city = areaEl?.innerText?.trim() || "";
        const detailTagList = detailRoot.querySelector(".tag-list");
        job.tags = detailTagList
          ? Array.from(detailTagList.querySelectorAll("li"))
              .map((li) => li.innerText.trim())
              .filter(Boolean)
              .join(" ")
          : "";

        // 职位描述
        const body = detailRoot.querySelector(".job-detail-body");
        let detailText = "";
        if (body) {
          const titles = body.querySelectorAll(".title");
          for (const t of titles) {
            if (/职位描述|岗位职责|工作内容/.test(t.innerText || "")) {
              let next = t.nextElementSibling;
              while (next) {
                if (next.classList.contains("desc")) {
                  detailText = next.innerText?.trim() || "";
                  break;
                }
                next = next.nextElementSibling;
              }
              break;
            }
          }
          if (!detailText) {
            const descs = body.querySelectorAll(".desc");
            detailText = Array.from(descs)
              .map((n) => n.innerText?.trim())
              .filter(Boolean)
              .join("\n\n");
          }
          if (!detailText) {
            const anyDesc = body.querySelector("[class*='desc']");
            if (anyDesc && anyDesc.innerText?.length > 50)
              detailText = anyDesc.innerText.trim();
          }
        }
        if (!detailText)
          detailText =
            detailRoot.querySelector(".job-sec-text, [class*='job-sec']")?.innerText?.trim() ||
            "";
        job.detailText = detailText;

        job.url = location.href;

        logFromContent(
          `[DOM] 采集成功：title="${job.title}"，salary="${job.salary}"，company="${job.company}"，id="${job.id}"`
        );

        const storageKey =
          "bossAiJob:" + (job.id || job.url || "");
        try {
          const existedRaw = localStorage.getItem(storageKey);
          if (existedRaw) {
            const existed = JSON.parse(existedRaw);
            if (
              existed &&
              (existed.sent || existed.status === "sent")
            ) {
              logFromContent(
                `[DOM] 职位「${job.title}」已标记为已发送，跳过 AI 评估，resumeNextJob。`
              );
              resumeNextJob("已发送跳过");
              return;
            }
            if (
              existed &&
              (existed.scored ||
                typeof existed.score === "number")
            ) {
              logFromContent(
                `[DOM] 职位「${job.title}」已评估过(score=${existed.score})，跳过重复评估，resumeNextJob。`
              );
              resumeNextJob("已评估跳过");
              return;
            }
          }
        } catch (e) {
          logFromContent(
            "[DOM] 读取 localStorage 记录失败：" + e
          );
        }

        function resumeNextJob(reason) {
          const s = ensureAutoBrowseState();
          if (s.clickTimer) clearInterval(s.clickTimer);
          s.clickTimer = setInterval(runOneClickCycle, CLICK_INTERVAL);
          logFromContent(
            `[resumeNextJob] 原因="${reason || "未知"}"，clickTimer 已重启，` +
            `clickIndex=${s.clickIndex}，jobs当前=${getJobElementsForAuto().length}`
          );
        }

        // 检查扩展 runtime 是否可用（扩展更新/重载后 sendMessage 会静默失败）
        if (!chrome.runtime || !chrome.runtime.sendMessage) {
          logFromContent("[AI] ⚠️ chrome.runtime 不可用，跳过 AI 评估，resumeNextJob。");
          resumeNextJob("runtime不可用");
          return;
        }
        const aiStartTime = Date.now();
        logFromContent(`[AI] 发送 JOB_DETAIL_FOR_AI：title="${job.title}"，等待回调...`);
        chrome.runtime.sendMessage(
          { type: "JOB_DETAIL_FOR_AI", job },
          (res) => {
            const elapsed = Date.now() - aiStartTime;
            if (chrome.runtime.lastError) {
              logFromContent(
                `[AI] ⚠️ sendMessage 错误（${elapsed}ms）：${chrome.runtime.lastError.message}，resumeNextJob。`
              );
              resumeNextJob("sendMessage错误");
              return;
            }
            if (!res || !res.ok) {
              logFromContent(
                `[AI] 评估失败（${elapsed}ms）：${res && res.error ? res.error : "未知错误"}，resumeNextJob。`
              );
              resumeNextJob("AI失败");
              return;
            }
            const { score, reason, sendMessage } =
              res.result || {};
            logFromContent(`[AI] 回调耗时=${elapsed}ms，score=${score}，reason="${String(reason || "").slice(0, 60)}"`);

            if (typeof score !== "number") {
              logFromContent(
                `[AI] score 非数字（值="${score}"），忽略该职位，resumeNextJob。`
              );
              resumeNextJob("score非数字");
              return;
            }

            const record = {
              job,
              score,
              reason,
              sendMessage,
              scored: true,
              sent: false,
              updatedAt: Date.now(),
            };
            try {
              if (storageKey) {
                localStorage.setItem(
                  storageKey,
                  JSON.stringify(record)
                );
              }
              // 额外的硬性薪资上限校验：如果职位薪资上限 < 18K，则无论分数多高都不发送消息
              function getMaxSalaryK(raw) {
                if (!raw) return null;
                const m = String(raw).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
                if (m) return parseFloat(m[2]);
                const single = String(raw).match(/(\d+(?:\.\d+)?)\s*K/i);
                if (single) return parseFloat(single[1]);
                return null;
              }

              const rawSalary =
                job.salary || job.listSalary || "";
              const maxSalaryK = getMaxSalaryK(rawSalary);
              if (maxSalaryK !== null && maxSalaryK < 18) {
                logFromContent(
                  `[AI] 薪资上限 ${maxSalaryK}K < 18K 硬性要求，跳过，resumeNextJob。`
                );
                resumeNextJob("薪资低于18K");
                return;
              }

              if (score > 50) {
                localStorage.setItem(
                  "bossAi:lastHighJob",
                  JSON.stringify(record)
                );
                logFromContent(
                  `[AI] score=${score} > 50，准备点击「立即沟通」，detailRoot=${detailRoot ? detailRoot.className || detailRoot.tagName : "null"}`
                );

                // 在详情面板中“耐心等待”一段时间，轮询查找「立即沟通」按钮再点击
                const MAX_TRIES = 10;
                let tries = 0;
                const pollInterval = 800;
                const timer = setInterval(() => {
                  tries += 1;
                  try {
                    const btnCandidates =
                      detailRoot.querySelectorAll(
                        "a,button"
                      );
                    let chatBtn = null;
                    for (const btn of btnCandidates) {
                      const txt = (
                        btn.innerText ||
                        btn.textContent ||
                        ""
                      ).trim();
                      if (
                        txt &&
                        (txt.includes("立即沟通") ||
                          txt.includes("马上沟通") ||
                          txt.includes("去沟通"))
                      ) {
                        chatBtn = btn;
                        break;
                      }
                    }
                    if (chatBtn) {
                      try {
                        const s = ensureAutoBrowseState();
                        const settings = {
                          cityIds: s.cities || [],
                          searchKeywords: s.searchQueries || [],
                        };
                        const nextTarget = getNextAutomationTarget(settings, {
                          cityIndex: s.cityIndex,
                          queryIndex: s.queryIndex,
                          cityId: s.currentCityId,
                          query: s.currentQuery,
                        });
                        saveRotationIndices(
                          nextTarget.queryIndex,
                          nextTarget.cityIndex
                        );
                        setPendingAutomationTarget(nextTarget);
                        // 点击「立即沟通」前停止所有自动化定时器，防止在聊天页（SPA跳转或内联弹窗）继续
                        // 运行 scrollTimer/clickTimer，误触聊天页内的岗位历史链接打开新窗口
                        if (s.scrollTimer) { clearInterval(s.scrollTimer); s.scrollTimer = null; }
                        if (s.clickTimer) { clearInterval(s.clickTimer); s.clickTimer = null; }
                        clearAutoBrowsePrepareTimer();
                        s.started = false;
                      } catch (_) {}
                      logFromContent(
                        `[chatBtn] 第 ${tries} 次轮询找到按钮："${(chatBtn.innerText || chatBtn.textContent || "").trim()}"，` +
                        `tag=${chatBtn.tagName}，href=${chatBtn.href || "无"}，disabled=${chatBtn.disabled}，class="${chatBtn.className}"，点击中...`
                      );
                      chatBtn.click();
                      logFromContent("[chatBtn] click() 已调用，已停止所有定时器，等待新会话页载入。");
                      clearInterval(timer);
                      return;
                    }
                    logFromContent(
                      `[chatBtn] 第 ${tries}/${MAX_TRIES} 次轮询未找到「立即沟通」，detailRoot 中 a/button 数量=${btnCandidates.length}`
                    );
                    if (tries >= MAX_TRIES) {
                      clearInterval(timer);
                      logFromContent(
                        "[chatBtn] 超过最大轮询次数，放弃点击「立即沟通」，resumeNextJob。"
                      );
                      resumeNextJob("chatBtn轮询超时");
                    }
                  } catch (e) {
                    clearInterval(timer);
                    logFromContent("[chatBtn] 轮询出错：" + e + "，resumeNextJob。");
                    resumeNextJob("chatBtn出错");
                  }
                }, pollInterval);
              } else {
                logFromContent(
                  `[AI] score=${score} <= 50，跳过，resumeNextJob。`
                );
                resumeNextJob("score<=50");
              }
            } catch (e) {
              logFromContent(
                "[AI] 写入 localStorage 或后续处理失败：" + e + "，resumeNextJob。"
              );
              resumeNextJob("catch块");
            }
          }
        );
      } catch (e) {
        logFromContent(
          "[DOM] 采集职位 DOM 失败：" + e + "，强制重启 clickTimer。"
        );
        const s = ensureAutoBrowseState();
        if (s.clickTimer) clearInterval(s.clickTimer);
        s.clickTimer = setInterval(runOneClickCycle, CLICK_INTERVAL);
      }
    }, 2000);
  }
  state.clickTimer = setInterval(runOneClickCycle, CLICK_INTERVAL);
}

async function startAutoBrowseFromTop(settingsOverride = null) {
  const state = ensureAutoBrowseState();
  if (
    state.started &&
    (state.prepareTimer || state.scrollTimer || state.clickTimer)
  ) {
    logFromContent("自动浏览：已在运行，本次不重复启动。");
    return;
  }
  const href = location.href;
  if (!href.includes("/web/geek/jobs")) {
    logFromContent(
      "自动浏览：当前标签不是求职列表页，不启动自动浏览。"
    );
    return;
  }

  const settings = settingsOverride || (await getAutomationSettingsForAuto());
  if (!hasValidAutomationSettings(settings)) {
    stopAutoBrowseAndChat("缺少城市 ID 或搜索关键词");
    throw new Error("请先在插件中至少配置 1 个城市 ID 和 1 个搜索关键词。");
  }

  const target = getPreferredAutomationTarget(settings);
  if (!target.cityId || !target.query) {
    stopAutoBrowseAndChat("自动执行配置无效");
    throw new Error("自动执行配置无效，请检查城市 ID 与搜索关键词。");
  }

  state.started = true;
  syncAutoBrowseConfig(state, settings, target);
  state.phase = "prepare_target";
  state._noTimerSince = null;
  state.__emptyJobsChecks = 0;
  state.searchRecoveryCount = 0;

  logFromContent(
    `自动浏览：加载配置完成，当前目标 cityId=${target.cityId}，关键词=${target.query}。`
  );

  if (!isCurrentJobListMatchingTarget(target)) {
    clearSearchResumeSignal();
    navigateToAutomationTarget(target, "应用新的城市与关键词配置");
    return;
  }

  if (shouldResumeCrawlingAfterSearch(target)) {
    logFromContent(
      "自动浏览：当前页面命中搜索刷新恢复条件，本轮跳过再次点击搜索。"
    );
    scheduleResumeCrawlingAfterSearch(target);
    return;
  }

  logFromContent(
    "自动浏览：当前页面已匹配配置项，等待页面稳定后强制点击搜索按钮。"
  );
  scheduleSearchClickAndCrawl(target);
}

function countStoredJobCache() {
  let count = 0;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("bossAiJob:")) {
        count += 1;
      }
    }
  } catch (_) {}
  return count;
}

function readLastHighJob() {
  try {
    const raw = localStorage.getItem("bossAi:lastHighJob");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function getPageStateSnapshot() {
  const state = ensureAutoBrowseState();
  const lastHighJob = readLastHighJob();
  let runningWanted = false;

  try {
    runningWanted = localStorage.getItem("bossAi:autoRunning") === "1";
  } catch (_) {}

  return {
    pageType: isJobListPage() ? "jobList" : isChatPage() ? "chat" : "other",
    currentUrl: location.href,
    runningWanted,
    started: Boolean(state.started),
    phase: state.phase || (state.started ? "running" : "idle"),
    hasTimers: Boolean(state.prepareTimer || state.scrollTimer || state.clickTimer),
    prepareTimer: Boolean(state.prepareTimer),
    scrollTimer: Boolean(state.scrollTimer),
    clickTimer: Boolean(state.clickTimer),
    clickIndex: Number(state.clickIndex) || 0,
    scrollCountThisCity: Number(state.scrollCountThisCity) || 0,
    scrollsWithNoNewCards: Number(state.scrollsWithNoNewCards) || 0,
    clickedCount: state.clicked instanceof Set ? state.clicked.size : 0,
    totalClickedCount:
      Number(state.totalClickedCount) || getSavedTotalClickCount(),
    cityIndex: Number(state.cityIndex) || 0,
    cityCount: Array.isArray(state.cities) ? state.cities.length : 0,
    queryIndex: Number(state.queryIndex) || 0,
    queryCount: Array.isArray(state.searchQueries) ? state.searchQueries.length : 0,
    maxTotalJobClicksPerRun: normalizeConfiguredMaxJobClicks(
      state.maxTotalJobClicksPerRun
    ),
    currentCityId: state.currentCityId || "",
    currentQuery: state.currentQuery || "",
    chatSending: Boolean(window.__bossChatSending),
    chatChecking: Boolean(
      window.__bossChatCheckTimer ||
        window.__bossChatStartDelayTimer ||
        window.__bossChatTimer
    ),
    jobCacheCount: countStoredJobCache(),
    hasLastHighJob: Boolean(lastHighJob),
    lastHighJobTitle:
      (lastHighJob &&
        lastHighJob.job &&
        (lastHighJob.job.title || lastHighJob.job.listTitle)) ||
      "",
    lastHighJobScore:
      lastHighJob && typeof lastHighJob.score === "number"
        ? lastHighJob.score
        : null,
  };
}

function stopAutoBrowseAndChat(reason = "manual") {
  const state = ensureAutoBrowseState();

  clearAutoBrowsePrepareTimer();
  if (state.scrollTimer) {
    clearInterval(state.scrollTimer);
    state.scrollTimer = null;
  }
  if (state.clickTimer) {
    clearInterval(state.clickTimer);
    state.clickTimer = null;
  }

  state.started = false;
  state.phase = "stopped";
  state._noTimerSince = null;
  state.__emptyJobsChecks = 0;
  state.scrollCountThisCity = 0;
  state.scrollsWithNoNewCards = 0;
  state.searchRecoveryCount = 0;

  stopChatPollingTimers();
  window.__bossChatSending = false;
  window.__bossChatAttemptId = null;
  window.__bossChatSignature = null;

  try {
    localStorage.setItem("bossAi:autoRunning", "0");
    localStorage.removeItem("bossAi:autoRestart");
  } catch (_) {}
  clearSavedRotationIndices();
  clearSearchResumeSignal();
  clearPendingAutomationTarget();

  logFromContent(`自动浏览：已停止（${reason}）。`);
  return getPageStateSnapshot();
}

function clearPageStorageRecords() {
  let removedCount = 0;

  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith("bossAiJob:") || key === "bossAi:lastHighJob") {
        localStorage.removeItem(key);
        removedCount += 1;
      }
    }
    localStorage.removeItem("bossAi:autoRestart");
    localStorage.removeItem("bossAi:debugLog");
  } catch (_) {}
  clearSearchResumeSignal();
  clearPendingAutomationTarget();

  logFromContent(`自动浏览：已清空页面岗位缓存 ${removedCount} 条。`);
  return removedCount;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "GET_PAGE_STATE") {
    sendResponse({
      ok: true,
      state: getPageStateSnapshot(),
    });
    return true;
  }

  if (message.type === "START_AUTO") {
    (async () => {
      const settings = await getAutomationSettingsForAuto();
      if (!hasValidAutomationSettings(settings)) {
        throw new Error("请先至少配置 1 个城市 ID 和 1 个搜索关键词。");
      }

      let wasRunningWanted = false;
      try {
        wasRunningWanted = localStorage.getItem("bossAi:autoRunning") === "1";
        localStorage.setItem("bossAi:autoRunning", "1");
        localStorage.removeItem("bossAi:autoRestart");
      } catch (_) {}

      if (!wasRunningWanted) {
        clearSavedRotationIndices();
        clearPendingAutomationTarget();
        setSavedTotalClickCount(0);
        const state = ensureAutoBrowseState();
        state.totalClickedCount = 0;
        logFromContent("自动浏览：开始新一轮执行，已重置城市与关键词轮换位置。");
      }

      if (isJobListPage()) {
        const state = ensureAutoBrowseState();
        if (
          state.started &&
          (state.prepareTimer || state.scrollTimer || state.clickTimer)
        ) {
          logFromContent("自动浏览：收到开始命令，但当前已在执行中。");
        } else {
          clearAutoBrowsePrepareTimer();
          if (state.scrollTimer) {
            clearInterval(state.scrollTimer);
            state.scrollTimer = null;
          }
          if (state.clickTimer) {
            clearInterval(state.clickTimer);
            state.clickTimer = null;
          }
          state.started = false;
          await startAutoBrowseFromTop(settings);
        }
        sendResponse({
          ok: true,
          state: getPageStateSnapshot(),
        });
        return;
      }

      const target = getPreferredAutomationTarget(settings);
      const targetUrl = buildJobListUrlForConfig(target.cityId, target.query);
      saveRotationIndices(target.queryIndex, target.cityIndex);
      setPendingAutomationTarget(target);
      try {
        localStorage.setItem("bossAi:autoRestart", "1");
      } catch (_) {}
      logFromContent(`自动浏览：收到开始命令，跳转到职位列表页：${targetUrl}`);
      sendResponse({
        ok: true,
        redirected: true,
        targetUrl,
        state: getPageStateSnapshot(),
      });
      location.href = targetUrl;
    })().catch((error) => {
      stopAutoBrowseAndChat("start-error");
      sendResponse({
        ok: false,
        error: error.message,
        state: getPageStateSnapshot(),
      });
    });
    return true;
  }

  if (message.type === "STOP_AUTO") {
    const pageState = stopAutoBrowseAndChat("popup-stop");
    sendResponse({
      ok: true,
      state: pageState,
    });
    return true;
  }

  if (message.type === "CLEAR_PAGE_STORAGE") {
    const removedCount = clearPageStorageRecords();
    sendResponse({
      ok: true,
      removedCount,
      state: getPageStateSnapshot(),
    });
    return true;
  }

  return false;
});

if (isJobListPage()) {
  // 如果从聊天页标记了需要“从头重新执行自动浏览”，则在列表页自动启动一次
  let needRestart = false;
  try {
    needRestart = localStorage.getItem("bossAi:autoRestart") === "1";
  } catch (_) {
    needRestart = false;
  }
  if (needRestart) {
    try {
      localStorage.removeItem("bossAi:autoRestart");
    } catch (_) {}
    // 稍等页面稳定后再启动
    setTimeout(() => {
      logFromContent(
        "自动浏览：检测到页面重启标记，开始按配置重新执行。"
      );
      try {
        const s = ensureAutoBrowseState();
        clearAutoBrowsePrepareTimer();
        if (s.scrollTimer) clearInterval(s.scrollTimer);
        if (s.clickTimer) clearInterval(s.clickTimer);
        s.scrollTimer = null;
        s.clickTimer = null;
        s._noTimerSince = null;
        s.__emptyJobsChecks = 0;
        s.started = false;
      } catch (_) {}
      startAutoBrowseFromTop().catch((error) => {
        logFromContent(`自动浏览：页面重启后恢复失败：${error.message}`);
      });
    }, 2000);
  }

  // 切换城市/关键词时，额外记录一个待恢复目标；即使 autoRestart 标记在页面跳转中丢失，
  // 也能在新列表页里尽快继续执行，而不是等守护进程超时后再拉起。
  setTimeout(() => {
    if (!isJobListPage()) return;

    let isRunningWanted = false;
    try {
      isRunningWanted = localStorage.getItem("bossAi:autoRunning") === "1";
    } catch (_) {}
    if (!isRunningWanted) return;

    const pendingTarget = readPendingAutomationTarget();
    if (!pendingTarget) return;

    const state = ensureAutoBrowseState();
    if (state.started || state.prepareTimer || state.scrollTimer || state.clickTimer) {
      return;
    }

    logFromContent(
      `自动浏览：检测到待恢复的目标组合，立即继续执行 cityId=${pendingTarget.cityId}，关键词=${pendingTarget.query}。`
    );
    startAutoBrowseFromTop().catch((error) => {
      logFromContent(`自动浏览：待恢复目标启动失败：${error.message}`);
    });
  }, 3200);

  // 守护进程：周期性检查并恢复脚本运行状态（通过 localStorage 持久化运行意图）
  setInterval(() => {
    if (!isJobListPage()) return;

    const state = ensureAutoBrowseState();
    const hasTimers =
      !!state.prepareTimer || !!state.scrollTimer || !!state.clickTimer;

    // 运行意图：由 popup.js 写入（避免 window.__bossAutoBrowse 状态不同步导致无法恢复）
    let isRunningWanted = false;
    try {
      isRunningWanted = localStorage.getItem("bossAi:autoRunning") === "1";
    } catch (_) {}

    // 若用户没有点“开始”，且没有 autoRestart 标记，则不自动重启。
    let needAutoRestart = false;
    try {
      needAutoRestart =
        localStorage.getItem("bossAi:autoRestart") === "1";
    } catch (_) {}

    // 每次守护进程触发都打印完整状态快照
    logFromContent(
      `[watchdog] started=${state.started}，phase=${state.phase}，` +
      `queryIndex=${state.queryIndex}/${state.searchQueries.length}，cityIndex=${state.cityIndex}/${state.cities.length}，` +
      `prepareTimer=${state.prepareTimer ? "运行" : "null"}，scrollTimer=${state.scrollTimer ? "运行" : "null"}，clickTimer=${state.clickTimer ? "运行" : "null"}，` +
      `scrollsNoNew=${state.scrollsWithNoNewCards}，clickIndex=${state.clickIndex}，` +
      `emptyChecks=${state.__emptyJobsChecks || 0}，` +
      `noTimerSince=${state._noTimerSince ? Math.round((Date.now() - state._noTimerSince) / 1000) + "s前" : "无"}，` +
      `isRunningWanted=${isRunningWanted}，needAutoRestart=${needAutoRestart}`
    );

    if (!isRunningWanted && !needAutoRestart) return;

    // autoRestart 优先：强制清理定时器并重启。
    if (needAutoRestart) {
      try {
        localStorage.removeItem("bossAi:autoRestart");
      } catch (_) {}

      clearAutoBrowsePrepareTimer();
      if (state.scrollTimer) clearInterval(state.scrollTimer);
      if (state.clickTimer) clearInterval(state.clickTimer);
      state.scrollTimer = null;
      state.clickTimer = null;
      state._noTimerSince = null;
      state.__emptyJobsChecks = 0;
      state.started = false;

      logFromContent(
        "自动浏览：守护进程检测到页面重启标记，强制重启自动浏览。"
      );
      startAutoBrowseFromTop().catch((error) => {
        logFromContent(`自动浏览：守护进程重启失败：${error.message}`);
      });
      return;
    }

    if (!isRunningWanted) return;

    // 情况：列表页处于运行中，但两类定时器都没有（可能是 SPA/DOM 更新导致时序丢失）
    if (!hasTimers) {
      const now = Date.now();
      if (!state._noTimerSince) {
        state._noTimerSince = now;
        logFromContent(
          "自动浏览：检测到运行意图开启但当前暂无定时器，等待确认是否为崩溃..."
        );
      } else if (now - state._noTimerSince > 25000) {
        state._noTimerSince = null;
        logFromContent(
          "自动浏览：等待超时（25s），判断为脚本意外停止，重置状态并重启。"
        );
        state.started = false;
        startAutoBrowseFromTop().catch((error) => {
          logFromContent(`自动浏览：自动恢复失败：${error.message}`);
        });
      }
      return;
    }

    // 有定时器在跑：清除“无定时器”计时
    state._noTimerSince = null;

    // 情况：定时器还在跑，但页面长时间没有任何职位卡片
    let jobs = [];
    try {
      jobs = getJobElementsForAuto();
    } catch (_) {
      jobs = [];
    }

    if (jobs.length === 0) {
      state.__emptyJobsChecks = (state.__emptyJobsChecks || 0) + 1;
      if (state.__emptyJobsChecks >= 4) {
        state.__emptyJobsChecks = 0;
        logFromContent(
          "自动浏览：多次检测到列表页没有任何职位卡片，将重新执行一次配置搜索。"
        );
        state.started = false;
        startAutoBrowseFromTop().catch((error) => {
          logFromContent(`自动浏览：重新执行配置搜索失败：${error.message}`);
        });
      }
    } else {
      state.__emptyJobsChecks = 0;
    }
  }, 15000);
}
