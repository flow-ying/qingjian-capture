param([Parameter(Mandatory=$true)][string]$Vault,[switch]$SkipEnable,[switch]$SkipBridge)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path $PSScriptRoot -Parent
$vaultPath=(Resolve-Path -LiteralPath $Vault).Path
if (-not (Test-Path -LiteralPath (Join-Path $vaultPath '.obsidian'))) { throw 'Target must be the existing Obsidian Vault.' }
if ((Get-Process -Name Obsidian -ErrorAction SilentlyContinue) -and -not $SkipEnable) { throw 'Obsidian is running; use SkipEnable, then enable only this bridge through Obsidian.' }
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=Join-Path $sourceRoot "artifacts/install-$stamp"
$version=(Get-Content -LiteralPath (Join-Path $sourceRoot 'dist/desktop-capture/package.json') -Raw | ConvertFrom-Json).version
$install=Join-Path $env:LOCALAPPDATA "Programs/ObsidianDesktopCapture/$version-$stamp"
$bridgeTarget=Join-Path $vaultPath '.obsidian/plugins/desktop-capture-bridge'
$community=Join-Path $vaultPath '.obsidian/community-plugins.json'
$desktop=[Environment]::GetFolderPath('Desktop')
$shortcut=Join-Path $desktop 'Obsidian 桌面采集.lnk'
$startupShortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'Obsidian 桌面采集.lnk'
$updateStartup=Test-Path -LiteralPath $startupShortcut
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$decisions=@{scope='Install desktop app; bridge only when SkipBridge is absent; preserve notes and Workbench';install=$install;bridge=$bridgeTarget;skipBridge=[bool]$SkipBridge;shortcut=$shortcut;startupUpdated=$updateStartup;rollback='Quit desktop app; restore previous desktop/startup shortcuts. Preserve local data. Restore bridge only if it was changed.'}
$decisions | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backup 'decision.json') -Encoding utf8
if (-not $SkipBridge -and (Test-Path -LiteralPath $bridgeTarget)) { Copy-Item -LiteralPath $bridgeTarget -Destination (Join-Path $backup 'previous-bridge') -Recurse }
if (Test-Path -LiteralPath $shortcut) { Copy-Item -LiteralPath $shortcut -Destination (Join-Path $backup 'previous-shortcut.lnk') }
if($updateStartup){Copy-Item -LiteralPath $startupShortcut -Destination (Join-Path $backup 'previous-startup.lnk')}
if(-not $SkipBridge){
 $enabled=Get-Content -LiteralPath $community -Raw | ConvertFrom-Json
 Copy-Item -LiteralPath $community -Destination (Join-Path $backup 'community-plugins.before.json')
 $baseHash=(Get-FileHash -LiteralPath $community -Algorithm SHA256).Hash
}
New-Item -ItemType Directory -Path $install -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'node_modules/electron/dist') | Copy-Item -Destination $install -Recurse
$appDir=Join-Path $install 'resources/app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'dist/desktop-capture') | Copy-Item -Destination $appDir -Recurse
if (-not $SkipBridge) { New-Item -ItemType Directory -Path $bridgeTarget -Force | Out-Null; Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'dist/desktop-capture-bridge') | Copy-Item -Destination $bridgeTarget -Recurse -Force }
if(-not $SkipBridge){
 if ((Get-FileHash -LiteralPath $community -Algorithm SHA256).Hash -ne $baseHash) { throw 'Enabled plugin list changed; refusing to overwrite it.' }
 if (-not $SkipEnable -and $enabled -notcontains 'desktop-capture-bridge') { $next=@($enabled)+@('desktop-capture-bridge'); [System.IO.File]::WriteAllText($community,($next | ConvertTo-Json),[System.Text.UTF8Encoding]::new($false)) }
}
$wsh=New-Object -ComObject WScript.Shell
$link=$wsh.CreateShortcut($shortcut)
$link.TargetPath=Join-Path $install 'electron.exe'
$link.Arguments='"'+$appDir+'" "--vault='+$vaultPath+'"'
$link.WorkingDirectory=$install
$link.Description='桌面随时采集；Obsidian 退出后仍可保存，重新打开后写入 Daily。'
$link.Save()
$files=@('main.cjs','preload.cjs','graph-preload.cjs','token-preload.cjs','ui/token.html','ui/token.js','ui/token.css','package.json','ui/graph.html','ui/graph.css','ui/graph.js','ui/graph-model.js','ui/capture.html','ui/capture.css','ui/window.css','ui/qingjian.css','ui/capture.js','ui/orb.html','ui/orb.css','ui/orb.js')
foreach($relative in $files) { if ((Get-FileHash -LiteralPath (Join-Path $appDir $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceRoot ('dist/desktop-capture/'+$relative))).Hash) { throw "Installed app hash mismatch: $relative" } }
if(-not $SkipBridge){foreach($relative in @('main.js','manifest.json')) { if ((Get-FileHash -LiteralPath (Join-Path $bridgeTarget $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceRoot ('dist/desktop-capture-bridge/'+$relative))).Hash) { throw "Installed bridge hash mismatch: $relative" } }}
if($updateStartup){Copy-Item -LiteralPath $shortcut -Destination $startupShortcut -Force;if((Get-FileHash -LiteralPath $shortcut).Hash -ne (Get-FileHash -LiteralPath $startupShortcut).Hash){throw 'Startup shortcut mismatch'}}
$result=@{installed=$install;app=$appDir;exe=(Join-Path $install 'electron.exe');bridge=$bridgeTarget;bridgeChanged=(-not $SkipBridge);shortcut=$shortcut;startup=$startupShortcut;startupUpdated=$updateStartup;backup=$backup;vault=$vaultPath;version=$version;verifiedFiles=$files.Count}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backup 'installed.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
