# CamLink local static server. Windows PowerShell 5.1+. Listens ONLY on 127.0.0.1.
param(
    [int]$Port = 8765,
    [string]$RunId = 'manual'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$allowed = @{
    '/'            = @('index.html', 'text/html; charset=utf-8')
    '/index.html'   = @('index.html', 'text/html; charset=utf-8')
    '/version.json' = @('version.json', 'application/json; charset=utf-8')
    '/style.css'    = @('style.css', 'text/css; charset=utf-8')
    '/app.js'       = @('app.js', 'text/javascript; charset=utf-8')
    '/recognition.js' = @('recognition.js', 'text/javascript; charset=utf-8')
    '/recognition.css' = @('recognition.css', 'text/css; charset=utf-8')
    '/scanner.js'   = @('scanner.js', 'text/javascript; charset=utf-8')
    '/favicon.svg'  = @('favicon.svg', 'image/svg+xml')
    '/install.js'   = @('install.js', 'text/javascript; charset=utf-8')
    '/sw.js'        = @('sw.js', 'text/javascript; charset=utf-8')
    '/manifest.webmanifest' = @('manifest.webmanifest', 'application/manifest+json; charset=utf-8')
    '/icons/icon-180.png' = @('icons/icon-180.png', 'image/png')
    '/icons/icon-192.png' = @('icons/icon-192.png', 'image/png')
    '/icons/icon-512.png' = @('icons/icon-512.png', 'image/png')
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 5000
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { continue }
            $m = [regex]::Match($requestLine, '^(GET|HEAD)\s+(\S+)\s+HTTP/1\.[01]$')
            if (-not $m.Success) { continue }
            $method = $m.Groups[1].Value
            $path = $m.Groups[2].Value.Split('?')[0]
            if ($path -eq '') { $path = '/' }
            while ($true) {
                $header = $reader.ReadLine()
                if ($null -eq $header -or $header -eq '') { break }
            }
            if ($path -eq '/__camlink_public') {
                # URL only: no event photos or local browser data is exposed by this server.
                $type = 'text/plain; charset=utf-8'
                $linkPath = Join-Path $root 'BOJOCAMREJECT-LINK.txt'
                if (Test-Path -LiteralPath $linkPath) {
                    $bytes = [System.IO.File]::ReadAllBytes($linkPath)
                    $status = '200 OK'
                } else {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes('No live public address')
                    $status = '503 Service Unavailable'
                }
            } elseif ($path -eq '/__camlink_health') {
                $type = 'text/plain; charset=utf-8'
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($RunId)
                $status = '200 OK'
            } elseif ($allowed.ContainsKey($path)) {
                $fileName = $allowed[$path][0]
                $type = $allowed[$path][1]
                $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root $fileName))
                $status = '200 OK'
            } else {
                $type = 'text/plain; charset=utf-8'
                $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
                $status = '404 Not Found'
            }
            $head = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nX-CamLink-Run: $RunId`r`nX-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -eq 'GET') { $stream.Write($bytes, 0, $bytes.Length) }
            $stream.Flush()
        } catch {
            # An individual browser request must not stop the server.
        } finally {
            if ($client) { $client.Close() }
        }
    }
} finally {
    $listener.Stop()
}
