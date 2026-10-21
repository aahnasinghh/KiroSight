<#
.SYNOPSIS
  KiroSight demo pre-flight check (Windows PowerShell 5.1 or later).

.DESCRIPTION
  Checks that the machine is ready for the KiroSight demo in docs/demo-script.md.

  Every result starts with a text label (PASS, FAIL, WARN or INFO) and one of three areas, so the
  output reads the same in a screen reader as on screen:
    OFFLINE  local files and tools only. No network, no backend. Typed local commands depend on these.
    BACKEND  the local KiroSight backend process on 127.0.0.1 (GET /health only).
    LIVE     depends on Deepgram, Amazon Bedrock, a microphone or the network. A LIVE problem is only
             ever a WARN: the typed, local demo still works without it.

  This script never prints the value of any environment variable or .env entry. It reports only
  whether a NAME is set. It makes no Bedrock or Deepgram request. Its only network use is a request
  to the local backend's /health on the loopback address, and an optional DNS-only lookup when
  -CheckNetwork is given.

  Credential files: by default the script checks the PowerShell PROCESS environment only and does
  not open backend\.env. The backend itself also reads backend\.env, so a name that is not in the
  process environment is reported as INFO (unknown), not as "not set". Add -InspectDotenv to let
  the script read backend\.env for the NAMES of entries that have a value. Values are never printed
  and are not kept past the line being examined. -OfflineOnly never opens backend\.env, even with
  -InspectDotenv.

  It runs the demo project's own typecheck and tests (local commands, no network) unless
  -SkipFixtureRun is given. Exit code 0 means no FAIL; 1 means at least one FAIL.

.PARAMETER OfflineOnly
  Skip the BACKEND and LIVE checks. Use this to prepare the offline-only version of the demo.

.PARAMETER SkipFixtureRun
  Do not run the demo project's typecheck and tests (the file checks still run).

.PARAMETER CheckNetwork
  Also resolve the Bedrock and Deepgram host names in DNS. No request is sent to either service.

.PARAMETER InspectDotenv
  Opt in to reading backend\.env for the names of entries that have a value. Off by default.
  Ignored with -OfflineOnly.

.PARAMETER Port
  Backend port for the /health check. Defaults to KIROSIGHT_PORT from the PowerShell process
  environment when it is a number, otherwise 8765. The script does not read KIROSIGHT_PORT from
  backend\.env, so if you set the port there (or anywhere the backend sees but this shell does
  not), pass the same number with -Port.

.PARAMETER PythonPath
  Python in the backend virtual environment.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1
#>
[CmdletBinding()]
param(
  [switch]$OfflineOnly,
  [switch]$SkipFixtureRun,
  [switch]$CheckNetwork,
  [switch]$InspectDotenv,
  [int]$Port = 0,
  [string]$PythonPath = (Join-Path $env:USERPROFILE '.venvs\KiroSight\Scripts\python.exe')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$demoRoot = Join-Path $repoRoot 'demo-project'
$extensionRoot = Join-Path $repoRoot 'extension'
$backendRoot = Join-Path $repoRoot 'backend'

# The exact command the demo fixture configures (see demo-project/README.md).
$expectedTestCommand = 'powershell.exe -NoProfile -Command "npm.cmd test"'

$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param([string]$Area, [string]$Status, [string]$Check, [string]$Detail = '')
  $results.Add([pscustomobject]@{ Area = $Area; Status = $Status; Check = $Check; Detail = $Detail })
  $line = '[{0}] {1}: {2}' -f $Status, $Area, $Check
  if ($Detail -ne '') { $line = $line + ' - ' + $Detail }
  $color = 'Gray'
  if ($Status -eq 'PASS') { $color = 'Green' }
  if ($Status -eq 'FAIL') { $color = 'Red' }
  if ($Status -eq 'WARN') { $color = 'Yellow' }
  Write-Host $line -ForegroundColor $color
}

function Invoke-Captured {
  param([string]$File, [string[]]$Arguments, [string]$WorkDir)
  $text = ''
  $code = -1
  Push-Location $WorkDir
  try {
    $lines = & $File @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    $text = ($lines -join "`n")
  } catch {
    $text = 'The command could not be started.'
  } finally {
    Pop-Location
  }
  $text = [regex]::Replace($text, '\x1B\[[0-9;]*[A-Za-z]', '')
  return [pscustomobject]@{ ExitCode = $code; Text = $text }
}

# Names of entries in a dotenv file that have a non-empty value. Only called after the explicit
# -InspectDotenv opt-in. Only the NAME is stored. The text after "=" is used for one yes/no test on
# the line being examined and is cleared before the next line; nothing is printed or returned.
function Get-DotenvSetNames {
  param([string]$Path)
  $names = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $Path)) { return ,$names }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') {
      $name = $Matches[1]
      $valueText = $line.Substring($Matches[0].Length).Trim().Trim('"').Trim("'").Trim()
      $hasValue = ($valueText -ne '') -and (-not $valueText.StartsWith('#'))
      $valueText = $null
      if ($hasValue) { $names.Add($name) }
      $Matches.Clear()
    }
    $line = $null
  }
  return ,$names
}

# backend\.env is opened only with -InspectDotenv, and never in -OfflineOnly mode.
$dotenvPath = Join-Path $backendRoot '.env'
$dotenvInspected = ($InspectDotenv.IsPresent -and -not $OfflineOnly.IsPresent)
$dotenvNames = @()
if ($dotenvInspected) { $dotenvNames = @(Get-DotenvSetNames -Path $dotenvPath) }

# Returns 'set', 'unset' or 'unknown'. A name that is not in the process environment is 'unknown'
# (not 'unset') while backend\.env has not been inspected, because the backend also reads that file.
function Get-NameState {
  param([string]$Name)
  $fromProcess = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrEmpty($fromProcess)) { return 'set' }
  if (-not $dotenvInspected) { return 'unknown' }
  if ($dotenvNames -contains $Name) { return 'set' }
  return 'unset'
}

Write-Host 'KiroSight demo pre-flight'
Write-Host ('Repository: ' + $repoRoot)
Write-Host 'No value of any environment variable or .env entry is printed by this script.'
Write-Host ''

# ---------------------------------------------------------------------------------------------
# OFFLINE: files, tools and the demo fixture
# ---------------------------------------------------------------------------------------------
foreach ($relative in @(
    'src\cart.ts', 'src\discount.ts', 'tests\cart.test.ts', 'tests\discount.test.ts',
    'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', '.vscode\settings.json')) {
  $full = Join-Path $demoRoot $relative
  if (Test-Path -LiteralPath $full) {
    Add-Result 'OFFLINE' 'PASS' ('demo-project\' + $relative + ' exists')
  } else {
    Add-Result 'OFFLINE' 'FAIL' ('demo-project\' + $relative + ' is missing') 'Restore the demo project (see the reset steps in docs/demo-script.md).'
  }
}

# kirosight.testCommand in the fixture's workspace settings.
$settingsPath = Join-Path $demoRoot '.vscode\settings.json'
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $configured = ''
    $property = $settings.PSObject.Properties['kirosight.testCommand']
    if ($null -ne $property) { $configured = [string]$property.Value }
    if ([string]::IsNullOrWhiteSpace($configured)) {
      Add-Result 'OFFLINE' 'FAIL' 'kirosight.testCommand is not configured in demo-project\.vscode\settings.json'
    } elseif ($configured -ne $expectedTestCommand) {
      # The configured text is deliberately not printed: a custom command could contain a secret.
      Add-Result 'OFFLINE' 'WARN' 'kirosight.testCommand is set but differs from the documented command (the configured value is not printed)' ('Documented command: ' + $expectedTestCommand)
    } else {
      Add-Result 'OFFLINE' 'PASS' 'kirosight.testCommand is configured and matches the documented command' $expectedTestCommand
    }
    $configured = $null
  } catch {
    Add-Result 'OFFLINE' 'FAIL' 'demo-project\.vscode\settings.json could not be read as JSON'
  }
}
Add-Result 'OFFLINE' 'INFO' 'Workspace trust' 'kirosight.testCommand is ignored in an untrusted workspace. Confirm in the Extension Development Host that the demo-project folder is trusted. This script cannot check it.'

# Tools.
if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
  Add-Result 'OFFLINE' 'PASS' 'powershell.exe is available (the test command uses it)'
} else {
  Add-Result 'OFFLINE' 'FAIL' 'powershell.exe was not found on PATH'
}
$npmAvailable = [bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)
if ($npmAvailable) {
  Add-Result 'OFFLINE' 'PASS' 'npm.cmd is available'
} else {
  Add-Result 'OFFLINE' 'FAIL' 'npm.cmd was not found on PATH'
}

if (Test-Path -LiteralPath (Join-Path $demoRoot 'node_modules\vitest')) {
  Add-Result 'OFFLINE' 'PASS' 'demo-project dependencies are installed (vitest found)'
} else {
  Add-Result 'OFFLINE' 'FAIL' 'demo-project dependencies are not installed' 'Run: Set-Location demo-project; npm.cmd install'
}

# Extension build output.
$extensionMain = ''
try {
  $manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw | ConvertFrom-Json
  $extensionMain = [string]$manifest.main
} catch {
  $extensionMain = ''
}
if ($extensionMain -ne '' -and (Test-Path -LiteralPath (Join-Path $extensionRoot $extensionMain))) {
  Add-Result 'OFFLINE' 'PASS' ('extension is compiled (' + $extensionMain + ' exists)')
} else {
  Add-Result 'OFFLINE' 'FAIL' 'extension is not compiled' 'Run: Set-Location extension; npm.cmd run compile'
}

# Fixture state: git cleanliness, typecheck, tests.
if (Get-Command git -ErrorAction SilentlyContinue) {
  $changes = Invoke-Captured 'git' @('status', '--porcelain', '--', 'demo-project') $repoRoot
  if ($changes.ExitCode -ne 0) {
    # A failed git command says nothing about the project, so it is never reported as clean.
    Add-Result 'OFFLINE' 'WARN' ('git status failed (exit code ' + $changes.ExitCode + '), so the demo project could not be compared with Git') 'Check that this folder is a Git repository, then run: git status --short -- demo-project'
  } elseif ($changes.Text.Trim() -eq '') {
    Add-Result 'OFFLINE' 'PASS' 'demo-project has no local changes against Git'
  } else {
    Add-Result 'OFFLINE' 'WARN' 'demo-project differs from Git (changed, new or untracked files)' 'If you did not mean to change it, reset it with the steps in docs/demo-script.md.'
  }
} else {
  Add-Result 'OFFLINE' 'INFO' 'git is not on PATH, so the demo project could not be compared with Git'
}

if ($SkipFixtureRun) {
  Add-Result 'OFFLINE' 'INFO' 'Typecheck and test run skipped (-SkipFixtureRun)'
} elseif (-not $npmAvailable) {
  Add-Result 'OFFLINE' 'WARN' 'Typecheck and test run skipped because npm.cmd is missing'
} elseif (-not (Test-Path -LiteralPath (Join-Path $demoRoot 'node_modules\vitest'))) {
  Add-Result 'OFFLINE' 'WARN' 'Typecheck and test run skipped because dependencies are not installed'
} else {
  # The fixture "builds" when TypeScript reports exactly the one known error and nothing else.
  $typecheck = Invoke-Captured 'npm.cmd' @('run', 'typecheck') $demoRoot
  $errorLines = @($typecheck.Text -split "`n" | Where-Object { $_ -match 'error TS\d+:' })
  if ($errorLines.Count -eq 1 -and $errorLines[0] -match 'cart\.ts' -and $errorLines[0] -match 'TS2322') {
    Add-Result 'OFFLINE' 'PASS' 'Typecheck reports exactly one error: TS2322 in src/cart.ts (the deliberate one)'
  } elseif ($errorLines.Count -eq 0) {
    Add-Result 'OFFLINE' 'FAIL' 'Typecheck reports no error, but the demo needs the deliberate TS2322 in src/cart.ts'
  } else {
    Add-Result 'OFFLINE' 'FAIL' ('Typecheck reported ' + $errorLines.Count + ' error line(s); expected exactly the one TS2322 in src/cart.ts')
  }

  # The exact documented command, run the way KiroSight runs it: through PowerShell, in the folder.
  $tests = Invoke-Captured 'powershell.exe' @('-NoProfile', '-Command', 'npm.cmd test') $demoRoot
  if ($tests.Text -match 'Tests\s+1 failed \| 6 passed \(7\)' -and $tests.ExitCode -ne 0) {
    Add-Result 'OFFLINE' 'PASS' 'Test command gives 1 failed and 6 passed (7), with a non-zero exit code, as the demo expects'
  } elseif ($tests.Text -match "Cannot read properties of undefined \(reading 'config'\)") {
    Add-Result 'OFFLINE' 'FAIL' 'Vitest failed to start (the known start-up error); no tests ran' 'Run the command from a normal terminal and see demo-project/README.md.'
  } else {
    Add-Result 'OFFLINE' 'FAIL' 'Test command did not give 1 failed and 6 passed (7)' ('Exit code ' + $tests.ExitCode)
  }
}

# ---------------------------------------------------------------------------------------------
# BACKEND: the local process
# ---------------------------------------------------------------------------------------------
if ($OfflineOnly) {
  Add-Result 'BACKEND' 'INFO' 'Skipped (-OfflineOnly). Typed local commands work without the backend.'
} else {
  if (Test-Path -LiteralPath $PythonPath) {
    Add-Result 'BACKEND' 'PASS' 'Backend virtual environment Python found'
  } else {
    Add-Result 'BACKEND' 'WARN' 'Backend virtual environment Python was not found' 'Pass -PythonPath, or create the environment and install backend\requirements.txt (see docs/env-vars.md).'
  }

  $effectivePort = 8765
  if ($Port -gt 0) {
    $effectivePort = $Port
  } else {
    $portFromEnv = [Environment]::GetEnvironmentVariable('KIROSIGHT_PORT')
    $parsedPort = 0
    if (-not [string]::IsNullOrEmpty($portFromEnv) -and [int]::TryParse($portFromEnv, [ref]$parsedPort) -and $parsedPort -gt 0) {
      $effectivePort = $parsedPort
    }
  }

  if ($Port -le 0 -and [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable('KIROSIGHT_PORT'))) {
    Add-Result 'BACKEND' 'INFO' ('Checking port ' + $effectivePort + ' (KIROSIGHT_PORT is not in the process environment)') 'If the backend uses another port, for example set in backend\.env, run this script again with -Port <number>.'
  }

  # Loopback only. This is a request to your own machine, not to any outside service.
  $healthUrl = 'http://127.0.0.1:' + $effectivePort + '/health'
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3
    if ($health.status -eq 'ok') {
      Add-Result 'BACKEND' 'PASS' ('GET /health on port ' + $effectivePort + ' returned status ok')
    } else {
      Add-Result 'BACKEND' 'FAIL' ('GET /health on port ' + $effectivePort + ' did not return status ok')
    }
  } catch {
    Add-Result 'BACKEND' 'FAIL' ('The backend did not answer GET /health on port ' + $effectivePort) 'Start it (see docs/demo-script.md), or use -OfflineOnly for the typed local demo.'
  }

  $tokenState = Get-NameState 'KIROSIGHT_AUTH_TOKEN'
  if ($tokenState -eq 'set') {
    Add-Result 'BACKEND' 'INFO' 'KIROSIGHT_AUTH_TOKEN is set' 'Run "KiroSight: Set Backend Token" in the Extension Development Host with the same token, or the handshake will be refused.'
  } elseif ($tokenState -eq 'unknown') {
    Add-Result 'BACKEND' 'INFO' 'KIROSIGHT_AUTH_TOKEN is not in the process environment; backend\.env was not inspected' 'If the backend uses a token, run "KiroSight: Set Backend Token" with the same one. Add -InspectDotenv to check by name.'
  }
}

# ---------------------------------------------------------------------------------------------
# LIVE: Deepgram, Amazon Bedrock, microphone, network. Names only; never values.
# ---------------------------------------------------------------------------------------------
if ($OfflineOnly) {
  Add-Result 'LIVE' 'INFO' 'Skipped (-OfflineOnly). Spoken input, spoken output and "explain this error" need live services.'
} else {
  if ($dotenvInspected) {
    Add-Result 'LIVE' 'INFO' 'backend\.env was inspected (-InspectDotenv); only the names of entries that have a value were read'
  } else {
    Add-Result 'LIVE' 'INFO' 'Only the PowerShell process environment was checked; backend\.env was not opened' 'The backend also reads backend\.env, so a name reported as unknown below may still be set there. Add -InspectDotenv to check by name, or read the panel status line.'
  }

  $deepgramState = Get-NameState 'DEEPGRAM_API_KEY'
  if ($deepgramState -eq 'set') {
    Add-Result 'LIVE' 'PASS' 'DEEPGRAM_API_KEY is set (speech recognition and speech output can be attempted)'
  } elseif ($deepgramState -eq 'unset') {
    Add-Result 'LIVE' 'WARN' 'DEEPGRAM_API_KEY is not set' 'Voice input and spoken output will be unavailable. Typed input still works.'
  } else {
    Add-Result 'LIVE' 'INFO' 'DEEPGRAM_API_KEY is unknown: not in the process environment, backend\.env not inspected' 'Read STT and TTS in the panel status line after the extension connects.'
  }

  # KIROSIGHT_LLM is a mode switch, not a secret, but its value is never printed: only a yes/no answer.
  # The value of a backend\.env entry is never kept, so a dotenv entry cannot be classified.
  $llmMode = [Environment]::GetEnvironmentVariable('KIROSIGHT_LLM')
  if (-not [string]::IsNullOrEmpty($llmMode)) {
    if ($llmMode.Trim().ToLowerInvariant() -eq 'bedrock') {
      Add-Result 'LIVE' 'PASS' 'KIROSIGHT_LLM selects Bedrock (process environment)'
    } else {
      Add-Result 'LIVE' 'WARN' 'KIROSIGHT_LLM in the process environment does not select Bedrock' 'The backend uses the offline stub: "explain this error" will not be a real explanation.'
    }
    $llmMode = $null
  } else {
    $llmState = Get-NameState 'KIROSIGHT_LLM'
    if ($llmState -eq 'set') {
      Add-Result 'LIVE' 'INFO' 'KIROSIGHT_LLM has a value in backend\.env; the script does not keep values, so it cannot tell whether it selects Bedrock' 'Read "Bedrock available" or "Bedrock unavailable" in the panel status line.'
    } elseif ($llmState -eq 'unset') {
      Add-Result 'LIVE' 'WARN' 'KIROSIGHT_LLM is not set' 'The backend uses the offline stub: "explain this error" will not be a real explanation.'
    } else {
      Add-Result 'LIVE' 'INFO' 'KIROSIGHT_LLM is unknown: not in the process environment, backend\.env not inspected' 'If it is not bedrock, the backend uses the offline stub.'
    }
  }

  $bearerState = Get-NameState 'AWS_BEARER_TOKEN_BEDROCK'
  $keyIdState = Get-NameState 'AWS_ACCESS_KEY_ID'
  $secretState = Get-NameState 'AWS_SECRET_ACCESS_KEY'
  if ($bearerState -eq 'set' -or ($keyIdState -eq 'set' -and $secretState -eq 'set')) {
    Add-Result 'LIVE' 'PASS' 'A Bedrock credential is configured by name (this does not prove quota or access)'
  } elseif ($bearerState -eq 'unknown' -or $keyIdState -eq 'unknown' -or $secretState -eq 'unknown') {
    Add-Result 'LIVE' 'INFO' 'Bedrock credential names are unknown: not all are in the process environment and backend\.env was not inspected' 'Read "Bedrock available" in the panel status line.'
  } else {
    Add-Result 'LIVE' 'WARN' 'No Bedrock credential names are set (AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY)' '"explain this error" will report that the reasoning service is unavailable.'
  }

  if ($CheckNetwork) {
    $region = [Environment]::GetEnvironmentVariable('AWS_REGION')
    if ([string]::IsNullOrEmpty($region)) { $region = [Environment]::GetEnvironmentVariable('AWS_DEFAULT_REGION') }
    if ([string]::IsNullOrEmpty($region) -or $region -notmatch '^[a-z0-9-]{3,30}$') { $region = 'us-east-1' }
    foreach ($hostName in @(('bedrock-runtime.' + $region + '.amazonaws.com'), 'api.deepgram.com')) {
      try {
        Resolve-DnsName -Name $hostName -ErrorAction Stop | Out-Null
        Add-Result 'LIVE' 'PASS' ('DNS resolves ' + $hostName + ' (no request was sent to it)')
      } catch {
        Add-Result 'LIVE' 'WARN' ('DNS could not resolve ' + $hostName) 'Check the network before a live demo.'
      }
    }
  } else {
    Add-Result 'LIVE' 'INFO' 'Network check skipped (add -CheckNetwork for a DNS-only lookup)'
  }

  Add-Result 'LIVE' 'INFO' 'Microphone, speech recognition, speech output and Bedrock access' 'Not checked by this script. After the extension connects, read the panel status line: "Backend: connected - Bedrock/STT/TTS available or unavailable - Mic available, unavailable or denied". Then do the live rehearsal in docs/demo-script.md.'
}

# ---------------------------------------------------------------------------------------------
Write-Host ''
$failures = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnings = @($results | Where-Object { $_.Status -eq 'WARN' }).Count
$passes = @($results | Where-Object { $_.Status -eq 'PASS' }).Count
Write-Host ('Summary: {0} passed, {1} warning(s), {2} failure(s).' -f $passes, $warnings, $failures)
if ($failures -gt 0) {
  Write-Host 'RESULT: NOT READY. Fix every FAIL before the demo.'
  exit 1
}
if ($warnings -gt 0) {
  Write-Host 'RESULT: READY for the parts without a WARN. Read each WARN and decide which live steps to skip.'
} else {
  Write-Host 'RESULT: READY. The live services still need the rehearsal in docs/demo-script.md.'
}
exit 0
