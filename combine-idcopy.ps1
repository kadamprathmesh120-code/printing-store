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

# Card area: ~1016x638px at 300 DPI (86x54mm)
$cardW = 1016; $cardH = 638
$marginTop = 300  # ~25mm
$gap = 360        # ~30mm
$pageW = 2480

# Front
$frontImg = [System.Drawing.Image]::FromFile($frontPath)
$fRatio = [double]$frontImg.Width / $frontImg.Height
$cRatio = [double]$cardW / $cardH
if ($fRatio -gt $cRatio) {
  $fW = $cardW; $fH = [int]($cardW / $fRatio)
} else {
  $fH = $cardH; $fW = [int]($cardH * $fRatio)
}
$fX = [int](($pageW - $fW) / 2)
$fY = $marginTop + [int](($cardH - $fH) / 2)
$gr.DrawImage($frontImg, $fX, $fY, $fW, $fH)
$frontImg.Dispose()

# Back
$backImg = [System.Drawing.Image]::FromFile($backPath)
$bRatio = [double]$backImg.Width / $backImg.Height
if ($bRatio -gt $cRatio) {
  $bW = $cardW; $bH = [int]($cardW / $bRatio)
} else {
  $bH = $cardH; $bW = [int]($cardH * $bRatio)
}
$bX = [int](($pageW - $bW) / 2)
$bY = $marginTop + $cardH + $gap + [int](($cardH - $bH) / 2)
$gr.DrawImage($backImg, $bX, $bY, $bW, $bH)
$backImg.Dispose()

$gr.Dispose()
$bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
