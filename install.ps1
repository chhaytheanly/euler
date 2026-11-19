
$ErrorActionPreference = "Stop"

# Configuration
$GITHUB_REPO = "chhaytheanly/euler"
$BRANCH = "main"

$INSTALL_DIR = Join-Path $env:LOCALAPPDATA "Euler\app"
$BIN_DIR = Join-Path $env:LOCALAPPDATA "Euler\bin"
$BIN_PATH = Join-Path $BIN_DIR "euler.cmd"

$TEMP_DIR = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
$EXTRACT_DIR = Join-Path $TEMP_DIR "extract"

Write-Host ""
Write-Host "  Euler CLI Installer"
Write-Host "  ==================="
Write-Host ""

# Requirements
foreach ($cmd in @("curl.exe", "tar.exe", "node.exe", "npm.cmd")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Error: $cmd is required but not installed."
    }
}

$NODE_VERSION = node -p "process.versions.node"
$NODE_MAJOR = [int]($NODE_VERSION.Split(".")[0])

if ($NODE_MAJOR -lt 22) {
    throw "Euler requires Node.js >= 22. Current version: $NODE_VERSION"
}

Write-Host "[1/6] Requirements satisfied"
Write-Host "      Node.js $NODE_VERSION"

try {
    New-Item -ItemType Directory -Force -Path $EXTRACT_DIR | Out-Null

    # Get latest release
    $TAG = ""

    try {
        $RELEASE = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/latest"

        $TAG = $RELEASE.tag_name
    }
    catch {
        Write-Warning "No GitHub release found. Falling back to $BRANCH."
    }

    # Download source
    if ($TAG) {
        Write-Host "[2/6] Downloading Euler release: $TAG"

        $ARCHIVE_URL = "https://codeload.github.com/$GITHUB_REPO/zip/refs/tags/$TAG"
    }
    else {
        Write-Host "[2/6] Downloading Euler branch: $BRANCH"

        $ARCHIVE_URL = "https://codeload.github.com/$GITHUB_REPO/zip/refs/heads/$BRANCH"
    }

    $ARCHIVE_PATH = Join-Path $TEMP_DIR "euler.zip"

    Invoke-WebRequest `
        -Uri $ARCHIVE_URL `
        -OutFile $ARCHIVE_PATH

    Expand-Archive `
        -Path $ARCHIVE_PATH `
        -DestinationPath $EXTRACT_DIR `
        -Force

    $SOURCE_DIR = Get-ChildItem $EXTRACT_DIR -Directory |
        Select-Object -First 1 -ExpandProperty FullName

    if (-not $SOURCE_DIR -or
        -not (Test-Path (Join-Path $SOURCE_DIR "package.json"))) {
        throw "Invalid Euler repository archive."
    }

    # Install dependencies
    Write-Host "[3/6] Installing dependencies..."

    Push-Location $SOURCE_DIR

    try {
        if (Test-Path "package-lock.json") {
            & npm.cmd ci
        }
        else {
            & npm.cmd install
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Dependency installation failed."
        }

        # Build
        Write-Host "[4/6] Building Euler..."

        & npm.cmd run typecheck

        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript typecheck failed."
        }

        & npm.cmd run build

        if ($LASTEXITCODE -ne 0) {
            throw "Euler build failed."
        }

        if (-not (Test-Path "dist/index.js")) {
            throw "Euler build output not found."
        }
    }
    finally {
        Pop-Location
    }

    # Install
    Write-Host "[5/6] Installing Euler..."

    New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null

    if (Test-Path $INSTALL_DIR) {
        Remove-Item $INSTALL_DIR -Recurse -Force
    }

    Move-Item -Path $SOURCE_DIR -Destination $INSTALL_DIR

    # Create Windows executable shim
    @'
@echo off
node "%~dp0..\app\dist\index.js" %*
'@ | Set-Content -Path $BIN_PATH -Encoding ASCII

    # Add to user PATH
    $USER_PATH = [Environment]::GetEnvironmentVariable("Path", "User")

    $PATH_ENTRIES = @(
        $USER_PATH -split ";" |
        Where-Object { $_.TrimEnd("\") -ne $BIN_DIR.TrimEnd("\") }
    )

    if (-not ($USER_PATH -split ";" |
        Where-Object { $_.TrimEnd("\") -eq $BIN_DIR.TrimEnd("\") })) {

        $NEW_PATH = (@($PATH_ENTRIES) + $BIN_DIR) -join ";"

        [Environment]::SetEnvironmentVariable(
            "Path",
            $NEW_PATH,
            "User"
        )
    }

    # Update current PowerShell session
    if (($env:PATH -split ";") -notcontains $BIN_DIR) {
        $env:PATH = "$BIN_DIR;$env:PATH"
    }

    Write-Host "[6/6] Installation completed!"
    Write-Host ""
    Write-Host "  Euler has been installed successfully."
    Write-Host ""
    Write-Host "  Repository: https://github.com/$GITHUB_REPO"
    Write-Host "  Location:   $INSTALL_DIR"
    Write-Host "  Executable: $BIN_PATH"
    Write-Host ""
    Write-Host "  Start Euler with:"
    Write-Host ""
    Write-Host "    euler"
    Write-Host ""

    Write-Host "Restart your terminal if PATH changes are not detected."
}
finally {
    if (Test-Path $TEMP_DIR) {
        Remove-Item $TEMP_DIR -Recurse -Force
    }
}
