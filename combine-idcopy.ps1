param(
  [string]$frontPath,
  [string]$backPath,
  [string]$outputPath
)
Add-Type -AssemblyName System.Drawing

# Use standard 300 DPI for fast crisp print quality (prevents slow processing)
$dpi   = 300
$pageW = [int](210 * $dpi / 25.4)   # 2480
$pageH = [int](297 * $dpi / 25.4)   # 3508

$bmp = New-Object System.Drawing.Bitmap($pageW, $pageH)
$bmp.SetResolution($dpi, $dpi)   # Embed 300 DPI metadata

$gr = [System.Drawing.Graphics]::FromImage($bmp)
$gr.Clear([System.Drawing.Color]::White)

# High quality 300 DPI rendering
$gr.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gr.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gr.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gr.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

# Exact 86mm x 54mm ID Card at 600 DPI
# 1mm = 600/25.4 = 23.62 px
$mmToPx = $dpi / 25.4
$cardW = [int](86 * $mmToPx)    # ~2031 px
$cardH = [int](54 * $mmToPx)    # ~1275 px

$marginTopMm = 25
$gapMm       = 30
$marginTop = [int]($marginTopMm * $mmToPx)
$gap       = [int]($gapMm * $mmToPx)

$hasFront = [string]::IsNullOrEmpty($frontPath) -eq $false -and (Test-Path $frontPath)
$hasBack  = [string]::IsNullOrEmpty($backPath)  -eq $false -and (Test-Path $backPath)

if ($hasFront) {
  $frontStream = [System.IO.File]::OpenRead($frontPath)
  $frontImg    = [System.Drawing.Image]::FromStream($frontStream)
  $fX = [int](($pageW - $cardW) / 2)
  $fY = $marginTop
  $destF = New-Object System.Drawing.RectangleF($fX, $fY, $cardW, $cardH)
  $srcF  = New-Object System.Drawing.RectangleF(0, 0, $frontImg.Width, $frontImg.Height)
  $gr.DrawImage($frontImg, $destF, $srcF, [System.Drawing.GraphicsUnit]::Pixel)
  $frontImg.Dispose()
  $frontStream.Close()
}

if ($hasBack) {
  $backStream = [System.IO.File]::OpenRead($backPath)
  $backImg    = [System.Drawing.Image]::FromStream($backStream)
  $bX = [int](($pageW - $cardW) / 2)
  $bY = if ($hasFront) { $marginTop + $cardH + $gap } else { $marginTop }
  $destB = New-Object System.Drawing.RectangleF($bX, $bY, $cardW, $cardH)
  $srcB  = New-Object System.Drawing.RectangleF(0, 0, $backImg.Width, $backImg.Height)
  $gr.DrawImage($backImg, $destB, $srcB, [System.Drawing.GraphicsUnit]::Pixel)
  $backImg.Dispose()
  $backStream.Close()
}

$gr.Dispose()

# Save as PNG (lossless) — no quality loss
$bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Saved combined ID copy at $dpi DPI: $outputPath"
