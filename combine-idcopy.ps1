param(
  [string]$frontPath,
  [string]$backPath,
  [string]$outputPath
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(2480, 3508)
$gr = [System.Drawing.Graphics]::FromImage($bmp)
$gr.Clear([System.Drawing.Color]::White)
$gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Exact 86mm x 54mm ID Card size at 300 DPI on 2480x3508 A4 page
# 1mm = 11.81px (2480 / 210)
$cardW = 1016   # 86mm
$cardH = 638    # 54mm
$pageW = 2480   # 210mm
$pageH = 3508   # 297mm

$marginTop = 295  # 25mm top margin
$gap = 354        # 30mm gap between cards

$hasFront = [string]::IsNullOrEmpty($frontPath) -eq $false -and (Test-Path $frontPath)
$hasBack = [string]::IsNullOrEmpty($backPath) -eq $false -and (Test-Path $backPath)

if ($hasFront) {
  $frontImg = [System.Drawing.Image]::FromFile($frontPath)
  $fX = [int](($pageW - $cardW) / 2)
  $fY = $marginTop
  $gr.DrawImage($frontImg, $fX, $fY, $cardW, $cardH)
  $frontImg.Dispose()
}

if ($hasBack) {
  $backImg = [System.Drawing.Image]::FromFile($backPath)
  $bX = [int](($pageW - $cardW) / 2)
  $bY = if ($hasFront) { $marginTop + $cardH + $gap } else { $marginTop }
  $gr.DrawImage($backImg, $bX, $bY, $cardW, $cardH)
  $backImg.Dispose()
}

$gr.Dispose()
$bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
