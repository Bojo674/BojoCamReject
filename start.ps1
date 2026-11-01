# CamLink one-click local website + temporary HTTPS link (Cloudflare Quick Tunnel).
# No Netlify, Vercel, hosting account or password required.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$port = $null
$localUrl = $null
$cloudflared = Join-Path $root 'cloudflared.exe'
# Use unique log paths so another launch cannot interfere with this session.
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$logOut = Join-Path $env:TEMP ("camlink-$runId-output.log")
$logErr = Join-Path $env:TEMP ("camlink-$runId-error.log")
$linkFile = Join-Path $root 'BOJOCAMREJECT-LINK.txt'
$serverProcess = $null
$tunnelProcess = $null

function Open-InternetPage([string]$url) {
    $chromeCandidates = @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($chrome) { Start-Process -FilePath $chrome -ArgumentList $url | Out-Null }
    else { Start-Process $url | Out-Null }
}

function Read-TunnelUrl {
    foreach ($path in @($logOut, $logErr)) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        # cloudflared keeps its redirected log open for writing. Read it while
        # the process is running, allowing shared read/write access on Windows.
        $stream = $null
        $reader = $null
        try {
            $stream = [System.IO.File]::Open(
                $path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite
            )
            $reader = [System.IO.StreamReader]::new($stream)
            $contents = $reader.ReadToEnd()
            $match = [regex]::Match($contents, 'https://[a-z0-9-]+\.trycloudflare\.com', 'IgnoreCase')
            if ($match.Success) { return $match.Value }
        } catch [System.IO.IOException] {
            # A writer may be rotating the log; retry on the next polling pass.
        } catch [System.UnauthorizedAccessException] {
            # Antivirus/indexer may briefly hold the log; try again.
        } finally {
            if ($reader) { $reader.Dispose() }
            elseif ($stream) { $stream.Dispose() }
        }
    }
    return $null
}


# The public URL must be reachable before being shown as working.
function Test-PublicWebsite([string]$url) {
    if ([string]::IsNullOrWhiteSpace($url)) { return $false }
    try {
        $response = Invoke-WebRequest -Uri ($url.TrimEnd('/') + '/__camlink_health') -UseBasicParsing -TimeoutSec 7
        return (($response.StatusCode -eq 200) -and ($response.Content.Trim() -eq $runId))
    } catch { return $false }
}
function Stop-CurrentTunnel {
    if ($script:tunnelProcess) {
        try {
            $script:tunnelProcess.Refresh()
            if (-not $script:tunnelProcess.HasExited) { Stop-Process -Id $script:tunnelProcess.Id -Force -ErrorAction SilentlyContinue }
            $script:tunnelProcess.WaitForExit(5000) | Out-Null
        } catch {}
    }
    $script:tunnelProcess = $null
}
function Save-TunnelDiagnostics {
    try {
        $details = @()
        foreach ($path in @($logErr, $logOut)) {
            if (-not (Test-Path -LiteralPath $path)) { continue }
            $stream=$null; $reader=$null
            try {
                $stream=[System.IO.File]::Open($path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)
                $reader=[System.IO.StreamReader]::new($stream)
                $details+=($reader.ReadToEnd())
            } finally {
                if($reader){$reader.Dispose()} elseif($stream){$stream.Dispose()}
            }
        }
        if ($details.Count -gt 0) {
            [System.IO.File]::WriteAllText((Join-Path $root 'BOJOCAMREJECT-DIAGNOSTICS.txt'), ($details -join "`r`n"), [System.Text.Encoding]::UTF8)
        }
    } catch {}
}
function Start-HealthyTunnel {
    Stop-CurrentTunnel
    $script:publicUrl = $null
    Remove-Item $linkFile -Force -ErrorAction SilentlyContinue
    for ($tryNumber=1; $tryNumber -le 3; $tryNumber++) {
        $tag = [guid]::NewGuid().ToString('N').Substring(0,10)
        $script:logOut = Join-Path $env:TEMP ("bojo-$runId-$tag-out.log")
        $script:logErr = Join-Path $env:TEMP ("bojo-$runId-$tag-err.log")
        Write-Host "Opening Cloudflare Tunnel (attempt $tryNumber/3)..." -ForegroundColor Yellow
        # HTTP/2 avoids networks that block UDP/QUIC. It still needs outbound access to Cloudflare.
        $script:tunnelProcess = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--protocol', 'http2', '--url', $localUrl) -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru -WindowStyle Hidden
        $candidateUrl = $null
        for ($i=0; $i -lt 35; $i++) {
            Start-Sleep -Seconds 1
            $candidateUrl = Read-TunnelUrl
            if ($candidateUrl) { break }
            $script:tunnelProcess.Refresh()
            if ($script:tunnelProcess.HasExited) { break }
        }
        if ($candidateUrl) {
            for ($j=0; $j -lt 10; $j++) {
                if (Test-PublicWebsite $candidateUrl) {
                    $script:publicUrl = $candidateUrl
                    try { [System.IO.File]::WriteAllText($linkFile, $candidateUrl, [System.Text.Encoding]::UTF8) } catch {}
                    try { Set-Clipboard -Value $candidateUrl } catch {}
                    Write-Host ''
                    Write-Host '==================================================' -ForegroundColor Green
                    Write-Host '  VERIFIED PUBLIC WEBSITE ADDRESS:' -ForegroundColor Green
                    Write-Host "  $candidateUrl" -ForegroundColor White
                    Write-Host '==================================================' -ForegroundColor Green
                    Write-Host 'Address copied and saved in BOJOCAMREJECT-LINK.txt' -ForegroundColor Cyan
                    Write-Host 'Use THIS new address on your phone. Old links stop working.' -ForegroundColor Yellow
                    return $true
                }
                $script:tunnelProcess.Refresh()
                if ($script:tunnelProcess.HasExited) { break }
                Start-Sleep -Seconds 3
            }
        }
        Write-Host 'Tunnel is not reachable. Checking it again...' -ForegroundColor Yellow
        Save-TunnelDiagnostics
        Stop-CurrentTunnel
        Start-Sleep -Seconds 2
    }
    return $false
}

try {
    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host '  BOJOCAMREJECT  -  PHONE CAMERA ON PC' -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Finding a free local port and starting the website...' -ForegroundColor Yellow
    # Old CamLink versions can leave port 8765 in use. Never kill that process;
    # choose another available port instead. Only accept OUR server's health ID.
    $serverReady = $false
    for ($candidate = 8765; $candidate -le 8880; $candidate++) {
        $portCheck = $null
        try {
            $portCheck = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
            $portCheck.Start()
        } catch {
            continue
        } finally {
            if ($null -ne $portCheck) { try { $portCheck.Stop() } catch { } }
        }

        $serverArgs = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', ('"' + (Join-Path $root 'server.ps1') + '"'),
            '-Port', [string]$candidate, '-RunId', $runId
        )
        $serverProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $serverArgs -PassThru -WindowStyle Hidden
        $candidateUrl = "http://127.0.0.1:$candidate"
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 350
            if ($serverProcess.HasExited) { break }
            try {
                $health = Invoke-WebRequest -UseBasicParsing -Uri "$candidateUrl/__camlink_health" -TimeoutSec 2
                if (($health.StatusCode -eq 200) -and ($health.Content.Trim() -eq $runId)) {
                    $serverReady = $true
                    $port = $candidate
                    $localUrl = $candidateUrl
                    break
                }
            } catch { }
        }
        if ($serverReady) { break }
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
        $serverProcess = $null
    }
    if (-not $serverReady) { throw 'Could not start the local website on any port from 8765 to 8880.' }
    Write-Host "Local site: $localUrl" -ForegroundColor Green

    if (-not (Test-Path $cloudflared)) {
        Write-Host 'Downloading official Cloudflare connector (first run only)...' -ForegroundColor Yellow
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $dl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $dl -OutFile $cloudflared -TimeoutSec 180
        if ((Get-Item $cloudflared).Length -lt 1000000) { throw 'Connector download failed.' }
    }

    Remove-Item $linkFile -Force -ErrorAction SilentlyContinue
    $script:publicUrl = $null
    if (-not (Start-HealthyTunnel)) {
        Write-Host ''
        Write-Host 'ERROR: Cannot establish a working public connection.' -ForegroundColor Red
        Write-Host "Local site is working at: $localUrl" -ForegroundColor Yellow
        Write-Host 'See BOJOCAMREJECT-DIAGNOSTICS.txt for the technical error.' -ForegroundColor Yellow
        Write-Host 'Check firewall / VPN / internet and then start again.' -ForegroundColor Yellow
        throw 'Cloudflare tunnel is not reachable.'
    }
    Write-Host "Computer-only photo archive: $localUrl" -ForegroundColor Cyan
    Write-Host 'This is the PC page. The HTTPS link above is only for the phone.' -ForegroundColor Yellow
    Open-InternetPage $localUrl
    Write-Host ''
    Write-Host 'BojoCamReject is running. Keep this window open.' -ForegroundColor Green
    Write-Host 'Press R here to RESTART the public link, Q to QUIT.' -ForegroundColor Yellow
    Write-Host 'The link changes when the tunnel restarts.' -ForegroundColor Yellow
    $failCount = 0
    $tick = 0
    while ($true) {
        Start-Sleep -Seconds 2
        try {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true).KeyChar.ToString().ToUpperInvariant()
                if ($key -eq 'Q') { break }
                if ($key -eq 'R') {
                    Write-Host 'Restarting tunnel by request...' -ForegroundColor Yellow
                    if (Start-HealthyTunnel) { $failCount=0;Open-InternetPage $localUrl }
                    else { Write-Host 'Failed to restart; press R again after checking network.' -ForegroundColor Red }
                    $tick=0
                    continue
                }
            }
        } catch { }
        if ($serverProcess.HasExited) { throw 'Local web server stopped unexpectedly.' }
        $tick++
        if ($tick -lt 8) { continue }
        $tick=0
        if ($null -ne $tunnelProcess) { $tunnelProcess.Refresh() }
        if (($null -eq $tunnelProcess) -or $tunnelProcess.HasExited) {
            Write-Host 'Cloudflare process stopped. Restoring it...' -ForegroundColor Yellow
            if (Start-HealthyTunnel) { $failCount=0; Open-InternetPage $localUrl }
            else { Write-Host 'No public link. Check connection or press R.' -ForegroundColor Red }
            continue
        }
        if (Test-PublicWebsite $script:publicUrl) {
            if($failCount -gt 0){Write-Host 'Tunnel connection recovered.' -ForegroundColor Green}
            $failCount=0
        } else {
            $failCount++
            Write-Host "Public link unavailable ($failCount/3 checks)." -ForegroundColor Yellow
            if ($failCount -ge 3) {
                Write-Host 'Error 1033 may be occurring. Recreating the tunnel...' -ForegroundColor Yellow
                if (Start-HealthyTunnel) { Open-InternetPage $localUrl }
                else { Write-Host 'Still offline; check BOJOCAMREJECT-DIAGNOSTICS.txt' -ForegroundColor Red }
                $failCount=0
            }
        }
    }
} catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Please take a screenshot or inspect BOJOCAMREJECT-DIAGNOSTICS.txt.' -ForegroundColor Yellow
    Read-Host 'Press ENTER to close' | Out-Null
} finally {
    Save-TunnelDiagnostics
    Stop-CurrentTunnel
    if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue }
}
