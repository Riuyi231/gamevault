#Requires -Version 5.1
# Downloads portable emulators bundled with GameVault into resources/emulators/
# - RetroArch (stable) + full cores pack
# - PCSX2 (PS2, Qt build)
# - Dolphin (GameCube / Wii)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/init-emulators.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$DEST      = Join-Path $REPO_ROOT 'resources\emulators'
$TMP       = Join-Path $REPO_ROOT 'resources\.emulators-tmp'
$MANIFEST_PATH = Join-Path $DEST 'manifest.json'

# ── Idempotence: keep going if a component is already extracted
$RA_EXE  = Join-Path $DEST 'retroarch\retroarch.exe'
$PCSX2   = Join-Path $DEST 'pcsx2\pcsx2-qt.exe'
$DOLPHIN = Join-Path $DEST 'dolphin\Dolphin.exe'

"==> GameVault emulators fetch"
"    Dest: $DEST"

New-Item -ItemType Directory -Force -Path $DEST, $TMP | Out-Null

function Get-File($Url, $Out) {
  if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 0)) {
    "       ya existe: $Out"
    return
  }
  "       descargando $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out
}

function Get-7zr {
  $exe = Join-Path $TMP '7zr.exe'
  if (-not (Test-Path $exe)) {
    Write-Host "==> Descargando 7zr.exe (7-Zip console)"
    Invoke-WebRequest -UseBasicParsing -Uri 'https://www.7-zip.org/a/7zr.exe' -OutFile $exe
  }
  return $exe
}

function Expand-7z($7zr, $Archive, $OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  & $7zr x -y "-o$OutDir" $Archive | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7zr falló al extraer $Archive (código $LASTEXITCODE)" }
}

function Find-Exe($Root, $Name) {
  Get-ChildItem -Path $Root -Recurse -Filter $Name -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

# Core libretro que el launcher registra (catálogo). El pack trae ~200 cores
# (MAME/QEMU ocupan cientos de MB); solo copiamos/pruneamos a estos.
$CORE_WHITELIST = @(
  'fceumm_libretro.dll',
  'snes9x_libretro.dll',
  'gambatte_libretro.dll',
  'mgba_libretro.dll',
  'mupen64plus_next_libretro.dll',
  'genesis_plus_gx_libretro.dll',
  'mednafen_saturn_libretro.dll',
  'flycast_libretro.dll',
  'swanstation_libretro.dll',
  'ppsspp_libretro.dll',
  'melonDS_libretro.dll'
)

# ── RETROARCH + CORES (Retro detect systems) ──────────────────────────────
if (-not (Test-Path $RA_EXE)) {
  "==> RetroArch (1.22.2)"
  $ra7z   = Join-Path $TMP 'RetroArch.7z'
  $cores7z = Join-Path $TMP 'RetroArch_cores.7z'
  Get-File 'https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch.7z' $ra7z
  Get-File 'https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch_cores.7z' $cores7z

  $7zr = Get-7zr
  $raTmp = Join-Path $TMP 'ra-extract'
  Expand-7z $7zr $ra7z $raTmp

  $exe = Find-Exe $raTmp 'retroarch.exe'
  if (-not $exe) { throw 'No se encontró retroarch.exe en el paquete de RetroArch' }

  $raDir = Join-Path $DEST 'retroarch'
  New-Item -ItemType Directory -Force -Path $raDir | Out-Null
  $exeRel = Join-Path $exe.DirectoryName '*'
  Copy-Item -Path $exeRel -Destination $raDir -Recurse -Force

  $coresTmp = Join-Path $TMP 'cores-extract'
  Expand-7z $7zr $cores7z $coresTmp
  $coreDir = Join-Path $raDir 'cores'
  New-Item -ItemType Directory -Force -Path $coreDir | Out-Null
  foreach ($core in $CORE_WHITELIST) {
    $src = Get-ChildItem -Path $coresTmp -Recurse -Filter $core -File | Select-Object -First 1
    if ($src) { Copy-Item $src.FullName -Destination $coreDir -Force }
  }

  $created = (Get-ChildItem -Path $coreDir -Filter '*_libretro.dll' -File).Count
  "       cores instalados: $created de $($CORE_WHITELIST.Count)"
} else {
  "==> RetroArch: ya presente, se omite"
}

# ── PRUNE RetroArch (siempre): dejar solo los cores del catálogo ─────────
$coreDirNow = Join-Path $DEST 'retroarch\cores'
if (Test-Path $coreDirNow) {
  Get-ChildItem -Path $coreDirNow -Filter '*_libretro.dll' -File |
    Where-Object { $_.Name -notin $CORE_WHITELIST } |
    Remove-Item -Force
  foreach ($prune in @('database', 'filters', 'system')) {
    $p = Join-Path $DEST "retroarch\$prune"
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force }
  }
}

# ── PCSX2 (PS2) ───────────────────────────────────────────────────────────
if (-not (Test-Path $PCSX2)) {
  "==> PCSX2 (v2.8.0, PS2)"
  $url  = 'https://github.com/PCSX2/pcsx2/releases/download/v2.8.0/pcsx2-v2.8.0-windows-x64-Qt.7z'
  $arch = Join-Path $TMP 'pcsx2.7z'
  Get-File $url $arch

  $7zr  = Get-7zr
  $tmp  = Join-Path $TMP 'pcsx2-extract'
  Expand-7z $7zr $arch $tmp

  $exe = Find-Exe $tmp 'pcsx2-qt.exe'
  if (-not $exe) { throw 'No se encontró pcsx2-qt.exe en el paquete de PCSX2' }

  $dir = Join-Path $DEST 'pcsx2'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $exeRel = Join-Path $exe.DirectoryName '*'
  Copy-Item -Path $exeRel -Destination $dir -Recurse -Force
  "       instalado en $dir"
} else {
  "==> PCSX2: ya presente, se omite"
}

# ── DOLPHIN (GameCube / Wii) ──────────────────────────────────────────────
if (-not (Test-Path $DOLPHIN)) {
  "==> Dolphin (2606a, GameCube / Wii)"
  $url  = 'https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-x64.7z'
  $arch = Join-Path $TMP 'dolphin.7z'
  Get-File $url $arch

  $7zr = Get-7zr
  $tmp = Join-Path $TMP 'dolphin-extract'
  Expand-7z $7zr $arch $tmp

  $exe = Find-Exe $tmp 'Dolphin.exe'
  if (-not $exe) { throw 'No se encontró Dolphin.exe en el paquete de Dolphin' }

  $dir = Join-Path $DEST 'dolphin'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $exeRel = Join-Path $exe.DirectoryName '*'
  Copy-Item -Path $exeRel -Destination $dir -Recurse -Force
  "       instalado en $dir"
} else {
  "==> Dolphin: ya presente, se omite"
}

# ── MANIFEST ──────────────────────────────────────────────────────────────
$coresNow = @()
$coreDirNow = Join-Path $DEST 'retroarch\cores'
if (Test-Path $coreDirNow) {
  $coresNow = @(Get-ChildItem -Path $coreDirNow -Filter '*_libretro.dll' -File | ForEach-Object { $_.Name })
}
$retroarchEntry = $null
$pcsx2Entry = $null
$dolphinEntry = $null
if (Test-Path $RA_EXE) {
  $retroarchEntry = @{ exe = 'retroarch\retroarch.exe'; version = '1.22.2'; cores = $coresNow }
}
if (Test-Path $PCSX2) {
  $pcsx2Entry = @{ exe = 'pcsx2\pcsx2-qt.exe'; version = 'v2.8.0' }
}
if (Test-Path $DOLPHIN) {
  $dolphinEntry = @{ exe = 'dolphin\Dolphin.exe'; version = '2606a' }
}
$manifest = @{
  version = '1.0.0'
  date = (Get-Date).ToString('s')
  retroarch = $retroarchEntry
  pcsx2 = $pcsx2Entry
  dolphin = $dolphinEntry
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($MANIFEST_PATH, $manifest, (New-Object System.Text.UTF8Encoding($false)))
"==> manifest escrito en: $MANIFEST_PATH"

# ── CLEANUP ───────────────────────────────────────────────────────────────
Remove-Item -Path $TMP -Recurse -Force -ErrorAction SilentlyContinue
"==> Listo. Emuladores en $DEST"