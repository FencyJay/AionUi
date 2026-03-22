/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void
    ) => {
      cb(null, { stdout: '', stderr: '' });
    }
  ),
}));

vi.mock('fs', () => ({
  promises: {
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@process/utils/shellEnv', () => ({
  getNpxCacheDir: vi.fn(() => 'C:\\Users\\Test\\AppData\\Local\\npm-cache\\_npx'),
  getWindowsShellExecutionOptions: vi.fn(() =>
    process.platform === 'win32' ? { shell: true, windowsHide: true } : {}
  ),
  resolveNpxPath: vi.fn(() => 'C:\\Program Files\\nodejs\\npx.cmd'),
}));

vi.mock('../../src/process/agent/acp/acpConnectors', async () => {
  const actual = await vi.importActual<typeof import('../../src/process/agent/acp/acpConnectors')>(
    '../../src/process/agent/acp/acpConnectors'
  );
  return {
    ...actual,
    prepareCleanEnv: vi.fn(() => ({ PATH: 'C:\\Windows' })),
    connectClaude: vi.fn(),
    connectCodebuddy: vi.fn(),
    connectCodex: vi.fn(),
    spawnGenericBackend: vi.fn(),
  };
});

import { execFile as execFileCb } from 'child_process';
import { AcpConnection } from '../../src/process/agent/acp/AcpConnection';

const mockExecFile = vi.mocked(execFileCb);

describe('AcpConnection.connect - Windows npm cache recovery', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('normalizes npm.cmd into PATH lookup before cleaning stale cache on Windows', async () => {
    const conn = new AcpConnection();
    const doConnect = vi
      .spyOn(conn as never, 'doConnect' as never)
      .mockRejectedValueOnce(new Error('No matching version found for package'))
      .mockResolvedValueOnce(undefined);

    await conn.connect('codex', undefined, 'C:\\cwd');

    expect(mockExecFile).toHaveBeenCalledWith(
      'npm.cmd',
      ['cache', 'clean', '--force'],
      expect.objectContaining({
        env: { PATH: 'C:\\Program Files\\nodejs;C:\\Windows' },
        shell: true,
        windowsHide: true,
      }),
      expect.any(Function)
    );
    expect(doConnect).toHaveBeenCalledTimes(2);
  });
});
