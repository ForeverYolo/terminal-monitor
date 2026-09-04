/**
 * AI Overseer (AI 督工) — 自主监控终端并驱动任务完成
 *
 * 连接到 SWT Server，监控指定 agent 的终端输出，
 * 检测空闲时截取上下文调用 LLM 分析，根据 LLM 决策注入命令。
 * 循环直到任务完成或达到最大迭代次数。
 *
 * Usage: node ai-overseer.js --config=config.ai-overseer.json
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Config ---
const configArg = process.argv.find(a => a.startsWith('--config='))?.split('=')[1]
  || (process.argv.indexOf('--config') !== -1 ? process.argv[process.argv.indexOf('--config') + 1] : null);
const configFile = configArg || path.join(__dirname, 'config.ai-overseer.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const cfg = config.aiOverseer;

// --- Validate ---
if (!cfg.serverUrl) { console.error('[!] Missing aiOverseer.serverUrl'); process.exit(1); }
if (!cfg.agentName) { console.error('[!] Missing aiOverseer.agentName'); process.exit(1); }
if (!cfg.taskGoal)  { console.error('[!] Missing aiOverseer.taskGoal');  process.exit(1); }
if (!cfg.llm) { console.error('[!] Missing aiOverseer.llm'); process.exit(1); }

// --- Constants ---
const IDLE_TIMEOUT = (cfg.idleTimeout || 30) * 1000;
const CHECK_INTERVAL = (cfg.checkInterval || 5) * 1000;
const MAX_ITERATIONS = cfg.maxIterations || 50;
const MAX_HISTORY_LINES = cfg.maxHistoryLines || 150;
const MAX_BUFFER_SIZE = 50000; // ~50KB rolling output buffer
const HB_INTERVAL = 30000;
const MAX_CONVERSATION = 20; // keep last 20 user/assistant pairs
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;

// --- State ---
let ws = null;
let currentAgentId = null;
let outputBuffer = '';
let lastOutputTime = Date.now();
let isProcessing = false;
let iterationCount = 0;
let conversationHistory = [];
let idleTimer = null;
let hbTimer = null;
let reconnectDelay = RECONNECT_BASE;
let running = true;

// --- LLM Provider Config ---
const llmProvider = cfg.llm.provider || 'openai';
const llmApiKey = cfg.llm.apiKey;
const llmModel = cfg.llm.model || (llmProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4');
const llmBaseUrl = cfg.llm.baseUrl || (llmProvider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');

// --- System Prompt ---
const SYSTEM_PROMPT = `你是一个终端督工 AI。你的任务是监控终端输出并自主驱动任务完成。

任务目标：${cfg.taskGoal}

分析当前终端状态，判断任务进展，并决定下一步操作。

请严格以 JSON 格式回复：
{
  "done": false,
  "reason": "对当前状态的分析",
  "action": "要执行的命令文本，如无需操作则为空字符串"
}

规则：
- 如果终端正在等待输入（有提示符），提供合适的输入
- 如果有错误，尝试修复
- 如果任务已完成，设置 done 为 true 并在 reason 中说明
- action 中的 \\n 表示回车换行，\\r 表示回车
- 每次只发送一个命令或一步操作，等待执行结果后再决定下一步
- 不要重复已经成功执行的命令`;

// --- Logging ---
function log(msg) {
  console.log(`[AI-OVERSEER] ${new Date().toISOString()} — ${msg}`);
}

// ========== WebSocket Connection ==========

function connect() {
  log(`Connecting to ${cfg.serverUrl}...`);
  ws = new WebSocket(cfg.serverUrl);

  ws.on('open', () => {
    log('Connected, authenticating...');
    reconnectDelay = RECONNECT_BASE;
    ws.send(JSON.stringify({ type: 'auth', password: cfg.password || 'admin' }));
    startHeartbeat();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth_ok') {
      const agents = msg.agents || [];
      log(`Authenticated. ${agents.length} agent(s) online: ${agents.map(a => a.name).join(', ')}`);

      // Find target agent
      const target = agents.find(a =>
        a.name === cfg.agentName || a.id === cfg.agentName ||
        a.name.includes(cfg.agentName)
      );

      if (!target) {
        log(`Agent "${cfg.agentName}" not found. Retrying in 5s...`);
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'auth', password: cfg.password || 'admin' }));
          }
        }, 5000);
        return;
      }

      currentAgentId = target.id;
      log(`Found agent: ${target.name} (${target.id}). Subscribing...`);
      ws.send(JSON.stringify({ type: 'connect', agentId: target.id }));
      startIdleMonitor();
    }

    if (msg.type === 'agents') {
      if (currentAgentId) {
        const stillAlive = msg.agents?.find(a => a.id === currentAgentId);
        if (!stillAlive) {
          log(`Agent ${currentAgentId} disconnected! Waiting for reconnect...`);
          currentAgentId = null;
          stopIdleMonitor();
        }
      }
    }

    if (msg.type === 'data' && msg.agentId === currentAgentId) {
      try {
        const text = Buffer.from(msg.payload, 'base64').toString('utf8');
        outputBuffer += text;
        if (outputBuffer.length > MAX_BUFFER_SIZE) {
          outputBuffer = outputBuffer.slice(-MAX_BUFFER_SIZE);
        }
        lastOutputTime = Date.now();
      } catch (e) { /* ignore decode errors */ }
    }

    if (msg.type === 'error') {
      log(`Server error: ${msg.message}`);
    }
  });

  ws.on('close', () => {
    log('Disconnected.');
    stopHeartbeat();
    stopIdleMonitor();
    currentAgentId = null;
    if (running) {
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
      log(`Reconnecting in ${delay / 1000}s...`);
      setTimeout(connect, delay);
    }
  });

  ws.on('error', (e) => {
    log(`WebSocket error: ${e.message}`);
  });
}

// ========== Heartbeat ==========

function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HB_INTERVAL);
}

function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

// ========== Idle Detection ==========

function startIdleMonitor() {
  stopIdleMonitor();
  idleTimer = setInterval(() => {
    if (!currentAgentId || isProcessing) return;

    const elapsed = Date.now() - lastOutputTime;
    if (elapsed >= IDLE_TIMEOUT) {
      log(`Agent idle for ${Math.round(elapsed / 1000)}s. Triggering LLM analysis...`);
      triggerAnalysis();
    }
  }, CHECK_INTERVAL);
  log(`Idle monitor started (timeout: ${IDLE_TIMEOUT / 1000}s, check: ${CHECK_INTERVAL / 1000}s)`);
}

function stopIdleMonitor() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

// ========== Main Analysis Loop ==========

async function triggerAnalysis() {
  if (isProcessing) return;
  isProcessing = true;

  iterationCount++;
  if (iterationCount > MAX_ITERATIONS) {
    log(`Max iterations (${MAX_ITERATIONS}) reached. Stopping.`);
    shutdown('max_iterations');
    return;
  }

  // Extract recent output
  const lines = outputBuffer.split('\n');
  const recentLines = lines.slice(-MAX_HISTORY_LINES).join('\n');
  const lineCount = recentLines.split('\n').length;

  log(`--- Iteration ${iterationCount}/${MAX_ITERATIONS} (${lineCount} lines of context) ---`);

  try {
    const result = await callLLM(recentLines);

    log(`LLM verdict: done=${result.done}, reason="${(result.reason || '').substring(0, 200)}"`);

    if (result.done) {
      log(`=== TASK COMPLETE === ${result.reason || 'Task finished'}`);
      shutdown('task_complete');
      return;
    }

    if (result.action && result.action.trim()) {
      const actionPreview = result.action.replace(/\n/g, '\\n').replace(/\r/g, '\\r').substring(0, 150);
      log(`Injecting: ${actionPreview}`);
      injectCommand(result.action);
      // Reset idle timer to wait for command output
      lastOutputTime = Date.now();
    } else {
      log('LLM returned no action. Will re-check on next idle.');
    }
  } catch (e) {
    log(`LLM call failed: ${e.message}`);
    // Don't stop — will retry on next idle detection
  }

  isProcessing = false;
}

// ========== LLM Integration ==========

async function callLLM(recentOutput) {
  // Build conversation history
  if (conversationHistory.length === 0) {
    conversationHistory.push({ role: 'system', content: SYSTEM_PROMPT });
  }

  conversationHistory.push({
    role: 'user',
    content: `[第${iterationCount}次检查] 终端最近输出：\n\n${recentOutput}`
  });

  // Trim history: keep system + last N pairs
  if (conversationHistory.length > MAX_CONVERSATION * 2 + 1) {
    conversationHistory = [
      conversationHistory[0],
      ...conversationHistory.slice(-(MAX_CONVERSATION * 2))
    ];
  }

  let content;
  if (llmProvider === 'anthropic') {
    content = await callAnthropic();
  } else {
    content = await callOpenAI();
  }

  conversationHistory.push({ role: 'assistant', content });

  // Parse JSON response (handle markdown code blocks from local LLMs)
  let jsonStr = content.trim();
  // Strip markdown code block wrapper: ```json ... ``` or ``` ... ```
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      done: !!parsed.done,
      reason: parsed.reason || '',
      action: parsed.action || ''
    };
  } catch {
    log(`Warning: LLM did not return valid JSON. Raw: ${content.substring(0, 300)}`);
    return { done: false, reason: 'Invalid JSON from LLM', action: '' };
  }
}

function callOpenAI() {
  const url = new URL(`${llmBaseUrl}/chat/completions`);
  const reqBody = {
    model: llmModel,
    messages: conversationHistory,
    temperature: cfg.llm.temperature || 0.3,
    max_tokens: cfg.llm.maxTokens || 1000
  };
  // Only add response_format if explicitly enabled (not all local LLMs support it)
  if (cfg.llm.jsonMode) {
    reqBody.response_format = { type: 'json_object' };
  }
  const body = JSON.stringify(reqBody);

  const headers = { 'Content-Type': 'application/json' };
  if (llmApiKey) headers['Authorization'] = `Bearer ${llmApiKey}`;

  return httpRequest(url, body, headers);
}

function callAnthropic() {
  const url = new URL(`${llmBaseUrl}/messages`);
  // Anthropic API: system is a top-level field, messages don't include system role
  const systemMsg = conversationHistory.find(m => m.role === 'system');
  const messages = conversationHistory.filter(m => m.role !== 'system');

  const body = JSON.stringify({
    model: llmModel,
    system: systemMsg ? systemMsg.content : '',
    messages,
    max_tokens: 1000,
    temperature: 0.3
  });

  return httpRequest(url, body, {
    'Content-Type': 'application/json',
    'x-api-key': llmApiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  }).then(raw => {
    // Anthropic response format: { content: [{ type: "text", text: "..." }] }
    const resp = JSON.parse(raw);
    return resp.content?.[0]?.text || '';
  });
}

function httpRequest(url, body, headers) {
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // For OpenAI: parse directly
          if (llmProvider !== 'anthropic' || !url.pathname.includes('/messages')) {
            const resp = JSON.parse(data);
            if (resp.error) {
              reject(new Error(resp.error.message || JSON.stringify(resp.error)));
              return;
            }
            const content = resp.choices?.[0]?.message?.content || '';
            resolve(content);
          } else {
            // Anthropic: return raw for caller to parse
            resolve(data);
          }
        } catch (e) {
          reject(new Error(`Failed to parse LLM response: ${e.message}\nRaw: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('LLM request timeout (60s)'));
    });
    req.write(body);
    req.end();
  });
}

// ========== Command Injection ==========

function injectCommand(command) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentAgentId) {
    log('Cannot inject: not connected to agent');
    return;
  }

  // Process escape sequences from LLM output
  const processed = command
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');

  const bytes = Buffer.from(processed, 'utf8');
  const payload = bytes.toString('base64');

  ws.send(JSON.stringify({
    type: 'data',
    payload,
    agentId: currentAgentId
  }));
}

// ========== Shutdown ==========

function shutdown(reason) {
  running = false;
  log(`Shutting down: ${reason}`);
  log(`Total iterations: ${iterationCount}`);
  stopIdleMonitor();
  stopHeartbeat();
  if (ws) {
    ws.close();
    ws = null;
  }
  process.exit(reason === 'task_complete' ? 0 : 1);
}

process.on('SIGINT', () => {
  log('Received SIGINT');
  shutdown('sigint');
});

process.on('SIGTERM', () => {
  log('Received SIGTERM');
  shutdown('sigterm');
});

// ========== Start ==========
log('AI Overseer starting...');
log(`  Task: ${cfg.taskGoal}`);
log(`  Target agent: ${cfg.agentName}`);
log(`  LLM: ${llmModel} via ${llmProvider} (${llmBaseUrl})`);
log(`  Idle timeout: ${IDLE_TIMEOUT / 1000}s`);
log(`  Max iterations: ${MAX_ITERATIONS}`);
log('');
connect();
