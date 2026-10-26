'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
  '.cache',
  'cache',
  'uvtools'
]);

const BINARY_OR_SKIP_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.asar', '.blockmap',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.pdb', '.sqlite', '.db'
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  '.DS_Store',
  'Thumbs.db',
  'OPENDOCFLOW_CONTEXT.md'
]);

function redactSecretsText(text) {
  if (!text) return '';
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{20,}/g, 'gho_[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{22,}/g, 'github_pat_[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{25,}/g, 'AIza[REDACTED]')
    .replace(/gsk_[A-Za-z0-9_-]{20,}/g, 'gsk_[REDACTED]')
    .replace(/xai-[A-Za-z0-9_-]{20,}/g, 'xai-[REDACTED]');
}

function isSensitiveEnvFile(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.') && !lower.endsWith('.example') && !lower.endsWith('.sample'))) {
    return true;
  }
  if (lower.endsWith('.key') || lower.endsWith('.pem') || lower === 'keys.cmd') {
    return true;
  }
  return false;
}

function parseGitignorePatterns(rootDir) {
  const giPath = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(giPath)) return [];
  try {
    return fs
      .readFileSync(giPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => l.replace(/^\/+|\/+$/g, ''));
  } catch (_) {
    return [];
  }
}

function matchesSimpleIgnore(relPosix, patterns) {
  for (const p of patterns) {
    if (!p) continue;
    if (relPosix === p || relPosix.startsWith(p + '/')) return true;
    if (p.startsWith('*.') && relPosix.endsWith(p.slice(1))) return true;
  }
  return false;
}

async function packRepositoryToMarkdown(options = {}) {
  const targetDir = path.resolve(String(options.dirPath || process.cwd()));
  const maxFiles = Number(options.maxFiles) || 180;
  const maxFileBytes = Number(options.maxFileBytes) || 64 * 1024;
  const maxTotalChars = Number(options.maxTotalChars) || 450000;

  const stat = await fsp.stat(targetDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { ok: false, error: `Directory not found: ${targetDir}` };
  }

  const gitignorePatterns = parseGitignorePatterns(targetDir);
  const collectedFiles = [];
  const treeLines = [];

  async function walk(currentDir, depth) {
    if (depth > 8 || collectedFiles.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (collectedFiles.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPosix = path.relative(targetDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.opencode-backup')) continue;
        if (matchesSimpleIgnore(relPosix, gitignorePatterns)) continue;
        treeLines.push(`${'  '.repeat(depth)}📁 ${entry.name}/`);
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (SKIP_FILENAMES.has(entry.name) || isSensitiveEnvFile(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_OR_SKIP_EXTS.has(ext)) continue;
        if (matchesSimpleIgnore(relPosix, gitignorePatterns)) continue;

        let fStat;
        try {
          fStat = await fsp.stat(fullPath);
        } catch (_) {
          continue;
        }
        if (fStat.size > maxFileBytes) {
          treeLines.push(`${'  '.repeat(depth)}📄 ${entry.name} (skipped: ${Math.round(fStat.size / 1024)} KB)`);
          continue;
        }
        treeLines.push(`${'  '.repeat(depth)}📄 ${entry.name}`);
        collectedFiles.push({ fullPath, relPosix, size: fStat.size, ext: ext.slice(1) || 'txt' });
      }
    }
  }

  await walk(targetDir, 0);

  let totalChars = 0;
  let totalLines = 0;
  const fileSections = [];
  const topFiles = [];

  for (const f of collectedFiles) {
    if (totalChars >= maxTotalChars) break;
    let content = '';
    try {
      content = await fsp.readFile(f.fullPath, 'utf8');
    } catch (_) {
      continue;
    }
    // Skip binary-like files containing NUL bytes
    if (content.includes('\u0000')) continue;

    const safeContent = redactSecretsText(content);
    const linesCount = safeContent.split(/\r?\n/).length;
    const estTokens = Math.ceil(safeContent.length / 4);
    totalChars += safeContent.length;
    totalLines += linesCount;
    topFiles.push({ path: f.relPosix, lines: linesCount, tokens: estTokens, bytes: f.size });

    fileSections.push(
      `## File: \`${f.relPosix}\`\n\`\`\`${f.ext}\n${safeContent.trimEnd()}\n\`\`\`\n`
    );
  }

  topFiles.sort((a, b) => b.tokens - a.tokens);
  const estimatedTokens = Math.ceil(totalChars / 4);
  const repoName = path.basename(targetDir);

  const markdown = [
    `# OpenDocFlow Context Bundle: ${repoName}`,
    ``,
    `- **Root Path:** \`${targetDir}\``,
    `- **Files Packed:** ${fileSections.length}`,
    `- **Total Lines:** ${totalLines.toLocaleString()}`,
    `- **Estimated Tokens:** ~${estimatedTokens.toLocaleString()}`,
    `- **Generated At:** ${new Date().toISOString()}`,
    ``,
    `## Directory Structure`,
    '```text',
    `${repoName}/`,
    ...treeLines.slice(0, 350),
    '```',
    ``,
    `## Source Files`,
    ``,
    ...fileSections
  ].join('\n');

  let savedTo = null;
  if (options.saveToFile) {
    savedTo = typeof options.saveToFile === 'string'
      ? options.saveToFile
      : path.join(targetDir, 'OPENDOCFLOW_CONTEXT.md');
    await fsp.writeFile(savedTo, markdown, 'utf8');
  }

  return {
    ok: true,
    repoName,
    rootDir: targetDir,
    filesCount: fileSections.length,
    filesPacked: fileSections.length,
    totalLines,
    totalChars,
    estimatedTokens,
    estTokens: estimatedTokens,
    topFiles: topFiles.slice(0, 12),
    savedTo,
    savedFile: savedTo,
    markdown
  };
}

function getRecentGitCommits(cwd, limit = 30) {
  return new Promise((resolve) => {
    const child = spawn('git', ['log', `-n`, String(limit), '--pretty=format:%h | %ad | %s', '--date=short'], {
      cwd,
      windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });
}

function buildDocFlowSystemPrompt(docType) {
  const prompts = {
    readme:
      'You are OpenDocFlow DocWriter. Generate a polished, high-converting, GitHub-#1-quality README.md in GitHub-Flavored Markdown based strictly on the provided repository context. Include badges, clear value proposition, feature highlights table, architecture overview (with a valid Mermaid flowchart), quickstart installation & usage steps, project structure, and license.',
    architecture:
      'You are OpenDocFlow Systems Architect. Analyze the repository context and produce a comprehensive ARCHITECTURE.md with valid Mermaid diagrams (`flowchart LR` and `sequenceDiagram`), component responsibilities, data/IPC flows, security model, and extension points.',
    api:
      'You are OpenDocFlow API Spec Writer. Produce a complete, developer-friendly API & Module Reference (`DOCS.md`) documenting every exported module, IPC channel, HTTP endpoint, CLI flag, and configuration schema found in the repository.',
    changelog:
      'You are OpenDocFlow Release Manager. Using the git commit history and repository context, generate clean, categorized Release Notes / CHANGELOG.md with Highlights, New Features, Performance & Speed Improvements, Bug Fixes, and Upgrade Notes.'
  };
  return prompts[docType] || prompts.readme;
}

// ============================================================================
// BUILT-IN AUTONOMOUS AGENT TOOL DEFINITIONS & EXECUTOR
// ============================================================================
const NATIVE_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders inside a workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: 'Relative path inside workspace (use "." for root).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read UTF-8 text contents of a file inside the workspace (up to 400 lines).',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: 'Relative file path inside workspace.' },
          startLine: { type: 'number', description: 'Optional 1-based start line.' },
          endLine: { type: 'number', description: 'Optional 1-based end line.' }
        },
        required: ['relPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search text or regex pattern across files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex pattern to search for.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file inside the workspace (requires write permission).',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: 'Relative file path inside workspace.' },
          content: { type: 'string', description: 'Full file content to write.' }
        },
        required: ['relPath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact target snippet inside an existing file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: 'Relative file path inside workspace.' },
          target: { type: 'string', description: 'Exact existing text to find.' },
          replacement: { type: 'string', description: 'Replacement text.' }
        },
        required: ['relPath', 'target', 'replacement']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pack_repo_overview',
      description: 'Generate a compact structural overview and token summary of the workspace.',
      parameters: {
        type: 'object',
        properties: {
          maxFiles: { type: 'number', description: 'Max files to scan (default 60).' }
        }
      }
    }
  }
];

function resolveSafeWorkspacePath(workspaceDir, relPath) {
  const root = path.resolve(workspaceDir || process.cwd());
  const resolved = path.resolve(root, String(relPath || '.'));
  if (!resolved.startsWith(root)) {
    throw new Error(`Path "${relPath}" escapes workspace root "${root}"`);
  }
  return resolved;
}

async function executeNativeAgentTool(toolName, args = {}, options = {}) {
  const workspaceDir = options.workspaceDir || process.cwd();
  const allowWrite = options.allowWrite !== false;

  try {
    if (toolName === 'list_directory') {
      const target = resolveSafeWorkspacePath(workspaceDir, args.relPath || '.');
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const formatted = entries
        .slice(0, 150)
        .map((e) => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`)
        .join('\n');
      return formatted || '(empty directory)';
    }

    if (toolName === 'read_file') {
      const target = resolveSafeWorkspacePath(workspaceDir, args.relPath);
      if (isSensitiveEnvFile(path.basename(target))) {
        return 'Blocked reading sensitive .env / .key file for security.';
      }
      const text = await fsp.readFile(target, 'utf8');
      const lines = text.split(/\r?\n/);
      const s = Math.max(1, Number(args.startLine) || 1);
      const e = Math.min(lines.length, Number(args.endLine) || s + 350);
      return lines
        .slice(s - 1, e)
        .map((line, i) => `${s + i}: ${redactSecretsText(line)}`)
        .join('\n');
    }

    if (toolName === 'search_code') {
      const packed = await packRepositoryToMarkdown({
        dirPath: workspaceDir,
        maxFiles: 90,
        maxFileBytes: 48 * 1024,
        maxTotalChars: 250000
      });
      if (!packed.ok) return packed.error;
      const q = String(args.query || '').toLowerCase();
      const hits = [];
      const lines = packed.markdown.split(/\r?\n/);
      let currentFile = '';
      for (const l of lines) {
        if (l.startsWith('## File: `')) {
          currentFile = l.slice(10, -1);
          continue;
        }
        if (currentFile && l.toLowerCase().includes(q)) {
          hits.push(`${currentFile}: ${l.trim().slice(0, 180)}`);
          if (hits.length >= 40) break;
        }
      }
      return hits.length > 0 ? hits.join('\n') : `No matches found for "${args.query}".`;
    }

    if (toolName === 'pack_repo_overview') {
      const packed = await packRepositoryToMarkdown({
        dirPath: workspaceDir,
        maxFiles: Number(args.maxFiles) || 50,
        maxTotalChars: 120000
      });
      if (!packed.ok) return packed.error;
      return packed.markdown.slice(0, 18000);
    }

    if (toolName === 'write_file') {
      if (!allowWrite) return 'Write permission disabled (Read-Only mode active).';
      const target = resolveSafeWorkspacePath(workspaceDir, args.relPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(args.content || ''), 'utf8');
      return `Wrote ${Buffer.byteLength(String(args.content || ''))} bytes to ${args.relPath}`;
    }

    if (toolName === 'edit_file') {
      if (!allowWrite) return 'Write permission disabled (Read-Only mode active).';
      const target = resolveSafeWorkspacePath(workspaceDir, args.relPath);
      const current = await fsp.readFile(target, 'utf8');
      if (!current.includes(args.target)) {
        return `Target snippet not found in ${args.relPath}. Read the file first to verify exact whitespace.`;
      }
      const updated = current.replace(args.target, String(args.replacement || ''));
      await fsp.writeFile(target, updated, 'utf8');
      return `Successfully edited ${args.relPath}`;
    }

    return `Unknown tool: ${toolName}`;
  } catch (err) {
    return `Tool error (${toolName}): ${err.message}`;
  }
}

module.exports = {
  redactSecretsText,
  packRepositoryToMarkdown,
  getRecentGitCommits,
  buildDocFlowSystemPrompt,
  NATIVE_AGENT_TOOLS,
  executeNativeAgentTool
};
