import { z } from 'zod';

import { ALLOWLIST, type Risk } from './allowlist';
import type { Action, Severity } from './actionTypes';

export type ValidationResult =
  | { ok: true; action: Action; risk: Risk }
  | { ok: false; code: 'UNKNOWN_ACTION' | 'INVALID_PARAMS'; message: string };

/**
 * Extension-side finite safety limit for the OPEN_FILE `path` parameter.
 * The approved design requires `path` to be length-capped but does not
 * prescribe a numeric value, so this number is an implementation choice,
 * not a spec-defined bound.
 */
export const MAX_ACTION_PATH_CHARS = 256;

const severitySchema = z.enum(['error', 'warning', 'any'] satisfies [Severity, ...Severity[]]);
const indexSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const lineSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const pathSchema = z.string()
  .min(1)
  .max(MAX_ACTION_PATH_CHARS)
  .refine((value) => !value.includes('\u0000'));

const actionSchemas = {
  NO_ACTION: z.object({ type: z.literal('NO_ACTION') }).strict(),
  GO_TO_DIAGNOSTIC: z.object({
    type: z.literal('GO_TO_DIAGNOSTIC'),
    index: indexSchema,
    severity: severitySchema.optional(),
  }).strict(),
  NEXT_DIAGNOSTIC: z.object({
    type: z.literal('NEXT_DIAGNOSTIC'),
    severity: severitySchema.optional(),
  }).strict(),
  PREVIOUS_DIAGNOSTIC: z.object({
    type: z.literal('PREVIOUS_DIAGNOSTIC'),
    severity: severitySchema.optional(),
  }).strict(),
  OPEN_FILE: z.object({
    type: z.literal('OPEN_FILE'),
    path: pathSchema,
  }).strict(),
  GO_TO_LINE: z.object({
    type: z.literal('GO_TO_LINE'),
    line: lineSchema,
  }).strict(),
  FOCUS_EDITOR: z.object({ type: z.literal('FOCUS_EDITOR') }).strict(),
  RUN_TESTS: z.object({ type: z.literal('RUN_TESTS') }).strict(),
} as const;

type ActionType = keyof typeof actionSchemas;

function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(actionSchemas, value);
}

export function validateAction(raw: unknown, origin: 'local' | 'agent'): ValidationResult {
  void origin;

  if (typeof raw !== 'object' || raw === null || !isActionType((raw as { type?: unknown }).type)) {
    return {
      ok: false,
      code: 'UNKNOWN_ACTION',
      message: 'Unknown action type.',
    };
  }

  const type = (raw as { type: ActionType }).type;
  const parsed = actionSchemas[type].safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: 'Action parameters are invalid.',
    };
  }

  const action = parsed.data as Action;
  return { ok: true, action, risk: ALLOWLIST[type].risk };
}
