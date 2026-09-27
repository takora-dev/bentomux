# Dev helper: drive the tray icon without a mouse.
#   -click   send a left-button release to the tray icon window (what the
#            tray-icon crate reports as MouseButtonState::Up on Windows)
#   -state   just print the window states
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tray-probe.ps1 <pid> [-click]
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [switch]$Click
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TrayProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
'@

$trayHwnd = [IntPtr]::Zero
$mainHwnd = [IntPtr]::Zero
$cb = [TrayProbe+EnumProc]{
  param($h, $p)
  $wpid = 0
  [void][TrayProbe]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq $TargetPid) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][TrayProbe]::GetClassName($h, $cls, 256)
    $name = $cls.ToString()
    if ($name -eq 'tray_icon_app') { $script:trayHwnd = $h }
    elseif ($name -eq 'Tauri Window') {
      $t = New-Object System.Text.StringBuilder 256
      [void][TrayProbe]::GetWindowText($h, $t, 256)
      if ($t.ToString() -eq 'Bentomux') { $script:mainHwnd = $h }
    }
  }
  return $true
}
[void][TrayProbe]::EnumWindows($cb, [IntPtr]::Zero)

if ($trayHwnd -eq [IntPtr]::Zero) { Write-Output 'tray icon window: NOT FOUND'; exit 1 }
Write-Output "tray icon window: $trayHwnd"
if ($mainHwnd -eq [IntPtr]::Zero) { Write-Output 'main window: NOT FOUND'; exit 1 }

if ($Click) {
  Write-Output "before: main visible=$([TrayProbe]::IsWindowVisible($mainHwnd))"
  # The tray-icon crate's window proc handles its own WM_USER_TRAYICON (6002)
  # with lparam set to the raw mouse message; WM_LBUTTONUP is what it maps to
  # Click { button: Left, button_state: Up } — the exact event tray.rs acts on.
  $WM_USER_TRAYICON = 6002
  $WM_LBUTTONUP = 0x0202
  [void][TrayProbe]::PostMessage($trayHwnd, $WM_USER_TRAYICON, [IntPtr]::Zero, [IntPtr]$WM_LBUTTONUP)
  Start-Sleep -Milliseconds 1200
  Write-Output "after left-click: main visible=$([TrayProbe]::IsWindowVisible($mainHwnd))"
} else {
  Write-Output "main window: $mainHwnd visible=$([TrayProbe]::IsWindowVisible($mainHwnd))"
}
