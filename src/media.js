// Multimedia processing and Discord rendering: Mermaid charts, file detection, and smart message formatting.
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';

const TIMEOUT_MS = 10000;
const MAX_ATTACHMENT_SIZE = 24 * 1024 * 1024; // 24MB Discord limit

/**
 * Render Mermaid code into an image buffer via mermaid.ink.
 * Returns null if network fails or syntax is invalid.
 */
export async function renderMermaid(code, { theme = 'dark' } = {}) {
  try {
    const clean = code.trim();
    if (!clean) return null;
    const base64 = Buffer.from(clean, 'utf8').toString('base64url');
    const url = `https://mermaid.ink/img/${base64}?theme=${theme}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    return null;
  }
}

/**
 * Generate a Mermaid dependency diagram from plan tasks with styled agent nodes.
 */
export function buildPlanDiagram(tasks = []) {
  if (!Array.isArray(tasks) || !tasks.length) return null;

  const lines = ['flowchart TD'];
  const agentClasses = new Set();

  for (const t of tasks) {
    const safeTitle = (t.title || t.id).replace(/["'`<>]/g, '').slice(0, 35);
    const agentName = String(t.agent || 'worker').toLowerCase();
    const nodeText = `<b>[${t.id}]</b><br/>${agentName}<br/><i>${safeTitle}</i>`;
    lines.push(`  ${t.id}["${nodeText}"]:::cls_${agentName.replace(/[^a-z0-9]/g, '_')}`);
    agentClasses.add(agentName);

    if (Array.isArray(t.depends_on)) {
      for (const d of t.depends_on) {
        if (d && d !== t.id) {
          lines.push(`  ${d} --> ${t.id}`);
        }
      }
    }
  }

  // Styles for different agents
  lines.push('  classDef default fill:#1e1f22,stroke:#5865f2,stroke-width:2px,color:#ffffff;');
  lines.push('  classDef cls_haiku fill:#2d241e,stroke:#f3d2b3,stroke-width:2px,color:#f3d2b3;');
  lines.push('  classDef cls_sonnet fill:#352014,stroke:#e8a87c,stroke-width:2px,color:#e8a87c;');
  lines.push('  classDef cls_gemini_flash fill:#142238,stroke:#4285f4,stroke-width:2px,color:#8ab4f8;');
  lines.push('  classDef cls_deepseek_flash fill:#181e3a,stroke:#4d6bfe,stroke-width:2px,color:#8da0ff;');
  lines.push('  classDef cls_orchestrator fill:#381d18,stroke:#d97757,stroke-width:2px,color:#ff9e7d;');

  return lines.join('\n');
}

/**
 * Extract files referenced in text (or created in cwd) and create Discord attachments.
 */
export function detectLocalMedia(text, cwd) {
  if (!text || !cwd) return { attachments: [], filesFound: [] };

  const attachments = [];
  const filesFound = [];
  const seenPaths = new Set();

  // Match markdown file links and bare file paths
  const patterns = [
    /!\[.*?\]\(([^)]+)\)/g,
    /\[.*?\]\((file:\/\/\/[^)]+)\)/g,
    /\b(?:[a-zA-Z0-9_\-./\\]+)\.(?:png|jpg|jpeg|gif|webp|svg|mp3|wav|ogg|m4a|mp4|webm|pdf|csv|json|zip|txt|md)\b/gi,
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      let candidate = (match[1] || match[0]).trim();
      candidate = candidate.replace(/^file:\/\/\/?/i, '');
      if (candidate.startsWith('"') || candidate.startsWith("'")) {
        candidate = candidate.slice(1, -1);
      }

      // Check relative to cwd or as absolute path
      const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);

      if (!seenPaths.has(resolved) && fs.existsSync(resolved)) {
        try {
          const stat = fs.statSync(resolved);
          if (stat.isFile() && stat.size > 0 && stat.size <= MAX_ATTACHMENT_SIZE) {
            seenPaths.add(resolved);
            const ext = path.extname(resolved).toLowerCase();
            const basename = path.basename(resolved);
            attachments.push(new AttachmentBuilder(resolved, { name: basename }));
            filesFound.push({ path: resolved, name: basename, ext, size: stat.size });
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  }

  return { attachments, filesFound };
}

/**
 * Smart markdown splitter: splits text to fit Discord's 2000 character limit
 * while keeping code blocks intact and not splitting words awkwardly.
 */
export function smartChunk(text, limit = 1900) {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeLang = '';

  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx < limit / 2) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit / 3) {
      splitIdx = limit;
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx);

    // Track code fence toggles in this chunk
    const fences = chunk.match(/```(\w*)/g) || [];
    for (const f of fences) {
      if (inCodeBlock) {
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = f.slice(3).trim();
      }
    }

    // If chunk ends inside a code block, close it cleanly
    if (inCodeBlock) {
      chunk += '\n```';
      remaining = `\`\`\`${codeLang}\n${remaining.trimStart()}`;
    }

    if (chunk.trim()) chunks.push(chunk);
  }

  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

/**
 * Find ```mermaid ... ``` blocks in text, render them to images,
 * and return modified text + image attachments.
 */
export async function renderMermaidInText(text) {
  if (!text || !text.includes('```mermaid')) return { text, attachments: [] };

  const attachments = [];
  let counter = 1;
  const mermaidRegex = /```mermaid\s*([\s\S]*?)```/gi;

  let newText = text;
  let match;
  while ((match = mermaidRegex.exec(text)) !== null) {
    const code = match[1].trim();
    const imgBuf = await renderMermaid(code);
    if (imgBuf) {
      const fileName = `diagram-${Date.now()}-${counter++}.png`;
      attachments.push(new AttachmentBuilder(imgBuf, { name: fileName }));
      newText = newText.replace(match[0], `*(📊 Rendered diagram: \`${fileName}\`)*`);
    }
  }

  return { text: newText, attachments };
}
