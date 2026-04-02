/**
 * CUREVIE BACKEND - Code Collector
 * Generates two files:
 *   1. all_code.txt   — all important source code concatenated
 *   2. tree.txt        — directory tree structure
 *
 * Run: node collect_code.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'logs',
  '.env',
  '.vscode',
  'dist',
  'build',
  'coverage',
]);

// File extensions to include in code output
const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.json',
  '.sql',
  '.md',
  '.env.example',
]);

// Files to always skip
const SKIP_FILES = new Set([
  'package-lock.json',
  'all_code.txt',
  'tree.txt',
  'collect_code.js',
]);

// ─── Helpers ───────────────────────────────────────────────

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function shouldIncludeFile(filename) {
  if (SKIP_FILES.has(filename)) return false;
  if (filename === '.env') return false;
  if (filename === '.env.example') return true;
  const ext = path.extname(filename).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// ─── Build Tree ────────────────────────────────────────────

function buildTree(dir, prefix = '', isLast = true, isRoot = true) {
  const name = path.basename(dir);
  let lines = [];

  if (isRoot) {
    lines.push(name + '/');
  } else {
    lines.push(prefix + (isLast ? '└── ' : '├── ') + name + (fs.statSync(dir).isDirectory() ? '/' : ''));
  }

  if (!fs.statSync(dir).isDirectory()) return lines;

  let entries = fs.readdirSync(dir).sort((a, b) => {
    const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
    const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  // Filter out skipped dirs and files
  entries = entries.filter((e) => {
    const fullPath = path.join(dir, e);
    if (fs.statSync(fullPath).isDirectory()) {
      return !shouldSkipDir(e);
    }
    return !SKIP_FILES.has(e);
  });

  entries.forEach((entry, index) => {
    const fullPath = path.join(dir, entry);
    const last = index === entries.length - 1;
    const newPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

    if (fs.statSync(fullPath).isDirectory()) {
      lines = lines.concat(buildTree(fullPath, newPrefix, last, false));
    } else {
      lines.push(newPrefix + (last ? '└── ' : '├── ') + entry);
    }
  });

  return lines;
}

// ─── Collect Code ──────────────────────────────────────────

function collectFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!shouldSkipDir(entry)) {
        files = files.concat(collectFiles(fullPath));
      }
    } else if (shouldIncludeFile(entry)) {
      files.push(fullPath);
    }
  }

  return files;
}

// ─── Main ──────────────────────────────────────────────────

function main() {
  console.log('📁 Collecting project code...\n');

  // 1. Generate tree
  const treeLines = buildTree(ROOT);
  const treeContent = treeLines.join('\n');
  const treePath = path.join(ROOT, 'tree.txt');
  fs.writeFileSync(treePath, treeContent, 'utf-8');
  console.log(`✅ tree.txt created (${treeLines.length} lines)`);

  // 2. Collect files and split into 5 parts
  const codeFiles = collectFiles(ROOT);
  const totalFiles = codeFiles.length;
  const filesPerPart = Math.ceil(totalFiles / 5);
  const separator = '═'.repeat(80);

  console.log(`📦 Grouping ${totalFiles} files into 5 parts (~${filesPerPart} files per part)...\n`);

  for (let i = 0; i < 5; i++) {
    const startIdx = i * filesPerPart;
    const endIdx = Math.min(startIdx + filesPerPart, totalFiles);
    const partFiles = codeFiles.slice(startIdx, endIdx);
    
    if (partFiles.length === 0) continue;

    let partContent = `CUREVIE BACKEND - Source Code Part ${i + 1}/5\n`;
    partContent += `Generated: ${new Date().toLocaleString()}\n`;
    partContent += `Files in this part: ${partFiles.length} (${startIdx + 1} to ${endIdx})\n`;
    partContent += `Total Files in Project: ${totalFiles}\n`;
    partContent += `${separator}\n\n`;

    for (const file of partFiles) {
      const relativePath = path.relative(ROOT, file);
      const content = fs.readFileSync(file, 'utf-8');
      
      partContent += `${'─'.repeat(80)}\n`;
      partContent += `📄 File: ${relativePath}\n`;
      partContent += `${'─'.repeat(80)}\n\n`;
      partContent += content;
      partContent += '\n\n';
    }

    const partPath = path.join(ROOT, `all_code_part${i + 1}.txt`);
    fs.writeFileSync(partPath, partContent, 'utf-8');
    const sizeKB = (Buffer.byteLength(partContent) / 1024).toFixed(1);
    console.log(`✅ all_code_part${i + 1}.txt created (${partFiles.length} files, ${sizeKB} KB)`);
  }

  console.log('\n🎉 Done!');
}

main();
