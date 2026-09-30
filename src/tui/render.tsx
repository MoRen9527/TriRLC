// ── Ink TUI bootstrap (自研 fork 渲染 + CC input pipeline) ──
// P10: CC terminal input layer replaces npm ink's stdin/useInput.
// Rendering components (Box, Text, render) 走 src/tui/fork.js barrel（自研
// src/tui/ink/ 引擎；npm ink 依赖已撤，batch-03 件 2 V3 裁条）。
// Stdin is managed by InputPipeline; the fork receives a shim stdin.
import React from 'react';
import { render } from './fork.js';
import App from './app.js';
import { ThemeProvider } from './design-system/theme.js';
import { InputPipeline } from './termio/InputPipeline.js';
import { InputContext } from './termio/InputContext.js';
import { createStdinShim } from './termio/stdin-shim.js';

// ── P10 feature flag ──
// Set to true to use CC InputPipeline instead of npm ink stdin management.
const USE_CC_INPUT = true;

const SIGINT_RESET_MS = 1000;

export interface TUIResumeOptions {
  sessionId?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  // REQ-013: onboarding persona etc. — carried on auto-resume (cli.ts)
  systemPrompt?: string;
}

export async function startTUI(resume?: TUIResumeOptions): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> {
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>(r => { exitResolve = r; });

  const abortRef: React.MutableRefObject<(() => void) | null> = { current: null };
  const ctrlCRef: React.MutableRefObject<(() => void) | null> = { current: null };

  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;

  const handleSigint = () => {
    if (ctrlCRef.current) {
      ctrlCRef.current();
      return;
    }
    if (abortRef.current) {
      sigintCount++;
      if (sigintCount === 1) {
        abortRef.current();
        if (sigintTimer) clearTimeout(sigintTimer);
        sigintTimer = setTimeout(() => { sigintCount = 0; }, SIGINT_RESET_MS);
        return;
      }
    }
    exitResolve?.();
    process.exit(0);
  };

  process.on('SIGINT', handleSigint);

  // ── P10: CC InputPipeline ──
  let pipeline: InputPipeline | null = null;
  let rawModeCount = 0;

  const setRawMode = (enabled: boolean) => {
    if (!pipeline) return;
    if (enabled) {
      if (rawModeCount === 0) pipeline.start();
      rawModeCount++;
    } else {
      if (--rawModeCount === 0) pipeline.stop();
    }
  };

  if (USE_CC_INPUT && process.stdin.isTTY) {
    pipeline = new InputPipeline(process.stdin);
  }


  // Determine stdin: CC mode uses a shim so npm ink doesn't touch real stdin;
  // otherwise pass the real stdin for npm ink's native handling.
  const inkStdin = USE_CC_INPUT && pipeline
    ? createStdinShim()
    : process.stdin;

  const appElement = React.createElement(ThemeProvider, null,
    React.createElement(App, { onAbortRef: abortRef, onCtrlCRef: ctrlCRef, resume })
  );

  // Wrap with InputContext when using CC input pipeline
  const wrappedElement = pipeline
    ? React.createElement(InputContext.Provider, {
        value: {
          setRawMode,
          internal_eventEmitter: pipeline.emitter,
        }
      }, appElement)
    : appElement;

  const { unmount, waitUntilExit: inkWait } = await render(wrappedElement, {
    stdin: inkStdin as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    unmount: () => {
      process.off('SIGINT', handleSigint);
      // dispose() drops all 'input' subscriptions + timers (full teardown).
      // stop() alone would be wrong here: stop() is also driven by the
      // raw-mode refcount and must NOT remove listeners (REQ-014).
      pipeline?.dispose();
      unmount();
    },
    waitUntilExit: () => Promise.race([inkWait(), exitPromise]),
  };
}
