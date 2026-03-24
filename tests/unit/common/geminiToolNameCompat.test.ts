/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

// 中文：这里直接导入 patched aioncli-core 的真实实现，避免测试和 patch 副本脱节。
// English: Import the real patched aioncli-core implementation here so the test validates the actual patch instead of a copied local helper.
import { generateValidName, MCP_QUALIFIED_NAME_SEPARATOR } from '@office-ai/aioncli-core/dist/src/tools/mcp-tool.js';

function getFullyQualifiedName(serverName: string, toolName: string): string {
  return `${generateValidName(serverName)}${MCP_QUALIFIED_NAME_SEPARATOR}${generateValidName(toolName)}`;
}

describe('Gemini MCP tool-name compatibility', () => {
  it('keeps already valid tool names unchanged', () => {
    expect(generateValidName('myTool')).toBe('myTool');
    expect(generateValidName('server:tool')).toBe('server:tool');
  });

  it('sanitizes illegal characters before sending to Gemini', () => {
    expect(generateValidName('ppt[export] server')).toBe('ppt_export__server');
    expect(generateValidName('tool with spaces')).toBe('tool_with_spaces');
  });

  it('prefixes names that do not start with a letter or underscore', () => {
    expect(generateValidName('123tool')).toBe('_123tool');
    expect(generateValidName('9ppt[export]')).toBe('_9ppt_export_');
  });

  it('builds a Gemini-compatible fully qualified MCP name', () => {
    expect(getFullyQualifiedName('ppt[export] server', 'render tool')).toBe('ppt_export__server__render_tool');
  });

  it('caps names at the Gemini-compatible 128-character limit', () => {
    const result = generateValidName(`a${'b'.repeat(140)}`);
    expect(result.length).toBe(128);
    expect(result).toBe(`${'a'.repeat(1)}${'b'.repeat(61)}___${'b'.repeat(63)}`);
  });
});
