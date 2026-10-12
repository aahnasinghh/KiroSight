// Spike C fixture: an executed process that prints the cmd.exe missing-command wording itself.
process.stderr.write("'fake_tool' is not recognized as an internal or external command,\noperable program or batch file.\n");
process.exitCode = 1;
