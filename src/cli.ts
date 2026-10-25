#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import { loadConfig, type GitfatherConfig } from './config.js';
import { formatCommitMessage } from './conventional.js';
import { GitfatherError } from './errors.js';
import { generateCommit } from './generate.js';
import { commit, hasStagedChanges, readRepoInfo, readStagedChanges } from './git.js';
import { prepareDiff, type DiffContext } from './prompt.js';
import { ModelHitchProvider } from './providers/modelhitch.js';
import { findSuspectedSecrets } from './secrets.js';
import * as ui from './ui.js';

interface CliOptions {
  dryRun?: boolean;
  yes?: boolean;
  plain?: boolean;
  allowSecrets?: boolean;
  model?: string;
  baseUrl?: string;
  maxDiffChars?: string;
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, '..', 'package.json'),
    path.join(here, '..', '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

function applyOverrides(config: GitfatherConfig, options: CliOptions): void {
  if (options.baseUrl) config.baseUrl = options.baseUrl;
  if (options.model) config.model = options.model;

  if (options.maxDiffChars !== undefined) {
    const value = Number(options.maxDiffChars);
    if (!Number.isInteger(value) || value <= 0) {
      throw new GitfatherError(
        `--max-diff-chars needs a positive whole number, not "${options.maxDiffChars}". The Don keeps tidy books.`,
      );
    }
    config.maxDiffChars = value;
  }
}

function refuseSuspectedSecrets(diff: string): void {
  const suspects = findSuspectedSecrets(diff);
  if (suspects.length === 0) return;

  process.stderr.write('\n');
  ui.warn('Credentials in the diff. The family does not share secrets with strangers.');
  for (const suspect of suspects) {
    ui.note(`${suspect.file}  (${suspect.kinds.join(', ')})`);
  }
  process.stderr.write('\n');

  throw new GitfatherError('Refusing to send credential-looking content to a model.', {
    hint: 'Remove them from the staged changes, or pass --allow-secrets if you insist on doing this the hard way.',
  });
}

async function runCommit(options: CliOptions): Promise<number> {
  ui.printBanner();

  const config = loadConfig();
  applyOverrides(config, options);

  ui.step('🚬 Reading the family\u2019s staged changes...');

  const cwd = process.cwd();
  const repo = await readRepoInfo(cwd);

  if (!(await hasStagedChanges(repo.root))) {
    throw new GitfatherError('No staged changes. Nothing to negotiate.', {
      hint: 'Stage something first: git add <files>, then run gitfather again.',
    });
  }

  const staged = await readStagedChanges(repo.root);

  if (!options.allowSecrets) refuseSuspectedSecrets(staged.diff);

  const prepared = prepareDiff(staged.diff, config.maxDiffChars);
  if (prepared.truncated) {
    ui.warn('Bigger than the table can review at once. The Don will only read part of it.');
  }

  const context: DiffContext = {
    branch: repo.branch,
    lastCommitSubject: repo.lastCommitSubject,
    files: staged.files,
    diff: prepared.text,
    truncated: prepared.truncated,
    omittedFiles: prepared.omittedFiles,
    omittedChars: prepared.omittedChars,
  };

  const provider = new ModelHitchProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });

  ui.step('🐈 Consulting the consigliere...');
  ui.step('🍷 Making the model an offer...');

  const generated = await generateCommit({
    provider,
    context,
    humor: options.plain ? 'plain' : 'godfather',
    maxSubjectLength: config.maxSubjectLength,
    model: config.model,
  });

  const message = formatCommitMessage(generated.parts);

  ui.step('');
  ui.success('✨ The message is written. Nothing personal.');
  ui.printPreview(message, generated.model);

  for (const warning of generated.warnings) ui.warn(warning);
  if (generated.warnings.length > 0) ui.step('');

  if (options.dryRun) {
    ui.note('--dry-run: nothing was committed. No hard feelings.');
    return 0;
  }

  if (!options.yes) {
    const confirmed = await ui.confirmCommit({
      question: 'Commit this?',
      stdinIsTty: Boolean(process.stdin.isTTY),
    });
    if (!confirmed) {
      ui.note('The offer was refused. Fine — but if these changes sit unread, don\u2019t come asking for help.');
      return 0;
    }
  }

  const summary = await commit(message, repo.root);
  ui.success(`🤝 ${summary || 'Done. The family thanks you.'}`);
  return 0;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('gitfather')
    .description(
      'Write a commit message from your staged diff. An offer your changes can\u2019t refuse.',
    )
    .version(readVersion(), '-v, --version', 'print the installed version')
    .option('--dry-run', 'print the message without creating a commit')
    .option('-y, --yes', 'commit without asking for confirmation')
    .option('--plain', 'professional message, no mob theatrics')
    .option('--model <id>', 'ModelHitch model to use, for example deepseek-v4-flash')
    .option('--base-url <url>', 'ModelHitch bridge base URL (default http://127.0.0.1:3939/v1)')
    .option('--max-diff-chars <n>', 'how much of the diff to send')
    .option('--allow-secrets', 'send the diff even when it looks like it holds credentials')
    .addHelpText(
      'after',
      [
        '',
        'Environment:',
        '  GITFATHER_BASE_URL or MODELHITCH_BASE_URL   bridge URL (default http://127.0.0.1:3939/v1)',
        '  GITFATHER_MODEL                             model id; unset lets ModelHitch rotate',
        '  GITFATHER_API_KEY                           only needed if the bridge requires one',
        '  GITFATHER_TIMEOUT_MS, GITFATHER_MAX_DIFF_CHARS, GITFATHER_MAX_SUBJECT_LENGTH',
        '',
        'Examples:',
        '  gitfather                    generate, preview, then ask before committing',
        '  gitfather --dry-run          look at the message only',
        '  gitfather --yes              commit straight away, no questions',
        '  gitfather --plain            keep it professional',
        '',
      ].join('\n'),
    )
    .action(async (options: CliOptions) => {
      process.exitCode = await runCommit(options);
    });

  return program;
}

async function main(): Promise<void> {
  await buildProgram().parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof GitfatherError) {
    ui.fail(error.message, error.hint);
    process.exit(error.exitCode);
  }

  ui.fail('Even the consigliere cannot explain what just happened.');
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`,
  );
  process.exit(1);
});
