/**
 * Claude state detector — parses terminal output tail and infers what state
 * a Claude Code (or similar LLM CLI) session is in.
 *
 * Pure module: takes a string of recent terminal output, returns a structured
 * state object. Designed to be unit-testable without any I/O.
 *
 * Recognized states:
 *   - none      : no Claude session detected
 *   - working   : Claude is processing (spinner / "Thinking..." / "Cogitating...")
 *   - yesno     : Claude is asking for yes/no confirmation
 *   - option    : Claude is presenting a numbered/bulleted option list
 *   - input     : Claude is waiting for free-form text input
 *   - bash      : Claude is asking for bash permission / "Run command?" prompt
 *   - done      : Claude finished a turn, sitting at idle prompt
 */

'use strict';

// Strip ANSI escape sequences, OSC sequences, and other terminal noise so the
// detector works on regex over plain text. Keeps newlines and spaces.
function stripAnsi(text) {
  if (!text) return '';
  return text
    // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences: ESC [ ... <final char>
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // Other ESC sequences (single-char: ESC 7, ESC 8, ESC M, etc.)
    .replace(/\x1b[@-Z\\-_]/g, '')
    // Carriage returns — keep as nothing (we already have newlines)
    .replace(/\r/g, '')
    // Backspace
    .replace(/.\x08/g, '');
}

// Heuristics for "is this a Claude Code session?"
const CLAUDE_BANNER_PATTERNS = [
  /Welcome\s+to\s+Claude/i,
  /claude\.ai\/code/i,
  /\bClaude Code\b/i,
  /^\s*✻/,                               // sparkle banner char
  /\b✻\s+Welcome/i,
  /\bclaude[>@:]\s*$/i,                   // `claude>` REPL prompt
  /Troubleshooting|esc\s+to\s+interrupt/i,
  /PRIVACY|Try\s+["']claude\b/i,
  /\bcwd:?\s*\//i,                        // cwd: line in Claude UI
  /\bmodel:?\s*(sonnet|opus|haiku|claude)/i,
  /\bcontext\s+left\s*:|tokens?\s*(left|remaining)\s*[:=]/i,
  /esc\s+to\s+interrupt|ctrl\+c.*interrupt/i,
  /\b(?:Allow|Permit|Approve)\s+Claude\s+to\b/i,
  /\bClaude\s+is\s+(thinking|working|analyzing|generating)\b/i,
  /\b━{10,}\s*Claude\b/i,                       // separator bars
];

const SPINNER_PATTERNS = [
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⣾⣽⣻⢿⡿⣟⣯⣷*+x○●]\s+/m,
  /\b(thinking|cogitating|pondering|generating|analyzing|warming\s+up|reading|searching|working|processing)\b[\s.]*$/i,
  /^\s*[\\|\/\-—–]\s*\S/m,
];

// Claude Code's permission prompts
const YESNO_PATTERNS = [
  /\b(?:Do\s+you|Would\s+you|Are\s+you|Shall\s+I|Should\s+I|May\s+I|Can\s+I|Try|Allow|Approve|Confirm|Proceed|Continue)\b[^\n?]*\?/i,
  /\b(?:Yes|No|OK|Cancel|Approve|Deny|Allow|Reject)\b\s*[\(\[]?[YN1-2]/i,
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)/,                  // (y/n)
  /\btype\s+(yes|y|no|n)\s+to\s+/i,
  /❯\s*(Yes|No)\b/,                              // Claude UI highlight
  /\bEnter\s+for\s+(Yes|No|default)\b/i,
];

// Permission-to-run-bash prompt
const BASH_PROMPT_PATTERNS = [
  /\b(bash|shell|command|cmd)\s+permission\b/i,
  /\bAllow\s+(Claude|me)\s+to\s+(run|execute|use)\b/i,
  /\b(?:Run|Execute)\s+(?:bash|shell|command|cmd)\b.*\?\s*$/i,
  /\bRun\s+command\s*\??\s*$/i,
  /\bExecute\s+(bash|shell|command)\??\s*$/i,
  /pressing\s+enter\s+to\s+(run|execute|allow)\b/i,
  /\bpermission\s+to\s+(run|execute|edit|write|delete)\b/i,
];

// Numbered / bulleted option list — must be at end of output
const OPTION_LIST_PATTERNS = [
  /[\n\r]\s*[❯>]\s*\d+\.\s+\S[^\n\r]*([\n\r]\s+\d+\.\s+\S[^\n\r]*)+\s*$/,
  /[\n\r]\s*\d+[\.\)]\s+\S[^\n\r]*([\n\r]\s*\d+[\.\)]\s+\S[^\n\r]*){1,}\s*$/,
  /[\n\r]\s*[❯>]\s+[\(\[]?[a-zA-Z][\)\]].?\s+\S[^\n\r]*([\n\r]\s+[a-zA-Z][\)\]].?\s+\S[^\n\r]*)+\s*$/,
];

// Idle prompt — Claude finished and waiting at input
const IDLE_PROMPT_PATTERNS = [
  /^\s*>\s*$/m,                                  // Claude Code's `>` input cursor
  /^\s*❯\s*$/m,
  /\bWhat\s+(would|do)\s+you\s+(like|want|need)\b.*\?\s*$/i,
  /\bHow\s+can\s+I\s+help.*\?\s*$/i,
  /^\s*claude[>@:]\s*$/im,
];

function tailLines(text, n) {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

function extractOptions(text) {
  const opts = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*[❯>]?\s*(\d+)[\.\)]\s+(.+?)\s*$/);
    if (m) opts.push({ index: parseInt(m[1]), label: m[2].trim() });
  }
  return opts;
}

function extractLastPromptQuestion(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.endsWith('?') && l.length > 5 && l.length < 400) return l;
  }
  // Fallback: last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim().substring(0, 300);
  }
  return '';
}

/**
 * Detect Claude session state from terminal output.
 * @param {string} rawOutput - raw terminal output (may include ANSI)
 * @returns {object} { running, kind, prompt, options, lastLine, raw_tail_len }
 */
function detectClaudeState(rawOutput) {
  const text = stripAnsi(rawOutput || '');
  // Inspect last ~3KB — enough for any prompt + recent context
  const tail = tailLines(text, 60);
  const lastLines = tail.split('\n');
  const lastNonEmpty = (() => {
    for (let i = lastLines.length - 1; i >= 0; i--) {
      if (lastLines[i].trim()) return lastLines[i].trim();
    }
    return '';
  })();

  const result = {
    running: false,
    kind: 'none',
    prompt: '',
    options: [],
    lastLine: lastNonEmpty.substring(0, 500),
    detectedAt: new Date().toISOString()
  };

  if (!text || !text.trim()) return result;

  // 1. Is this a Claude session at all?
  const isClaude = CLAUDE_BANNER_PATTERNS.some(re => re.test(text))
                || CLAUDE_BANNER_PATTERNS.some(re => re.test(tail));
  if (!isClaude) return result;

  result.running = true;

  // 2. Working / spinner?
  if (SPINNER_PATTERNS.some(re => re.test(tail))) {
    result.kind = 'working';
    result.prompt = lastNonEmpty.substring(0, 200);
    return result;
  }

  // 3. Bash permission?
  if (BASH_PROMPT_PATTERNS.some(re => re.test(tail))) {
    result.kind = 'bash';
    result.prompt = extractLastPromptQuestion(tail) || lastNonEmpty;
    return result;
  }

  // 4. Option list?
  if (OPTION_LIST_PATTERNS.some(re => re.test(tail))) {
    const opts = extractOptions(tail);
    if (opts.length >= 2) {
      result.kind = 'option';
      result.options = opts.slice(0, 20);
      result.prompt = extractLastPromptQuestion(tail);
      return result;
    }
  }

  // 5. Yes/no?
  if (YESNO_PATTERNS.some(re => re.test(tail))) {
    result.kind = 'yesno';
    result.prompt = extractLastPromptQuestion(tail) || lastNonEmpty;
    return result;
  }

  // 6. Idle prompt waiting for input?
  if (IDLE_PROMPT_PATTERNS.some(re => re.test(tail))) {
    result.kind = 'input';
    result.prompt = extractLastPromptQuestion(tail) || lastNonEmpty;
    return result;
  }

  // 7. Default: detected Claude but no clear prompt → working / streaming
  result.kind = 'working';
  result.prompt = lastNonEmpty.substring(0, 200);
  return result;
}

module.exports = {
  detectClaudeState,
  stripAnsi,
  // exported for testing
  _INTERNAL: { CLAUDE_BANNER_PATTERNS, SPINNER_PATTERNS, YESNO_PATTERNS, BASH_PROMPT_PATTERNS, OPTION_LIST_PATTERNS, IDLE_PROMPT_PATTERNS }
};
