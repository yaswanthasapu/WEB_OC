param(
  [string]$Url
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'loadtest.execution.config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Load execution configuration was not found: $configPath"
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$resolvedUrl = if (-not [string]::IsNullOrWhiteSpace($Url)) { $Url } elseif ($config.url) { $config.url } else { 'https://uat1-oc.iviscloud.net/' }

$username = $config.credentials.username
if ([string]::IsNullOrWhiteSpace($username)) { $username = Read-Host 'Operator username or email' }
$mobileNumber = $config.credentials.mobileNumber
if ([string]::IsNullOrWhiteSpace($mobileNumber)) { $mobileNumber = Read-Host 'Operator mobile number' }
$password = $config.credentials.password
$passwordPointer = [IntPtr]::Zero
if ([string]::IsNullOrWhiteSpace($password)) {
  $securePassword = Read-Host 'Operator password' -AsSecureString
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
}
if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($mobileNumber) -or [string]::IsNullOrWhiteSpace($password)) {
  throw 'Username, mobile number, and password are required.'
}

$previous = @{
  OC_USERNAME = $env:OC_USERNAME
  OC_MOBILE_NUMBER = $env:OC_MOBILE_NUMBER
  OC_PASSWORD = $env:OC_PASSWORD
  BASE_URL = $env:BASE_URL
  PW_EXECUTION_CONFIG = $env:PW_EXECUTION_CONFIG
  PW_LOAD_TEST = $env:PW_LOAD_TEST
  LOAD_RUN_ID = $env:LOAD_RUN_ID
}

Push-Location $PSScriptRoot
try {
  $env:OC_USERNAME = $username.Trim()
  $env:OC_MOBILE_NUMBER = $mobileNumber.Trim()
  $env:OC_PASSWORD = $password
  $env:BASE_URL = $resolvedUrl
  $env:PW_EXECUTION_CONFIG = 'loadtest.execution.config.json'
  $env:PW_LOAD_TEST = '1'
  $env:LOAD_RUN_ID = [Guid]::NewGuid().ToString('N')
  & npm.cmd run test:load
  $testExitCode = $LASTEXITCODE
  if ($config.reports.crmDashboard -ne $false) {
    & npm.cmd run report:load
    $reportExitCode = $LASTEXITCODE
    if ($testExitCode -eq 0 -and $reportExitCode -ne 0) {
      $testExitCode = $reportExitCode
    }
    if ($reportExitCode -eq 0) {
      Write-Output "[LOAD] CRM dashboard: $(Join-Path $PSScriptRoot $config.reports.crmOutputFile)"
    }
  }
} finally {
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  foreach ($name in $previous.Keys) {
    if ($null -eq $previous[$name]) {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$name" -Value $previous[$name]
    }
  }
  Pop-Location
}
exit $testExitCode
