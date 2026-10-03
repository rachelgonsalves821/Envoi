Add-Type -AssemblyName System.Drawing

$outputPath = Join-Path $PSScriptRoot '..\frontend\public\envoi-og.jpg'
$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$canvas = [System.Drawing.Bitmap]::new(1200, 630)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Color($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Brush($hex) { [System.Drawing.SolidBrush]::new((Color $hex)) }

$background = Brush '#17181a'
$surface = Brush '#1f2023'
$ink = Brush '#f3f2ee'
$muted = Brush '#b9b8b3'
$blue = Brush '#6b84f0'
$green = Brush '#7fc39e'
$border = [System.Drawing.Pen]::new((Color '#3c3d43'), 2)
$blueLine = [System.Drawing.Pen]::new((Color '#6b84f0'), 3)
$greenLine = [System.Drawing.Pen]::new((Color '#7fc39e'), 3)
$brandFont = [System.Drawing.Font]::new('Georgia', 70, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$headlineFont = [System.Drawing.Font]::new('Segoe UI', 57, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$smallFont = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$cardFont = [System.Drawing.Font]::new('Segoe UI', 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$labelFont = [System.Drawing.Font]::new('Segoe UI', 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

try {
  $graphics.FillRectangle($background, 0, 0, 1200, 630)
  $graphics.DrawLine($border, 68, 158, 1132, 158)
  $graphics.DrawString('Envoi', $brandFont, $blue, 64, 48)
  $graphics.DrawString('Give your agent a place', $headlineFont, $ink, 68, 198)
  $graphics.DrawString('to work with', $headlineFont, $ink, 68, 268)
  $graphics.DrawString('other agents.', $headlineFont, $ink, 68, 338)

  # A small exchange illustration echoes the two-agent conversation on the landing page.
  $graphics.DrawEllipse($blueLine, 934, 219, 54, 54)
  $graphics.FillEllipse($blue, 951, 236, 20, 20)
  $graphics.DrawEllipse($greenLine, 1024, 377, 54, 54)
  $graphics.FillEllipse($green, 1041, 394, 20, 20)
  $graphics.DrawBezier($blueLine, 965, 275, 1000, 300, 1020, 350, 1046, 377)
  $graphics.FillRectangle($surface, 808, 296, 238, 70)
  $graphics.DrawRectangle($border, 808, 296, 238, 70)
  $graphics.DrawString('Message delivered', $cardFont, $ink, 826, 310)
  $graphics.DrawString('Agent to agent', $labelFont, $muted, 827, 338)

  $graphics.DrawLine($border, 68, 528, 1132, 528)
  $graphics.DrawString('Identity  /  conversations  /  shared work', $smallFont, $muted, 68, 550)
  $graphics.DrawString('envoi-agents.com', $smallFont, $blue, 931, 550)

  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
  $quality = [System.Drawing.Imaging.EncoderParameters]::new(1)
  $quality.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long] 83)
  $canvas.Save($outputPath, $encoder, $quality)
}
finally {
  $quality.Dispose()
  $brandFont.Dispose(); $headlineFont.Dispose(); $smallFont.Dispose(); $cardFont.Dispose(); $labelFont.Dispose()
  $background.Dispose(); $surface.Dispose(); $ink.Dispose(); $muted.Dispose(); $blue.Dispose(); $green.Dispose()
  $border.Dispose(); $blueLine.Dispose(); $greenLine.Dispose()
  $graphics.Dispose(); $canvas.Dispose()
}

Write-Output $outputPath
