param(
  [ValidateSet("status","enable","create","start","save")]
  [string]$Action = "status",
  [string]$VmName = "Cotrux Persistent Workspace",
  [string]$VhdPath = "",
  [string]$IsoPath = "",
  [int]$MemoryMB = 4096,
  [int]$MaxMemoryMB = 8192,
  [int]$Processors = 2,
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Result([hashtable]$data) {
  $data.timestamp = (Get-Date).ToString("o")
  $json = $data | ConvertTo-Json -Compress -Depth 6
  if ($ResultPath) {
    $dir = Split-Path -Parent $ResultPath
    if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($ResultPath, $json, [System.Text.UTF8Encoding]::new($false))
  } else {
    Write-Output $json
  }
}

function Is-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Q([string]$value) {
  return '"' + ($value -replace '"','\"') + '"'
}

function Relaunch-Elevated {
  $parts = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Q $PSCommandPath),
    "-Action", (Q $Action),
    "-VmName", (Q $VmName),
    "-VhdPath", (Q $VhdPath),
    "-IsoPath", (Q $IsoPath),
    "-MemoryMB", [string]$MemoryMB,
    "-MaxMemoryMB", [string]$MaxMemoryMB,
    "-Processors", [string]$Processors,
    "-ResultPath", (Q $ResultPath)
  )
  $p = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList ($parts -join " ") -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0 -and -not (Test-Path $ResultPath)) {
    Write-Result @{ ok = $false; error = "Administrator permission was cancelled or failed."; exitCode = $p.ExitCode }
  }
  exit
}

function HyperV-Available {
  return [bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
}

try {
  $edition = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -ErrorAction SilentlyContinue).EditionID
  $hyperv = HyperV-Available

  if ($Action -eq "status") {
    if (-not $hyperv) {
      Write-Result @{ ok = $true; hypervEnabled = $false; edition = $edition; exists = $false; running = $false; state = "Unavailable" }
      exit
    }

    try { $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue }
    catch {
      Write-Result @{ ok = $false; hypervEnabled = $true; edition = $edition; exists = $false; running = $false; state = "PermissionRequired"; error = $_.Exception.Message }
      exit
    }

    if (-not $vm) {
      Write-Result @{ ok = $true; hypervEnabled = $true; edition = $edition; exists = $false; running = $false; state = "NotCreated" }
      exit
    }

    Write-Result @{
      ok = $true
      hypervEnabled = $true
      edition = $edition
      exists = $true
      running = ($vm.State -eq "Running")
      state = [string]$vm.State
      automaticStartAction = [string]$vm.AutomaticStartAction
      automaticStopAction = [string]$vm.AutomaticStopAction
      uptimeSeconds = [math]::Round($vm.Uptime.TotalSeconds)
    }
    exit
  }

  if ($Action -eq "enable") {
    if (-not (Is-Admin)) { Relaunch-Elevated }

    $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
    $restartNeeded = $false
    if ($feature.State -ne "Enabled") {
      $result = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
      $restartNeeded = [bool]$result.RestartNeeded
    }

    try {
      $member = "$env:USERDOMAIN\$env:USERNAME"
      Add-LocalGroupMember -Group "Hyper-V Administrators" -Member $member -ErrorAction SilentlyContinue
    } catch {}

    Write-Result @{ ok = $true; hypervEnabled = $true; restartNeeded = $restartNeeded; edition = $edition; message = "Hyper-V enabled. Restart Windows if requested." }
    exit
  }

  if (-not $hyperv) {
    Write-Result @{ ok = $false; hypervEnabled = $false; error = "Hyper-V is not enabled." }
    exit
  }

  if ($Action -eq "create") {
    if (-not (Is-Admin)) { Relaunch-Elevated }
    if (-not $VhdPath) { throw "VHDX path is required." }
    if (-not $IsoPath -or -not (Test-Path $IsoPath)) { throw "A valid Windows ISO is required." }

    $existing = Get-VM -Name $VmName -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Result @{ ok = $true; exists = $true; running = ($existing.State -eq "Running"); state = [string]$existing.State; message = "Workspace already exists. Cotrux never overwrites its VHDX." }
      exit
    }

    $vhdDir = Split-Path -Parent $VhdPath
    New-Item -ItemType Directory -Path $vhdDir -Force | Out-Null
    if (Test-Path $VhdPath) { throw "A VHDX already exists at the workspace path. Cotrux will not overwrite it." }

    New-VHD -Path $VhdPath -Dynamic -SizeBytes 100GB | Out-Null

    $switch = Get-VMSwitch -Name "Default Switch" -ErrorAction SilentlyContinue
    if (-not $switch) {
      $switch = Get-VMSwitch | Where-Object { $_.SwitchType -eq "External" -or $_.SwitchType -eq "Internal" } | Select-Object -First 1
    }
    if (-not $switch) { throw "No Hyper-V virtual switch is available." }

    New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryMB * 1MB) -VHDPath $VhdPath -SwitchName $switch.Name | Out-Null
    Set-VMProcessor -VMName $VmName -Count ([Math]::Max(2, $Processors))
    Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 2GB -StartupBytes ($MemoryMB * 1MB) -MaximumBytes ($MaxMemoryMB * 1MB)
    Set-VM -Name $VmName -AutomaticStartAction Start -AutomaticStartDelay 10 -AutomaticStopAction Save
    Set-VMFirmware -VMName $VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
    Set-VMKeyProtector -VMName $VmName -NewLocalKeyProtector
    Enable-VMTPM -VMName $VmName

    $dvd = Add-VMDvdDrive -VMName $VmName -Path $IsoPath -Passthru
    Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd
    try { Enable-VMIntegrationService -VMName $VmName -Name "Guest Service Interface" -ErrorAction SilentlyContinue } catch {}
    Start-VM -Name $VmName | Out-Null

    Write-Result @{
      ok = $true
      exists = $true
      running = $true
      state = "Running"
      vhdPath = $VhdPath
      isoPath = $IsoPath
      automaticStartAction = "Start"
      automaticStopAction = "Save"
      message = "Persistent workspace created. Its VHDX will not be deleted when the VM stops."
    }
    exit
  }

  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if (-not $vm) { throw "Persistent workspace has not been created yet." }

  if ($Action -eq "start") {
    if ($vm.State -ne "Running") { Start-VM -Name $VmName | Out-Null }
    $vm = Get-VM -Name $VmName
    Write-Result @{ ok = $true; exists = $true; running = ($vm.State -eq "Running"); state = [string]$vm.State }
    exit
  }

  if ($Action -eq "save") {
    if ($vm.State -eq "Running") { Save-VM -Name $VmName }
    $vm = Get-VM -Name $VmName
    Write-Result @{ ok = $true; exists = $true; running = $false; state = [string]$vm.State; message = "Workspace saved. VHDX data and VM state were preserved." }
    exit
  }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message; action = $Action }
  exit 1
}
