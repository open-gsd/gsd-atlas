export type Severity = 'error' | 'warning' | 'info';

/** A machine-readable problem report. `subject` names what it is about (usually a file path). */
export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly subject?: string;
}

export function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  subject?: string,
): Diagnostic {
  return subject === undefined
    ? { code, severity, message }
    : { code, severity, message, subject };
}
