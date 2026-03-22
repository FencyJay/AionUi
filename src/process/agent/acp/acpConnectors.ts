/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend-specific ACP connector logic and environment helpers.
 * Extracted from AcpConnection to keep the main class focused on
 * process lifecycle, messaging, and session management.
 */

import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFile as execFileCb, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_ACP_NPX_PACKAGE,
  CODEBUDDY_ACP_NPX_PACKAGE,
  CODEX_ACP_BRIDGE_VERSION,
  CODEX_ACP_NPX_PACKAGE,
} from '@/common/types/acpTypes';
import {
  findSuitableNodeBin,
  getEnhancedEnv,
  getNpxCacheDir,
  getWindowsShellExecutionOptions,
  resolveNpxPath,
} from '@process/utils/shellEnv';
import { mainLog, mainWarn } from '@process/utils/mainLogger';

const execFile = promisify(execFileCb);

/** Enable ACP performance diagnostics via ACP_PERF=1 */
export const ACP_PERF_LOG = process.env.ACP_PERF === '1';

function prependWindowsPathEntry(pathValue: string | undefined, entry: string): string {
  if (!pathValue) return entry;
  const entries = pathValue.split(';').filter(Boolean);
  return entries.includes(entry) ? pathValue : `${entry};${pathValue}`;
}

export function normalizeWindowsShellCommand(command: string, env: Record<string, string | undefined>): string {
  const trimmed = command.trim();
  const quotedCommandMatch = trimmed.match(/^"([^"]+)"(?:\s+(.*))?$/);
  const commandToken = quotedCommandMatch?.[1] ?? trimmed;
  const trailingArgs = quotedCommandMatch?.[2]?.trim();

  if (path.win32.isAbsolute(commandToken)) {
    const commandDir = path.win32.dirname(commandToken);
    env.PATH = prependWindowsPathEntry(env.PATH, commandDir);
    const bareCommand = path.win32.basename(commandToken);
    return trailingArgs ? `${bareCommand} ${trailingArgs}` : bareCommand;
  }

  return trimmed;
}

function createWindowsShellCommand(command: string, env: Record<string, string | undefined>): string {
  return `chcp 65001 >nul && ${normalizeWindowsShellCommand(command, env)}`;
}

function getNpmCommandFromNpx(npxCommand: string): string {
  const normalized = npxCommand.trim();
  if (/npx\.cmd$/i.test(normalized)) return normalized.replace(/npx\.cmd$/i, 'npm.cmd');
  if (/npx$/i.test(normalized)) return normalized.replace(/npx$/i, 'npm');
  return normalized.replace(/npx/i, 'npm');
}

function getNpxPackageBinaryName(npxPackage: string): string {
  if (npxPackage === CODEX_ACP_NPX_PACKAGE) return 'codex-acp.cmd';
  if (npxPackage === CLAUDE_ACP_NPX_PACKAGE) return 'claude-agent-acp.cmd';
  if (npxPackage === CODEBUDDY_ACP_NPX_PACKAGE) return 'codebuddy.cmd';
  const packageName = npxPackage.split('@')[0] || npxPackage;
  const slashIndex = packageName.lastIndexOf('/');
  const bareName = slashIndex >= 0 ? packageName.slice(slashIndex + 1) : packageName;
  return `${bareName}.cmd`;
}

async function installWindowsNpxBridge(
  backend: string,
  npxPackage: string,
  npxCommand: string,
  cleanEnv: Record<string, string | undefined>,
  preferOffline: boolean
): Promise<string> {
  const packageVersion = npxPackage.replace(/^.*@(?=\d)/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const installDir = path.join(getNpxCacheDir(), 'aionui-acp', backend, packageVersion || 'latest');
  const npmCommand = normalizeWindowsShellCommand(getNpmCommandFromNpx(npxCommand), cleanEnv);
  const installArgs = [
    'install',
    '--no-save',
    '--prefix',
    installDir,
    npxPackage,
    ...(preferOffline ? ['--prefer-offline'] : []),
  ];

  await fs.mkdir(installDir, { recursive: true });
  await execFile(npmCommand, installArgs, {
    env: cleanEnv,
    timeout: 120000,
    windowsHide: true,
    ...getWindowsShellExecutionOptions(),
  });

  const shimPath = path.join(installDir, 'node_modules', '.bin', getNpxPackageBinaryName(npxPackage));
  if (!existsSync(shimPath)) {
    throw new Error(`Installed ACP bridge shim not found: ${shimPath}`);
  }

  return shimPath;
}

// ── Environment helpers ─────────────────────────────────────────────

/**
 * Prepare a clean environment for ACP backends.
 * Removes Electron-injected NODE_OPTIONS, npm lifecycle vars, and other
 * env vars that interfere with child Node.js processes.
 */
export function prepareCleanEnv(): Record<string, string | undefined> {
  const cleanEnv = getEnhancedEnv();
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.NODE_INSPECT;
  delete cleanEnv.NODE_DEBUG;
  // Remove CLAUDECODE env var to prevent claude-agent-sdk from detecting
  // a nested session when AionUi itself is launched from Claude Code.
  delete cleanEnv.CLAUDECODE;
  // Strip npm lifecycle vars inherited from parent `npm start` process.
  // These (npm_config_*, npm_lifecycle_*, npm_package_*) can cause npx to
  // behave as if running inside an npm script, interfering with package
  // resolution and child process startup.
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('npm_')) {
      delete cleanEnv[key];
    }
  }
  return cleanEnv;
}

/**
 * Pre-check Node.js version and auto-correct PATH if too old.
 * Requires Node >= minMajor.minMinor for ACP backends.
 * Mutates cleanEnv.PATH when auto-correction is needed.
 */
export function ensureMinNodeVersion(
  cleanEnv: Record<string, string | undefined>,
  minMajor: number,
  minMinor: number,
  backendLabel: string
): void {
  const isWindows = process.platform === 'win32';
  let versionTooOld = false;
  let detectedVersion = '';

  try {
    detectedVersion = execFileSync(isWindows ? 'node.exe' : 'node', ['--version'], {
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const match = detectedVersion.match(/^v(\d+)\.(\d+)\./);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < minMajor || (major === minMajor && minor < minMinor)) {
        versionTooOld = true;
      }
    }
  } catch {
    // node not found — let spawn attempt handle it
    console.warn('[ACP] Node.js version check skipped: node not found in PATH');
  }

  if (versionTooOld) {
    const suitableBinDir = findSuitableNodeBin(minMajor, minMinor);
    if (suitableBinDir) {
      const sep = isWindows ? ';' : ':';
      cleanEnv.PATH = suitableBinDir + sep + (cleanEnv.PATH || '');

      // Verify the corrected PATH actually resolves to a good node (npx uses the same PATH)
      try {
        const correctedVersion = execFileSync(isWindows ? 'node.exe' : 'node', ['--version'], {
          env: cleanEnv,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        console.log(
          `[ACP] Node.js ${detectedVersion} is below v${minMajor}.${minMinor}.0 — auto-corrected to ${correctedVersion} from: ${suitableBinDir}`
        );
      } catch {
        console.warn(`[ACP] PATH corrected with ${suitableBinDir} but node verification failed — proceeding anyway`);
      }
    } else {
      throw new Error(
        `Node.js ${detectedVersion} is too old for ${backendLabel}. ` +
          `Minimum required: v${minMajor}.${minMinor}.0. ` +
          `Please upgrade Node.js: https://nodejs.org/`
      );
    }
  }
}

// ── Generic spawn config ────────────────────────────────────────────

/**
 * Creates spawn configuration for ACP CLI commands.
 * Exported for unit testing.
 *
 * @param cliPath - CLI command path (e.g., 'goose', 'npx @pkg/cli')
 * @param workingDir - Working directory for the spawned process
 * @param acpArgs - Arguments to enable ACP mode (e.g., ['acp'] for goose, ['--acp'] for auggie, ['exec','--output-format','acp'] for droid)
 * @param customEnv - Custom environment variables
 * @param prebuiltEnv - Pre-built env to use directly (skips internal getEnhancedEnv)
 */
export function createGenericSpawnConfig(
  cliPath: string,
  workingDir: string,
  acpArgs?: string[],
  customEnv?: Record<string, string>,
  prebuiltEnv?: Record<string, string>
) {
  const isWindows = process.platform === 'win32';
  // Use prebuilt env if provided (already cleaned by caller), otherwise build from shell env
  const env = prebuiltEnv ?? getEnhancedEnv(customEnv);

  // Default to --experimental-acp only if acpArgs is strictly undefined.
  // This allows passing an empty array [] to bypass default flags.
  const effectiveAcpArgs = acpArgs === undefined ? ['--experimental-acp'] : acpArgs;

  let spawnCommand: string;
  let spawnArgs: string[];

  if (cliPath.startsWith('npx ')) {
    // For "npx @package/name [extra-args]", split into command and arguments.
    // On Windows, normalize the resolved npx path so shell:true does not break
    // when Node/npm is installed under a path with spaces.
    const parts = cliPath.split(' ').filter(Boolean);
    const resolvedNpx = resolveNpxPath(env);
    spawnCommand = isWindows ? createWindowsShellCommand(resolvedNpx, env) : resolvedNpx;
    spawnArgs = [...parts.slice(1), ...effectiveAcpArgs];
  } else if (isWindows) {
    // Windows shell parsing breaks when shell:true is combined with an absolute
    // executable path containing spaces (e.g. C:\Program Files\nodejs\npx.cmd).
    // Normalize absolute paths into PATH + bare command form before spawning.
    spawnCommand = createWindowsShellCommand(cliPath, env);
    spawnArgs = effectiveAcpArgs;
  } else {
    // Unix: simple command or path. If cliPath contains spaces (e.g., "goose acp"),
    // parse into command + inline args.
    const parts = cliPath.split(/\s+/);
    spawnCommand = parts[0];
    spawnArgs = [...parts.slice(1), ...effectiveAcpArgs];
  }

  const options: SpawnOptions = {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    shell: isWindows,
  };

  return {
    command: spawnCommand,
    args: spawnArgs,
    options,
  };
}

// ── Spawn result type ───────────────────────────────────────────────

export type SpawnResult = { child: ChildProcess; isDetached: boolean };

/** Return type for npx backend prepare functions (prepareClaude, prepareCodex, prepareCodebuddy). */
export type NpxPrepareResult = {
  cleanEnv: Record<string, string | undefined>;
  npxCommand: string;
  extraArgs?: string[];
};

// ── Backend-specific connectors ─────────────────────────────────────

/**
 * Spawn an npx-based ACP backend package.
 * Used by Claude, Codex, and CodeBuddy connectors.
 */
export async function spawnNpxBackend(
  backend: string,
  npxPackage: string,
  npxCommand: string,
  cleanEnv: Record<string, string | undefined>,
  workingDir: string,
  isWindows: boolean,
  preferOffline: boolean,
  { extraArgs = [], detached = false }: { extraArgs?: string[]; detached?: boolean } = {}
): Promise<SpawnResult> {
  const spawnStart = Date.now();

  let command: string;
  let spawnArgs: string[];
  let shell = isWindows;

  if (isWindows) {
    const shimPath = await installWindowsNpxBridge(backend, npxPackage, npxCommand, cleanEnv, preferOffline);
    command = createWindowsShellCommand(shimPath, cleanEnv);
    spawnArgs = extraArgs;
  } else {
    command = npxCommand;
    spawnArgs = ['--yes', ...(preferOffline ? ['--prefer-offline'] : []), npxPackage, ...extraArgs];
  }

  const child = spawn(command, spawnArgs, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanEnv,
    shell,
    detached,
    windowsHide: isWindows,
  });
  // Prevent the detached child from keeping the parent alive when the parent wants to exit normally.
  if (detached) {
    child.unref();
  }
  if (ACP_PERF_LOG) {
    console.log(`[ACP-PERF] ${backend}: process spawned ${Date.now() - spawnStart}ms (preferOffline=${preferOffline})`);
  }

  return { child, isDetached: detached };
}

/** Prepare clean env + resolve npx for Claude ACP bridge. */
function prepareClaude(): NpxPrepareResult {
  const cleanEnv = prepareCleanEnv();
  ensureMinNodeVersion(cleanEnv, 20, 10, 'Claude ACP bridge');
  return { cleanEnv, npxCommand: resolveNpxPath(cleanEnv) };
}

/** Prepare clean env + resolve npx + run diagnostics for Codex ACP bridge. */
async function prepareCodex(): Promise<NpxPrepareResult> {
  const cleanEnv = prepareCleanEnv();
  ensureMinNodeVersion(cleanEnv, 20, 10, 'Codex ACP bridge');

  const codexCommand = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const codexExecOptions = {
    env: cleanEnv,
    timeout: 5000,
    windowsHide: true,
    ...getWindowsShellExecutionOptions(),
  };
  const diagnostics: {
    bridgeVersion: string;
    bridgePackage: string;
    codexCliVersion: string;
    loginStatus: string;
    hasCodexApiKey: boolean;
    hasOpenAiApiKey: boolean;
    hasChatGptSession: boolean;
  } = {
    bridgeVersion: CODEX_ACP_BRIDGE_VERSION,
    bridgePackage: CODEX_ACP_NPX_PACKAGE,
    codexCliVersion: 'unknown',
    loginStatus: 'unknown',
    hasCodexApiKey: Boolean(cleanEnv.CODEX_API_KEY),
    hasOpenAiApiKey: Boolean(cleanEnv.OPENAI_API_KEY),
    hasChatGptSession: false,
  };

  try {
    const { stdout } = await execFile(codexCommand, ['--version'], codexExecOptions);
    diagnostics.codexCliVersion = stdout.trim() || diagnostics.codexCliVersion;
  } catch (error) {
    mainWarn('[ACP codex]', 'Failed to read codex CLI version', error);
  }

  try {
    const { stdout } = await execFile(codexCommand, ['login', 'status'], codexExecOptions);
    diagnostics.loginStatus = stdout.trim() || diagnostics.loginStatus;
    diagnostics.hasChatGptSession = /chatgpt/i.test(diagnostics.loginStatus);
  } catch (error) {
    mainWarn('[ACP codex]', 'Failed to read codex login status', error);
  }

  mainLog('[ACP codex]', 'Runtime diagnostics', diagnostics);
  return { cleanEnv, npxCommand: resolveNpxPath(cleanEnv) };
}

/** Prepare clean env + resolve npx + load MCP config for CodeBuddy. */
async function prepareCodebuddy(): Promise<NpxPrepareResult> {
  const cleanEnv = prepareCleanEnv();
  ensureMinNodeVersion(cleanEnv, 20, 10, 'CodeBuddy ACP');

  // Load user's MCP config if available (~/.codebuddy/mcp.json)
  // CodeBuddy CLI in --acp mode does not auto-load mcp.json, so we pass it explicitly
  const mcpConfigPath = path.join(os.homedir(), '.codebuddy', 'mcp.json');
  const extraArgs: string[] = [];
  try {
    await fs.access(mcpConfigPath);
    extraArgs.push('--mcp-config', mcpConfigPath);
    mainLog('[ACP]', `Loading CodeBuddy MCP config from ${mcpConfigPath}`);
  } catch {
    mainWarn('[ACP]', 'No CodeBuddy MCP config found, starting without MCP servers');
  }

  return { cleanEnv, npxCommand: resolveNpxPath(cleanEnv), extraArgs };
}

/**
 * Spawn a generic ACP backend with clean env and Node version check.
 * Many generic backends are Node.js CLIs (#!/usr/bin/env node) that break
 * when Electron's inherited env resolves to an old Node version.
 * Safe for native binaries too — they ignore NODE_OPTIONS and Node version checks.
 */
export async function spawnGenericBackend(
  backend: string,
  cliPath: string,
  workingDir: string,
  acpArgs?: string[],
  customEnv?: Record<string, string>
): Promise<SpawnResult> {
  try {
    await fs.mkdir(workingDir, { recursive: true });
  } catch {
    // best-effort: if mkdir fails, let spawn report the actual error
  }

  const cleanEnv = prepareCleanEnv();
  if (customEnv) {
    Object.assign(cleanEnv, customEnv);
  }
  ensureMinNodeVersion(cleanEnv, 18, 17, `${backend} ACP`);

  const spawnStart = Date.now();
  const config = createGenericSpawnConfig(cliPath, workingDir, acpArgs, undefined, cleanEnv as Record<string, string>);
  const child = spawn(config.command, config.args, {
    ...config.options,
    windowsHide: process.platform === 'win32',
  });
  if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: ${backend} process spawned ${Date.now() - spawnStart}ms`);

  return { child, isDetached: false };
}

/** Callbacks for wiring a spawned child into the AcpConnection instance. */
export type NpxConnectHooks = {
  /** Wire the spawned child into the connection (e.g. attach protocol handlers). */
  setup: (result: SpawnResult) => Promise<void>;
  /** Terminate a failed Phase-1 child before retrying. */
  cleanup: () => Promise<void>;
};

/**
 * Connect to an npx-based ACP backend with Phase 1/2 retry strategy.
 * Phase 1: --prefer-offline for fast startup (~1-2s).
 * Phase 2: fresh registry lookup on failure (~3-5s).
 */
async function connectNpxBackend(config: {
  backend: string;
  npxPackage: string;
  prepareFn: () => NpxPrepareResult | Promise<NpxPrepareResult>;
  workingDir: string;
  /** Wire the spawned child into the connection (e.g. attach protocol handlers). */
  setup: (result: SpawnResult) => Promise<void>;
  /** Terminate a failed Phase-1 child before retrying. */
  cleanup: () => Promise<void>;
  extraArgs?: string[];
  detached?: boolean;
}): Promise<void> {
  const { backend, npxPackage, prepareFn, workingDir, setup, cleanup } = config;

  const envStart = Date.now();
  const { cleanEnv, npxCommand, extraArgs: prepExtraArgs = [] } = await prepareFn();
  if (ACP_PERF_LOG) console.log(`[ACP-PERF] ${backend}: env prepared ${Date.now() - envStart}ms`);

  const isWindows = process.platform === 'win32';
  const opts = {
    extraArgs: [...(config.extraArgs ?? []), ...prepExtraArgs],
    detached: config.detached ?? false,
  };

  // Phase 1: Try with --prefer-offline for fast startup
  try {
    await setup(await spawnNpxBackend(backend, npxPackage, npxCommand, cleanEnv, workingDir, isWindows, true, opts));
  } catch (firstError) {
    // Phase 2: Retry without --prefer-offline to refresh stale cache
    console.warn(
      `[ACP] ${backend} --prefer-offline failed, retrying with fresh registry lookup:`,
      firstError instanceof Error ? firstError.message : String(firstError)
    );

    await cleanup();

    await setup(await spawnNpxBackend(backend, npxPackage, npxCommand, cleanEnv, workingDir, isWindows, false, opts));
  }
}

// ── Exported per-backend connect functions ───────────────────────────

/** Connect to Claude ACP bridge via npx. */
export function connectClaude(workingDir: string, hooks: NpxConnectHooks): Promise<void> {
  return connectNpxBackend({
    backend: 'claude',
    npxPackage: CLAUDE_ACP_NPX_PACKAGE,
    prepareFn: prepareClaude,
    workingDir,
    ...hooks,
  });
}

/** Connect to Codex ACP bridge via npx. */
export function connectCodex(workingDir: string, hooks: NpxConnectHooks): Promise<void> {
  return connectNpxBackend({
    backend: 'codex',
    npxPackage: CODEX_ACP_NPX_PACKAGE,
    prepareFn: prepareCodex,
    workingDir,
    ...hooks,
  });
}

/** Connect to CodeBuddy ACP via npx. */
export function connectCodebuddy(workingDir: string, hooks: NpxConnectHooks): Promise<void> {
  return connectNpxBackend({
    backend: 'codebuddy',
    npxPackage: CODEBUDDY_ACP_NPX_PACKAGE,
    prepareFn: prepareCodebuddy,
    workingDir,
    ...hooks,
    extraArgs: ['--acp'],
    detached: process.platform !== 'win32',
  });
}
