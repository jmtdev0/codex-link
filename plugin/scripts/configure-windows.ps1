# The packaged plugin uses the public Codex Link relay by default.
# Run this only to override it with another HTTPS relay for this Windows user.
$ErrorActionPreference = "Stop"

$relayUrl = Read-Host "Custom HTTPS relay URL (leave blank to use the built-in Codex Link relay)"
if ([string]::IsNullOrWhiteSpace($relayUrl)) {
    Write-Host "No configuration needed. The plugin will use its built-in relay URL."
    exit 0
}

[Uri]$parsedUrl = $null
if (-not [Uri]::TryCreate($relayUrl, [UriKind]::Absolute, [ref]$parsedUrl)) {
    throw "Enter a valid absolute HTTPS URL."
}
if (
    $parsedUrl.Scheme -ne "https" -or
    -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Fragment)
) {
    throw "Use an HTTPS URL without embedded credentials, query parameters, or a fragment."
}

[Environment]::SetEnvironmentVariable("CODEX_LINK_RELAY_URL", $relayUrl.TrimEnd("/"), "User")
Write-Host "Custom relay URL saved for the current Windows user. Restart Codex to load it."
Write-Host "No global access token or Sites bypass token is required; room access comes from the invitation."
