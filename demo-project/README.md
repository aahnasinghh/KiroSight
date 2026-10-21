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
| `.vscode/settings.json` | Sets `kirosight.testCommand` to the Windows PowerShell wrapper explained below, for this folder |
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
   `.vscode/settings.json`: it contains one command, `powershell.exe -NoProfile -Command "npm.cmd test"` (see "Why the
   test command is a PowerShell wrapper" below).
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

## Why the test command is a PowerShell wrapper (Windows)

`.vscode/settings.json` sets `kirosight.testCommand` to:

```
powershell.exe -NoProfile -Command "npm.cmd test"
```

Plain `npm test` and `npm.cmd test` work in a normal terminal. When KiroSight started either of them directly inside the
Extension Development Host on the development machine, Vitest failed to start: both test files reported
`Cannot read properties of undefined (reading 'config')` and no test ran. The same command run through the PowerShell
wrapper works. The cause of the direct failure has **not** been found.

- **This is a demo-specific workaround.** It is not a fix, and it is not evidence of a general TestRunner problem or of a
  general repair. KiroSight's TestRunner is unchanged: it runs exactly the configured string, through the shell, in the
  workspace folder, and reports the real output and exit code.
- **Expected result: 6 passed, 1 failed** (7 tests in 2 files). The one failure is the deliberately failing test in
  `tests/discount.test.ts`, and it is the demo. A different failure, including the start-up error above (no tests run at
  all), is not the demo.
- **Windows only.** The wrapper needs `powershell.exe`. On macOS or Linux use `npm test` instead.
- **Workspace trust.** `kirosight.testCommand` is a restricted setting. In an untrusted workspace Kiro ignores it and
  KiroSight says no test command is configured. Trust this folder only after reading `.vscode/settings.json`.
- **Explicit confirmation.** KiroSight never runs the tests on its own. Asking to run tests produces a confirmation prompt
  that names the exact command, and nothing runs until you confirm. The wrapper adds no permission: it is still the one
  command the setting holds, and the confirmation step and the eight-action allow-list are unchanged.

## Demo scenarios (typed or spoken)

KiroSight handles these with its existing commands. Spoken versions are the same words.

| Say or type | Expected |
|---|---|
| "What errors are there?" | One error: the file `cart.ts`, its line, the message about `number` and `string`, and the enclosing function when the editor can name it |
| "Next error." | The cursor moves to that error |
| "Explain this error." | A grounded explanation **when Amazon Bedrock is available**. Without it, KiroSight states that the explanation could not be generated and the local commands keep working |
| "Open discount.ts." | Opens `src/discount.ts` (the only file with that name) |
| "Run my tests." | A confirmation prompt that names the exact configured command, `powershell.exe -NoProfile -Command "npm.cmd test"` (the quotes inside it are part of the command). Nothing runs yet |
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
- The configured test command is a Windows workaround (see the next section). On macOS or Linux `powershell.exe` is normally not installed: set `kirosight.testCommand` to `npm test` in this folder's `.vscode/settings.json` instead, and check it in a terminal first.
