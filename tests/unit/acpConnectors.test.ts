/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="node" />

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
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
  execFileSync: vi.fn(() => 'v20.10.0\n'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@process/utils/shellEnv', () => ({
  findSuitableNodeBin: vi.fn(() => null),
  getEnhancedEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  getNpxCacheDir: vi.fn(() => 'C:\\Users\\Test\\AppData\\Local\\npm-cache\\_npx'),
  getWindowsShellExecutionOptions: vi.fn(() =>
    process.platform === 'win32' ? { shell: true, windowsHide: true } : {}
  ),
  resolveNpxPath: vi.fn(() => 'npx'),
}));

vi.mock('@process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
}));

import { execFile as execFileCb, spawn } from 'child_process';
import { resolveNpxPath } from '@process/utils/shellEnv';
import { connectCodex, createGenericSpawnConfig, spawnNpxBackend } from '../../src/process/agent/acp/acpConnectors';

const mockExecFile = vi.mocked(execFileCb);
const mockSpawn = vi.mocked(spawn);
const mockResolveNpxPath = vi.mocked(resolveNpxPath);

describe('spawnNpxBackend - Windows UTF-8 fix', () => {
  const mockChild = { unref: vi.fn() };

  beforeEach(() => {
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses npxCommand directly on non-Windows (no chcp prefix)', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', '/usr/local/bin/npx', {}, '/cwd', false, false);

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/npx',
      expect.any(Array),
      expect.objectContaining({ shell: false, windowsHide: false })
    );
  });

  it('installs bridge package and spawns shim via PATH lookup on Windows', async () => {
    const env = { PATH: 'C:\\Windows' };
    await spawnNpxBackend('claude', '@zed-industries/claude-agent-acp@0.21.0', 'npx.cmd', env, '/cwd', true, false);

    expect(mockExecFile).toHaveBeenCalledWith(
      'npm.cmd',
      [
        'install',
        '--no-save',
        '--prefix',
        'C:\\Users\\Test\\AppData\\Local\\npm-cache\\_npx\\aionui-acp\\claude\\0.21.0',
        '@zed-industries/claude-agent-acp@0.21.0',
      ],
      expect.objectContaining({ shell: true, windowsHide: true }),
      expect.any(Function)
    );

    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe('chcp 65001 >nul && claude-agent-acp.cmd');
    expect(args).toEqual([]);
    expect(options).toMatchObject({ shell: true, windowsHide: true, env });
    expect(env.PATH).toBe(
      'C:\\Users\\Test\\AppData\\Local\\npm-cache\\_npx\\aionui-acp\\claude\\0.21.0\\node_modules\\.bin;C:\\Windows'
    );
  });

  it('uses npm.cmd from PATH when derived npx path contains spaces on Windows', async () => {
    const npxWithSpaces = 'C:\\Program Files\\nodejs\\npx.cmd';
    const env = { PATH: 'C:\\Windows' };
    await spawnNpxBackend('claude', '@zed-industries/claude-agent-acp@0.21.0', npxWithSpaces, env, '/cwd', true, false);

    expect(mockExecFile).toHaveBeenCalledWith(
      'npm.cmd',
      expect.any(Array),
      expect.objectContaining({ env, shell: true, windowsHide: true }),
      expect.any(Function)
    );
    expect(env.PATH).toBe(
      'C:\\Users\\Test\\AppData\\Local\\npm-cache\\_npx\\aionui-acp\\claude\\0.21.0\\node_modules\\.bin;C:\\Program Files\\nodejs;C:\\Windows'
    );
  });

  it('includes --prefer-offline during Windows bridge install when requested', async () => {
    await spawnNpxBackend('claude', '@zed-industries/claude-agent-acp@0.21.0', 'npx.cmd', {}, '/cwd', true, true);

    expect(mockExecFile).toHaveBeenCalledWith(
      'npm.cmd',
      expect.arrayContaining(['--prefer-offline']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('passes extra args directly to shim spawn on Windows', async () => {
    await spawnNpxBackend('codebuddy', '@tencent-ai/codebuddy-code', 'npx.cmd', {}, '/cwd', true, false, {
      extraArgs: ['--acp'],
    });

    const [, args, options] = mockSpawn.mock.calls[0];
    expect(args).toEqual(['--acp']);
    expect(options).toMatchObject({ shell: true, windowsHide: true });
  });

  it('passes --yes and package name as spawn args on non-Windows', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', 'npx', {}, '/cwd', false, false);

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--yes');
    expect(args).toContain('@pkg/cli@1.0.0');
  });

  it('includes --prefer-offline in spawn args on non-Windows when preferOffline is true', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', 'npx', {}, '/cwd', false, true);

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--prefer-offline');
  });

  it('omits --prefer-offline in spawn args on non-Windows when preferOffline is false', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', 'npx', {}, '/cwd', false, false);

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--prefer-offline');
  });

  it('calls child.unref() when detached is true', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', 'npx', {}, '/cwd', false, false, { detached: true });

    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('does not call child.unref() when detached is false', async () => {
    await spawnNpxBackend('claude', '@pkg/cli@1.0.0', 'npx', {}, '/cwd', false, false, { detached: false });

    expect(mockChild.unref).not.toHaveBeenCalled();
  });
});

describe('createGenericSpawnConfig - Windows path handling', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  const setWindowsPlatform = () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  };

  const setLinuxPlatform = () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  };

  it('returns plain command on non-Windows', () => {
    setLinuxPlatform();
    const config = createGenericSpawnConfig('goose', '/cwd', ['acp'], undefined, { PATH: '/usr/bin' });

    expect(config.command).toBe('goose');
    expect(config.args).toEqual(['acp']);
    expect(config.options).toMatchObject({ shell: false });
  });

  it('uses bare command with chcp prefix on Windows', () => {
    setWindowsPlatform();
    const config = createGenericSpawnConfig('goose', 'C:\\cwd', ['acp'], undefined, { PATH: 'C:\\Windows' });

    expect(config.command).toBe('chcp 65001 >nul && goose');
    expect(config.options).toMatchObject({ shell: true });
  });

  it('normalizes Windows paths with spaces into PATH lookup', () => {
    setWindowsPlatform();
    const env = { PATH: 'C:\\Windows' };
    const config = createGenericSpawnConfig('C:\\Program Files\\agent\\agent.exe', 'C:\\cwd', [], undefined, env);

    expect(config.command).toBe('chcp 65001 >nul && agent.exe');
    expect(env.PATH).toBe('C:\\Program Files\\agent;C:\\Windows');
    expect(config.options).toMatchObject({ shell: true, env });
  });

  it('splits npx package into command and args and keeps Windows-safe command normalization', () => {
    const config = createGenericSpawnConfig('npx @pkg/cli', '/cwd', ['--acp'], undefined, { PATH: '/usr/bin' });

    expect(config.command).toBe('chcp 65001 >nul && npx');
    expect(config.args).toContain('@pkg/cli');
    expect(config.args).toContain('--acp');
  });

  it('normalizes resolved npx paths with spaces on Windows', () => {
    setWindowsPlatform();
    mockResolveNpxPath.mockReturnValueOnce('C:\\Program Files\\nodejs\\npx.cmd');
    const env = { PATH: 'C:\\Windows' };
    const config = createGenericSpawnConfig('npx @pkg/cli', 'C:\\cwd', ['--acp'], undefined, env);

    expect(config.command).toBe('chcp 65001 >nul && npx.cmd');
    expect(config.args).toContain('@pkg/cli');
    expect(config.args).toContain('--acp');
    expect(env.PATH).toBe('C:\\Program Files\\nodejs;C:\\Windows');
  });
});

describe('connectCodex - Windows diagnostics', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  const mockChild = { unref: vi.fn() };

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args[0] === '--version') {
          cb(null, { stdout: '0.0.1\n', stderr: '' });
          return undefined as never;
        }

        cb(null, { stdout: 'Logged in with ChatGPT\n', stderr: '' });
        return undefined as never;
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('uses shell execution for codex.cmd probes on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const setup = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await connectCodex('C:\\cwd', { setup, cleanup });

    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'codex.cmd',
      ['--version'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expect.stringContaining('/usr/bin') }),
        shell: true,
        timeout: 5000,
        windowsHide: true,
      }),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'codex.cmd',
      ['login', 'status'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expect.stringContaining('/usr/bin') }),
        shell: true,
        timeout: 5000,
        windowsHide: true,
      }),
      expect.any(Function)
    );
    expect(setup).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
