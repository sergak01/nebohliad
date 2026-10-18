# Builds Nebohliad and signs it with the self-signed certificate made by
# scripts\make-signing-cert.ps1. electron-builder reads the certificate from
# WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD; they are set for this build only.
#
# Usage: npm run dist:signed

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.nebohliad-signing'
$pfx = Join-Path $dir 'nebohliad-codesign.pfx'
$passwordFile = Join-Path $dir 'pfx-password.dpapi'
if (-not (Test-Path $pfx)) { throw "No certificate at $pfx. Run scripts\make-signing-cert.ps1 first." }

$secure = Get-Content $passwordFile | ConvertTo-SecureString
$env:WIN_CSC_LINK = $pfx
$env:WIN_CSC_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
try {
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
} finally {
  Remove-Item Env:WIN_CSC_LINK, Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# Report what got signed and whether Windows trusts it yet.
$root = Split-Path -Parent $PSScriptRoot
$files = @(Get-ChildItem (Join-Path $root 'dist') -Filter *.exe) + @(Get-Item (Join-Path $root 'dist\win-unpacked\Nebohliad.exe'))
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature $f.FullName
  "{0,-34} signer: {1,-16} status: {2}" -f $f.Name, ($sig.SignerCertificate.Subject -replace '^CN=', ''), $sig.Status
}
