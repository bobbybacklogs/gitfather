/**
 * Every error gitfather shows the user on purpose is a GitfatherError.
 * Anything else is a bug and gets the stack trace treatment.
 */
export interface GitfatherErrorOptions {
  /** A second line telling the user what to do about it. */
  hint?: string;
  exitCode?: number;
}

export class GitfatherError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, options: GitfatherErrorOptions = {}) {
    super(message);
    this.name = 'GitfatherError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}
