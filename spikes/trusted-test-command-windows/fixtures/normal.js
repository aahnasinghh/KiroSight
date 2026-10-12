// Spike C fixture A: deterministic stdout, stderr and non-zero exit code.
process.stdout.write('KIROSIGHT_STDOUT_OK\n');
process.stderr.write('KIROSIGHT_STDERR_OK\n');
process.exitCode = 7;
