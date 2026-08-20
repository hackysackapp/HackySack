Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 1. Capture screen to bitmap
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()

$tempFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "hackysack_cap.png")
$bmp.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 2. Run Windows 10/11 native WinRT OCR
[Windows.Globalization.Language, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null

$fileTask = [Windows.Storage.StorageFile]::GetFileFromPathAsync($tempFile)
$storageFile = $fileTask.GetAwaiter().GetResult()

$streamTask = $storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)
$stream = $streamTask.GetAwaiter().GetResult()

$decoderTask = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
$decoder = $decoderTask.GetAwaiter().GetResult()

$bmpTask = $decoder.GetSoftwareBitmapAsync()
$softwareBmp = $bmpTask.GetAwaiter().GetResult()

$lang = New-Object Windows.Globalization.Language("en-US")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

$ocrTask = $engine.RecognizeAsync($softwareBmp)
$ocrResult = $ocrTask.GetAwaiter().GetResult()

$stream.Dispose()
Remove-Item -Force $tempFile -ErrorAction SilentlyContinue

if ($ocrResult -and $ocrResult.Text) {
    Write-Output $ocrResult.Text
} else {
    Write-Output ""
}
