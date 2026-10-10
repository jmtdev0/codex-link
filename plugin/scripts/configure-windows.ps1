# Configure Codex Link for the current Windows user without putting secrets in
# command-line arguments, project files, or terminal output.
$ErrorActionPreference = "Stop"

$relayUrl = Read-Host "Private Codex Link Site URL (use the exact URL returned after deployment)"
if ([string]::IsNullOrWhiteSpace($relayUrl)) {
    throw "No deployed relay URL was provided. Publish the Site first, then enter its exact HTTPS origin."
}

[Uri]$parsedUrl = $null
if (-not [Uri]::TryCreate($relayUrl, [UriKind]::Absolute, [ref]$parsedUrl)) {
    throw "Enter a valid absolute Site URL."
}
if (
    $parsedUrl.Scheme -ne "https" -or
    -not $parsedUrl.DnsSafeHost.EndsWith(".chatgpt.site", [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Fragment) -or
    $parsedUrl.AbsolutePath -ne "/"
) {
    throw "Use the HTTPS origin of the private *.chatgpt.site relay, without a path or credentials."
}

$appTokenSecure = $null
$sitesTokenSecure = $null
$appTokenPtr = [IntPtr]::Zero
$sitesTokenPtr = [IntPtr]::Zero
$appToken = $null
$sitesToken = $null
try {
    $appTokenSecure = Read-Host "Codex Link application access token" -AsSecureString
    $sitesTokenSecure = Read-Host "Sites private-service bypass token" -AsSecureString
    if ($appTokenSecure.Length -lt 32) { throw "The application token must contain at least 32 characters." }
    if ($sitesTokenSecure.Length -lt 32) { throw "The Sites token must contain at least 32 characters." }

    $appTokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($appTokenSecure)
    $sitesTokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sitesTokenSecure)
    $appToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($appTokenPtr).Trim()
    $sitesToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($sitesTokenPtr).Trim()
    if ($appToken.Length -lt 32) { throw "The application token must contain at least 32 non-space characters." }
    if ($sitesToken.Length -lt 32) { throw "The Sites token must contain at least 32 non-space characters." }

    [Environment]::SetEnvironmentVariable("CODEX_LINK_RELAY_URL", $relayUrl.TrimEnd("/"), "User")
    [Environment]::SetEnvironmentVariable("CODEX_LINK_ACCESS_TOKEN", $appToken, "User")
    [Environment]::SetEnvironmentVariable("CODEX_LINK_SITES_BYPASS_TOKEN", $sitesToken, "User")
    [Environment]::SetEnvironmentVariable("CODEX_LINK_SITES_ALLOWED_ORIGIN", $parsedUrl.GetLeftPart([UriPartial]::Authority), "User")
}
finally {
    if ($appTokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($appTokenPtr) }
    if ($sitesTokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($sitesTokenPtr) }
    if ($appTokenSecure) { $appTokenSecure.Dispose() }
    if ($sitesTokenSecure) { $sitesTokenSecure.Dispose() }
    $appToken = $null
    $sitesToken = $null
}

Write-Host "Codex Link variables saved for the current Windows user. Restart Codex to load them."
Write-Host "Windows stores user environment values outside the project; anyone running as this user can read them."
