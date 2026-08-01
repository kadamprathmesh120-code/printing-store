param(
  [string]$filePath,
  [string]$printerName,
  [double]$printScale = 1.0,
  [int]$copies = 1,
  [string]$orientation = 'portrait'
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($filePath)
$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName

# Always set copies explicitly so printer defaults don't override
$pd.PrinterSettings.Copies = [short]([Math]::Max(1, $copies))

# Set Landscape / Portrait orientation
if ($orientation -eq 'landscape') {
  $pd.DefaultPageSettings.Landscape = $true
} else {
  $pd.DefaultPageSettings.Landscape = $false
}

# Force Simplex (Single Side) to prevent duplex printer drivers from ejecting a 2nd blank page
$pd.DefaultPageSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex

# Set zero margins so the printable area is maximum (full bleed as much as hardware allows)
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$pd.OriginAtMargins = $false

# Set A4 paper size if available
$a4 = $pd.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq 'A4' } | Select-Object -First 1
if ($a4) { $pd.DefaultPageSettings.PaperSize = $a4 }

$printed = $false
$pd.add_PrintPage({
  param($sender, $e)
  if ($printed) {
    $e.HasMorePages = $false
    return
  }

  # Use Graphics ClipBounds (actual printable area) NOT PageBounds (full paper, which clips)
  $clip   = $e.Graphics.VisibleClipBounds
  $destW  = [int]$clip.Width
  $destH  = [int]$clip.Height

  $imgW   = $img.Width
  $imgH   = $img.Height

  # Scale image to FILL the printable area, maintaining aspect ratio
  $scaleX = $destW / $imgW
  $scaleY = $destH / $imgH
  $scale  = [Math]::Min($scaleX, $scaleY)   # use Min to keep full image (no cropping)

  $drawW  = [int]($imgW * $scale)
  $drawH  = [int]($imgH * $scale)

  # Center the image within the printable area
  $offsetX = [int](($destW - $drawW) / 2)
  $offsetY = [int](($destH - $drawH) / 2)

  $destRect = New-Object System.Drawing.Rectangle($offsetX, $offsetY, $drawW, $drawH)

  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $e.Graphics.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $e.Graphics.DrawImage($img, $destRect)
  $printed = $true
  $e.HasMorePages = $false
})
$pd.Print()
$img.Dispose()
