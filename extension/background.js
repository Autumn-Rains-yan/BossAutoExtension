const LOG_STORAGE_KEY = "bossAiLogs";
const SETTINGS_STORAGE_KEY = "bossAiSettings";
const MAX_LOGS = 240;

const DEFAULT_SETTINGS = {
  apiKey: "",
  apiBase: "https://api.deepseek.com",
  model: "deepseek-chat",
  cityIds: [],
  searchKeywords: [],
  maxTotalJobClicksPerRun: 30,
  rawResumeText: "",
  preparedResumeText: "",
  resumeHighlights: [],
  resumeFileName: "",
  resumeUpdatedAt: 0,
  lastOrganizedAt: 0,
};

let logs = [];

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function loadLogs() {
  if (logs.length) {
    return logs;
  }

  const result = await storageGet([LOG_STORAGE_KEY]);
  const storedLogs = result[LOG_STORAGE_KEY];
  logs = Array.isArray(storedLogs) ? storedLogs : [];
  return logs;
}

async function persistLogs() {
  await storageSet({
    [LOG_STORAGE_KEY]: logs.slice(-MAX_LOGS),
  });
}

async function appendLog(text) {
  await loadLogs();
  const entry = `[${new Date().toLocaleTimeString()}] ${text}`;
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(-MAX_LOGS);
  }
  await persistLogs();
  console.log("[BossAI]", entry);
  return entry;
}

function trimText(value) {
  return String(value || "").trim();
}

function splitConfigList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitConfigList(item));
  }

  return String(value || "")
    .split(/[\n,，;；]+/)
    .map((item) => trimText(item))
    .filter(Boolean);
}

function uniqueList(values, limit = 20) {
  const result = [];
  const seen = new Set();

  for (const item of values) {
    const key = trimText(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function normalizeCityIds(value) {
  const cityIds = splitConfigList(value)
    .map((item) => {
      const fromUrl = item.match(/[?&]city=(\d{4,})/i);
      if (fromUrl) {
        return fromUrl[1];
      }

      const direct = item.match(/\b(\d{4,})\b/);
      return direct ? direct[1] : "";
    })
    .filter(Boolean);

  return uniqueList(cityIds, 30);
}

function normalizeSearchKeywords(value) {
  return uniqueList(splitConfigList(value), 30);
}

function normalizeMaxTotalJobClicksPerRun(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SETTINGS.maxTotalJobClicksPerRun;
  }

  return Math.max(1, Math.min(300, parsed));
}

function normalizeSettings(rawSettings = {}) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...rawSettings,
  };

  return {
    apiKey: trimText(settings.apiKey),
    apiBase: trimText(settings.apiBase) || DEFAULT_SETTINGS.apiBase,
    model: trimText(settings.model) || DEFAULT_SETTINGS.model,
    cityIds: normalizeCityIds(settings.cityIds),
    searchKeywords: normalizeSearchKeywords(settings.searchKeywords),
    maxTotalJobClicksPerRun: normalizeMaxTotalJobClicksPerRun(
      settings.maxTotalJobClicksPerRun ?? settings.maxJobClicksPerTarget
    ),
    rawResumeText: trimText(settings.rawResumeText),
    preparedResumeText: trimText(settings.preparedResumeText),
    resumeHighlights: Array.isArray(settings.resumeHighlights)
      ? settings.resumeHighlights
          .map((item) => trimText(item))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    resumeFileName: trimText(settings.resumeFileName),
    resumeUpdatedAt: Number(settings.resumeUpdatedAt) || 0,
    lastOrganizedAt: Number(settings.lastOrganizedAt) || 0,
  };
}

async function getSettings() {
  const result = await storageGet([SETTINGS_STORAGE_KEY]);
  return normalizeSettings(result[SETTINGS_STORAGE_KEY]);
}

async function saveSettings(partial = {}) {
  const current = await getSettings();
  const definedPartial = Object.fromEntries(
    Object.entries(partial).filter(([, value]) => value !== undefined)
  );
  const next = normalizeSettings({
    ...current,
    ...definedPartial,
  });

  await storageSet({
    [SETTINGS_STORAGE_KEY]: next,
  });

  return next;
}

function buildJobTextForLLM(job) {
  const parts = [];

  if (job.title || job.listTitle) {
    parts.push(`职位名称：${job.title || job.listTitle || ""}`);
  }
  if (job.company || job.listCompany) {
    parts.push(`公司：${job.company || job.listCompany || ""}`);
  }
  if (job.city) {
    parts.push(`城市：${job.city}`);
  }
  if (job.salary || job.listSalary) {
    parts.push(`薪资：${job.salary || job.listSalary || ""}`);
  }
  if (job.tags || job.listMeta) {
    parts.push(`标签/技能：${job.tags || job.listMeta || ""}`);
  }
  if (job.detailText) {
    parts.push(`职位描述：\n${job.detailText}`);
  }
  if (job.url) {
    parts.push(`职位链接：${job.url}`);
  }

  return parts.join("\n");
}

function parseJsonObjectFromText(text, label = "LLM 返回") {
  const content = trimText(text);
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`${label}中未找到 JSON 对象`);
  }

  try {
    return JSON.parse(content.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`解析 ${label} 失败：${error.message}`);
  }
}

function buildResumeContext(settings) {
  const rawResumeText = trimText(settings.rawResumeText);
  const preparedResumeText = trimText(settings.preparedResumeText);

  if (!rawResumeText && !preparedResumeText) {
    throw new Error("未上传简历，请先在插件中上传简历。");
  }

  if (preparedResumeText) {
    return {
      preparedResumeText,
      rawResumeText,
      promptText:
        `候选人档案（AI整理版）：\n${preparedResumeText}` +
        (rawResumeText
          ? `\n\n候选人原始简历（补充参考）：\n${rawResumeText.slice(0, 12000)}`
          : ""),
    };
  }

  return {
    preparedResumeText: "",
    rawResumeText,
    promptText: `候选人简历（原文）：\n${rawResumeText}`,
  };
}

async function callDeepSeekJson({
  settings,
  systemPrompt,
  userPrompt,
  label,
}) {
  const apiKey = trimText(settings.apiKey);
  if (!apiKey) {
    throw new Error("未配置 DeepSeek API Key，请先在插件中保存。");
  }

  const apiBase = trimText(settings.apiBase) || DEFAULT_SETTINGS.apiBase;
  const model = trimText(settings.model) || DEFAULT_SETTINGS.model;

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek 接口请求失败：${response.status} ${response.statusText} ${text}`
    );
  }

  const data = await response.json();
  const content = trimText(data?.choices?.[0]?.message?.content || "");

  return parseJsonObjectFromText(content, label);
}

async function organizeResumeWithAI(rawResumeText, settings) {
  const resumeText = trimText(rawResumeText);
  if (!resumeText) {
    throw new Error("当前没有可整理的简历内容。");
  }

  const parsed = await callDeepSeekJson({
    settings,
    label: "简历整理结果",
    systemPrompt:
      "你是一名资深技术招聘顾问和候选人包装专家。" +
      "请把原始简历整理成更适合 AI 岗位匹配和 Boss 直聘主动沟通的候选人档案。" +
      "不要编造信息，不要补充不存在的经历。",
    userPrompt: `
原始简历：
${resumeText}

请只输出一个 JSON 对象，不要输出任何多余文字：
{
  "preparedResume": "整理后的中文候选人档案。请分段输出，建议包含：职业概览、目标岗位、核心能力、行业/项目经验、远程与薪资偏好、补充说明。整体 400~1200 字。",
  "highlights": ["最多 8 条中文亮点短句，每条 8~30 字。"]
}

要求：
1. preparedResume 必须只基于原始简历整理，不得臆造。
2. highlights 用于插件中快速展示候选人亮点。
3. 表达要专业、凝练，适合后续岗位匹配使用。
`,
  });

  const preparedResume = trimText(parsed.preparedResume);
  if (!preparedResume) {
    throw new Error("AI 未返回可用的整理结果。");
  }

  return {
    preparedResumeText: preparedResume,
    resumeHighlights: Array.isArray(parsed.highlights)
      ? parsed.highlights
          .map((item) => trimText(item))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    lastOrganizedAt: Date.now(),
  };
}

async function generateSearchKeywordsWithAI(description, settings) {
  const requirementText = trimText(description);
  if (!requirementText) {
    throw new Error("请先输入关键词描述。");
  }

  const parsed = await callDeepSeekJson({
    settings,
    label: "关键词生成结果",
    systemPrompt:
      "你是一名熟悉 Boss 直聘搜索习惯的招聘搜索策略顾问。" +
      "你的任务是把用户输入的岗位描述拆解成可直接放进搜索框的关键词列表。" +
      "不要输出复杂检索语法，不要输出长句，不要编造不存在的岗位方向。",
    userPrompt: `
需求描述：
${requirementText}

请只输出一个 JSON 对象，不要输出任何多余文字：
{
  "keywords": ["AI应用工程师", "AI Agent", "AIGC应用开发"],
  "notes": "一句 20~60 字的中文说明。"
}

要求：
1. 输出 8~16 个适合 Boss 搜索框直接使用的关键词。
2. 关键词尽量覆盖岗位名称、技术方向、常见同义词、业务方向。
3. 每个关键词尽量控制在 2~16 个字符，优先使用短语，不要写成长句。
4. 不要包含城市、公司名、薪资、重复项、标点堆砌或布尔语法。
5. 如果描述比较宽泛，也尽量生成常见、能搜到岗位的关键词。
`,
  });

  const keywords = normalizeSearchKeywords(parsed.keywords).slice(0, 16);
  if (!keywords.length) {
    throw new Error("AI 未返回可用的搜索关键词。");
  }

  return {
    keywords,
    notes: trimText(parsed.notes),
  };
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    throw new Error("返回的 score 非数字");
  }

  const bounded = Math.max(0, Math.min(100, score));
  return Math.round(bounded * 10) / 10;
}

async function matchJobWithAI(job, settings) {
  const resumeContext = buildResumeContext(settings);
  const jobText = buildJobTextForLLM(job);

  const parsed = await callDeepSeekJson({
    settings,
    label: "职位匹配结果",
    systemPrompt:
      "你是一个资深技术招聘专家兼求职助手，负责根据候选人信息与职位信息评估匹配度，并生成用于 Boss 直聘首轮沟通的消息。" +
      "【匹配优先级】① 岗位薪资上限是硬性条件，低于 18K 必须视为不匹配；② 岗位方向是否符合候选人的全栈、AI Agent、产品研发等方向；③ 其他因素权重更低。" +
      "【不要误伤】地域/工作城市不纳入评分；不要因技术栈表述不完全一致就明显降分；不要因岗位经验年限写法与候选人不同就大幅扣分。" +
      "【名称要求】职位名称必须严格沿用原始职位名称，不允许改写。",
    userPrompt: `
${resumeContext.promptText}

职位信息：
${jobText}

请只输出一个 JSON 对象，不要输出任何多余文字：
{
  "score": 95.3,
  "reason": "用中文简要说明匹配或不匹配的关键原因，50~150 字。",
  "sendMessage": "用于和 Boss 打招呼的一段中文消息，1~3 段话。请严格使用职位信息中的原始职位名称，不要以“您好”开头，因为插件会自动补开场问候。"
}

要求：
1. score 为 0~100 的小数，保留 1 位小数。
2. sendMessage 先写与岗位和候选人技术背景相关的内容，再自然说明目前只考虑远程办公岗位。
3. 不要写 emoji，不要写“简历见附件”等空话。
4. 如果岗位薪资上限低于 18K，应明显降低分数并在 reason 中写明。
`,
  });

  return {
    score: normalizeScore(parsed.score),
    reason: trimText(parsed.reason),
    sendMessage: trimText(parsed.sendMessage),
    resumeMode: resumeContext.preparedResumeText ? "prepared" : "raw",
  };
}

function buildDashboardData(settings, currentLogs) {
  return {
    settings,
    logs: currentLogs,
    summary: {
      hasApiKey: Boolean(settings.apiKey),
      hasCityIds: settings.cityIds.length > 0,
      hasSearchKeywords: settings.searchKeywords.length > 0,
      cityIdsCount: settings.cityIds.length,
      searchKeywordsCount: settings.searchKeywords.length,
      maxTotalJobClicksPerRun: settings.maxTotalJobClicksPerRun,
      hasRawResume: Boolean(settings.rawResumeText),
      hasPreparedResume: Boolean(settings.preparedResumeText),
      resumeFileName: settings.resumeFileName,
      resumeUpdatedAt: settings.resumeUpdatedAt,
      lastOrganizedAt: settings.lastOrganizedAt,
      highlightCount: settings.resumeHighlights.length,
    },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  (async () => {
    switch (message.type) {
      case "LOG": {
        await appendLog(message.text || "");
        sendResponse({ ok: true });
        return;
      }

      case "GET_LOGS": {
        const currentLogs = await loadLogs();
        sendResponse({ ok: true, logs: currentLogs });
        return;
      }

      case "CLEAR_LOGS": {
        logs = [];
        await persistLogs();
        sendResponse({ ok: true, logs: [] });
        return;
      }

      case "GET_DASHBOARD_DATA": {
        const [settings, currentLogs] = await Promise.all([
          getSettings(),
          loadLogs(),
        ]);
        sendResponse({
          ok: true,
          data: buildDashboardData(settings, currentLogs),
        });
        return;
      }

      case "GET_AUTOMATION_SETTINGS": {
        const settings = await getSettings();
        sendResponse({
          ok: true,
          settings,
        });
        return;
      }

      case "SAVE_SETTINGS": {
        const settings = await saveSettings(message.payload || {});
        await appendLog("插件配置已更新。");
        sendResponse({
          ok: true,
          settings,
        });
        return;
      }

      case "ORGANIZE_RESUME": {
        const currentSettings = await saveSettings({
          rawResumeText: trimText(message.rawResumeText),
          resumeFileName:
            message.resumeFileName !== undefined
              ? trimText(message.resumeFileName)
              : undefined,
          resumeUpdatedAt:
            message.resumeUpdatedAt !== undefined
              ? Number(message.resumeUpdatedAt) || Date.now()
              : undefined,
        });
        const organized = await organizeResumeWithAI(
          currentSettings.rawResumeText,
          currentSettings
        );
        const savedSettings = await saveSettings(organized);
        await appendLog(
          `简历 AI 整理完成：${savedSettings.resumeFileName || "未命名简历"}`
        );
        sendResponse({
          ok: true,
          result: {
            preparedResumeText: savedSettings.preparedResumeText,
            resumeHighlights: savedSettings.resumeHighlights,
            lastOrganizedAt: savedSettings.lastOrganizedAt,
          },
          settings: savedSettings,
        });
        return;
      }

      case "GENERATE_SEARCH_KEYWORDS": {
        const currentSettings = await getSettings();
        const aiSettings = normalizeSettings({
          ...currentSettings,
          ...(message.apiKey !== undefined
            ? { apiKey: trimText(message.apiKey) }
            : {}),
        });
        const result = await generateSearchKeywordsWithAI(
          message.description,
          aiSettings
        );
        await appendLog(`AI 生成搜索关键词完成：${result.keywords.length} 个。`);
        sendResponse({
          ok: true,
          result,
        });
        return;
      }

      case "JOB_DETAIL_FOR_AI": {
        const job = message.job || {};
        const settings = await getSettings();
        const result = await matchJobWithAI(job, settings);
        await appendLog(
          `AI 分析完成：${job.title || job.listTitle || "未知职位"} / 分数=${result.score} / 简历模式=${result.resumeMode}`
        );
        sendResponse({
          ok: true,
          result,
        });
        return;
      }

      case "BOSS_API_RESPONSE": {
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({
          ok: false,
          error: `未知消息类型：${message.type}`,
        });
    }
  })().catch(async (error) => {
    try {
      await appendLog(`${message.type} 失败：${error.message}`);
    } catch (_) {}
    sendResponse({
      ok: false,
      error: error.message,
    });
  });

  return true;
});
