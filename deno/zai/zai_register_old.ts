/**
 * Z.AI 账号注册管理系统 V2 - 带登录页面和高级配置
 *
 * 功能特性:
 * - 登录鉴权: Session 管理，防止未授权访问
 * - 批量注册: 支持多线程并发注册 Z.AI 账号
 * - 实时监控: SSE 推送实时日志和进度
 * - 账号管理: 查看、搜索、导出注册的账号
 * - 高级配置: 可自定义邮件超时、注册间隔、通知等参数
 *
 * 数据存储: Deno KV (内置键值数据库)
 *
 * @author dext7r
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// ==================== 配置区域 ====================

const PORT = 8001;  // Web 服务监听端口
const NOTIFY_INTERVAL = 3600;  // 通知发送间隔（秒）
const MAX_LOGIN_ATTEMPTS = 5;  // 最大登录失败次数
const LOGIN_LOCK_DURATION = 900000;  // 登录锁定时长（15分钟）

// 鉴权配置 - 可通过环境变量覆盖
const AUTH_USERNAME = Deno.env.get("ZAI_USERNAME") || "admin";
const AUTH_PASSWORD = Deno.env.get("ZAI_PASSWORD") || "123456";

// 邮箱域名列表 - 用于生成随机临时邮箱
// 这些域名来自 mail.chatgpt.org.uk 的临时邮箱服务
const DOMAINS = [
  "14club.org.uk", "29thnewport.org.uk", "2ndwhartonscoutgroup.org.uk",
  "3littlemiracles.com", "aard.org.uk", "abrahampath.org.uk",
  "aiccministry.com", "allumhall.co.uk", "almiswelfare.org",
  "amyfalconer.co.uk", "avarthanas.org", "aylshamrotary.club",
  "bbfcharity.org", "birdsedgevillagehall.co.uk", "bodyofchristministries.co.uk",
  "bp-hall.co.uk", "brendansbridge.org.uk", "brentwoodmdc.org",
  "cade.org.uk", "caye.org.uk", "cccnoahsark.com", "cccvojc.org",
  "cementingfutures.org", "cephastrust.org", "chatgptuk.pp.ua",
  "christchurchandstgeorges.org", "christchurchsouthend.org.uk",
  "cketrust.org", "club106.org.uk", "cockertonmethodist.org.uk",
  "cok.org.uk", "counsellingit.org", "cumnorthampton.org", "cwetg.co.uk",
  "dormerhouseschool.co.uk", "dpmcharity.org", "e-quiparts.org.uk",
  "eapn-england.org", "educationossett.co.uk", "egremonttrust.org.uk",
  "email.gravityengine.cc", "engagefordevelopment.org", "f4jobseekers.org.uk",
  "flushingvillageclub.org.uk", "fordslane.org.uk", "freemails.pp.ua",
  "friendsofkms.org.uk", "gadshillplace.com", "goleudy.org.uk",
  "gospelassembly.org.uk", "gospelgeneration.org.uk", "gracesanctuary-rccg.co.uk",
  "gravityengine.cc", "greyhoundwalks.org.uk", "gyan-netra.com",
  "haslemerecfr.org.uk", "hfh4elderly.org", "hhe.org.uk",
  "hottchurch.org.uk", "huddsdeafcentre.org", "hvcrc.org",
  "ingrambreamishvalley.co.uk", "iqraacademy.org.uk", "iraniandsa.org"
];

// ==================== 数据存储 ====================

// Deno KV 数据库实例
const kv = await Deno.openKv();

// ==================== 全局状态 ====================

let isRunning = false;  // 注册任务是否正在运行
let shouldStop = false;  // 是否请求停止注册
const sseClients = new Set<ReadableStreamDefaultController>();  // SSE 客户端连接池
let stats = { success: 0, failed: 0, startTime: 0, lastNotifyTime: 0 };  // 统计信息
const logHistory: any[] = [];  // 日志历史记录（内存缓存）
const MAX_LOG_HISTORY = 500;  // 最大日志条数
let logSaveTimer: number | null = null;  // 日志保存定时器
const LOG_SAVE_INTERVAL = 30000;  // 日志保存间隔（30秒）

// 登录失败跟踪（IP -> {attempts: number, lockedUntil: number}）
const loginAttempts = new Map<string, { attempts: number; lockedUntil: number }>();

/**
 * 批量保存日志到 KV（节流）
 */
async function saveLogs(): Promise<void> {
  if (logHistory.length === 0) return;

  try {
    const logKey = ["logs", "recent"];
    const now = Date.now();

    // 只保存最近1小时的日志，并过滤旧数据
    const oneHourAgo = now - 3600000;
    const recentLogs = logHistory
      .filter(log => log.timestamp > oneHourAgo)
      .slice(-200);

    if (recentLogs.length > 0) {
      await kv.set(logKey, recentLogs, { expireIn: 3600000 });  // 1小时过期
    } else {
      // 如果没有新日志，删除旧key
      await kv.delete(logKey);
    }
  } catch (error) {
    console.error("保存日志失败:", error);
  }
}

/**
 * 调度日志保存（防抖）
 */
function scheduleSaveLogs() {
  if (logSaveTimer) {
    clearTimeout(logSaveTimer);
  }

  logSaveTimer = setTimeout(() => {
    saveLogs();
    logSaveTimer = null;
  }, LOG_SAVE_INTERVAL);
}

/**
 * 广播消息并自动保存日志
 */
function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  console.log(`📤 broadcast: type=${data.type}, sseClients=${sseClients.size}, message=${message.substring(0, 100)}...`);

  for (const controller of sseClients) {
    try {
      controller.enqueue(new TextEncoder().encode(message));
    } catch (err) {
      console.log(`⚠️ SSE客户端发送失败，移除连接:`, err);
      sseClients.delete(controller);
    }
  }

  // 保存到内存
  if (data.type === 'log' || data.type === 'start' || data.type === 'complete') {
    logHistory.push({ ...data, timestamp: Date.now() });

    // 清理超过1小时的旧日志（内存）
    const oneHourAgo = Date.now() - 3600000;
    while (logHistory.length > 0 && logHistory[0].timestamp < oneHourAgo) {
      logHistory.shift();
    }

    // 限制最大数量
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.shift();
    }

    // 调度批量保存（节流，30秒一次）
    scheduleSaveLogs();

    // 在任务完成或停止时立即保存
    if (data.type === 'complete' || (data.type === 'log' && data.level === 'error')) {
      saveLogs().catch(() => {});
    }
  }
}

/**
 * 生成唯一的 Session ID
 */
function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * 获取客户端 IP 地址
 */
function getClientIP(req: Request): string {
  // 优先从 X-Forwarded-For 获取（反向代理场景）
  const forwarded = req.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // 从 X-Real-IP 获取
  const realIP = req.headers.get("X-Real-IP");
  if (realIP) {
    return realIP;
  }

  // 默认返回占位符（Deno.serve 不直接提供 socket 信息）
  return "unknown";
}

/**
 * 检查 IP 是否被锁定
 */
function checkIPLocked(ip: string): { locked: boolean; remainingTime?: number } {
  const record = loginAttempts.get(ip);
  if (!record) {
    return { locked: false };
  }

  const now = Date.now();
  if (record.lockedUntil > now) {
    return {
      locked: true,
      remainingTime: Math.ceil((record.lockedUntil - now) / 1000)  // 秒
    };
  }

  // 锁定已过期，清除记录
  loginAttempts.delete(ip);
  return { locked: false };
}

/**
 * 记录登录失败
 */
function recordLoginFailure(ip: string): void {
  const record = loginAttempts.get(ip) || { attempts: 0, lockedUntil: 0 };
  record.attempts++;

  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOGIN_LOCK_DURATION;
    console.log(`🔒 IP ${ip} 已被锁定 ${LOGIN_LOCK_DURATION / 60000} 分钟（失败 ${record.attempts} 次）`);
  }

  loginAttempts.set(ip, record);
}

/**
 * 清除登录失败记录
 */
function clearLoginFailure(ip: string): void {
  loginAttempts.delete(ip);
}

// 注册配置（可动态调整）
let registerConfig = {
  emailTimeout: 120,  // 邮件等待超时（秒）
  emailCheckInterval: 1,  // 邮件轮询间隔（秒）
  registerDelay: 2000,  // 每个账号注册间隔（毫秒）
  retryTimes: 3,  // API 重试次数
  concurrency: 10,  // 并发数（1-10）
  enableNotification: false,  // 是否启用通知（默认关闭）
  pushplusToken: "",  // PushPlus Token（需要用户自行配置）
};

// ==================== 鉴权相关 ====================

/**
 * 检查请求是否已认证（从 KV 读取 session）
 * @param req HTTP 请求对象
 * @returns 认证状态和 session ID
 */
async function checkAuth(req: Request): Promise<{ authenticated: boolean; sessionId?: string }> {
  const cookies = req.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/sessionId=([^;]+)/);

  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    // 从 KV 检查 session 是否存在且未过期
    const sessionKey = ["sessions", sessionId];
    const session = await kv.get(sessionKey);

    if (session.value) {
      return { authenticated: true, sessionId };
    }
  }

  return { authenticated: false };
}

// ==================== 工具函数 ====================

/**
 * 生成随机邮箱地址
 * @returns 随机生成的邮箱地址
 */
function createEmail(): string {
  const randomHex = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
  return `${randomHex}@${domain}`;
}

/**
 * 生成随机密码
 * @returns 14位随机密码
 */
function createPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: 14 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

/**
 * 发送 PushPlus 通知
 * @param title 通知标题
 * @param content 通知内容（支持 Markdown）
 */
async function sendNotification(title: string, content: string): Promise<void> {
  // 检查是否启用通知和 Token 是否配置
  if (!registerConfig.enableNotification || !registerConfig.pushplusToken) return;

  try {
    await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: registerConfig.pushplusToken,
        title,
        content,
        template: "markdown"
      })
    });
  } catch {
    // 忽略错误
  }
}

/**
 * 获取验证邮件
 * @param email 邮箱地址
 * @returns 邮件内容或 null
 */
async function fetchVerificationEmail(email: string): Promise<string | null> {
  const actualTimeout = registerConfig.emailTimeout;  // 使用配置的超时时间
  const checkInterval = registerConfig.emailCheckInterval;  // 使用配置的轮询间隔
  const startTime = Date.now();
  const apiUrl = `https://mail.chatgpt.org.uk/api/get-emails?email=${encodeURIComponent(email)}`;

  let attempts = 0;
  let lastReportTime = 0;  // 上次报告进度的时间
  const reportInterval = 10;  // 每 10 秒报告一次进度

  // 格式化时间显示
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m${secs}s`;
  };

  while (Date.now() - startTime < actualTimeout * 1000) {
    attempts++;
    try {
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();

      // 每 10 秒报告一次进度
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastReportTime >= reportInterval && elapsed > 0) {
        const progress = Math.min(Math.floor((elapsed / actualTimeout) * 100), 99);
        const remaining = actualTimeout - elapsed;
        broadcast({
          type: 'log',
          level: 'info',
          message: `  等待验证邮件中... [${progress}%] 已用: ${formatTime(elapsed)} / 剩余: ${formatTime(remaining)} (已尝试 ${attempts} 次)`
        });
        lastReportTime = elapsed;
      }

      if (data?.emails) {
        for (const emailData of data.emails) {
          if (emailData.from?.toLowerCase().includes("z.ai")) {
            broadcast({ type: 'log', level: 'success', message: `  ✓ 收到验证邮件 (耗时 ${Math.floor((Date.now() - startTime) / 1000)}s)` });
            return emailData.content || null;
          }
        }
      }
    } catch {
      // 继续重试
    }
    // 使用配置的轮询间隔
    await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
  }

  broadcast({ type: 'log', level: 'error', message: `  ✗ 验证邮件超时 (等待了 ${actualTimeout}s)` });
  return null;
}

function parseVerificationUrl(url: string): { token: string | null; email: string | null; username: string | null } {
  try {
    const urlObj = new URL(url);
    return {
      token: urlObj.searchParams.get('token'),
      email: urlObj.searchParams.get('email'),
      username: urlObj.searchParams.get('username')
    };
  } catch {
    return { token: null, email: null, username: null };
  }
}

/**
 * API登录功能 - 移植自Python版本
 * 使用用户Token登录到API获取access_token
 */
async function loginToApi(token: string): Promise<string | null> {
  const url = 'https://api.z.ai/api/auth/z/login';
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://z.ai',
    'Referer': 'https://z.ai/',
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(15000)  // 15秒超时
    });

    const result = await response.json();
    if (result.success && result.code === 200) {
      const accessToken = result.data?.access_token;
      if (accessToken) {
        broadcast({ type: 'log', level: 'success', message: `  ✓ API登录成功` });
        return accessToken;
      }
    }
    broadcast({ type: 'log', level: 'error', message: `  ✗ API登录失败: ${JSON.stringify(result)}` });
    return null;
  } catch (error) {
    broadcast({ type: 'log', level: 'error', message: `  ✗ API登录异常: ${error}` });
    return null;
  }
}

/**
 * 获取客户信息 - 移植自Python版本
 * 获取组织ID和项目ID用于创建API密钥
 */
async function getCustomerInfo(accessToken: string): Promise<{ orgId: string | null; projectId: string | null }> {
  const url = 'https://api.z.ai/api/biz/customer/getCustomerInfo';
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://z.ai',
    'Referer': 'https://z.ai/'
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20000)  // 20秒超时
    });

    const result = await response.json();
    if (result.success && result.code === 200) {
      const orgs = result.data?.organizations || [];
      if (orgs.length > 0) {
        const orgId = orgs[0].organizationId;
        const projects = orgs[0].projects || [];
        const projectId = projects.length > 0 ? projects[0].projectId : null;

        if (orgId && projectId) {
          broadcast({ type: 'log', level: 'success', message: `  ✓ 获取客户信息成功` });
          return { orgId, projectId };
        }
      }
    }
    broadcast({ type: 'log', level: 'error', message: `  ✗ 获取客户信息失败: ${JSON.stringify(result)}` });
    return { orgId: null, projectId: null };
  } catch (error) {
    broadcast({ type: 'log', level: 'error', message: `  ✗ 获取客户信息异常: ${error}` });
    return { orgId: null, projectId: null };
  }
}

/**
 * 创建API密钥 - 移植自Python版本
 * 生成最终的API密钥
 */
async function createApiKey(accessToken: string, orgId: string, projectId: string): Promise<string | null> {
  const url = `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://z.ai',
    'Referer': 'https://z.ai/'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'auto_generated_key' }),
      signal: AbortSignal.timeout(30000)  // 30秒超时
    });

    const result = await response.json();
    if (result.success && result.code === 200) {
      const apiKeyData = result.data || {};
      const finalKey = `${apiKeyData.apiKey}.${apiKeyData.secretKey}`;
      if (finalKey && finalKey !== 'undefined.undefined') {
        broadcast({ type: 'log', level: 'success', message: `  ✓ API密钥创建成功` });
        return finalKey;
      }
    }
    broadcast({ type: 'log', level: 'error', message: `  ✗ 创建API密钥失败: ${JSON.stringify(result)}` });
    return null;
  } catch (error) {
    broadcast({ type: 'log', level: 'error', message: `  ✗ 创建API密钥异常: ${error}` });
    return null;
  }
}

async function saveAccount(email: string, password: string, token: string, apikey?: string): Promise<void> {
  const timestamp = Date.now();
  const key = ["zai_accounts", timestamp, email];
  await kv.set(key, {
    email,
    password,
    token,
    apikey: apikey || null,  // 新增 APIKEY 字段
    createdAt: new Date().toISOString()
  });
}

interface RegisterResult {
  success: boolean;
  account?: { email: string; password: string; token: string; apikey: string | null };
}

async function registerAccount(): Promise<RegisterResult> {
  try {
    const email = createEmail();
    const password = createPassword();
    const name = email.split("@")[0];
    const emailCheckUrl = `https://mail.chatgpt.org.uk/api/get-emails?email=${encodeURIComponent(email)}`;

    broadcast({
      type: 'log',
      level: 'info',
      message: `▶ 开始注册: ${email}`,
      link: { text: '查看邮箱', url: emailCheckUrl }
    });

    // 1. 注册
    broadcast({ type: 'log', level: 'info', message: `  → 发送注册请求...` });
    const signupResponse = await fetch("https://chat.z.ai/api/v1/auths/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, profile_image_url: "data:image/png;base64,", sso_redirect: null }),
      signal: AbortSignal.timeout(30000)
    });

    if (signupResponse.status !== 200) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 注册请求失败: HTTP ${signupResponse.status}` });
      stats.failed++;
      return { success: false };
    }

    const signupResult = await signupResponse.json();
    if (!signupResult.success) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 注册被拒绝: ${JSON.stringify(signupResult)}` });
      stats.failed++;
      return { success: false };
    }

    broadcast({ type: 'log', level: 'success', message: `  ✓ 注册请求成功` });

    // 2. 获取验证邮件
    broadcast({
      type: 'log',
      level: 'info',
      message: `  → 等待验证邮件: ${email}`,
      link: { text: '点击打开邮箱', url: emailCheckUrl }
    });
    const emailContent = await fetchVerificationEmail(email);
    if (!emailContent) {
      stats.failed++;
      return { success: false };
    }

    // 3. 提取验证链接
    broadcast({ type: 'log', level: 'info', message: `  → 提取验证链接...` });

    // 尝试多种匹配方式
    let verificationUrl = null;

    // 方式1: 匹配 /auth/verify_email 路径（新版本）
    let match = emailContent.match(/https:\/\/chat\.z\.ai\/auth\/verify_email\?[^\s<>"']+/);
    if (match) {
      verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    }

    // 方式2: 匹配 /verify_email 路径（旧版本）
    if (!verificationUrl) {
      match = emailContent.match(/https:\/\/chat\.z\.ai\/verify_email\?[^\s<>"']+/);
      if (match) {
        verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
        broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (旧版路径)` });
      }
    }

    // 方式3: 匹配HTML编码的URL
    if (!verificationUrl) {
      match = emailContent.match(/https?:\/\/chat\.z\.ai\/(?:auth\/)?verify_email[^"'\s]*/);
      if (match) {
        verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
        broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (HTML解码)` });
      }
    }

    // 方式4: 在JSON中查找
    if (!verificationUrl) {
      try {
        const urlMatch = emailContent.match(/"(https?:\/\/[^"]*verify_email[^"]*)"/);
        if (urlMatch) {
          verificationUrl = urlMatch[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
          broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (JSON格式)` });
        }
      } catch (e) {
        // 忽略JSON解析错误
      }
    }

    if (!verificationUrl) {
      // 打印邮件内容的前500个字符用于调试
      const preview = emailContent.substring(0, 500).replace(/\n/g, ' ');
      broadcast({ type: 'log', level: 'error', message: `  ✗ 未找到验证链接，邮件预览: ${preview}...` });
      stats.failed++;
      return { success: false };
    }


    const { token, email: emailFromUrl, username } = parseVerificationUrl(verificationUrl);
    if (!token || !emailFromUrl || !username) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证链接格式错误` });
      stats.failed++;
      return { success: false };
    }

    broadcast({ type: 'log', level: 'success', message: `  ✓ 验证链接已提取` });

    // 4. 完成注册
    broadcast({ type: 'log', level: 'info', message: `  → 提交验证信息...` });
    const finishResponse = await fetch("https://chat.z.ai/api/v1/auths/finish_signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailFromUrl, password, profile_image_url: "data:image/png;base64,", sso_redirect: null, token, username }),
      signal: AbortSignal.timeout(30000)
    });

    if (finishResponse.status !== 200) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证失败: HTTP ${finishResponse.status}` });
      stats.failed++;
      return { success: false };
    }

    const finishResult = await finishResponse.json();
    if (!finishResult.success) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证被拒绝: ${JSON.stringify(finishResult)}` });
      stats.failed++;
      return { success: false };
    }

    // 5. 获取用户Token
    const userToken = finishResult.user?.token;
    if (!userToken) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 未获取到用户Token` });
      stats.failed++;
      return { success: false };
    }

    broadcast({ type: 'log', level: 'success', message: `  ✓ 获得用户Token` });

    // 6. API登录
    broadcast({ type: 'log', level: 'info', message: `  → 登录API平台...` });
    const accessToken = await loginToApi(userToken);
    if (!accessToken) {
      // 即使API登录失败，也保存账号（只有Token，没有APIKEY）
      await saveAccount(email, password, userToken);
      stats.success++;
      broadcast({
        type: 'log',
        level: 'warning',
        message: `⚠️ 注册成功但API登录失败: ${email} (仅获取Token)`,
        stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed },
        link: { text: '查看邮箱', url: emailCheckUrl }
      });
      const account = { email, password, token: userToken, apikey: null, createdAt: new Date().toISOString() };
      broadcast({ type: 'account_added', account });
      return { success: true, account };
    }

    // 7. 获取客户信息
    broadcast({ type: 'log', level: 'info', message: `  → 获取组织信息...` });
    const { orgId, projectId } = await getCustomerInfo(accessToken);
    if (!orgId || !projectId) {
      // 保存账号（只有Token，没有APIKEY）
      await saveAccount(email, password, userToken);
      stats.success++;
      broadcast({
        type: 'log',
        level: 'warning',
        message: `⚠️ 注册成功但获取组织信息失败: ${email} (仅获取Token)`,
        stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed },
        link: { text: '查看邮箱', url: emailCheckUrl }
      });
      const account = { email, password, token: userToken, apikey: null, createdAt: new Date().toISOString() };
      broadcast({ type: 'account_added', account });
      return { success: true, account };
    }

    // 8. 创建API密钥
    broadcast({ type: 'log', level: 'info', message: `  → 创建API密钥...` });
    const apiKey = await createApiKey(accessToken, orgId, projectId);

    // 9. 保存完整账号信息
    await saveAccount(email, password, userToken, apiKey || undefined);
    stats.success++;

    const account = { email, password, token: userToken, apikey: apiKey || null, createdAt: new Date().toISOString() };

    if (apiKey) {
      broadcast({
        type: 'log',
        level: 'success',
        message: `✅ 注册完成: ${email} (包含APIKEY)`,
        stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed },
        link: { text: '查看邮箱', url: emailCheckUrl }
      });
      broadcast({ type: 'account_added', account });
    } else {
      broadcast({
        type: 'log',
        level: 'warning',
        message: `⚠️ 注册成功但创建API密钥失败: ${email} (仅获取Token)`,
        stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed },
        link: { text: '查看邮箱', url: emailCheckUrl }
      });
      broadcast({ type: 'account_added', account });
    }

    return { success: true, account };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    broadcast({ type: 'log', level: 'error', message: `  ✗ 异常: ${msg}` });
    stats.failed++;
    return { success: false };
  }
}

async function batchRegister(count: number): Promise<void> {
  console.log(`🚀 batchRegister 开始，count=${count}, sseClients.size=${sseClients.size}`);

  isRunning = true;
  shouldStop = false;
  stats = { success: 0, failed: 0, startTime: Date.now(), lastNotifyTime: Date.now() };

  console.log(`📡 准备广播 'start' 事件...`);
  broadcast({ type: 'start', config: { count } });
  console.log(`✓ 已广播 'start' 事件`);

  const concurrency = registerConfig.concurrency || 1;
  let completed = 0;
  const successAccounts: Array<{ email: string; password: string; token: string; apikey: string | null }> = [];  // 存储成功注册的账号

  // 并发注册
  while (completed < count && !shouldStop) {
    // 计算本批次任务数量
    const batchSize = Math.min(concurrency, count - completed);
    const batchPromises: Promise<RegisterResult>[] = [];

    // 创建并发任务
    for (let i = 0; i < batchSize; i++) {
      const taskIndex = completed + i + 1;
      const progress = Math.floor((taskIndex / count) * 100);
      const elapsed = Math.floor((Date.now() - stats.startTime) / 1000);
      const avgTimePerAccount = completed > 0 ? elapsed / completed : 0;
      const remaining = count - taskIndex;
      const eta = avgTimePerAccount > 0 ? Math.ceil(remaining * avgTimePerAccount) : 0;

      // 格式化时间显示
      const formatTime = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m${secs}s`;
      };

      broadcast({
        type: 'log',
        level: 'info',
        message: `\n[${taskIndex}/${count}] ━━━━━━━━━━━━━━━━━━━━ [${progress}%] 已用: ${formatTime(elapsed)} / 预计剩余: ${formatTime(eta)}`
      });
      batchPromises.push(registerAccount());
    }

    // 等待本批次完成
    const results = await Promise.allSettled(batchPromises);

    // 收集成功注册的账号
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success && result.value.account) {
        successAccounts.push(result.value.account);
      }
    }

    completed += batchSize;

    // 批次间延迟
    if (completed < count && !shouldStop) {
      await new Promise(resolve => setTimeout(resolve, registerConfig.registerDelay));
    }
  }

  if (shouldStop) {
    broadcast({ type: 'log', level: 'warning', message: `⚠️ 用户手动停止，已完成 ${completed}/${count} 个` });
  }

  const elapsedTime = (Date.now() - stats.startTime) / 1000;

  broadcast({
    type: 'complete',
    stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed, elapsedTime: elapsedTime.toFixed(1) }
  });

  // 获取总账号数
  let totalAccounts = 0;
  try {
    const entries = kv.list({ prefix: ["zai_accounts"] });
    for await (const _ of entries) {
      totalAccounts++;
    }
  } catch {
    // 忽略错误
  }

  // 构建注册详情列表（最多显示10个）
  let accountsDetail = '';
  if (successAccounts.length > 0) {
    accountsDetail += '\n\n### 📋 注册详情\n';
    const displayCount = Math.min(successAccounts.length, 10);
    for (let i = 0; i < displayCount; i++) {
      const acc = successAccounts[i];
      accountsDetail += `${i + 1}. **${acc.email}**\n`;
      accountsDetail += `   - 密码: \`${acc.password}\`\n`;
      accountsDetail += `   - Token: \`${acc.token.substring(0, 20)}...\`\n`;
      if (acc.apikey) {
        accountsDetail += `   - APIKEY: \`${acc.apikey.substring(0, 20)}...\`\n`;
      }
    }
    if (successAccounts.length > displayCount) {
      accountsDetail += `\n*... 还有 ${successAccounts.length - displayCount} 个账号未显示*\n`;
    }
  }

  // 发送完成通知
  await sendNotification(
    "✅ Z.AI 注册任务完成",
    `## ✅ Z.AI 账号注册任务完成

### 📊 执行结果
- **成功**: ${stats.success} 个
- **失败**: ${stats.failed} 个
- **本次总计**: ${stats.success + stats.failed} 个
- **账号总数**: ${totalAccounts} 个

### ⏱️ 耗时统计
- **总耗时**: ${elapsedTime.toFixed(1)} 秒 (${(elapsedTime / 60).toFixed(1)} 分钟)
- **平均速度**: ${((stats.success + stats.failed) / (elapsedTime / 60)).toFixed(1)} 个/分钟
- **单个耗时**: ${stats.success + stats.failed > 0 ? (elapsedTime / (stats.success + stats.failed)).toFixed(1) : 0} 秒/个

### 📈 成功率
- **成功率**: ${stats.success + stats.failed > 0 ? ((stats.success / (stats.success + stats.failed)) * 100).toFixed(1) : 0}%
- **失败率**: ${stats.success + stats.failed > 0 ? ((stats.failed / (stats.success + stats.failed)) * 100).toFixed(1) : 0}%${accountsDetail}`
  );

  isRunning = false;
  shouldStop = false;
}

// 登录页面
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - Z.AI 管理系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div class="text-center mb-8">
            <h1 class="text-3xl font-bold text-gray-800 mb-2">🤖 Z.AI 管理系统</h1>
            <p class="text-gray-600">请登录以继续</p>
        </div>

        <form id="loginForm" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">用户名</label>
                <input type="text" id="username" required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">密码</label>
                <input type="password" id="password" required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
            </div>

            <div id="errorMsg" class="hidden text-red-500 text-sm text-center"></div>

            <button type="submit"
                class="w-full px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all">
                登录
            </button>
        </form>

        <div class="mt-6 text-center text-sm text-gray-500">
            <p>默认账号: admin / 123456</p>
        </div>
    <div class="mt-2 text-center text-sm text-gray-500">
      <p>📦 <a href="https://github.com/dext7r/ZtoApi/tree/main/deno/zai/zai_register.ts" target="_blank" class="text-cyan-600 underline">源码地址 (GitHub)</a> |
      💬 <a href="https://linux.do/t/topic/1009939" target="_blank" class="text-cyan-600 underline">交流讨论</a></p>
    </div>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const errorMsg = document.getElementById('errorMsg');

            errorMsg.classList.add('hidden');

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const result = await response.json();

                if (result.success) {
                    document.cookie = 'sessionId=' + result.sessionId + '; path=/; max-age=86400';
                    window.location.href = '/';
                } else {
                    // 显示错误信息
                    let errorText = result.error || '登录失败';

                    // 如果账号被锁定，显示剩余时间
                    if (result.code === 'ACCOUNT_LOCKED' && result.remainingTime) {
                        const minutes = Math.floor(result.remainingTime / 60);
                        const seconds = result.remainingTime % 60;
                        errorText += ' (' + minutes + '分' + seconds + '秒后可重试)';
                    }
                    // 如果有剩余尝试次数，显示提示
                    else if (result.attemptsRemaining !== undefined) {
                        errorText += ' (剩余 ' + result.attemptsRemaining + ' 次尝试机会)';
                    }

                    errorMsg.textContent = errorText;
                    errorMsg.classList.remove('hidden');
                }
            } catch (error) {
                errorMsg.textContent = '网络错误，请重试';
                errorMsg.classList.remove('hidden');
            }
        });
    </script>
</body>
</html>`;

// 主页面
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Z.AI 账号管理系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
    <style>
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        .toast-enter { animation: slideIn 0.3s ease-out; }
        .toast-exit { animation: slideOut 0.3s ease-in; }

        /* 移动端优化 */
        @media (max-width: 768px) {
            .mobile-scroll {
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
            }

            table {
                font-size: 0.75rem;
            }

            /* 移动端固定Toast位置到底部 */
            #toastContainer {
                left: 0.5rem;
                right: 0.5rem;
                top: auto;
                bottom: 0.5rem;
            }

            /* 优化日志容器高度 */
            #logContainer {
                height: 10rem !important;
            }

            /* 隐藏部分列 */
            .hide-mobile {
                display: none;
            }

            /* 移动端按钮组优化 */
            .btn-group-mobile {
                flex-wrap: wrap;
            }

            /* 移动端可点击单元格 */
            .clickable-cell {
                cursor: pointer;
            }

            .clickable-cell:active {
                opacity: 0.5;
            }
        }

        /* 触摸优化 */
        button, a, input[type="checkbox"] {
            -webkit-tap-highlight-color: rgba(0, 0, 0, 0.1);
        }

        /* 防止双击缩放 */
        * {
            touch-action: manipulation;
        }

        /* PC端优化 */
        @media (min-width: 769px) {
            /* 表格悬停效果 */
            tbody tr {
                transition: all 0.2s ease;
            }

            tbody tr:hover {
                background-color: #f8fafc;
                transform: translateX(4px);
                box-shadow: -4px 0 0 0 #6366f1;
            }

            /* 操作按钮悬停效果 */
            .action-btn {
                transition: all 0.15s ease;
                position: relative;
            }

            .action-btn:hover {
                transform: translateY(-1px);
            }

            .action-btn::after {
                content: '';
                position: absolute;
                bottom: -2px;
                left: 0;
                right: 0;
                height: 2px;
                background: currentColor;
                transform: scaleX(0);
                transition: transform 0.2s ease;
            }

            .action-btn:hover::after {
                transform: scaleX(1);
            }

            /* 表格单元格内边距优化 */
            td, th {
                padding: 1rem !important;
            }

            /* 代码块样式优化 */
            code {
                font-family: 'Courier New', Consolas, Monaco, monospace;
                letter-spacing: -0.5px;
            }

            /* 可点击单元格样式 */
            .clickable-cell {
                cursor: pointer;
                transition: all 0.15s ease;
                position: relative;
            }

            .clickable-cell:hover {
                opacity: 0.7;
            }

            .clickable-cell::before {
                content: '📋';
                position: absolute;
                left: 0;
                top: 50%;
                transform: translateY(-50%);
                opacity: 0;
                transition: opacity 0.2s ease;
                font-size: 0.75rem;
            }

            .clickable-cell:hover::before {
                opacity: 0.5;
            }
        }

        /* 滚动条美化 */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: #f1f5f9;
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb {
            background: #cbd5e1;
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #94a3b8;
        }

        /* 日志链接样式优化 */
        #logContainer a {
            text-decoration: none;
            transition: all 0.2s ease;
        }

        #logContainer a:hover {
            opacity: 0.8;
            transform: translateX(2px);
        }
    </style>
</head>
<body class="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 min-h-screen p-2 sm:p-4 md:p-8">
    <!-- Toast 容器 -->
    <div id="toastContainer" class="fixed top-4 right-4 z-50 space-y-2"></div>

    <div class="max-w-7xl mx-auto">
        <div class="text-center text-white mb-4 sm:mb-8">
            <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div class="hidden sm:block flex-1"></div>
                <div class="flex-1 text-center">
                    <h1 class="text-2xl sm:text-3xl md:text-5xl font-bold mb-2">🤖 Z.AI 管理系统 V2</h1>
                    <p class="text-sm sm:text-base md:text-xl opacity-90">批量注册 · 数据管理 · 实时监控</p>
          <p class="text-xs sm:text-sm mt-2 opacity-80">📦 <a href="https://github.com/dext7r/ZtoApi/tree/main/deno/zai/zai_register.ts" target="_blank" class="text-cyan-200 underline">源码</a> |
          💬 <a href="https://linux.do/t/topic/1009939" target="_blank" class="text-cyan-200 underline">讨论</a></p>
                </div>
                <div class="w-full sm:w-auto sm:flex-1 sm:flex sm:justify-end">
                    <button id="logoutBtn" class="w-full sm:w-auto px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-white font-semibold transition">
                        退出登录
                    </button>
                </div>
            </div>
        </div>

        <!-- 控制面板 + 高级设置 -->
        <div class="bg-white rounded-2xl shadow-2xl p-3 sm:p-6 mb-4 sm:mb-6">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0 mb-4 sm:mb-6">
                <h2 class="text-xl sm:text-2xl font-bold text-gray-800">注册控制</h2>
                <div class="flex gap-2 w-full sm:w-auto">
                    <button id="settingsBtn" class="flex-1 sm:flex-none px-3 sm:px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-semibold transition text-sm sm:text-base">
                        ⚙️ 高级设置
                    </button>
                    <span id="statusBadge" class="flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-full text-xs sm:text-sm font-semibold bg-gray-400 text-white text-center">闲置中</span>
                </div>
            </div>

            <!-- 高级设置面板 -->
            <div id="settingsPanel" class="mb-6 p-4 bg-gray-50 rounded-lg hidden">
                <h3 class="font-semibold text-gray-700 mb-4">⚙️ 高级设置</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">邮件等待超时 (秒)</label>
                        <input type="number" id="emailTimeout" value="120" min="30" max="300"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">账号间隔 (毫秒)</label>
                        <input type="number" id="registerDelay" value="2000" min="500" max="10000" step="500"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">邮件轮询间隔（秒）</label>
                        <input type="number" id="emailCheckInterval" value="1" min="0.5" max="10" step="0.5"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                        <p class="text-xs text-gray-500 mt-1">建议：0.5-2秒，过小可能触发限流</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">并发数</label>
                        <input type="number" id="concurrency" value="1" min="1" max="10"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                        <p class="text-xs text-gray-500 mt-1">同时注册的账号数量，建议3-5</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">API 重试次数</label>
                        <input type="number" id="retryTimes" value="3" min="1" max="10"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">PushPlus Token</label>
                        <input type="text" id="pushplusToken" value="" placeholder="留空则不发送通知"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div class="flex items-center md:col-span-2">
                        <input type="checkbox" id="enableNotification" checked class="w-5 h-5 text-indigo-600 rounded">
                        <label class="ml-3 text-sm font-medium text-gray-700">启用 PushPlus 通知</label>
                    </div>
                </div>
                <div class="mt-4 flex gap-2">
                    <button id="saveSettingsBtn" class="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
                        保存设置
                    </button>
                    <button id="cancelSettingsBtn" class="px-6 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition">
                        取消
                    </button>
                </div>
            </div>

            <div class="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-4">
                <input type="number" id="registerCount" value="5" min="1" max="100"
                    class="flex-1 px-4 py-3 text-base border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                <button id="startRegisterBtn"
                    class="w-full sm:w-auto px-6 sm:px-8 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed text-base">
                    开始注册
                </button>
                <button id="stopRegisterBtn" style="display: none;"
                    class="w-full sm:w-auto px-6 sm:px-8 py-3 bg-gradient-to-r from-red-500 to-pink-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all text-base">
                    停止注册
                </button>
            </div>

            <!-- 进度条 -->
            <div id="progressContainer" style="display: none;" class="mb-4">
                <div class="flex justify-between text-sm text-gray-600 mb-2">
                    <span>注册进度</span>
                    <span id="progressText">0/0 (0%)</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                    <div id="progressBar" class="h-full bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full transition-all duration-300 flex items-center justify-center">
                        <span id="progressPercent" class="text-xs text-white font-semibold"></span>
                    </div>
                </div>
                <div class="flex justify-between text-xs text-gray-500 mt-1">
                    <span id="progressSpeed">速度: 0/分钟</span>
                    <span id="progressETA">预计剩余: --</span>
                </div>
            </div>
        </div>

        <!-- 统计面板 -->
        <div class="bg-white rounded-2xl shadow-2xl p-3 sm:p-6 mb-4 sm:mb-6">
            <h2 class="text-xl sm:text-2xl font-bold text-gray-800 mb-3 sm:mb-4">统计信息</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
                <div class="bg-gradient-to-br from-green-400 to-emerald-500 rounded-xl p-3 sm:p-4 text-center text-white">
                    <div class="text-xs sm:text-sm opacity-90 mb-1">总账号</div>
                    <div class="text-2xl sm:text-3xl font-bold" id="totalAccounts">0</div>
                </div>
                <div class="bg-gradient-to-br from-blue-400 to-indigo-500 rounded-xl p-3 sm:p-4 text-center text-white">
                    <div class="text-xs sm:text-sm opacity-90 mb-1">本次成功</div>
                    <div class="text-2xl sm:text-3xl font-bold" id="successCount">0</div>
                </div>
                <div class="bg-gradient-to-br from-red-400 to-pink-500 rounded-xl p-3 sm:p-4 text-center text-white">
                    <div class="text-xs sm:text-sm opacity-90 mb-1">本次失败</div>
                    <div class="text-2xl sm:text-3xl font-bold" id="failedCount">0</div>
                </div>
                <div class="bg-gradient-to-br from-purple-400 to-fuchsia-500 rounded-xl p-3 sm:p-4 text-center text-white">
                    <div class="text-xs sm:text-sm opacity-90 mb-1">耗时</div>
                    <div class="text-2xl sm:text-3xl font-bold" id="timeValue">0s</div>
                </div>
            </div>
        </div>

        <!-- 账号列表 -->
        <div class="bg-white rounded-2xl shadow-2xl p-3 sm:p-6 mb-4 sm:mb-6">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
                <h2 class="text-xl sm:text-2xl font-bold text-gray-800">账号列表</h2>
                <div class="flex flex-wrap gap-2 w-full sm:w-auto">
                    <input type="text" id="searchInput" placeholder="搜索邮箱..."
                        class="flex-1 sm:flex-none px-3 sm:px-4 py-2 text-sm sm:text-base border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    <input type="file" id="importFileInput" accept=".txt" style="display: none;">
                    <button id="importBtn"
                        class="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition text-sm sm:text-base whitespace-nowrap">
                        导入
                    </button>
                    <button id="exportBtn"
                        class="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition text-sm sm:text-base whitespace-nowrap">
                        导出
                    </button>
                    <button id="refreshBtn"
                        class="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition text-sm sm:text-base whitespace-nowrap">
                        刷新
                    </button>
                </div>
            </div>
            <div class="overflow-x-auto mobile-scroll">
                <table class="w-full min-w-[640px]">
                    <thead>
                        <tr class="bg-gray-50 text-left">
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700">序号</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700">邮箱</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700 hide-mobile">密码</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700 hide-mobile">Token</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700 hide-mobile">APIKEY</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700 hide-mobile">创建时间</th>
                            <th class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-semibold text-gray-700">操作</th>
                        </tr>
                    </thead>
                    <tbody id="accountTableBody" class="divide-y divide-gray-200">
                        <tr>
                            <td colspan="7" class="px-4 py-8 text-center text-gray-400">暂无数据</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <!-- 分页控件 -->
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mt-4 px-2 sm:px-4">
                <div class="text-xs sm:text-sm text-gray-600">
                    共 <span id="totalItems">0</span> 条数据
                </div>
                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                    <div class="flex items-center gap-1 sm:gap-2 overflow-x-auto">
                        <button id="firstPageBtn" class="px-2 sm:px-3 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">首页</button>
                        <button id="prevPageBtn" class="px-2 sm:px-3 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">上一页</button>
                        <div class="flex items-center gap-1" id="pageNumbers"></div>
                        <button id="nextPageBtn" class="px-2 sm:px-3 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">下一页</button>
                    <button id="lastPageBtn" class="px-2 sm:px-3 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">尾页</button>
                    </div>
                    <select id="pageSizeSelect" class="px-2 py-1 text-xs sm:text-sm border border-gray-300 rounded w-full sm:w-auto">
                        <option value="10">10条/页</option>
                        <option value="20" selected>20条/页</option>
                        <option value="50">50条/页</option>
                        <option value="100">100条/页</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- 实时日志 -->
        <div class="bg-white rounded-2xl shadow-2xl p-3 sm:p-6">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
                <h2 class="text-xl sm:text-2xl font-bold text-gray-800">实时日志</h2>
                <button id="clearLogBtn"
                    class="w-full sm:w-auto px-3 sm:px-4 py-2 bg-gradient-to-r from-gray-500 to-gray-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition text-sm sm:text-base">
                    清空日志
                </button>
            </div>
            <div id="logContainer" class="bg-gray-900 rounded-lg p-3 sm:p-4 h-40 sm:h-64 overflow-y-auto font-mono text-xs sm:text-sm">
                <div class="text-blue-400">等待任务启动...</div>
            </div>
        </div>
    </div>

    <script>
        let accounts = [];
        let filteredAccounts = [];
        let isRunning = false;
        let currentPage = 1;
        let pageSize = 20;
        let taskStartTime = 0;
        let totalTaskCount = 0;

        const $statusBadge = $('#statusBadge');
        const $startRegisterBtn = $('#startRegisterBtn');
        const $stopRegisterBtn = $('#stopRegisterBtn');
        const $logContainer = $('#logContainer');
        const $totalAccounts = $('#totalAccounts');
        const $successCount = $('#successCount');
        const $failedCount = $('#failedCount');
        const $timeValue = $('#timeValue');
        const $accountTableBody = $('#accountTableBody');
        const $searchInput = $('#searchInput');
        const $progressContainer = $('#progressContainer');
        const $progressBar = $('#progressBar');
        const $progressText = $('#progressText');
        const $progressPercent = $('#progressPercent');
        const $progressSpeed = $('#progressSpeed');
        const $progressETA = $('#progressETA');

        // 更新进度条
        function updateProgress(current, total, success, failed) {
            const completed = success + failed;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

            $progressBar.css('width', percent + '%');
            $progressPercent.text(percent + '%');
            $progressText.text(completed + '/' + total + ' (' + percent + '%)');

            // 计算速度和预计剩余时间
            if (taskStartTime > 0 && completed > 0) {
                const elapsed = (Date.now() - taskStartTime) / 1000 / 60; // 分钟
                const speed = completed / elapsed;
                const remaining = total - completed;
                const eta = remaining / speed;

                $progressSpeed.text('速度: ' + speed.toFixed(1) + '/分钟');

                if (eta < 1) {
                    $progressETA.text('预计剩余: <1分钟');
                } else if (eta < 60) {
                    $progressETA.text('预计剩余: ' + Math.ceil(eta) + '分钟');
                } else {
                    const hours = Math.floor(eta / 60);
                    const mins = Math.ceil(eta % 60);
                    $progressETA.text('预计剩余: ' + hours + '小时' + mins + '分钟');
                }
            }
        }

        // Toast 消息提示
        function showToast(message, type = 'info') {
            const colors = {
                success: 'bg-green-500',
                error: 'bg-red-500',
                warning: 'bg-yellow-500',
                info: 'bg-blue-500'
            };
            const icons = {
                success: '✓',
                error: '✗',
                warning: '⚠',
                info: 'ℹ'
            };

            const $toast = $('<div>', {
                class: 'toast-enter ' + colors[type] + ' text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 min-w-[300px]',
                html: '<span class="text-xl">' + icons[type] + '</span><span>' + message + '</span>'
            });

            $('#toastContainer').append($toast);

            setTimeout(() => {
                $toast.removeClass('toast-enter').addClass('toast-exit');
                setTimeout(() => $toast.remove(), 300);
            }, 3000);
        }

        function addLog(message, level = 'info', link = null) {
            const colors = { success: 'text-green-400', error: 'text-red-400', warning: 'text-yellow-400', info: 'text-blue-400' };
            const time = new Date().toLocaleTimeString('zh-CN');

            let html = '<span class="text-gray-500">[' + time + ']</span> ' + message;

            // 添加链接（优化样式，更醒目）
            if (link && link.url) {
                html += ' <a href="' + link.url + '" target="_blank" class="inline-flex items-center ml-2 px-2 py-0.5 bg-cyan-600/20 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-600/30 rounded border border-cyan-500/30 text-xs font-medium transition">' +
                    '<svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>' +
                    (link.text || '查看') +
                    '</a>';
            }

            const $log = $('<div>', {
                class: colors[level] + ' mb-1',
                html: html
            });

            $logContainer.append($log);
            $logContainer[0].scrollTop = $logContainer[0].scrollHeight;
            if ($logContainer.children().length > 200) $logContainer.children().first().remove();
        }

        function updateStatus(running) {
            isRunning = running;
            if (running) {
                $statusBadge.text('运行中').removeClass('bg-gray-400').addClass('bg-green-500');
                $startRegisterBtn.hide();
                $stopRegisterBtn.show();
            } else {
                $statusBadge.text('闲置中').removeClass('bg-green-500').addClass('bg-gray-400');
                $startRegisterBtn.show();
                $stopRegisterBtn.hide();
            }
        }

        function renderTable(data = filteredAccounts) {
            const totalPages = Math.ceil(data.length / pageSize);
            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const pageData = data.slice(startIndex, endIndex);

            if (pageData.length === 0) {
                $accountTableBody.html('<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">暂无数据</td></tr>');
            } else {
                const rows = pageData.map((acc, idx) => {
                    const rowId = 'row-' + (startIndex + idx);
                    // 处理APIKEY显示
                    const apikeyDisplay = acc.apikey ?
                        '<code class="bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs font-mono">' + acc.apikey.substring(0, 20) + '...</code>' :
                        '<span class="text-gray-400 text-xs italic">未生成</span>';

                    return '<tr class="group" id="' + rowId + '">' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 font-medium">' + (startIndex + idx + 1) + '</td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 truncate max-w-[200px] clickable-cell" title="点击复制: ' + acc.email + '" data-copy="' + acc.email + '">' + acc.email + '</td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 hide-mobile clickable-cell" title="点击复制密码" data-copy="' + acc.password + '"><code class="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-mono">' + acc.password + '</code></td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 hide-mobile clickable-cell" title="点击复制Token" data-copy="' + acc.token + '"><code class="bg-green-50 text-green-700 px-2 py-1 rounded text-xs font-mono">' + acc.token.substring(0, 20) + '...</code></td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 hide-mobile' + (acc.apikey ? ' clickable-cell' : '') + '"' + (acc.apikey ? ' title="点击复制APIKEY" data-copy="' + acc.apikey + '"' : '') + '>' + apikeyDisplay + '</td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-700 hide-mobile">' + new Date(acc.createdAt).toLocaleString('zh-CN') + '</td>' +
                        '<td class="px-2 sm:px-4 py-2 sm:py-3"><div class="flex gap-1 sm:gap-2 flex-wrap">' +
                            '<button class="copy-full-btn action-btn text-indigo-600 hover:text-indigo-800 text-xs sm:text-sm font-medium whitespace-nowrap" ' +
                            'data-email="' + acc.email + '" ' +
                            'data-password="' + acc.password + '" ' +
                            'data-token="' + acc.token + '" ' +
                            'data-apikey="' + (acc.apikey || '') + '" ' +
                            'data-createdat="' + acc.createdAt + '">复制全部</button>' +
                        '</div></td>' +
                    '</tr>';
                });
                $accountTableBody.html(rows.join(''));

                // 绑定单元格点击复制事件
                $('.clickable-cell').on('click', function() {
                    const copyText = $(this).data('copy');
                    if (copyText) {
                        navigator.clipboard.writeText(copyText);
                        const cellContent = $(this).text().trim();
                        const displayText = cellContent.length > 30 ? cellContent.substring(0, 30) + '...' : cellContent;
                        showToast('已复制: ' + displayText, 'success');
                    }
                });

                // 绑定"复制全部"按钮事件
                $('.copy-full-btn').on('click', function() {
                    const email = $(this).data('email');
                    const password = $(this).data('password');
                    const token = $(this).data('token');
                    const apikey = $(this).data('apikey');
                    const createdAt = $(this).data('createdat');

                    // 构建完整的账号信息
                    let fullInfo = '邮箱: ' + email + '\\n密码: ' + password + '\\n';
                    fullInfo += 'Token: ' + token + '\\n';
                    if (apikey) {
                        fullInfo += 'APIKEY: ' + apikey + '\\n';
                    }
                    fullInfo += '创建时间: ' + new Date(createdAt).toLocaleString('zh-CN');

                    navigator.clipboard.writeText(fullInfo);
                    showToast('已复制完整账号信息', 'success');
                });
            }

            // 更新分页控件
            updatePagination(data.length, totalPages);
        }

        function updatePagination(totalItems, totalPages) {
            $('#totalItems').text(totalItems);

            // 更新按钮状态
            $('#firstPageBtn, #prevPageBtn').prop('disabled', currentPage === 1);
            $('#nextPageBtn, #lastPageBtn').prop('disabled', currentPage === totalPages || totalPages === 0);

            // 渲染页码
            const $pageNumbers = $('#pageNumbers');
            $pageNumbers.empty();

            if (totalPages <= 7) {
                for (let i = 1; i <= totalPages; i++) {
                    addPageButton(i, $pageNumbers);
                }
            } else {
                addPageButton(1, $pageNumbers);
                if (currentPage > 3) $pageNumbers.append('<span class="px-2">...</span>');

                let start = Math.max(2, currentPage - 1);
                let end = Math.min(totalPages - 1, currentPage + 1);

                for (let i = start; i <= end; i++) {
                    addPageButton(i, $pageNumbers);
                }

                if (currentPage < totalPages - 2) $pageNumbers.append('<span class="px-2">...</span>');
                addPageButton(totalPages, $pageNumbers);
            }
        }

        function addPageButton(page, container) {
            const isActive = page === currentPage;
            const $btn = $('<button>', {
                text: page,
                class: 'px-3 py-1 border rounded ' + (isActive ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 hover:bg-gray-100'),
                click: () => {
                    currentPage = page;
                    renderTable();
                }
            });
            container.append($btn);
        }

        async function loadAccounts() {
            const response = await fetch('/api/accounts');
            accounts = await response.json();
            filteredAccounts = accounts;
            $totalAccounts.text(accounts.length);
            currentPage = 1;
            renderTable();
        }

        $searchInput.on('input', function() {
            const keyword = $(this).val().toLowerCase();
            filteredAccounts = accounts.filter(acc => acc.email.toLowerCase().includes(keyword));
            currentPage = 1;
            renderTable();
        });

        // 分页按钮事件
        $('#firstPageBtn').on('click', () => { currentPage = 1; renderTable(); });
        $('#prevPageBtn').on('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
        $('#nextPageBtn').on('click', () => { const totalPages = Math.ceil(filteredAccounts.length / pageSize); if (currentPage < totalPages) { currentPage++; renderTable(); } });
        $('#lastPageBtn').on('click', () => { currentPage = Math.ceil(filteredAccounts.length / pageSize); renderTable(); });
        $('#pageSizeSelect').on('change', function() {
            pageSize = parseInt($(this).val());
            currentPage = 1;
            renderTable();
        });

        async function loadSettings() {
            try {
                const response = await fetch('/api/config');
                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }
                    throw new Error('HTTP ' + response.status);
                }
                const config = await response.json();
                $('#emailTimeout').val(config.emailTimeout);
                $('#emailCheckInterval').val(config.emailCheckInterval || 1);
                $('#registerDelay').val(config.registerDelay);
                $('#retryTimes').val(config.retryTimes);
                $('#concurrency').val(config.concurrency || 1);
                $('#enableNotification').prop('checked', config.enableNotification);
                $('#pushplusToken').val(config.pushplusToken || '');
            } catch (error) {
                console.error('加载配置失败:', error);
                showToast('加载配置失败', 'error');
            }
        }

        $('#refreshBtn').on('click', loadAccounts);

        $('#clearLogBtn').on('click', function() {
            $logContainer.html('<div class="text-gray-500">日志已清空</div>');
            addLog('✓ 日志已清空', 'success');
        });

        $('#settingsBtn').on('click', function() {
            $('#settingsPanel').slideToggle();
        });

        $('#cancelSettingsBtn').on('click', function() {
            $('#settingsPanel').slideUp();
        });

        $('#saveSettingsBtn').on('click', async function() {
            try {
                const config = {
                    emailTimeout: parseInt($('#emailTimeout').val()),
                    emailCheckInterval: parseFloat($('#emailCheckInterval').val()),
                    registerDelay: parseInt($('#registerDelay').val()),
                    retryTimes: parseInt($('#retryTimes').val()),
                    concurrency: parseInt($('#concurrency').val()),
                    enableNotification: $('#enableNotification').is(':checked'),
                    pushplusToken: $('#pushplusToken').val().trim()
                };

                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }
                    throw new Error('HTTP ' + response.status);
                }

                const result = await response.json();
                if (result.success) {
                    showToast('设置已保存', 'success');
                    $('#settingsPanel').slideUp();
                } else {
                    showToast('保存失败: ' + (result.error || '未知错误'), 'error');
                }
            } catch (error) {
                console.error('保存配置失败:', error);
                showToast('保存失败: ' + error.message, 'error');
            }
        });

        $('#logoutBtn').on('click', async function() {
            if (confirm('确定要退出登录吗？')) {
                await fetch('/api/logout', { method: 'POST' });
                document.cookie = 'sessionId=; path=/; max-age=0';
                window.location.href = '/login';
            }
        });

        $('#exportBtn').on('click', async function() {
            try {
                const response = await fetch('/api/export');
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'zai_accounts_' + Date.now() + '.txt';
                a.click();
                showToast('导出成功！', 'success');
            } catch (error) {
                showToast('导出失败: ' + error.message, 'error');
            }
        });

        $('#importBtn').on('click', function() {
            $('#importFileInput').click();
        });

        $('#importFileInput').on('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;

            try {
                showToast('开始导入，请稍候...', 'info');
                const text = await file.text();
                const lines = text.split('\\n').filter(line => line.trim());

                // 准备批量数据
                const importData = [];
                const emailSet = new Set();

                for (const line of lines) {
                    const parts = line.split('----');
                    let email, password, token;

                    if (parts.length >= 4) {
                        email = parts[0].trim();
                        password = parts[1].trim();
                        token = parts[2].trim() + '----' + parts[3].trim();
                    } else if (parts.length === 3) {
                        email = parts[0].trim();
                        password = parts[1].trim();
                        token = parts[2].trim();
                    } else {
                        continue;
                    }

                    // 去重检查
                    if (!emailSet.has(email)) {
                        emailSet.add(email);
                        importData.push({ email, password, token });
                    }
                }

                // 批量导入
                const response = await fetch('/api/import-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accounts: importData })
                });

                const result = await response.json();
                if (result.success) {
                    showToast('导入完成！成功: ' + result.imported + ', 跳过重复: ' + result.skipped, 'success');
                    await loadAccounts();
                } else {
                    showToast('导入失败: ' + result.error, 'error');
                }

                $(this).val('');
            } catch (error) {
                showToast('导入失败: ' + error.message, 'error');
            }
        });

        $startRegisterBtn.on('click', async function() {
            try {
                const count = parseInt($('#registerCount').val());
                if (!count || count < 1) {
                    alert('请输入有效数量');
                    return;
                }

                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ count })
                });

                const result = await response.json();

                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }

                    // 显示详细错误信息
                    if (result.isRunning) {
                        const msg = result.error + '\\n\\n' +
                            '当前进度：' + result.stats.success + ' 成功 / ' + result.stats.failed + ' 失败 / ' + result.stats.total + ' 已完成';
                        showToast(msg, 'warning');
                        addLog('⚠️ ' + result.error, 'warning');
                    } else {
                        showToast(result.error || '启动失败', 'error');
                        addLog('✗ ' + (result.error || '启动失败'), 'error');
                    }
                    return;
                }

                if (!result.success) {
                    addLog('✗ ' + (result.error || '启动失败'), 'error');
                }
            } catch (error) {
                console.error('启动注册失败:', error);
                addLog('✗ 启动失败: ' + error.message, 'error');
                showToast('启动失败: ' + error.message, 'error');
            }
        });

        $stopRegisterBtn.on('click', async function() {
            if (confirm('确定要停止当前注册任务吗？')) {
                const response = await fetch('/api/stop', { method: 'POST' });
                const result = await response.json();
                if (result.success) {
                    addLog('⚠️ 已发送停止信号...', 'warning');
                }
            }
        });

        function connectSSE() {
            const eventSource = new EventSource('/events');
            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'connected':
                        addLog('✓ 已连接到服务器', 'success');
                        updateStatus(data.isRunning);
                        break;
                    case 'start':
                        updateStatus(true);
                        taskStartTime = Date.now();
                        totalTaskCount = data.config.count;
                        $progressContainer.show();
                        updateProgress(0, totalTaskCount, 0, 0);
                        addLog('🚀 开始注册 ' + data.config.count + ' 个账号', 'info');
                        $successCount.text(0);
                        $failedCount.text(0);
                        break;
                    case 'log':
                        addLog(data.message, data.level, data.link);
                        if (data.stats) {
                            $successCount.text(data.stats.success);
                            $failedCount.text(data.stats.failed);
                            updateProgress(data.stats.total, totalTaskCount, data.stats.success, data.stats.failed);
                        }
                        break;
                    case 'account_added':
                        accounts.unshift(data.account);
                        filteredAccounts = accounts;
                        $totalAccounts.text(accounts.length);
                        renderTable();
                        break;
                    case 'complete':
                        updateStatus(false);
                        $successCount.text(data.stats.success);
                        $failedCount.text(data.stats.failed);
                        $timeValue.text(data.stats.elapsedTime + 's');
                        updateProgress(data.stats.total, totalTaskCount, data.stats.success, data.stats.failed);
                        addLog('✓ 注册完成！成功: ' + data.stats.success + ', 失败: ' + data.stats.failed, 'success');
                        setTimeout(() => $progressContainer.fadeOut(), 3000);
                        break;
                }
            };
            eventSource.onerror = () => {
                addLog('✗ 连接断开，5秒后重连...', 'error');
                eventSource.close();
                setTimeout(connectSSE, 5000);
            };
        }

        $(document).ready(function() {
            loadAccounts();
            loadSettings();
            connectSSE();
        });
    </script>
</body>
</html>`;

// HTTP 处理器
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 登录页面（无需鉴权）
  if (url.pathname === "/login") {
    return new Response(LOGIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // 登录 API（无需鉴权）
  if (url.pathname === "/api/login" && req.method === "POST") {
    const clientIP = getClientIP(req);

    // 检查 IP 是否被锁定
    const lockCheck = checkIPLocked(clientIP);
    if (lockCheck.locked) {
      console.log(`🚫 IP ${clientIP} 尝试登录但已被锁定，剩余 ${lockCheck.remainingTime} 秒`);
      return new Response(JSON.stringify({
        success: false,
        error: `登录失败次数过多，账号已被锁定`,
        remainingTime: lockCheck.remainingTime,
        code: "ACCOUNT_LOCKED"
      }), {
        status: 429,  // Too Many Requests
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    if (body.username === AUTH_USERNAME && body.password === AUTH_PASSWORD) {
      // 登录成功，清除失败记录
      clearLoginFailure(clientIP);
      const sessionId = generateSessionId();

      // 保存 session 到 KV，设置 24 小时过期
      const sessionKey = ["sessions", sessionId];
      await kv.set(sessionKey, { createdAt: Date.now() }, { expireIn: 86400000 }); // 24小时过期

      console.log(`✅ IP ${clientIP} 登录成功`);
      return new Response(JSON.stringify({ success: true, sessionId }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 登录失败，记录失败次数
    recordLoginFailure(clientIP);
    const attempts = loginAttempts.get(clientIP)?.attempts || 0;
    console.log(`❌ IP ${clientIP} 登录失败（第 ${attempts} 次）`);

    return new Response(JSON.stringify({
      success: false,
      error: "用户名或密码错误",
      attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts)
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 鉴权检查（其他所有路径都需要验证）
  const auth = await checkAuth(req);
  if (!auth.authenticated) {
    // 判断是 API 请求还是页面请求
    const isApiRequest = url.pathname.startsWith('/api/');

    if (isApiRequest) {
      // API 请求返回 401 JSON 响应
      return new Response(JSON.stringify({
        success: false,
        error: "未授权访问，请先登录",
        code: "UNAUTHORIZED"
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      // 页面请求返回 302 重定向
      return new Response(null, {
        status: 302,
        headers: { "Location": "/login" }
      });
    }
  }

  // 登出 API
  if (url.pathname === "/api/logout" && req.method === "POST") {
    if (auth.sessionId) {
      // 从 KV 删除 session
      const sessionKey = ["sessions", auth.sessionId];
      await kv.delete(sessionKey);
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 主页
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // 获取配置
  if (url.pathname === "/api/config" && req.method === "GET") {
    // 从 KV 读取配置，如果不存在则返回默认值
    const configKey = ["config", "register"];
    const savedConfig = await kv.get(configKey);

    const config = savedConfig.value || registerConfig;
    return new Response(JSON.stringify(config), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 保存配置
  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await req.json();
    registerConfig = { ...registerConfig, ...body };

    // 保存到 KV 持久化
    const configKey = ["config", "register"];
    await kv.set(configKey, registerConfig);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // SSE
  if (url.pathname === "/events") {
    console.log(`🔌 新的 SSE 连接建立，当前客户端数: ${sseClients.size + 1}`);
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        console.log(`✓ SSE 客户端已添加到连接池，isRunning=${isRunning}`);
        // 发送当前状态
        const message = `data: ${JSON.stringify({ type: 'connected', isRunning })}\n\n`;
        controller.enqueue(new TextEncoder().encode(message));

        // 发送历史日志（最近50条）
        const recentLogs = logHistory.slice(-50);
        for (const log of recentLogs) {
          const logMessage = `data: ${JSON.stringify(log)}\n\n`;
          controller.enqueue(new TextEncoder().encode(logMessage));
        }

        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepAlive);
            sseClients.delete(controller);
          }
        }, 30000);
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
    });
  }

  // 获取运行状态（新增 API）
  if (url.pathname === "/api/status") {
    return new Response(JSON.stringify({
      isRunning,
      stats,
      logCount: logHistory.length
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 账号列表
  if (url.pathname === "/api/accounts") {
    const accounts = [];
    const entries = kv.list({ prefix: ["zai_accounts"] }, { reverse: true });
    for await (const entry of entries) {
      accounts.push(entry.value);
    }
    return new Response(JSON.stringify(accounts), { headers: { "Content-Type": "application/json" } });
  }

  // 导出
  if (url.pathname === "/api/export") {
    const lines: string[] = [];
    const entries = kv.list({ prefix: ["zai_accounts"] });
    for await (const entry of entries) {
      const data = entry.value as any;
      // 支持四字段格式：账号----密码----Token----APIKEY
      if (data.apikey) {
        lines.push(`${data.email}----${data.password}----${data.token}----${data.apikey}`);
      } else {
        // 兼容旧格式，APIKEY为空
        lines.push(`${data.email}----${data.password}----${data.token}----`);
      }
    }
    return new Response(lines.join('\n'), {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="zai_accounts_${Date.now()}.txt"`
      }
    });
  }

  // 导入
  if (url.pathname === "/api/import" && req.method === "POST") {
    try {
      const body = await req.json();
      const { email, password, token, apikey } = body;

      if (!email || !password || !token) {
        return new Response(JSON.stringify({ success: false, error: "缺少必要字段" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 保存到 KV
      const timestamp = Date.now();
      const key = ["zai_accounts", timestamp, email];
      await kv.set(key, {
        email,
        password,
        token,
        apikey: apikey || null,  // 支持APIKEY字段
        createdAt: new Date().toISOString()
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ success: false, error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 批量导入（优化性能，支持去重）
  if (url.pathname === "/api/import-batch" && req.method === "POST") {
    try {
      const body = await req.json();
      const { accounts: importAccounts } = body;

      if (!Array.isArray(importAccounts)) {
        return new Response(JSON.stringify({ success: false, error: "数据格式错误" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 获取已存在的邮箱
      const existingEmails = new Set();
      const entries = kv.list({ prefix: ["zai_accounts"] });
      for await (const entry of entries) {
        const data = entry.value as any;
        existingEmails.add(data.email);
      }

      // 批量写入（去重）
      let imported = 0;
      let skipped = 0;
      const timestamp = Date.now();

      for (const [index, acc] of importAccounts.entries()) {
        const { email, password, token, apikey } = acc;

        if (!email || !password || !token) {
          skipped++;
          continue;
        }

        // 检查是否已存在
        if (existingEmails.has(email)) {
          skipped++;
          continue;
        }

        // 使用不同的时间戳避免键冲突
        const key = ["zai_accounts", timestamp + index, email];
        await kv.set(key, {
          email,
          password,
          token,
          apikey: apikey || null,  // 支持APIKEY字段
          createdAt: new Date().toISOString()
        });

        existingEmails.add(email);
        imported++;
      }

      return new Response(JSON.stringify({ success: true, imported, skipped }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ success: false, error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 开始注册
  if (url.pathname === "/api/register" && req.method === "POST") {
    if (isRunning) {
      return new Response(JSON.stringify({
        success: false,
        error: "任务正在运行中，请等待当前任务完成或手动停止后再试",
        isRunning: true,
        stats: {
          success: stats.success,
          failed: stats.failed,
          total: stats.success + stats.failed
        }
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const count = body.count || 5;

    // 立即启动任务（不等待完成）
    batchRegister(count).catch(err => {
      console.error("注册任务异常:", err);
      broadcast({ type: 'log', level: 'error', message: `✗ 任务异常: ${err.message}` });
    });

    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // 停止注册
  if (url.pathname === "/api/stop" && req.method === "POST") {
    if (!isRunning) {
      return new Response(JSON.stringify({ error: "没有运行中的任务" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    shouldStop = true;
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("Not Found", { status: 404 });
}

// 启动时从 KV 加载配置和日志
(async () => {
  // 加载配置
  const configKey = ["config", "register"];
  const savedConfig = await kv.get(configKey);
  if (savedConfig.value) {
    registerConfig = { ...registerConfig, ...savedConfig.value };
    console.log("✓ 已加载保存的配置");
  }

  // 清理历史日志（重启时清空）
  const logKey = ["logs", "recent"];
  try {
    await kv.delete(logKey);
    console.log("✓ 已清理历史日志数据");
  } catch (error) {
    console.log("⚠️ 清理日志失败:", error);
  }
})();

console.log(`🚀 Z.AI 管理系统 V2 启动: http://localhost:${PORT}`);
console.log(`🔐 登录账号: ${AUTH_USERNAME}`);
console.log(`🔑 登录密码: ${AUTH_PASSWORD}`);
console.log(`💡 访问 http://localhost:${PORT}/login 登录`);
await serve(handler, { port: PORT });

/*
  📦 源码地址:
  https://github.com/dext7r/ZtoApi/tree/main/deno/zai/zai_register.ts
  |
  💬 交流讨论: https://linux.do/t/topic/1009939
──────────────────────────────────────────────────
*/
