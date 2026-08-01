param(
  [string]$filePath,
  [string]$printerName,
  [double]$printScale = 1.0,
  [int]$copies = 1,
  [string]$orientation = 'portrait'
)

Add-Type -AssemblyName System.Drawing

# Load image locking file to avoid GDI+ sharing issues
$imgStream = [System.IO.File]::OpenRead($filePath)
$img = [System.Drawing.Image]::FromStream($imgStream)

$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName

# Set max printer DPI for highest quality output
try {
  $maxDpiX = $pd.PrinterSettings.DefaultPageSettings.PrinterResolution.X
  $maxDpiY = $pd.PrinterSettings.DefaultPageSettings.PrinterResolution.Y

  # Find the highest resolution the printer supports
  $bestRes = $pd.PrinterSettings.PrinterResolutions |
    Where-Object { $_.Kind -eq 'Custom' -and $_.X -gt 0 } |
    Sort-Object { $_.X } -Descending |
    Select-Object -First 1

  if ($null -eq $bestRes) {
    $bestRes = $pd.PrinterSettings.PrinterResolutions |
      Sort-Object { $_.X } -Descending |
      Select-Object -First 1
  }

  if ($bestRes -ne $null) {
    $pd.DefaultPageSettings.PrinterResolution = $bestRes
    Write-Host "Set printer DPI: $($bestRes.X) x $($bestRes.Y)"
  }
} catch {
  Write-Host "Note: Could not set printer DPI (non-critical): $_"
}

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

# Zero margins — maximize printable area (hardware margin still applies physically)
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

  # ---- Highest quality GDI+ rendering flags ----
  $e.Graphics.InterpolationMode   = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.SmoothingMode       = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $e.Graphics.PixelOffsetMode     = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $e.Graphics.CompositingQuality  = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $e.Graphics.CompositingMode     = [System.Drawing.Drawing2D.CompositingMode]::SourceOver

  # Use VisibleClipBounds — actual printable area returned by the printer driver
  $clip   = $e.Graphics.VisibleClipBounds
  $destW  = [float]$clip.Width
  $destH  = [float]$clip.Height

  $imgW   = [float]$img.Width
  $imgH   = [float]$img.Height

  # Scale image to FILL the entire printable area (fit-to-page, may crop if very different aspect)
  $scaleX = $destW / $imgW
  $scaleY = $destH / $imgH
  $scale  = [Math]::Max($scaleX, $scaleY)
  $drawW  = $imgW * $scale
  $drawH  = $imgH * $scale

  # Center on printable area
  $offsetX = ($destW - $drawW) / 2.0
  $offsetY = ($destH - $drawH) / 2.0

  $destRect = New-Object System.Drawing.RectangleF($offsetX, $offsetY, $drawW, $drawH)

  # Full source rect — use entire image at full native resolution
  $srcRect = New-Object System.Drawing.RectangleF(0, 0, $imgW, $imgH)

  # DrawImage with explicit source rect prevents GDI+ internal thumbnail downsampling
  $e.Graphics.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

  $printed = $true
  $e.HasMorePages = $false
})

$pd.Print()
$img.Dispose()
$imgStream.Close()
$imgStream.Dispose()
