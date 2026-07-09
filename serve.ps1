# Minimal static file server for the BREP CAD tool.
#
# Why this exists: the BREP kernel (js/oc-init.js, an ES module) and its WASM
# file (vendor/replicad_single.wasm) both fail to load under a file:// URL
# (double-clicking index.html) - browsers block module-script and WASM
# fetches from local files for the same reason opentype.js font loading was
# blocked in the original MR-CAD tool. Unlike that project, there's no
# base64-embedding workaround for a 10 MB WASM binary, so this tool needs an
# actual (even if tiny/local) HTTP server. No Node/npm/Python were available
# on this machine, so this is a plain PowerShell/.NET HttpListener - no
# dependencies beyond PowerShell itself.
#
# Usage: right-click > "Run with PowerShell", or from a terminal:
#   powershell -ExecutionPolicy Bypass -File serve.ps1
# Then open the printed http://localhost:8080/ URL in a browser.

param(
  [int]$Port = 8080
)

$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host "Konnte Port $Port nicht öffnen (evtl. schon belegt): $_"
  exit 1
}

$mimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.json' = 'application/json; charset=utf-8'
  '.mrcad'= 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
}

Write-Host "MR-CAD (BREP) läuft auf $prefix - im Browser öffnen, dann Strg+C hier zum Beenden."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $urlPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
    if ($urlPath -eq '/') { $urlPath = '/index.html' }
    $filePath = Join-Path $root ($urlPath -replace '^/', '')
    $fullRoot = (Resolve-Path $root).Path
    $resolved = $null
    if (Test-Path $filePath) { $resolved = (Resolve-Path $filePath).Path }

    if ($resolved -and $resolved.StartsWith($fullRoot) -and -not (Get-Item $resolved).PSIsContainer) {
      $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
      $contentType = $mimeTypes[$ext]
      if (-not $contentType) { $contentType = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($resolved)
      $response.ContentType = $contentType
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
      $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 - Nicht gefunden: $urlPath")
      $response.OutputStream.Write($notFound, 0, $notFound.Length)
    }
    $response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
