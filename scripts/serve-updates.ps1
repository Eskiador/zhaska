# Canal de actualizaciones local para probar en Windows la actualización de punta a punta (docs/WINDOWS.md).
# Sirve una carpeta (latest.yml + ZHASKA-Setup-X.Y.Z.exe + .blockmap) en http://127.0.0.1:45789/
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\serve-updates.ps1 -Folder dist\e2e-0.1.1
param([Parameter(Mandatory = $true)][string]$Folder)
$root = (Resolve-Path $Folder).Path
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:45789/')
$listener.Start()
Write-Host "Sirviendo $root en http://127.0.0.1:45789/  (Ctrl+C para parar)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $name = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $name))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "200 $name"
    } else {
      $ctx.Response.StatusCode = 404
      Write-Host "404 $name"
    }
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop()
}
