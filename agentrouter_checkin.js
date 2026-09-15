/**
 * AgentRouter 每日自动签到 —— Surge 原生模块版
 *
 * 站点：https://agentrouter.org
 * 原脚本：https://github.com/ddgksf2013/Scripts/raw/master/agentrouter_checkin.js
 * 本文件为 Surge 优先重写版，配合 AgentRouter.sgmodule 使用，无需 MITM、无需抓 Cookie。
 *
 * 原理：POST /api/user/login 使用账号密码登录，登录本身即触发每日签到；
 *       随后 GET /api/user/self 读取账户额度，GET /api/log/self/ 核验当天签到日志。
 *
 * 配置优先级：模块参数（$argument） > 持久化存储（BoxJS / $persistentStore） > 文件内 DEFAULT_CONFIG
 *   模块参数名 / 持久化键名：
 *     account   / AGENTROUTER_ACCOUNT        单账号：邮箱#密码
 *     accounts  / AGENTROUTER_ACCOUNTS       多账号：[名称|]邮箱#密码;... 或 JSON 数组
 *     baseUrl   / AGENTROUTER_BASE_URL       接口域名，默认 https://agentrouter.org
 *     policy    / AGENTROUTER_POLICY         出站策略 / 策略组，留空按分流规则
 *     timeout   / AGENTROUTER_TIMEOUT        单次请求超时秒数，默认 20
 *     verifyLog / AGENTROUTER_VERIFY_LOG     登录后是否再核验签到日志，默认 true
 *     notify    / AGENTROUTER_NOTIFY         是否发送通知，默认 true
 *
 * 安全提示：账号密码只会发送到 baseUrl 指定的站点，脚本不会外传，也不会写入日志。
 *
 * 注意：模块参数是 "a=b&c=d" 形式，若密码中含 & = % 等字符，请在参数里写成百分号编码
 *       （例如 & 写成 %26），或直接改用持久化存储（BoxJS）写入，避免被截断。
 */

"use strict";

/* ============================ 默认配置 ============================ */

const DEFAULT_CONFIG = {
  baseUrl: "https://agentrouter.org",
  account: "",
  accounts: [],
  policy: "",
  timeoutSeconds: 20,
  verifyLog: true,
  notify: true,
  logWindowDays: 1
};

/* ============================ 接口与常量 ============================ */

const API_LOGIN = "/api/user/login";
const API_USER_SELF = "/api/user/self";
const API_SELF_LOG = "/api/log/self/";
const SELF_LOG_HEADER = "New-API-User";
const CHECKIN_LOG_TYPE = 4;
const QUOTA_PER_DOLLAR = 500000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

let finished = false;
let notifyEnabled = true;

/* ============================ 基础工具 ============================ */

function finish() {
  if (finished) return;
  finished = true;
  if (typeof $done === "function") $done();
}

function pad2(n) {
  return ("0" + n).slice(-2);
}

function formatTime(date) {
  const d = date || new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function log(message) {
  console.log("[" + formatTime() + "] " + message);
}

function errText(err) {
  if (err && typeof err === "object") {
    return String(err.message || err.error || JSON.stringify(err));
  }
  return String(err === null || err === undefined ? "未知错误" : err);
}

function trim(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  const s = trim(value).toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

function postNotify(title, body, subtitle) {
  if (!notifyEnabled) {
    log("[通知已关闭] " + title + " | " + (body || ""));
    return;
  }
  try {
    if (typeof $notification !== "undefined" && $notification && typeof $notification.post === "function") {
      $notification.post(title, subtitle || "", body || "");
    } else {
      log("[通知] " + title + " | " + (body || ""));
    }
  } catch (e) {
    log("通知发送失败（不影响签到）: " + errText(e));
  }
}

/* ============================ 环境与配置读取 ============================ */

function readStore(key) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore && typeof $persistentStore.read === "function") {
      const v = $persistentStore.read(key);
      return v === null || v === undefined ? "" : String(v);
    }
    if (typeof $prefs !== "undefined" && $prefs && typeof $prefs.valueForKey === "function") {
      const v = $prefs.valueForKey(key);
      return v === null || v === undefined ? "" : String(v);
    }
  } catch (e) {
    log("读取持久化配置失败 [" + key + "]: " + errText(e));
  }
  return "";
}

/** 解析 Surge 模块 argument："a=b&c=d" */
function parseArguments(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  raw.split("&").forEach(function (pair) {
    if (!pair) return;
    const idx = pair.indexOf("=");
    const key = trim(idx < 0 ? pair : pair.slice(0, idx));
    if (!key) return;
    let value = idx < 0 ? "" : pair.slice(idx + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, "%20"));
    } catch (e) {
      /* 保留原始值 */
    }
    out[key] = value;
  });
  return out;
}

/** "邮箱#密码" / "邮箱|密码" */
function splitAccount(text) {
  const s = trim(text);
  if (!s) return null;
  let idx = s.lastIndexOf("#");
  if (idx < 0) idx = s.indexOf("|");
  if (idx < 0) return { email: s, password: "" };
  return { email: trim(s.slice(0, idx)), password: trim(s.slice(idx + 1)) };
}

function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  let email = "";
  let password = "";
  if (trim(raw.account)) {
    const parsed = splitAccount(raw.account);
    if (parsed) {
      email = parsed.email;
      password = parsed.password;
    }
  }
  if ((!email || !password) && trim(raw.email) && trim(raw.password)) {
    email = trim(raw.email);
    password = trim(raw.password);
  }
  if (!email || !password) return null;
  return { name: trim(raw.name) || ("账号" + (index + 1)), email: email, password: password };
}

/**
 * 多账号解析：
 *  1) JSON 数组：[{"name":"甲","account":"a@x.com#pwdA"}]
 *  2) 分号列表：[名称|]邮箱#密码;...
 */
function parseAccountList(raw, label) {
  if (Array.isArray(raw)) {
    return raw.map(normalizeAccount).filter(Boolean);
  }
  const s = trim(raw);
  if (!s) return [];

  if (s.charAt(0) === "[") {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) {
        log(label + " 必须是 JSON 数组");
        return [];
      }
      return arr.map(normalizeAccount).filter(Boolean);
    } catch (e) {
      log(label + " JSON 解析失败: " + errText(e));
      return [];
    }
  }

  return s.split(";").map(function (item, i) {
    const t = trim(item);
    if (!t) return null;
    const bar = t.indexOf("|");
    if (bar >= 0) {
      return normalizeAccount({ name: trim(t.slice(0, bar)), account: trim(t.slice(bar + 1)) }, i);
    }
    return normalizeAccount({ account: t }, i);
  }).filter(Boolean);
}

function resolveConfig() {
  const args = parseArguments(typeof $argument === "string" ? $argument : "");

  function pick(argKey, storeKey, fallback) {
    if (args[argKey] !== undefined && trim(args[argKey]) !== "") return trim(args[argKey]);
    const stored = trim(readStore(storeKey));
    if (stored !== "") return stored;
    return fallback;
  }

  const baseUrl = String(pick("baseUrl", "AGENTROUTER_BASE_URL", DEFAULT_CONFIG.baseUrl) ||
    "https://agentrouter.org").replace(/\/+$/, "");

  const timeoutValue = Number(pick("timeout", "AGENTROUTER_TIMEOUT", String(DEFAULT_CONFIG.timeoutSeconds)));
  const timeoutSeconds = Number.isFinite(timeoutValue) && timeoutValue > 0
    ? timeoutValue
    : DEFAULT_CONFIG.timeoutSeconds;

  const verifyLog = parseBool(pick("verifyLog", "AGENTROUTER_VERIFY_LOG", ""), DEFAULT_CONFIG.verifyLog);
  const notifyFlag = parseBool(pick("notify", "AGENTROUTER_NOTIFY", ""), DEFAULT_CONFIG.notify);

  let accounts = [];

  // 1) 模块参数
  accounts = parseAccountList(args["accounts"], "模块参数 accounts");
  if (!accounts.length) {
    const single = splitAccount(args["account"]);
    if (single && single.email && single.password) {
      accounts = [{ name: "默认账号", email: single.email, password: single.password }];
    }
  }

  // 2) 持久化存储（BoxJS）
  if (!accounts.length) {
    accounts = parseAccountList(readStore("AGENTROUTER_ACCOUNTS"), "AGENTROUTER_ACCOUNTS");
    if (accounts.length) log("已读取持久化多账号配置，共 " + accounts.length + " 个");
  }
  if (!accounts.length) {
    const single = splitAccount(readStore("AGENTROUTER_ACCOUNT"));
    if (single && single.email && single.password) {
      accounts = [{ name: "默认账号", email: single.email, password: single.password }];
      log("已读取持久化单账号配置");
    }
  }

  // 3) 文件内配置
  if (!accounts.length) {
    accounts = parseAccountList(DEFAULT_CONFIG.accounts, "CONFIG.accounts");
    if (accounts.length) log("已读取脚本内多账号配置，共 " + accounts.length + " 个");
  }
  if (!accounts.length) {
    const single = splitAccount(DEFAULT_CONFIG.account);
    if (single && single.email && single.password) {
      accounts = [{ name: "默认账号", email: single.email, password: single.password }];
      log("已读取脚本内单账号配置");
    }
  }

  return {
    baseUrl: baseUrl,
    policy: pick("policy", "AGENTROUTER_POLICY", DEFAULT_CONFIG.policy),
    timeoutSeconds: timeoutSeconds,
    verifyLog: verifyLog,
    notify: notifyFlag,
    logWindowDays: DEFAULT_CONFIG.logWindowDays,
    accounts: accounts
  };
}

/* ============================ HTTP 封装（Surge $httpClient） ============================ */

function headerValues(headers, name) {
  const target = name.toLowerCase();
  const out = [];
  if (!headers) return out;

  if (Array.isArray(headers)) {
    headers.forEach(function (item) {
      if (!item || String(item.field || "").toLowerCase() !== target) return;
      if (Array.isArray(item.value)) {
        for (let i = 0; i < item.value.length; i++) out.push(item.value[i]);
      } else if (item.value !== undefined && item.value !== null) {
        out.push(item.value);
      }
    });
    return out;
  }

  Object.keys(headers).forEach(function (key) {
    if (key.toLowerCase() !== target) return;
    const value = headers[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) out.push(value[i]);
    } else if (value !== undefined && value !== null) {
      out.push(value);
    }
  });
  return out;
}

function getHeader(headers, name) {
  const values = headerValues(headers, name);
  return values.length ? String(values[0]) : "";
}

/** 把响应头里的 Set-Cookie 拼成请求用的 Cookie 头 */
function buildCookieHeader(headers) {
  const pairs = [];
  headerValues(headers, "set-cookie").forEach(function (raw) {
    String(raw).split(/\r?\n/).forEach(function (line) {
      line.split(/,(?=\s*[^;,\s]+=)/).forEach(function (chunk) {
        const pair = chunk.split(";")[0].trim();
        if (/^[^=;\s]+=.*/.test(pair) && pairs.indexOf(pair) < 0) pairs.push(pair);
      });
    });
  });
  return pairs.join("; ");
}

function httpRequest(options, cfg) {
  return new Promise(function (resolve, reject) {
    if (typeof $httpClient === "undefined" || !$httpClient) {
      reject(new Error("当前环境不支持 $httpClient，请在 Surge 中运行本脚本"));
      return;
    }
    const method = String(options.method || "GET").toLowerCase();
    const fn = $httpClient[method];
    if (typeof fn !== "function") {
      reject(new Error("当前环境不支持 HTTP 方法: " + method.toUpperCase()));
      return;
    }

    const opts = {
      url: options.url,
      headers: options.headers || {},
      timeout: cfg.timeoutSeconds,
      "auto-redirect": true,
      "auto-cookie": false
    };
    if (options.body !== undefined && options.body !== null) opts.body = options.body;
    if (cfg.policy) opts.policy = cfg.policy;

    let settled = false;
    const guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("请求超时（" + cfg.timeoutSeconds + " 秒）"));
    }, (cfg.timeoutSeconds + 5) * 1000);

    fn.call($httpClient, opts, function (error, response, data) {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (error) {
        reject(new Error(errText(error)));
        return;
      }
      resolve({
        status: Number((response && (response.status || response.statusCode)) || 0),
        headers: (response && response.headers) || {},
        body: typeof data === "string" ? data : (data === undefined || data === null ? "" : String(data))
      });
    });
  });
}

/* ============================ 数据解析与格式化 ============================ */

function parseJsonResponse(res, label) {
  const contentType = getHeader(res.headers, "content-type").toLowerCase();
  if (contentType.indexOf("text/html") >= 0) {
    throw new Error(label + "返回 HTML（HTTP " + res.status + "），可能被 WAF 拦截或接口已变化");
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error(label + "返回非 JSON（HTTP " + res.status + "）");
  }
}

function quotaToDollars(value) {
  const n = finiteNumber(value);
  return n === null ? null : Math.round((n / QUOTA_PER_DOLLAR) * 100) / 100;
}

function quotaDetailsFromUserData(data, source) {
  const empty = { remaining: null, used: null, total: null, source: source || "unknown" };
  if (!data || typeof data !== "object") return empty;

  const remaining = quotaToDollars(data.quota);
  const used = quotaToDollars(data.used_quota);
  let total = quotaToDollars(data.total_quota);
  if (total === null && remaining !== null && used !== null) {
    total = Math.round((remaining + used) * 100) / 100;
  }
  return { remaining: remaining, used: used, total: total, source: source || "unknown" };
}

function moneyText(value) {
  const n = finiteNumber(value);
  return n === null ? "未知" : "$" + n.toFixed(2);
}

function agoText(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

/** 屏蔽服务端回显里可能出现的账号密码 */
function maskSecrets(text, account) {
  let s = String(text || "未知错误").replace(/[\r\n]+/g, " ").slice(0, 160);
  [account && account.email, account && account.password].forEach(function (v) {
    if (v) s = s.split(v).join("***");
  });
  return s;
}

function makeResult(name, status, message, username, quota) {
  const q = quota || { remaining: null, used: null, total: null, source: "unknown" };
  const result = {
    name: name,
    status: status,
    message: message,
    username: username || "",
    quota: q.remaining,
    usedQuota: q.used,
    totalQuota: q.total,
    quotaSource: q.source,
    time: formatTime()
  };
  const labels = { success: "✅ 成功", already: "🟡 已签到", fail: "❌ 失败" };
  log("[" + name + "] " + (labels[status] || status) + " | " + message +
    " | 剩余: " + moneyText(result.quota) +
    " | 已用: " + moneyText(result.usedQuota) +
    " | 总额: " + moneyText(result.totalQuota));
  return result;
}

/* ============================ 业务逻辑 ============================ */

async function verifyCheckin(cfg, uid, cookie, freshWindowSeconds, windowDays) {
  if (!uid) return { level: "error", detail: "缺少 uid，跳过日志核验" };

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": USER_AGENT
  };
  headers[SELF_LOG_HEADER] = String(uid);
  if (cookie) headers["Cookie"] = cookie;

  let res;
  try {
    res = await httpRequest({
      url: cfg.baseUrl + API_SELF_LOG + "?p=1&page_size=20",
      method: "GET",
      headers: headers
    }, cfg);
  } catch (e) {
    return { level: "error", detail: "日志查询异常: " + errText(e) };
  }

  if (res.status !== 200 || getHeader(res.headers, "content-type").toLowerCase().indexOf("text/html") >= 0) {
    return { level: "error", detail: "日志接口返回 HTTP " + res.status };
  }

  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch (e) {
    return { level: "error", detail: "日志接口返回非 JSON" };
  }

  const items = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
  let latest = null;
  let latestContent = "";
  items.forEach(function (item) {
    if (!item || typeof item !== "object") return;
    const content = String(item.content || "");
    const isCheckin = content.indexOf("签到成功") >= 0 || Number(item.type) === CHECKIN_LOG_TYPE;
    const ts = Number(item.created_at);
    if (isCheckin && Number.isFinite(ts) && (latest === null || ts > latest)) {
      latest = ts;
      latestContent = content;
    }
  });

  if (latest === null) return { level: "none", detail: "日志中未找到任何签到记录" };

  const now = Math.floor(Date.now() / 1000);
  const ago = agoText(now - latest);

  if (latest >= now - freshWindowSeconds) {
    return { level: "new", detail: "本次运行已生成签到日志（" + ago + "）", timestamp: latest, content: latestContent };
  }
  if (latest >= now - 86400 * windowDays) {
    return {
      level: "today",
      detail: "近 " + windowDays + " 天内有签到记录（" + ago + "），本次未新增",
      timestamp: latest,
      content: latestContent
    };
  }
  return { level: "none", detail: "最近一条签到日志较旧（" + ago + "）", timestamp: latest, content: latestContent };
}

async function fetchQuotaDetails(cfg, uid, cookie, loginData) {
  const fallback = quotaDetailsFromUserData(loginData, "login-fallback");
  if (!uid) return { details: fallback, warning: "缺少 uid，无法查询完整账户额度" };

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": USER_AGENT
  };
  headers[SELF_LOG_HEADER] = String(uid);
  if (cookie) headers["Cookie"] = cookie;

  let res;
  try {
    res = await httpRequest({ url: cfg.baseUrl + API_USER_SELF, method: "GET", headers: headers }, cfg);
  } catch (e) {
    return { details: fallback, warning: "账户额度查询异常: " + errText(e) };
  }
  if (res.status !== 200) return { details: fallback, warning: "账户额度接口返回 HTTP " + res.status };

  let payload;
  try {
    payload = parseJsonResponse(res, "账户额度接口");
  } catch (e) {
    return { details: fallback, warning: errText(e) };
  }

  if (!payload || !payload.success || !payload.data || typeof payload.data !== "object") {
    return { details: fallback, warning: "账户额度接口未返回有效用户数据" };
  }

  const details = quotaDetailsFromUserData(payload.data, "user-self");
  if (details.remaining === null && details.used === null && details.total === null) {
    return { details: fallback, warning: "账户资料中未找到 quota / used_quota / total_quota" };
  }
  return { details: details, warning: "" };
}

async function loginAndCheckin(account, cfg) {
  const name = account.name || "默认账号";
  if (!account.email || !account.password) {
    return makeResult(name, "fail", "未配置 email / password，跳过", "", null);
  }
  log("====== 开始处理账号（账号密码登录即签到）: " + name + " ======");

  let res;
  try {
    res = await httpRequest({
      url: cfg.baseUrl + API_LOGIN,
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Referer": cfg.baseUrl + "/login",
        "Origin": cfg.baseUrl
      },
      body: JSON.stringify({ username: account.email, password: account.password })
    }, cfg);
  } catch (e) {
    return makeResult(name, "fail", "登录请求异常: " + maskSecrets(errText(e), account), "", null);
  }

  let payload;
  try {
    payload = parseJsonResponse(res, "登录接口");
  } catch (e) {
    return makeResult(name, "fail", errText(e), "", null);
  }

  if (!payload || !payload.success) {
    return makeResult(name, "fail", "登录失败: " + maskSecrets(payload && payload.message, account), "", null);
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const checkedIn = Boolean(data.checked_in);
  const username = data.username || data.display_name || account.email;
  const cookie = buildCookieHeader(res.headers);

  const quotaResult = await fetchQuotaDetails(cfg, data.id, cookie, data);
  const quota = quotaResult.details;

  let message;
  if (checkedIn && cfg.verifyLog) {
    const verify = await verifyCheckin(cfg, data.id, cookie, 300, cfg.logWindowDays);
    if (verify.level === "new" || verify.level === "today") {
      message = "签到成功，日志已确认（" + verify.detail + "）";
    } else {
      message = "登录成功且服务端返回已签到，但日志未确认: " + verify.detail;
      if (!cookie) message += "；登录响应中未读取到 Set-Cookie";
    }
  } else if (checkedIn) {
    message = "签到成功（已关闭日志核验）";
  } else {
    message = "登录成功，但 checked_in=false（可能今日额度已发或接口变化）";
  }

  if (quotaResult.warning) {
    message += "；" + quotaResult.warning;
    if (quota.source === "login-fallback") message += "，当前额度来自登录响应后备值";
  }

  return makeResult(name, "success", message, username, quota);
}

function buildSummary(results) {
  const lines = results.map(function (r) {
    const icon = r.status === "fail" ? "❌" : (r.status === "already" ? "🟡" : "✅");
    return icon + " " + r.name + "\n" + r.message +
      "\n剩余额度: " + moneyText(r.quota) +
      "｜已用: " + moneyText(r.usedQuota) +
      "｜总额度: " + moneyText(r.totalQuota);
  }).join("\n\n");

  const known = results.filter(function (r) { return finiteNumber(r.totalQuota) !== null; });
  if (!known.length) return lines;

  const sum = { remaining: 0, used: 0, total: 0, remainingKnown: true, usedKnown: true };
  known.forEach(function (r) {
    const remaining = finiteNumber(r.quota);
    const used = finiteNumber(r.usedQuota);
    const total = finiteNumber(r.totalQuota);
    if (remaining !== null) sum.remaining += remaining; else sum.remainingKnown = false;
    if (used !== null) sum.used += used; else sum.usedKnown = false;
    if (total !== null) sum.total += total;
  });

  return lines + "\n\n📊 " + known.length + " 个账号合计\n" +
    "剩余额度: " + (sum.remainingKnown ? moneyText(sum.remaining) : "部分未知") +
    "｜已用: " + (sum.usedKnown ? moneyText(sum.used) : "部分未知") +
    "｜总额度: " + moneyText(sum.total);
}

/* ============================ 入口 ============================ */

async function main() {
  log("AgentRouter 自动签到启动（账号密码登录即签到）");

  const cfg = resolveConfig();
  notifyEnabled = cfg.notify;

  if (!cfg.accounts.length) {
    const message = "未检测到有效账号配置：请在模块「编辑参数」中填写账号（格式 邮箱#密码），" +
      "或写入 AGENTROUTER_ACCOUNT / AGENTROUTER_ACCOUNTS";
    log(message);
    postNotify("[AgentRouter] 签到失败", message);
    return;
  }

  const results = [];
  for (let i = 0; i < cfg.accounts.length; i++) {
    results.push(await loginAndCheckin(cfg.accounts[i], cfg));
  }

  const failed = results.filter(function (r) { return r.status === "fail"; }).length;
  const title = failed
    ? "[AgentRouter] 签到完成（失败 " + failed + "/" + results.length + "）"
    : "[AgentRouter] 签到成功（" + results.length + " 个账号）";

  log(title);
  postNotify(title, buildSummary(results));
}

main()
  .catch(function (e) {
    const message = "脚本异常: " + errText(e);
    log(message);
    try {
      postNotify("[AgentRouter] 签到失败", message);
    } catch (ignored) {
      /* 通知失败不影响收尾 */
    }
  })
  .then(finish);
