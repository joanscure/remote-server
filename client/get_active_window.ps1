$code = @"
using System;
using System.Runtime.InteropServices;
public class User32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
"@
Add-Type $code
$hwnd = [User32]::GetForegroundWindow()
$pidVar = 0
[User32]::GetWindowThreadProcessId($hwnd, [ref]$pidVar) > $null
try {
    $p = Get-Process -Id $pidVar -ErrorAction Stop
    Write-Output $p.MainWindowTitle
} catch {
    Write-Output "Unknown"
}