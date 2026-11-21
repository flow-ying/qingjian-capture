param([string]$Action,[long]$Handle=0,[int]$X=0,[int]$Y=0,[int]$EndX=0,[int]$EndY=0)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OrbWin32 {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr ignored);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
}
'@
[void][OrbWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Check-Target([int]$px,[int]$py) {
 $point=[OrbWin32+POINT]::new();$point.X=$px;$point.Y=$py
 $hit=[OrbWin32]::GetAncestor([OrbWin32]::WindowFromPoint($point),2).ToInt64()
 if($hit -ne $Handle){throw 'Test target is covered or moved; no input was sent.'}
}
switch($Action){
 'inspect' {
  $point=[OrbWin32+POINT]::new();[void][OrbWin32]::GetCursorPos([ref]$point)
  $ex=[OrbWin32]::GetWindowLongPtrW([IntPtr]$Handle,-20).ToInt64()
  @{foreground=[OrbWin32]::GetForegroundWindow().ToInt64();topmost=($ex -band 8)-ne 0;noActivate=($ex -band 0x8000000)-ne 0;x=$point.X;y=$point.Y}|ConvertTo-Json -Compress
 }
 'foreground' {
  [void][OrbWin32]::ShowWindow([IntPtr]$Handle,5)
  $current=[OrbWin32]::GetCurrentThreadId();$foregroundThread=[OrbWin32]::GetWindowThreadProcessId([OrbWin32]::GetForegroundWindow(),[IntPtr]::Zero)
  $attached=[OrbWin32]::AttachThreadInput($current,$foregroundThread,$true)
  try{[void][OrbWin32]::SetForegroundWindow([IntPtr]$Handle)}finally{if($attached){[void][OrbWin32]::AttachThreadInput($current,$foregroundThread,$false)}}
  @{foreground=[OrbWin32]::GetForegroundWindow().ToInt64()}|ConvertTo-Json -Compress
 }
 'restore' {[void][OrbWin32]::SetCursorPos($X,$Y);[void][OrbWin32]::SetForegroundWindow([IntPtr]$Handle)}
 'hit' {$point=[OrbWin32+POINT]::new();$point.X=$X;$point.Y=$Y;@{hit=[OrbWin32]::GetAncestor([OrbWin32]::WindowFromPoint($point),2).ToInt64()}|ConvertTo-Json -Compress}
 'click' {
  [void][OrbWin32]::SetCursorPos($X,$Y);Check-Target $X $Y
  [OrbWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 70;[OrbWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 }
 'drag' {
  [void][OrbWin32]::SetCursorPos($X,$Y);Check-Target $X $Y
  [OrbWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  try {Start-Sleep -Milliseconds 60;for($i=1;$i -le 12;$i++){[void][OrbWin32]::SetCursorPos([int]($X+($EndX-$X)*$i/12),[int]($Y+($EndY-$Y)*$i/12));Start-Sleep -Milliseconds 20};Start-Sleep -Milliseconds 60}
  finally {[OrbWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}
 }
 'shortcut' {
  if([OrbWin32]::GetForegroundWindow().ToInt64() -ne $Handle){throw 'Foreground changed; no keyboard input was sent.'}
  try{[OrbWin32]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[OrbWin32]::keybd_event(0x10,0,0,[UIntPtr]::Zero);[OrbWin32]::keybd_event(0x20,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 60}
  finally{[OrbWin32]::keybd_event(0x20,0,2,[UIntPtr]::Zero);[OrbWin32]::keybd_event(0x10,0,2,[UIntPtr]::Zero);[OrbWin32]::keybd_event(0x11,0,2,[UIntPtr]::Zero)}
 }
 'escape' {if([OrbWin32]::GetForegroundWindow().ToInt64() -ne $Handle){throw 'Foreground changed.'};[OrbWin32]::keybd_event(0x1b,0,0,[UIntPtr]::Zero);[OrbWin32]::keybd_event(0x1b,0,2,[UIntPtr]::Zero)}
 default {throw 'Unknown test action'}
}
