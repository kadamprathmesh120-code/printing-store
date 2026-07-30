param(
  [string]$filePath,
  [string]$printerName,
  [double]$printScale = 1.0,
  [int]$copies = 1
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($filePath)
$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName

if ($copies -gt 1) {
  $pd.PrinterSettings.Copies = [short]$copies
}

# Force Simplex (Single Side) to prevent duplex printer drivers from ejecting a 2nd blank page
$pd.DefaultPageSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex

$pd.OriginAtMargins = $false
$pd.DefaultPageSettings.PaperSize = $pd.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq "A4" } | Select-Object -First 1
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

$printed = $false
$pd.add_PrintPage({
  param($sender, $e)
  if ($printed) {
    $e.HasMorePages = $false
    return
  }
  $pw = $e.PageBounds.Width
  $ph = $e.PageBounds.Height
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $e.Graphics.DrawImage($img, 0, 0, $pw, $ph)
  $printed = $true
  $e.HasMorePages = $false
})
$pd.Print()
$img.Dispose()
