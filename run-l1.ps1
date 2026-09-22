param(
  [string]$Url
)
$ErrorActionPreference = 'Stop'
$executionConfigPath = Join-Path $PSScriptRoot 'execution.config.json'
$executionConfig = if (Test-Path $executionConfigPath) {
  Get-Content -Raw $executionConfigPath | ConvertFrom-Json
} else {
  $null
}
$resolvedUrl = if (-not [string]::IsNullOrWhiteSpace($Url)) {
  $Url
} elseif ($executionConfig.url) {
  $executionConfig.url
} else {
  'https://uat1-oc.iviscloud.net/'
}
$username = $executionConfig.credentials.username
if ([string]::IsNullOrWhiteSpace($username)) {
  $username = Read-Host 'Operator username or email'
}
if ([string]::IsNullOrWhiteSpace($username)) {
  throw 'Operator username or email is required.'
}
$mobileNumber = $executionConfig.credentials.mobileNumber
if ([string]::IsNullOrWhiteSpace($mobileNumber)) {
  $mobileNumber = Read-Host 'Operator mobile number'
}
if ([string]::IsNullOrWhiteSpace($mobileNumber)) {
  throw 'Operator mobile number is required.'
}
$password = $executionConfig.credentials.password
if ([string]::IsNullOrWhiteSpace($password)) {
  $securePassword = Read-Host 'Operator password' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
if ([string]::IsNullOrWhiteSpace($password)) {
  throw 'Operator password is required.'
}
$oldUsername = $env:OC_USERNAME
$oldMobileNumber = $env:OC_MOBILE_NUMBER
$oldPassword = $env:OC_PASSWORD
$oldBaseUrl = $env:BASE_URL
Push-Location $PSScriptRoot
try {
  $env:OC_USERNAME = $username.Trim()
  $env:OC_MOBILE_NUMBER = $mobileNumber.Trim()
  $env:OC_PASSWORD = $password
  $env:BASE_URL = $resolvedUrl
  & npm.cmd run test:l1
  $testExitCode = $LASTEXITCODE
} finally {
  if ($pointer) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  $env:OC_USERNAME = $oldUsername
  $env:OC_MOBILE_NUMBER = $oldMobileNumber
  $env:OC_PASSWORD = $oldPassword
  $env:BASE_URL = $oldBaseUrl
  Pop-Location
}
exit $testExitCode
