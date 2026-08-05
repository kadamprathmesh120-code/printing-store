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

# Auto-rotate image if customer requested orientation differs from native image dimensions
if ($orientation -eq 'landscape' -and $img.Width -lt $img.Height) {
  $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
} elseif ($orientation -eq 'portrait' -and $img.Width -gt $img.Height) {
  $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)
}

$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName
$pd.PrinterSettings.Copies = [short]([Math]::Max(1, $copies))

# Inherit user's default Windows Printing Preferences
# Set Landscape / Portrait orientation on BOTH DefaultPageSettings and PrinterSettings driver defaults
if ($orientation -eq 'landscape') {
  $pd.DefaultPageSettings.Landscape = $true
  try { $pd.PrinterSettings.DefaultPageSettings.Landscape = $true } catch {}
} else {
  $pd.DefaultPageSettings.Landscape = $false
  try { $pd.PrinterSettings.DefaultPageSettings.Landscape = $false } catch {}
}

# Force Simplex (Single Side) to prevent duplex printer drivers from ejecting a 2nd blank page
$pd.DefaultPageSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex

# Enable Color Printing driver capability
$pd.DefaultPageSettings.Color = $true
try { $pd.PrinterSettings.DefaultPageSettings.Color = $true } catch {}

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

  # ---- High-Quality Color & Photo rendering flags ----
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

  # Fit the ENTIRE image within the printable area — no cropping, no forced upscaling
  # Math.Min = use the smaller scale axis so the whole image fits within the page
  # [Math]::Min(scale, 1.0) = never upscale beyond native pixel resolution (no blur from upsampling)
  $scaleX = $destW / $imgW
  $scaleY = $destH / $imgH
  $scale  = [Math]::Min($scaleX, $scaleY)   # fit entire image, preserve aspect ratio, no cropping
  # Note: do NOT clamp to 1.0 — allow upscale to fill page since printer DPI > screen DPI
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
