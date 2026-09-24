param(
  [ValidateSet("status","enable","create","start","save","provision","prepare-bootstrap")]
  [string]$Action = "status",
  [string]$VmName = "Cotrux Persistent Workspace",
  [string]$VhdPath = "",
  [string]$IsoPath = "",
  [int]$MemoryMB = 4096,
  [int]$MaxMemoryMB = 8192,
  [int]$Processors = 2,
  [string]$GuestUsername = "",
  [string]$SignalUrl = "",
  [string]$PairingPin = "",
  [string]$InstallerUrl = "",
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
    "-GuestUsername", (Q $GuestUsername),
    "-SignalUrl", (Q $SignalUrl),
    "-PairingPin", (Q $PairingPin),
    "-InstallerUrl", (Q $InstallerUrl),
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

    if (-not (Test-Path $VhdPath)) {
      New-VHD -Path $VhdPath -Dynamic -SizeBytes 100GB | Out-Null
    }

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

  if ($Action -eq "prepare-bootstrap") {
    if (-not (Is-Admin)) { Relaunch-Elevated }
    if (-not $InstallerUrl -or -not $InstallerUrl.StartsWith("https://github.com/farshoffs/cotrux/")) {
      throw "The Cotrux installer URL is invalid."
    }
    if ($PairingPin -notmatch "^\d{6}$") { throw "A valid six-digit workspace pairing PIN is required." }
    if (-not $SignalUrl) { throw "Cotrux signaling URL is required." }

    if ($vm.State -ne "Running") {
      Start-VM -Name $VmName | Out-Null
      Start-Sleep -Seconds 3
    }

    Enable-VMIntegrationService -VMName $VmName -Name "Guest Service Interface" -ErrorAction SilentlyContinue

    $tempInstaller = Join-Path $env:TEMP ("Cotrux-Setup-" + [guid]::NewGuid().ToString("N") + ".exe")
    $tempScript = Join-Path $env:TEMP ("Cotrux-Guest-Bootstrap-" + [guid]::NewGuid().ToString("N") + ".ps1")
    $tempShortcut = Join-Path $env:TEMP ("Finish Cotrux Setup-" + [guid]::NewGuid().ToString("N") + ".lnk")

    try {
      Invoke-WebRequest -Uri $InstallerUrl -OutFile $tempInstaller -UseBasicParsing
      if (-not (Test-Path $tempInstaller) -or (Get-Item $tempInstaller).Length -lt 10MB) {
        throw "Downloaded Cotrux installer is incomplete."
      }

      $encodedSignal = [uri]::EscapeDataString($SignalUrl)
      $encodedName = [uri]::EscapeDataString("Cotrux Persistent Workspace")
      $bootstrap = @'
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework
try {
  $installer = "C:\Users\Public\Desktop\Cotrux-Setup.exe"
  Start-Process -FilePath $installer -ArgumentList "/S" -Wait

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Cotrux\Cotrux.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\cotrux\Cotrux.exe"),
    (Join-Path $env:ProgramFiles "Cotrux\Cotrux.exe")
  )
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) {
    $exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs") -Filter "Cotrux.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $exe) { throw "Cotrux installed, but Cotrux.exe could not be located." }

  $arguments = @(
    "--background-workspace",
    "--workspace-bootstrap",
    "--hidden",
    "--signal-url=__SIGNAL__",
    "--pairing-pin=__PIN__",
    "--display-name=__NAME__"
  )
  Start-Process -FilePath $exe -ArgumentList $arguments
  Start-Sleep -Seconds 3

  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Remove-Item "C:\Users\Public\Desktop\Finish Cotrux Setup.lnk" -Force -ErrorAction SilentlyContinue
  [System.Windows.MessageBox]::Show("Cotrux is installed and configured. Return to the host Cotrux window and use the workspace pairing PIN.", "Cotrux Workspace", "OK", "Information") | Out-Null
} catch {
  [System.Windows.MessageBox]::Show($_.Exception.Message, "Cotrux Workspace Setup", "OK", "Error") | Out-Null
}
'@
      $bootstrap = $bootstrap.Replace("__SIGNAL__", $encodedSignal).Replace("__PIN__", $PairingPin).Replace("__NAME__", $encodedName)
      [System.IO.File]::WriteAllText($tempScript, $bootstrap, [System.Text.UTF8Encoding]::new($false))

      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($tempShortcut)
      $shortcut.TargetPath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
      $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Public\Desktop\Cotrux-Guest-Bootstrap.ps1"'
      $shortcut.WorkingDirectory = "C:\Users\Public\Desktop"
      $shortcut.Description = "Finish Cotrux setup inside this persistent workspace"
      $shortcut.Save()

      Copy-VMFile -VMName $VmName -SourcePath $tempInstaller -DestinationPath "C:\Users\Public\Desktop\Cotrux-Setup.exe" -FileSource Host -CreateFullPath -Force
      Copy-VMFile -VMName $VmName -SourcePath $tempScript -DestinationPath "C:\Users\Public\Desktop\Cotrux-Guest-Bootstrap.ps1" -FileSource Host -CreateFullPath -Force
      Copy-VMFile -VMName $VmName -SourcePath $tempShortcut -DestinationPath "C:\Users\Public\Desktop\Finish Cotrux Setup.lnk" -FileSource Host -CreateFullPath -Force

      Write-Result @{
        ok = $true
        prepared = $true
        message = "One-click guest setup was copied to the VM desktop. Open the workspace and double-click Finish Cotrux Setup."
      }
    } finally {
      Remove-Item $tempInstaller -Force -ErrorAction SilentlyContinue
      Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
      Remove-Item $tempShortcut -Force -ErrorAction SilentlyContinue
    }
    exit
  }

  if ($Action -eq "provision") {
    if (-not (Is-Admin)) { Relaunch-Elevated }
    if (-not $GuestUsername) { throw "Guest Windows username is required." }
    if (-not $env:COTRUX_GUEST_PASSWORD) { throw "Guest Windows password is required." }
    if (-not $InstallerUrl -or -not $InstallerUrl.StartsWith("https://github.com/farshoffs/cotrux/")) {
      throw "The Cotrux installer URL is invalid."
    }
    if ($PairingPin -notmatch "^\d{6}$") { throw "A valid six-digit workspace pairing PIN is required." }
    if (-not $SignalUrl) { throw "Cotrux signaling URL is required." }

    if ($vm.State -ne "Running") {
      Start-VM -Name $VmName | Out-Null
      Start-Sleep -Seconds 3
    }

    try { Enable-VMIntegrationService -VMName $VmName -Name "Guest Service Interface" -ErrorAction SilentlyContinue } catch {}

    $secure = ConvertTo-SecureString $env:COTRUX_GUEST_PASSWORD -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($GuestUsername, $secure)

    $session = $null
    $lastSessionError = $null
    for ($i = 0; $i -lt 20; $i++) {
      try {
        $session = New-PSSession -VMName $VmName -Credential $credential -ErrorAction Stop
        if ($session) { break }
      } catch {
        $lastSessionError = $_.Exception.Message
        Start-Sleep -Seconds 3
      }
    }
    if (-not $session) {
      throw "Could not connect to Windows inside the workspace. Make sure Windows setup is finished and the username/password are correct. $lastSessionError"
    }

    $tempInstaller = Join-Path $env:TEMP ("Cotrux-Setup-" + [guid]::NewGuid().ToString("N") + ".exe")
    try {
      Invoke-WebRequest -Uri $InstallerUrl -OutFile $tempInstaller -UseBasicParsing
      if (-not (Test-Path $tempInstaller) -or (Get-Item $tempInstaller).Length -lt 10MB) {
        throw "Downloaded Cotrux installer is incomplete."
      }

      Invoke-Command -Session $session -ScriptBlock {
        New-Item -ItemType Directory -Path "C:\CotruxProvision" -Force | Out-Null
      }
      Copy-Item -ToSession $session -Path $tempInstaller -Destination "C:\CotruxProvision\Cotrux-Setup.exe" -Force

      $guestResult = Invoke-Command -Session $session -ArgumentList $SignalUrl,$PairingPin -ScriptBlock {
        param($CotruxSignalUrl,$CotruxPairingPin)

        $ErrorActionPreference = "Stop"
        Get-Process -Name "Cotrux" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

        Start-Process -FilePath "C:\CotruxProvision\Cotrux-Setup.exe" -ArgumentList "/S" -Wait

        $candidates = @(
          (Join-Path $env:LOCALAPPDATA "Programs\Cotrux\Cotrux.exe"),
          (Join-Path $env:LOCALAPPDATA "Programs\cotrux\Cotrux.exe"),
          (Join-Path $env:ProgramFiles "Cotrux\Cotrux.exe")
        )
        $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $exe) {
          $exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs") -Filter "Cotrux.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
        }
        if (-not $exe) { throw "Cotrux installed, but Cotrux.exe could not be located." }

        $encodedSignal = [uri]::EscapeDataString($CotruxSignalUrl)
        $encodedName = [uri]::EscapeDataString("Cotrux Persistent Workspace")
        $arguments = "--background-workspace --workspace-bootstrap --hidden --signal-url=$encodedSignal --pairing-pin=$CotruxPairingPin --display-name=$encodedName"

        $taskName = "Cotrux Persistent Workspace Agent"
        $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ("$env:USERDOMAIN\$env:USERNAME")
        $principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

        try { Start-ScheduledTask -TaskName $taskName } catch {}

        [pscustomobject]@{
          ok = $true
          exePath = $exe
          taskName = $taskName
          user = "$env:USERDOMAIN\$env:USERNAME"
        }
      }

      Write-Result @{
        ok = $true
        provisioned = $true
        guestUser = [string]$guestResult.user
        exePath = [string]$guestResult.exePath
        taskName = [string]$guestResult.taskName
        message = "Cotrux installed and configured inside the workspace. The guest password was used only for this provisioning session and was not saved by Cotrux."
      }
    } finally {
      if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
      Remove-Item $tempInstaller -Force -ErrorAction SilentlyContinue
      Remove-Item Env:COTRUX_GUEST_PASSWORD -ErrorAction SilentlyContinue
    }
    exit
  }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message; action = $Action }
  exit 1
}
