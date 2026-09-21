param(
  [string]$Url = 'https://uat1-oc.iviscloud.net/'
)
$ErrorActionPreference = 'Stop'
$credentialsPath = Join-Path $PSScriptRoot 'credentials.local.json'
$credentials = if (Test-Path $credentialsPath) {
  Get-Content -Raw $credentialsPath | ConvertFrom-Json
} else {
  $null
}
$username = $credentials.username
$password = $credentials.password
if ([string]::IsNullOrWhiteSpace($username)) {
  $username = Read-Host 'Operator username or email'
}
if ([string]::IsNullOrWhiteSpace($username)) {
  throw 'Operator username or email is required.'
}
if ([string]::IsNullOrWhiteSpace($password)) {
  $securePassword = Read-Host 'Operator password' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
$oldUsername = $env:OC_USERNAME
$oldPassword = $env:OC_PASSWORD
$oldBaseUrl = $env:BASE_URL
Push-Location $PSScriptRoot
try {
  $env:OC_USERNAME = $username.Trim()
  $env:OC_PASSWORD = $password
  $env:BASE_URL = $Url
  & npm.cmd run test:l1
  $testExitCode = $LASTEXITCODE
} finally {
  if ($pointer) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  $env:OC_USERNAME = $oldUsername
  $env:OC_PASSWORD = $oldPassword
  $env:BASE_URL = $oldBaseUrl
  Pop-Location
}
exit $testExitCode
