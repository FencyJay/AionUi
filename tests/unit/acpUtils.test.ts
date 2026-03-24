/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void;

const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

describe('acp utils killChild', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs readable Windows taskkill output when stderr is encoded in cp936', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: { encoding: 'buffer'; windowsHide: boolean; timeout: number },
        callback: ExecFileCallback
      ) => {
        const stderr = Buffer.from('b4edcef33a20c3bbd3d0d5d2b5bdbdf8b3cc202239393939393922a1a30d0a', 'hex');
        const error = new Error(
          'Command failed: taskkill /PID 999999 /T /F\n����: û���ҵ����� "999999"��\r\n'
        ) as Error & {
          code?: number;
        };
        error.code = 128;
        callback(error, Buffer.alloc(0), stderr);
      }
    );

    const { killChild } = await import('@process/agent/acp/utils');

    await killChild(
      {
        pid: 999999,
        kill: vi.fn(),
      } as never,
      false
    );

    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '999999', '/T', '/F'],
      expect.objectContaining({ encoding: 'buffer', windowsHide: true, timeout: 5000 }),
      expect.any(Function)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[ACP] taskkill /T /F failed for PID 999999: 错误: 没有找到进程 "999999"。\n(exit code: 128)'
    );

    warnSpy.mockRestore();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('keeps utf-8 taskkill output unchanged when no fallback decoding is needed', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: { encoding: 'buffer'; windowsHide: boolean; timeout: number },
        callback: ExecFileCallback
      ) => {
        const stderr = Buffer.from('ERROR: The process "999999" not found.\r\n', 'utf8');
        const error = new Error('Command failed') as Error & {
          code?: number;
        };
        error.code = 128;
        callback(error, Buffer.alloc(0), stderr);
      }
    );

    const { killChild } = await import('@process/agent/acp/utils');

    await killChild(
      {
        pid: 999999,
        kill: vi.fn(),
      } as never,
      false
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ACP] taskkill /T /F failed for PID 999999: ERROR: The process "999999" not found.\n(exit code: 128)'
    );

    warnSpy.mockRestore();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});
