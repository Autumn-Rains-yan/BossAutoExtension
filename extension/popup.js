const state = {
  dashboard: null,
  pageState: null,
  bossTab: null,
  apiKeyVisible: false,
  refreshTimer: null,
};

const elements = {
  runStatusPill: document.getElementById("runStatusPill"),
  pageStatusPill: document.getElementById("pageStatusPill"),
  resumeStatusPill: document.getElementById("resumeStatusPill"),
  pageSummary: document.getElementById("pageSummary"),
  phaseSummary: document.getElementById("phaseSummary"),
  resumeSummary: document.getElementById("resumeSummary"),
  configSummary: document.getElementById("configSummary"),
  controlBtn: document.getElementById("controlBtn"),
  openBossBtn: document.getElementById("openBossBtn"),
  refreshStatusBtn: document.getElementById("refreshStatusBtn"),
  clearPageStorageBtn: document.getElementById("clearPageStorage"),
  refreshLogsBtn: document.getElementById("refreshLogs"),
  clearLogsBtn: document.getElementById("clearLogs"),
  apiKeyEyeBtn: document.getElementById("apiKeyEyeBtn"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  cityIdsInput: document.getElementById("cityIdsInput"),
  searchKeywordsInput: document.getElementById("searchKeywordsInput"),
  maxJobClicksInput: document.getElementById("maxJobClicksInput"),
  keywordDescriptionInput: document.getElementById("keywordDescriptionInput"),
  generateKeywordsBtn: document.getElementById("generateKeywordsBtn"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  settingsHint: document.getElementById("settingsHint"),
  resumeFileInput: document.getElementById("resumeFileInput"),
  uploadResumeBtn: document.getElementById("uploadResumeBtn"),
  organizeResumeBtn: document.getElementById("organizeResumeBtn"),
  saveResumeBtn: document.getElementById("saveResumeBtn"),
  clearResumeBtn: document.getElementById("clearResumeBtn"),
  resumeFileBadge: document.getElementById("resumeFileBadge"),
  organizedBadge: document.getElementById("organizedBadge"),
  resumeHighlights: document.getElementById("resumeHighlights"),
  resumeHighlightsEmpty: document.getElementById("resumeHighlightsEmpty"),
  rawResumeText: document.getElementById("rawResumeText"),
  preparedResumeText: document.getElementById("preparedResumeText"),
  rawResumeMeta: document.getElementById("rawResumeMeta"),
  preparedResumeMeta: document.getElementById("preparedResumeMeta"),
  logCountPill: document.getElementById("logCountPill"),
  logs: document.getElementById("logs"),
};

const buttonLabels = new Map(
  [
    elements.controlBtn,
    elements.openBossBtn,
    elements.refreshStatusBtn,
    elements.clearPageStorageBtn,
    elements.refreshLogsBtn,
    elements.clearLogsBtn,
    elements.saveSettingsBtn,
    elements.generateKeywordsBtn,
    elements.uploadResumeBtn,
    elements.organizeResumeBtn,
    elements.saveResumeBtn,
    elements.clearResumeBtn,
  ]
    .filter(Boolean)
    .map((button) => [button, button.textContent])
);

function normalizeText(value) {
  return String(value || "").trim();
}

function splitConfigInput(value) {
  return String(value || "")
    .split(/[\n,，;；]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseCityIdsInput(value) {
  return uniqueValues(
    splitConfigInput(value)
      .map((item) => {
        const fromUrl = item.match(/[?&]city=(\d{4,})/i);
        if (fromUrl) {
          return fromUrl[1];
        }

        const direct = item.match(/\b(\d{4,})\b/);
        return direct ? direct[1] : "";
      })
      .filter(Boolean)
  );
}

function parseSearchKeywordsInput(value) {
  return uniqueValues(splitConfigInput(value));
}

function normalizeMaxJobClicksInput(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return 30;
  }

  return Math.max(1, Math.min(300, parsed));
}

function isSameStringList(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function joinConfigList(values) {
  return (Array.isArray(values) ? values : []).join("\n");
}

function mergeSearchKeywordsIntoInput(nextKeywords) {
  const merged = uniqueValues([
    ...parseSearchKeywordsInput(elements.searchKeywordsInput.value),
    ...(Array.isArray(nextKeywords)
      ? nextKeywords.map((item) => normalizeText(item)).filter(Boolean)
      : []),
  ]);

  elements.searchKeywordsInput.value = joinConfigList(merged);
  return merged;
}

function setButtonText(button, text) {
  button.textContent = text;
}

async function withBusyButton(button, pendingText, task) {
  const originalText = buttonLabels.get(button) || button.textContent;
  if (button.dataset.busy === "1") {
    return;
  }

  button.dataset.busy = "1";
  button.disabled = true;
  setButtonText(button, pendingText);

  try {
    return await task();
  } catch (error) {
    setHint(elements.settingsHint, `操作失败：${error.message}`);
    console.error(error);
    return undefined;
  } finally {
    button.dataset.busy = "0";
    setButtonText(button, originalText);
    renderDashboard();
  }
}

function runtimeSendMessage(message) {
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

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJobListUrl(cityId, query) {
  const targetUrl = new URL("https://www.zhipin.com/web/geek/jobs");
  const normalizedCityId = normalizeText(cityId);
  const normalizedQuery = normalizeText(query);
  targetUrl.searchParams.set("city", normalizedCityId);
  targetUrl.searchParams.set("query", normalizedQuery);
  targetUrl.searchParams.set("industry", "");
  targetUrl.searchParams.set("position", normalizedQuery);
  return targetUrl.toString();
}

function getConfiguredJobListTarget(settings = state.dashboard?.settings || {}) {
  const cityId = normalizeText(settings.cityIds?.[0]);
  const query = normalizeText(settings.searchKeywords?.[0]);

  if (!cityId || !query) {
    throw new Error("请先保存至少 1 个城市 ID 和 1 个搜索关键词。");
  }

  return {
    cityId,
    query,
    targetUrl: buildJobListUrl(cityId, query),
  };
}

function isJobListUrlMatching(url, cityId, query) {
  try {
    const parsed = new URL(url);
    const normalizedQuery = normalizeText(
      parsed.searchParams.get("position") ||
        parsed.searchParams.get("query") ||
        ""
    );
    return (
      parsed.pathname.includes("/web/geek/jobs") &&
      normalizeText(parsed.searchParams.get("city")) === normalizeText(cityId) &&
      normalizedQuery === normalizeText(query)
    );
  } catch (_) {
    return false;
  }
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "暂无";
  }

  try {
    return new Date(timestamp).toLocaleString();
  } catch (_) {
    return "暂无";
  }
}

function setHint(element, text) {
  element.textContent = text;
}

function setPill(element, text, variant) {
  element.className = `pill pill--${variant}`;
  element.textContent = text;
}

function getApiKeyEyeIcon(isVisible) {
  if (isVisible) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6S2 12 2 12Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 4.5 20 19.5"></path>
      <path d="M10.6 6.2A11.6 11.6 0 0 1 12 6c6.2 0 10 6 10 6a18.2 18.2 0 0 1-3.1 3.6"></path>
      <path d="M6.1 8.1A18 18 0 0 0 2 12s3.8 6 10 6c1.2 0 2.3-.2 3.3-.6"></path>
      <path d="M9.9 9.8A3 3 0 0 0 9 12a3 3 0 0 0 4.4 2.6"></path>
    </svg>
  `;
}

function setApiKeyVisibility(visible) {
  state.apiKeyVisible = Boolean(visible);
  elements.apiKeyInput.type = state.apiKeyVisible ? "text" : "password";
  elements.apiKeyEyeBtn.innerHTML = getApiKeyEyeIcon(state.apiKeyVisible);
  elements.apiKeyEyeBtn.setAttribute(
    "aria-label",
    state.apiKeyVisible ? "隐藏 API Key" : "显示 API Key"
  );
  elements.apiKeyEyeBtn.setAttribute(
    "title",
    state.apiKeyVisible ? "隐藏 API Key" : "显示 API Key"
  );
  elements.apiKeyEyeBtn.setAttribute(
    "aria-pressed",
    state.apiKeyVisible ? "true" : "false"
  );
}

function renderControlButton(runningState, canStart) {
  const isBusy = elements.controlBtn.dataset.busy === "1";
  const canStop = runningState !== "idle";
  const summary = state.dashboard?.summary || {};

  if (!isBusy) {
    elements.controlBtn.className = canStop
      ? "btn-danger control-btn"
      : "btn-primary control-btn";
    setButtonText(elements.controlBtn, canStop ? "停止执行" : "开始执行");
  }

  elements.controlBtn.dataset.mode = canStop ? "stop" : "start";
  elements.controlBtn.title = canStop
    ? "停止当前自动执行"
    : !summary.hasApiKey
      ? "请先配置 API Key"
      : !summary.hasCityIds || !summary.hasSearchKeywords
        ? "请至少配置 1 个城市 ID 和 1 个搜索关键词"
    : canStart
      ? "开始自动执行"
      : "请先完成简历配置";
  elements.controlBtn.disabled = isBusy || (!canStop && !canStart);
}

function updateTextMeta() {
  const rawLength = normalizeText(elements.rawResumeText.value).length;
  const preparedLength = normalizeText(elements.preparedResumeText.value).length;
  elements.rawResumeMeta.textContent = `${rawLength} 字`;
  elements.preparedResumeMeta.textContent = `${preparedLength} 字`;
}

function renderHighlights(highlights) {
  elements.resumeHighlights.innerHTML = "";
  if (!highlights.length) {
    elements.resumeHighlightsEmpty.style.display = "";
    return;
  }

  elements.resumeHighlightsEmpty.style.display = "none";
  for (const item of highlights) {
    const li = document.createElement("li");
    li.textContent = item;
    elements.resumeHighlights.appendChild(li);
  }
}

function renderLogs(logs) {
  const finalLogs = logs && logs.length ? logs : ["暂无日志。"];
  elements.logs.textContent = finalLogs.join("\n");
  setPill(
    elements.logCountPill,
    `${logs ? logs.length : 0} 条`,
    logs && logs.length ? "ready" : "neutral"
  );
}

function getRunningState() {
  if (!state.pageState) {
    return "idle";
  }

  if (state.pageState.runningWanted) {
    if (
      state.pageState.started ||
      state.pageState.hasTimers ||
      state.pageState.chatSending ||
      state.pageState.chatChecking
    ) {
      return "running";
    }
    return "arming";
  }

  return "idle";
}

function formatPageType(pageState) {
  if (!pageState) {
    return "未连接 Boss 页面";
  }

  if (pageState.pageType === "jobList") {
    return "Boss 职位列表页";
  }
  if (pageState.pageType === "chat") {
    return "Boss 聊天页";
  }
  if (pageState.pageType === "other") {
    return "Boss 站内其他页面";
  }
  return "未知页面";
}

function formatPhase(pageState) {
  if (!pageState) {
    return "等待连接";
  }

  if (pageState.pageType === "chat") {
    if (pageState.chatSending) {
      return "聊天发送中";
    }
    if (pageState.chatChecking) {
      return "聊天确认中";
    }
  }

  if (pageState.phase) {
    return pageState.phase;
  }

  return pageState.runningWanted ? "等待页面执行" : "未启动";
}

function isSettingsDirty() {
  const settings = state.dashboard?.settings;
  if (!settings) {
    return false;
  }

  return (
    normalizeText(elements.apiKeyInput.value) !== normalizeText(settings.apiKey) ||
    !isSameStringList(
      parseCityIdsInput(elements.cityIdsInput.value),
      settings.cityIds || []
    ) ||
    !isSameStringList(
      parseSearchKeywordsInput(elements.searchKeywordsInput.value),
      settings.searchKeywords || []
    ) ||
    normalizeMaxJobClicksInput(elements.maxJobClicksInput.value) !==
      normalizeMaxJobClicksInput(settings.maxTotalJobClicksPerRun)
  );
}

function isResumeDirty() {
  const settings = state.dashboard?.settings;
  if (!settings) {
    return false;
  }

  return (
    normalizeText(elements.rawResumeText.value) !==
      normalizeText(settings.rawResumeText) ||
    normalizeText(elements.preparedResumeText.value) !==
      normalizeText(settings.preparedResumeText)
  );
}

function renderDashboard() {
  const dashboard = state.dashboard;
  const pageState = state.pageState;
  const settings = dashboard?.settings || {};
  const summary = dashboard?.summary || {};

  const runningState = getRunningState();
  if (runningState === "running") {
    setPill(elements.runStatusPill, "执行中", "running");
  } else if (runningState === "arming") {
    setPill(elements.runStatusPill, "等待页面执行", "ready");
  } else {
    setPill(elements.runStatusPill, "已停止", "stopped");
  }

  setPill(
    elements.pageStatusPill,
    formatPageType(pageState),
    pageState ? "ready" : "neutral"
  );

  if (summary.hasPreparedResume) {
    setPill(elements.resumeStatusPill, "简历已整理并可匹配", "running");
  } else if (summary.hasRawResume) {
    setPill(elements.resumeStatusPill, "已上传简历，待 AI 整理", "ready");
  } else {
    setPill(elements.resumeStatusPill, "简历未就绪", "neutral");
  }

  elements.pageSummary.textContent = formatPageType(pageState);
  elements.phaseSummary.textContent = formatPhase(pageState);
  elements.resumeSummary.textContent = summary.resumeFileName
    ? `${summary.resumeFileName} · ${formatTime(summary.resumeUpdatedAt)}`
    : "尚未上传简历";
  if (!summary.hasApiKey) {
    elements.configSummary.textContent = "请先填写 API Key";
  } else if (!summary.hasCityIds || !summary.hasSearchKeywords) {
    elements.configSummary.textContent = "请配置城市 ID 和搜索关键词";
  } else {
    elements.configSummary.textContent =
      `${summary.cityIdsCount || 0} 个城市 · ${summary.searchKeywordsCount || 0} 个关键词 · 总上限${summary.maxTotalJobClicksPerRun || 30}个`;
  }

  elements.resumeFileBadge.textContent = summary.resumeFileName
    ? summary.resumeFileName
    : "未选择文件";
  setPill(
    elements.resumeFileBadge,
    summary.resumeFileName ? summary.resumeFileName : "未选择文件",
    summary.resumeFileName ? "ready" : "neutral"
  );

  setPill(
    elements.organizedBadge,
    summary.hasPreparedResume
      ? `已整理 · ${formatTime(summary.lastOrganizedAt)}`
      : "未整理",
    summary.hasPreparedResume ? "running" : "neutral"
  );

  renderHighlights(settings.resumeHighlights || []);
  renderLogs(dashboard?.logs || []);

  const canStart =
    runningState === "idle" &&
    summary.hasApiKey &&
    summary.hasCityIds &&
    summary.hasSearchKeywords &&
    (summary.hasRawResume || summary.hasPreparedResume) &&
    elements.controlBtn.dataset.busy !== "1";

  renderControlButton(runningState, canStart);
  const hasConfiguredTarget = summary.hasCityIds && summary.hasSearchKeywords;
  const canGenerateKeywords =
    Boolean(normalizeText(elements.keywordDescriptionInput.value)) &&
    Boolean(normalizeText(elements.apiKeyInput.value) || summary.hasApiKey) &&
    elements.generateKeywordsBtn.dataset.busy !== "1";
  elements.openBossBtn.disabled =
    !hasConfiguredTarget || elements.openBossBtn.dataset.busy === "1";
  elements.openBossBtn.title = hasConfiguredTarget
    ? "打开当前配置的职位列表"
    : "请先配置城市 ID 和搜索关键词";
  elements.generateKeywordsBtn.disabled = !canGenerateKeywords;
  elements.generateKeywordsBtn.title = canGenerateKeywords
    ? "根据描述生成一组搜索关键词"
    : !normalizeText(elements.apiKeyInput.value) && !summary.hasApiKey
      ? "请先填写 API Key"
      : "请先输入关键词生成描述";
  elements.refreshStatusBtn.disabled =
    elements.refreshStatusBtn.dataset.busy === "1";
  elements.clearPageStorageBtn.disabled =
    !state.bossTab || elements.clearPageStorageBtn.dataset.busy === "1";
  elements.refreshLogsBtn.disabled =
    elements.refreshLogsBtn.dataset.busy === "1";
  elements.clearLogsBtn.disabled =
    elements.clearLogsBtn.dataset.busy === "1";
  elements.saveSettingsBtn.disabled =
    !isSettingsDirty() || elements.saveSettingsBtn.dataset.busy === "1";
  elements.saveResumeBtn.disabled =
    !isResumeDirty() || elements.saveResumeBtn.dataset.busy === "1";
  elements.organizeResumeBtn.disabled =
    !normalizeText(elements.rawResumeText.value) ||
    !summary.hasApiKey ||
    elements.organizeResumeBtn.dataset.busy === "1";
}

async function getBossTab() {
  const tabs = await tabsQuery({ currentWindow: true });
  const bossTabs = tabs.filter(
    (tab) => tab.url && tab.url.includes("zhipin.com")
  );

  return (
    bossTabs.find((tab) => tab.url.includes("/web/geek/jobs")) ||
    bossTabs.find((tab) => tab.active) ||
    bossTabs[0] ||
    null
  );
}

function waitForTabUrl(tabId, matcher, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("等待 Boss 页面加载超时。"));
    }, timeoutMs);

    function cleanup() {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (!matcher(tab?.url || "", changeInfo, tab)) {
        return;
      }
      cleanup();
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ensureJobListTab() {
  const settings = state.dashboard?.settings || {};
  const { cityId, query, targetUrl } = getConfiguredJobListTarget(settings);
  const existingTab = await getBossTab();

  if (existingTab && existingTab.url.includes("/web/geek/jobs")) {
    if (isJobListUrlMatching(existingTab.url, cityId, query)) {
      await tabsUpdate(existingTab.id, { active: true });
      return existingTab;
    }

    await tabsUpdate(existingTab.id, { active: true, url: targetUrl });
    await waitForTabUrl(
      existingTab.id,
      (url, changeInfo) =>
        url.includes("/web/geek/jobs") && changeInfo.status === "complete"
    );
    return await tabsQuery({ currentWindow: true }).then((tabs) =>
      tabs.find((tab) => tab.id === existingTab.id)
    );
  }

  if (existingTab) {
    await tabsUpdate(existingTab.id, {
      active: true,
      url: targetUrl,
    });
    await waitForTabUrl(
      existingTab.id,
      (url, changeInfo) =>
        url.includes("/web/geek/jobs") && changeInfo.status === "complete"
    );
    return await tabsQuery({ currentWindow: true }).then((tabs) =>
      tabs.find((tab) => tab.id === existingTab.id)
    );
  }

  const created = await tabsCreate({
    url: targetUrl,
    active: true,
  });
  await waitForTabUrl(
    created.id,
    (url, changeInfo) =>
      url.includes("/web/geek/jobs") && changeInfo.status === "complete"
  );
  return await tabsQuery({ currentWindow: true }).then((tabs) =>
    tabs.find((tab) => tab.id === created.id)
  );
}

async function sendMessageToBossTab(message, options = {}) {
  const targetTab = options.ensureJobList
    ? await ensureJobListTab()
    : await getBossTab();

  if (!targetTab) {
    throw new Error("当前窗口中没有可用的 Boss 页面。");
  }

  state.bossTab = targetTab;

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (attempt > 0) {
        await delay(400);
      }
      return await tabsSendMessage(targetTab.id, message);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("向 Boss 页面发送命令失败。");
}

async function refreshDashboardData() {
  const preserveSettings = isSettingsDirty();
  const preserveResume = isResumeDirty();
  const dashboardResponse = await runtimeSendMessage({
    type: "GET_DASHBOARD_DATA",
  });
  if (!dashboardResponse?.ok) {
    throw new Error(dashboardResponse?.error || "读取插件配置失败。");
  }

  state.dashboard = dashboardResponse.data;

  const bossTab = await getBossTab();
  state.bossTab = bossTab;
  if (bossTab) {
    try {
      const response = await tabsSendMessage(bossTab.id, {
        type: "GET_PAGE_STATE",
      });
      state.pageState = response?.state || null;
    } catch (_) {
      state.pageState = null;
    }
  } else {
    state.pageState = null;
  }

  const settings = state.dashboard.settings;
  if (!preserveSettings) {
    elements.apiKeyInput.value = settings.apiKey || "";
    elements.cityIdsInput.value = joinConfigList(settings.cityIds || []);
    elements.searchKeywordsInput.value = joinConfigList(
      settings.searchKeywords || []
    );
    elements.maxJobClicksInput.value = String(
      settings.maxTotalJobClicksPerRun || 30
    );
  }
  if (!preserveResume) {
    elements.rawResumeText.value = settings.rawResumeText || "";
    elements.preparedResumeText.value = settings.preparedResumeText || "";
  }

  updateTextMeta();
  renderDashboard();
}

async function saveSettings() {
  const response = await runtimeSendMessage({
    type: "SAVE_SETTINGS",
    payload: {
      apiKey: normalizeText(elements.apiKeyInput.value),
      cityIds: parseCityIdsInput(elements.cityIdsInput.value),
      searchKeywords: parseSearchKeywordsInput(
        elements.searchKeywordsInput.value
      ),
      maxTotalJobClicksPerRun: normalizeMaxJobClicksInput(
        elements.maxJobClicksInput.value
      ),
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "保存配置失败。");
  }

  setHint(
    elements.settingsHint,
    "插件配置已保存，后续会按这里的城市 ID 和关键词执行。"
  );
  await refreshDashboardData();
}

async function saveResumeTexts(extraPayload = {}) {
  const response = await runtimeSendMessage({
    type: "SAVE_SETTINGS",
    payload: {
      rawResumeText: elements.rawResumeText.value,
      preparedResumeText: elements.preparedResumeText.value,
      resumeFileName:
        extraPayload.resumeFileName !== undefined
          ? extraPayload.resumeFileName
          : state.dashboard?.settings?.resumeFileName || "",
      resumeUpdatedAt:
        extraPayload.resumeUpdatedAt !== undefined
          ? extraPayload.resumeUpdatedAt
          : Date.now(),
      resumeHighlights:
        extraPayload.resumeHighlights !== undefined
          ? extraPayload.resumeHighlights
          : state.dashboard?.settings?.resumeHighlights || [],
      lastOrganizedAt:
        extraPayload.lastOrganizedAt !== undefined
          ? extraPayload.lastOrganizedAt
          : state.dashboard?.settings?.lastOrganizedAt || 0,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "保存简历文本失败。");
  }

  await refreshDashboardData();
}

async function extractResumeText(file) {
  const fileName = normalizeText(file.name);

  if (/\.docx$/i.test(fileName)) {
    if (!window.mammoth) {
      throw new Error("当前插件未加载 docx 解析器。");
    }
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return normalizeText(result?.value);
  }

  return normalizeText(await file.text());
}

function showTransientHint(element, text) {
  setHint(element, text);
  clearTimeout(element.__hintTimer);
  element.__hintTimer = setTimeout(() => {
    renderDashboard();
  }, 2600);
}

async function handleResumeUpload() {
  const file = elements.resumeFileInput.files?.[0];
  if (!file) {
    return;
  }

  const extractedText = await extractResumeText(file);
  if (!extractedText) {
    throw new Error("上传文件中未提取到可用文本。");
  }

  elements.rawResumeText.value = extractedText;
  elements.preparedResumeText.value = "";
  updateTextMeta();

  const response = await runtimeSendMessage({
    type: "SAVE_SETTINGS",
    payload: {
      rawResumeText: extractedText,
      preparedResumeText: "",
      resumeHighlights: [],
      resumeFileName: file.name,
      resumeUpdatedAt: Date.now(),
      lastOrganizedAt: 0,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "保存上传简历失败。");
  }

  showTransientHint(
    elements.settingsHint,
    `已解析并保存简历：${file.name}`
  );
  elements.resumeFileInput.value = "";
  await refreshDashboardData();
}

async function handleResumeOrganize() {
  const rawResumeText = normalizeText(elements.rawResumeText.value);
  if (!rawResumeText) {
    throw new Error("请先上传或粘贴简历内容。");
  }

  const response = await runtimeSendMessage({
    type: "ORGANIZE_RESUME",
    rawResumeText,
    resumeFileName: state.dashboard?.settings?.resumeFileName || "",
    resumeUpdatedAt: Date.now(),
  });

  if (!response?.ok) {
    throw new Error(response?.error || "AI 整理失败。");
  }

  elements.preparedResumeText.value =
    response.result?.preparedResumeText || "";
  updateTextMeta();
  showTransientHint(
    elements.settingsHint,
    "AI 整理完成，已同步回插件配置。"
  );
  await refreshDashboardData();
}

async function handleGenerateKeywords() {
  const description = normalizeText(elements.keywordDescriptionInput.value);
  if (!description) {
    throw new Error("请先输入关键词生成描述。");
  }

  const apiKey =
    normalizeText(elements.apiKeyInput.value) ||
    normalizeText(state.dashboard?.settings?.apiKey);
  if (!apiKey) {
    throw new Error("请先填写并保存 API Key。");
  }

  const beforeKeywords = parseSearchKeywordsInput(
    elements.searchKeywordsInput.value
  );
  const response = await runtimeSendMessage({
    type: "GENERATE_SEARCH_KEYWORDS",
    description,
    apiKey,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "AI 生成关键词失败。");
  }

  const generatedKeywords = Array.isArray(response.result?.keywords)
    ? response.result.keywords
    : [];
  if (!generatedKeywords.length) {
    throw new Error("AI 未返回可用关键词。");
  }

  const mergedKeywords = mergeSearchKeywordsIntoInput(generatedKeywords);
  const addedCount = Math.max(mergedKeywords.length - beforeKeywords.length, 0);
  const notes = normalizeText(response.result?.notes);

  showTransientHint(
    elements.settingsHint,
    notes
      ? `已生成并合并 ${generatedKeywords.length} 个关键词，新增 ${addedCount} 个。${notes} 请确认后保存配置。`
      : `已生成并合并 ${generatedKeywords.length} 个关键词，新增 ${addedCount} 个。请确认后保存配置。`
  );
}

async function handleStart() {
  const summary = state.dashboard?.summary || {};
  if (!summary.hasApiKey) {
    throw new Error("请先填写并保存 API Key。");
  }
  if (!summary.hasCityIds || !summary.hasSearchKeywords) {
    throw new Error("请至少配置 1 个城市 ID 和 1 个搜索关键词。");
  }
  if (!summary.hasRawResume && !summary.hasPreparedResume) {
    throw new Error("请先上传简历内容。");
  }

  const response = await sendMessageToBossTab(
    { type: "START_AUTO" },
    { ensureJobList: true }
  );

  if (!response?.ok) {
    throw new Error(response?.error || "启动自动执行失败。");
  }

  await delay(400);
  await refreshDashboardData();
}

async function handleStop() {
  const tabs = await tabsQuery({ currentWindow: true });
  const bossTabs = tabs.filter(
    (tab) => tab.url && tab.url.includes("zhipin.com")
  );

  await Promise.all(
    bossTabs.map(async (tab) => {
      try {
        await tabsSendMessage(tab.id, { type: "STOP_AUTO" });
      } catch (_) {}
    })
  );

  await refreshDashboardData();
}

async function handleControlToggle() {
  if (getRunningState() === "idle") {
    await handleStart();
    return;
  }

  await handleStop();
}

async function handleClearPageStorage() {
  const response = await sendMessageToBossTab(
    { type: "CLEAR_PAGE_STORAGE" },
    { ensureJobList: false }
  );

  if (!response?.ok) {
    throw new Error(response?.error || "清空页面缓存失败。");
  }

  showTransientHint(
    elements.settingsHint,
    `已清空 ${response.removedCount || 0} 条页面岗位缓存。`
  );
  await refreshDashboardData();
}

function confirmClearPageStorage() {
  return window.confirm(
    "确定要清空岗位缓存吗？这会删除当前插件记录的岗位匹配缓存。"
  );
}

async function handleClearLogs() {
  const response = await runtimeSendMessage({ type: "CLEAR_LOGS" });
  if (!response?.ok) {
    throw new Error(response?.error || "清空日志失败。");
  }
  await refreshDashboardData();
}

function bindEvents() {
  elements.controlBtn.addEventListener("click", () =>
    withBusyButton(
      elements.controlBtn,
      getRunningState() === "idle" ? "启动中..." : "停止中...",
      handleControlToggle
    )
  );

  elements.openBossBtn.addEventListener("click", () =>
    withBusyButton(elements.openBossBtn, "打开中...", async () => {
      await ensureJobListTab();
      await refreshDashboardData();
    })
  );

  elements.refreshStatusBtn.addEventListener("click", () =>
    withBusyButton(elements.refreshStatusBtn, "刷新中...", refreshDashboardData)
  );

  elements.refreshLogsBtn.addEventListener("click", () =>
    withBusyButton(elements.refreshLogsBtn, "刷新中...", refreshDashboardData)
  );

  elements.clearLogsBtn.addEventListener("click", () =>
    withBusyButton(elements.clearLogsBtn, "清理中...", handleClearLogs)
  );

  elements.clearPageStorageBtn.addEventListener("click", () => {
    if (!confirmClearPageStorage()) {
      return;
    }

    withBusyButton(
      elements.clearPageStorageBtn,
      "清理中...",
      handleClearPageStorage
    );
  });

  elements.apiKeyEyeBtn.addEventListener("click", () => {
    setApiKeyVisibility(!state.apiKeyVisible);
  });

  elements.saveSettingsBtn.addEventListener("click", () =>
    withBusyButton(elements.saveSettingsBtn, "保存中...", saveSettings)
  );

  elements.generateKeywordsBtn.addEventListener("click", () =>
    withBusyButton(
      elements.generateKeywordsBtn,
      "生成中...",
      handleGenerateKeywords
    )
  );

  elements.uploadResumeBtn.addEventListener("click", () => {
    elements.resumeFileInput.click();
  });

  elements.resumeFileInput.addEventListener("change", () =>
    withBusyButton(elements.uploadResumeBtn, "解析中...", handleResumeUpload)
  );

  elements.organizeResumeBtn.addEventListener("click", () =>
    withBusyButton(
      elements.organizeResumeBtn,
      "整理中...",
      handleResumeOrganize
    )
  );

  elements.saveResumeBtn.addEventListener("click", () =>
    withBusyButton(elements.saveResumeBtn, "保存中...", async () => {
      await saveResumeTexts();
      showTransientHint(elements.settingsHint, "简历文本已保存。");
    })
  );

  elements.clearResumeBtn.addEventListener("click", () =>
    withBusyButton(elements.clearResumeBtn, "清空中...", async () => {
      elements.rawResumeText.value = "";
      elements.preparedResumeText.value = "";
      updateTextMeta();
      const response = await runtimeSendMessage({
        type: "SAVE_SETTINGS",
        payload: {
          rawResumeText: "",
          preparedResumeText: "",
          resumeHighlights: [],
          resumeFileName: "",
          resumeUpdatedAt: 0,
          lastOrganizedAt: 0,
        },
      });
      if (!response?.ok) {
        throw new Error(response?.error || "清空简历失败。");
      }
      showTransientHint(elements.settingsHint, "已清空插件中的简历内容。");
      await refreshDashboardData();
    })
  );

  for (const input of [
    elements.apiKeyInput,
    elements.cityIdsInput,
    elements.searchKeywordsInput,
    elements.maxJobClicksInput,
    elements.keywordDescriptionInput,
    elements.rawResumeText,
    elements.preparedResumeText,
  ]) {
    input.addEventListener("input", () => {
      updateTextMeta();
      renderDashboard();
    });
  }
}

async function initialize() {
  bindEvents();
  setApiKeyVisibility(false);
  await refreshDashboardData();
  state.refreshTimer = setInterval(() => {
    refreshDashboardData().catch(() => {});
  }, 4000);
}

window.addEventListener("beforeunload", () => {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
  }
});

initialize().catch((error) => {
  setHint(elements.settingsHint, `初始化失败：${error.message}`);
  renderLogs([`初始化失败：${error.message}`]);
});
