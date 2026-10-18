# Creates a self-signed code-signing certificate for Nebohliad builds (once).
#
# - The certificate (CN=Serhii Shpak, Code Signing usage only) goes into the
#   current user's personal store (Cert:\CurrentUser\My).
# - A .pfx copy (private key) and a .cer (public part, for trusting) are
#   written to %USERPROFILE%\.nebohliad-signing, outside the repository.
# - The .pfx password is random and stored encrypted with Windows DPAPI, so
#   only this Windows account on this PC can read it.
#
# Trusting the certificate (so Windows shows "Serhii Shpak" as a verified
# publisher) is a separate, manual step: import the .cer into
# Cert:\CurrentUser\Root and Cert:\CurrentUser\TrustedPublisher yourself.
#
# Usage: powershell -NoProfile -File scripts\make-signing-cert.ps1

$ErrorActionPreference = 'Stop'
$subject = 'CN=Serhii Shpak'
$dir = Join-Path $env:USERPROFILE '.nebohliad-signing'
$pfx = Join-Path $dir 'nebohliad-codesign.pfx'
$cer = Join-Path $dir 'nebohliad-codesign.cer'
$passwordFile = Join-Path $dir 'pfx-password.dpapi'

if (Test-Path $pfx) {
  "Already exists: $pfx (delete the folder to create a new certificate)"
  exit 0
}
New-Item -ItemType Directory -Force $dir | Out-Null

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -FriendlyName 'Nebohliad code signing (self-signed)' `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(5)

# Random 32-character password, kept only DPAPI-encrypted.
$chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$secure | ConvertFrom-SecureString | Set-Content -Path $passwordFile -Encoding ASCII

Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null

# Only the current user may read the folder.
icacls $dir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null

"Created certificate $($cert.Thumbprint) ($subject), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
"Files: $dir"
