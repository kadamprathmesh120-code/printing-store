param(
    [Parameter(Mandatory=$true)]
    [string]$DocPath,
    [Parameter(Mandatory=$true)]
    [string]$PdfPath
)

$ErrorActionPreference = 'Stop'

$fullDoc = [System.IO.Path]::GetFullPath($DocPath)
$fullPdf = [System.IO.Path]::GetFullPath($PdfPath)

if (-not (Test-Path $fullDoc)) {
    throw "Source document not found: $fullDoc"
}

if (Test-Path $fullPdf) {
    Remove-Item $fullPdf -Force -ErrorAction SilentlyContinue
}

$word = $null
$doc = $null

try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.ScreenUpdating = $false
    $word.DisplayAlerts = 0

    # Open ReadOnly ($true)
    $doc = $word.Documents.Open($fullDoc, $false, $true)
    
    # Export to PDF (17 = wdExportFormatPDF)
    $doc.ExportAsFixedFormat($fullPdf, 17)
    $doc.Close(0)
    $doc = $null

    Write-Host "SUCCESS: Converted '$fullDoc' to '$fullPdf'"
} finally {
    if ($doc) {
        try { $doc.Close(0) } catch {}
    }
    if ($word) {
        try { $word.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
