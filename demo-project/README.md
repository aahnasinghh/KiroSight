# KiroSight demo project

A tiny, self-contained TypeScript project used to demonstrate KiroSight. It is deliberately imperfect:

- **One deliberate type error** in `src/cart.ts`, inside the function `formatReceiptLine`.
- **One deliberately failing test** in `tests/discount.test.ts`.

Everything else is correct. A failing test here is expected: it is the demo, not a problem with KiroSight.
Nothing in this project calls the network, uses randomness or reads the clock, so results are the same on every run.

## What is in it

| File | Purpose |
|---|---|
| `src/cart.ts` | `calculateTotal` and `formatReceiptLine` (holds the type error) |
| `src/discount.ts` | `applyDiscount` and `loyaltyPrice`. Its name is unique, so "Open discount.ts" is unambiguous |
| `tests/cart.test.ts` | 3 passing tests |
| `tests/discount.test.ts` | 3 passing tests and 1 deliberately failing test |
| `.vscode/settings.json` | Sets `kirosight.testCommand` to `npm test` for this folder |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Exactly pinned `typescript` 7.0.2 and `vitest` 5.0.3. Single-run Vitest, no watch mode |

## The deliberate type error

In `src/cart.ts`, `formatReceiptLine` declares `const label: string = lineTotal;`, but `lineTotal` is a number.
TypeScript reports `Type 'number' is not assignable to type 'string'` (TS2322) on that line, one error in total.
It is easy to explain out loud: a number was put into a variable declared as text. It does not change how the program runs.

## The deliberate failing test

`loyaltyPrice(995)` takes ten percent off 995 cents, which is 895.5. `applyDiscount` rounds down to 895, but the test
expects the nearest cent, 896. Expected result of a full run: **6 passed, 1 failed** (7 tests, 2 files).

## Setup (once)

1. Open **this folder** (`demo-project`) as the workspace folder in the KiroSight Extension Development Host
   (File, Open Folder). Do not open it as part of a multi-root workspace: KiroSight runs the test command in the first
   workspace folder, and it must be this one.
2. **Trust the workspace.** `kirosight.testCommand` is a restricted setting, so Kiro ignores it in an untrusted
   workspace and KiroSight will say that no test command is configured. Choose "Yes, I trust the authors" when asked, or
   use Manage Workspace Trust. Do not turn workspace security off. Only trust this folder if you have read
   `.vscode/settings.json`: it contains one command, `npm test`.
3. Install the pinned dependencies once, from this folder (see "Install" below).
4. Open `src/cart.ts` in the editor. The TypeScript service reports problems for open files, so the error shows up in
   the Problems list once the file is open.

### Install

```powershell
Set-Location "<path to KiroSight>\demo-project"
npm.cmd install
```

This creates `package-lock.json` (commit it so the versions stay pinned) and `node_modules/` (ignored by Git).

### Check it without KiroSight

```powershell
npm.cmd run typecheck   # expect exactly one error: src/cart.ts, TS2322
npm.cmd test            # expect 1 failed | 6 passed (7), and a non-zero exit code
```

## Demo scenarios (typed or spoken)

KiroSight handles these with its existing commands. Spoken versions are the same words.

| Say or type | Expected |
|---|---|
| "What errors are there?" | One error: the file `cart.ts`, its line, the message about `number` and `string`, and the enclosing function when the editor can name it |
| "Next error." | The cursor moves to that error |
| "Explain this error." | A grounded explanation **when Amazon Bedrock is available**. Without it, KiroSight states that the explanation could not be generated and the local commands keep working |
| "Open discount.ts." | Opens `src/discount.ts` (the only file with that name) |
| "Run my tests." | A confirmation prompt that names the exact command, `npm test`. Nothing runs yet |
| "Repeat." | The same prompt again; still nothing runs |
| "Decline." | The request is discarded; nothing runs |
| "Run my tests." then "Confirm." | The tests run once. Expect 1 failed and 6 passed, naming the failing test |
| "Summarize the test failures." | The stored result again, with the failing test's name. A written failure summary needs Bedrock |

## Known limits

- The enclosing function name depends on the editor's symbol provider. In Kiro it may be unavailable (Spike B), in which
  case KiroSight reports the file and line plus a short excerpt instead of a name.
- Problems are reported for files the TypeScript service has open. Open `src/cart.ts` first.
- Until `npm install` has run, the test files report "Cannot find module 'vitest'". That is expected before installing.
- Do not run the main KiroSight extension tests from this folder. `npm test` here runs only this project's tests.
