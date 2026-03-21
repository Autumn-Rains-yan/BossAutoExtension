// inject.js：在页面环境 hook fetch/XHR，拦截 Boss 列表和详情接口
(function () {
  const JOB_LIST_PATH = "/wapi/zpgeek/pc/recommend/job/list.json";
  const JOB_DETAIL_PATH = "/wapi/zpgeek/job/detail.json";

  function post(type, url, body) {
    try {
      window.postMessage(
        { type: "BOSS_API_RESPONSE", apiType: type, url, body },
        "*"
      );
    } catch (_) {}
  }

  if (typeof window.fetch === "function") {
    const orig = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const res = await orig(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (url.includes(JOB_LIST_PATH) || url.includes(JOB_DETAIL_PATH)) {
          const clone = res.clone();
          clone.json().then(function (data) {
            post(url.includes(JOB_LIST_PATH) ? "jobList" : "jobDetail", url, data);
          }).catch(function () {});
        }
      } catch (_) {}
      return res;
    };
  }

  if (window.XMLHttpRequest) {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._url = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const url = this._url || "";
          if (!url.includes(JOB_LIST_PATH) && !url.includes(JOB_DETAIL_PATH)) return;
          const data = JSON.parse(this.responseText || "{}");
          post(url.includes(JOB_LIST_PATH) ? "jobList" : "jobDetail", url, data);
        } catch (_) {}
      });
      return origSend.apply(this, arguments);
    };
  }
})();
