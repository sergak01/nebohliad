# Draws the app and tray icons into this folder: PNGs for the tray and window,
# and icon.ico (every size drawn separately, PNG-compressed entries) for the
# packaged .exe, installer and shortcuts. Run after changing the design:
#   powershell -File assets\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Returns the icon at $size px as PNG bytes.
function Draw-Icon([int]$size, [bool]$alert) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 32.0

  # Dark rounded square.
  $r = 7 * $s
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($size - 2 * $r - 1, 0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($size - 2 * $r - 1, $size - 2 * $r - 1, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc(0, $size - 2 * $r - 1, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 19, 24))), $path)

  # Radar: outer ring, inner ring, center dot, a sweep line.
  $amber = [System.Drawing.Color]::FromArgb(255, 245, 179, 1)
  $pen = New-Object System.Drawing.Pen $amber, ([Math]::Max(1.5, 2.2 * $s))
  $g.DrawEllipse($pen, 5 * $s, 5 * $s, 22 * $s, 22 * $s)
  $thin = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(170, 245, 179, 1)), ([Math]::Max(1, 1.4 * $s))
  $g.DrawEllipse($thin, 10.5 * $s, 10.5 * $s, 11 * $s, 11 * $s)
  $g.DrawLine($pen, 16 * $s, 16 * $s, 24 * $s, 9 * $s)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $amber), 13.5 * $s, 13.5 * $s, 5 * $s, 5 * $s)

  if ($alert) {
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 59, 48))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 19, 24))), 17 * $s, 0, 15 * $s, 15 * $s)
    $g.FillEllipse($red, 19 * $s, 2 * $s, 11 * $s, 11 * $s)
  }
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

function Save-Png([int]$size, [bool]$alert, [string]$file) {
  [System.IO.File]::WriteAllBytes((Join-Path $dir $file), (Draw-Icon $size $alert))
}

# ICO: 6-byte header, 16-byte directory entry per image, then the PNG data.
function Save-Ico([int[]]$sizes, [string]$file) {
  $images = @($sizes | ForEach-Object { ,(Draw-Icon $_ $false) })
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $out
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] } # 0 means 256
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($img in $images) { $w.Write($img) }
  $w.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path $dir $file), $out.ToArray())
}

Save-Png 16 $false 'tray.png'
Save-Png 32 $false 'tray@2x.png'
Save-Png 16 $true 'tray-alert.png'
Save-Png 32 $true 'tray-alert@2x.png'
Save-Png 256 $false 'icon.png'
# Viewer page as a home-screen app: Chrome wants 192 and 512 px icons.
Save-Png 192 $false 'icon-192.png'
Save-Png 512 $false 'icon-512.png'
Save-Ico @(16, 20, 24, 32, 40, 48, 64, 128, 256) 'icon.ico'
'icons written'
