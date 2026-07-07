param(
  [string]$filePath,
  [string]$printerName,
  [double]$printScale = 1.0
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($filePath)
$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName
$pd.DefaultPageSettings.PaperSize = $pd.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq "A4" } | Select-Object -First 1
$pd.add_PrintPage({
  param($sender, $e)
  $pageW = $e.PageBounds.Width
  $pageH = $e.PageBounds.Height
  $imgW = $img.Width
  $imgH = $img.Height
  $fitScale = [Math]::Min($pageW / $imgW, $pageH / $imgH)
  $finalScale = $fitScale * $printScale
  $drawW = [int]($imgW * $finalScale)
  $drawH = [int]($imgH * $finalScale)
  $x = [int](($pageW - $drawW) / 2)
  $y = [int](($pageH - $drawH) / 2)
  $e.Graphics.DrawImage($img, $x, $y, $drawW, $drawH)
  $e.HasMorePages = $false
})
$pd.Print()
$img.Dispose()
