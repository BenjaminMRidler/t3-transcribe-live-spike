# Runs node with OPENROUTER_API_KEY taken from the user environment (PO decision R1).
# The key is only placed in this child process environment; it is never printed or written.
if (-not $env:OPENROUTER_API_KEY) {
    $env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
}
& node @args
exit $LASTEXITCODE
