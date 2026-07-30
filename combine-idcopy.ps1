param(
  [string]$frontPath,
  [string]$backPath,
  [string]$outputPath,
  [string]$layoutMode = "horizontal"
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(2480, 3508)
$gr = [System.Drawing.Graphics]::FromImage($bmp)
$gr.Clear([System.Drawing.Color]::White)
$gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# 86mm x 54mm ID Card size at 300 DPI (2480x3508 A4 canvas)
$cardW = 1016
$cardH = 638
$pageW = 2480
$pageH = 3508

$hasFront = [string]::IsNullOrEmpty($frontPath) -eq $false -and (Test-Path $frontPath)
$hasBack = [string]::IsNullOrEmpty($backPath) -eq $false -and (Test-Path $backPath)

if ($hasFront -and $hasBack) {
  if ($layoutMode -eq "vertical") {
    # Vertical layout (Front top center, Back bottom center)
    $marginTop = 350
    $gap = 300
    
    $frontImg = [System.Drawing.Image]::FromFile($frontPath)
    $fX = [int](($pageW - $cardW) / 2)
    $fY = $marginTop
    $gr.DrawImage($frontImg, $fX, $fY, $cardW, $cardH)
    $frontImg.Dispose()

    $backImg = [System.Drawing.Image]::FromFile($backPath)
    $bX = [int](($pageW - $cardW) / 2)
    $bY = $marginTop + $cardH + $gap
    $gr.DrawImage($backImg, $bX, $bY, $cardW, $cardH)
    $backImg.Dispose()
  } else {
    # Horizontal side-by-side layout (matching exact user screenshot)
    $gap = 100
    $totalW = ($cardW * 2) + $gap
    $startX = [int](($pageW - $totalW) / 2)
    $topY = 350

    $frontImg = [System.Drawing.Image]::FromFile($frontPath)
    $gr.DrawImage($frontImg, $startX, $topY, $cardW, $cardH)
    $frontImg.Dispose()

    $backImg = [System.Drawing.Image]::FromFile($backPath)
    $backX = $startX + $cardW + $gap
    $gr.DrawImage($backImg, $backX, $topY, $cardW, $cardH)
    $backImg.Dispose()
  }
} elseif ($hasFront) {
  # Single Front Card at top center
  $startX = [int](($pageW - $cardW) / 2)
  $topY = 350
  $frontImg = [System.Drawing.Image]::FromFile($frontPath)
  $gr.DrawImage($frontImg, $startX, $topY, $cardW, $cardH)
  $frontImg.Dispose()
} elseif ($hasBack) {
  # Single Back Card at top center
  $startX = [int](($pageW - $cardW) / 2)
  $topY = 350
  $backImg = [System.Drawing.Image]::FromFile($backPath)
  $gr.DrawImage($backImg, $startX, $topY, $cardW, $cardH)
  $backImg.Dispose()
}

$gr.Dispose()
$bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
