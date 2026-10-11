param([int]$Port = 8080)
# 簡易ローカルWebサーバー(ES Modules を file:// では読めないため)
# 修正が必ず反映されるよう Cache-Control: no-store を付与
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Item .).FullName }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.glb'='model/gltf-binary'; '.png'='image/png'; '.jpg'='image/jpeg' }
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq '/') { $path = '/index.html' }
  $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
  $ctx.Response.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
  if ((Test-Path $file -PathType Leaf) -and ($file.StartsWith($root))) {
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
